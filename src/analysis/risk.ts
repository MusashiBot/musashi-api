// Risk assessment for a proposed binary-outcome trade.
//
// The API exposes this through /api/risk-assessment so that a trading bot
// can submit a trade idea (side + price + size + conviction) and get back
// an opinionated answer:
//
//   recommendation  — TAKE | SCALE_DOWN | AVOID
//   expected_value  — dollar EV after fees / slippage
//   variance        — variance of the PnL distribution in dollars^2
//   stddev          — standard deviation (matches EV units)
//   sharpe          — EV / stddev (single-trade)
//   prob_profit     — probability that PnL > 0 at resolution
//   worst_case      — max dollar loss
//   best_case       — max dollar gain
//   time_to_expiry_days  (optional) — used for time-decay warnings
//
// This module only performs math & reasoning; HTTP plumbing lives in
// `api/risk-assessment.ts`.

import { computeEdge, clamp } from './edge';
import { FeeModel, getFeeModel, costFraction } from './fees';

export type Side = 'YES' | 'NO';
export type Recommendation = 'TAKE' | 'SCALE_DOWN' | 'AVOID';

export interface RiskInputs {
  side: Side;
  /** Current YES price (0..1). NO price is 1 - yesPrice. */
  yesPrice: number;
  /**
   * Caller's estimate of P(YES). If omitted, we fall back to the market
   * price — in which case EV will be negative once fees apply (useful as
   * a sanity check: "why should I take this trade?").
   */
  trueProb?: number;
  stake: number;          // dollars at risk
  bankroll?: number;      // optional — gates the SCALE_DOWN recommendation
  volume24h: number;      // liquidity proxy
  platform?: string;
  fees?: FeeModel;
  confidence?: number;    // 0..1, shrinks true_prob toward market
  endDate?: string;       // ISO date — used to compute days-to-expiry
  /**
   * Max acceptable fraction of bankroll at risk (e.g. 0.1 = don't bet more
   * than 10% of bankroll on a single idea). Defaults to 0.1.
   */
  maxBankrollFraction?: number;
}

export interface RiskAssessment {
  recommendation: Recommendation;
  side: Side;
  stake: number;
  expectedValue: number;
  variance: number;
  stddev: number;
  sharpe: number;
  probProfit: number;
  worstCase: number;
  bestCase: number;
  evPerDollar: number;
  edgeNet: number;
  kellySuggestedStake: number;
  timeToExpiryDays: number | null;
  warnings: string[];
  reasoning: string;
}

export function assessRisk(input: RiskInputs): RiskAssessment {
  const fees = input.fees ?? getFeeModel(input.platform ?? 'polymarket');
  const yes = clamp(input.yesPrice, 1e-4, 1 - 1e-4);
  const entry = input.side === 'YES' ? yes : 1 - yes;
  const trueProb = input.trueProb === undefined
    ? yes // neutral fallback: assume market is right → EV will be ≤ 0
    : clamp(input.trueProb, 0, 1);

  // Probability our side wins.
  const winProb = input.side === 'YES' ? trueProb : 1 - trueProb;

  // Payout per $1 staked if our side wins. Buying at `entry` and
  // redeeming at $1 returns (1 / entry) dollars, or (1/entry - 1) net.
  const payoutIfWin = (1 - entry) / entry;
  const cost = costFraction(input.stake, input.volume24h, entry, fees);

  const evPerDollar = winProb * payoutIfWin - (1 - winProb) - cost;
  const expectedValue = input.stake * evPerDollar;

  // Variance of PnL per $1: E[X^2] - E[X]^2
  //   X = payoutIfWin w.p. winProb, else -1
  const ex2 = winProb * payoutIfWin * payoutIfWin + (1 - winProb) * 1;
  const ex = winProb * payoutIfWin - (1 - winProb);
  const variancePerDollar = Math.max(0, ex2 - ex * ex);
  const variance = input.stake * input.stake * variancePerDollar;
  const stddev = Math.sqrt(variance);
  const sharpe = stddev > 0 ? expectedValue / stddev : 0;

  // For a single binary trade PnL > 0 iff our side wins. Binary-option
  // longs on Polymarket and Kalshi cannot lose more than the stake; fees
  // are already reflected in `evPerDollar`, so the worst-case dollar loss
  // is bounded at `-stake`.
  const probProfit = winProb;
  const worstCase = -input.stake;
  const bestCase = Math.max(0, input.stake * (payoutIfWin - cost));

  // Kelly-suggested stake in dollars. We reuse the edge module; when the
  // caller supplies a bankroll the cap is `maxBankrollFraction` of that
  // value, otherwise we compute a display-only figure and skip the
  // bankroll-fraction SCALE_DOWN branch below.
  const edge = computeEdge({
    trueProb,
    yesPrice: yes,
    volume24h: input.volume24h,
    fees,
    stake: input.stake,
    confidence: input.confidence ?? 1,
  });
  const maxFrac = clamp(input.maxBankrollFraction ?? 0.1, 0, 1);
  const bankrollProvided = typeof input.bankroll === 'number' && input.bankroll > 0;
  const bankroll = bankrollProvided
    ? (input.bankroll as number)
    : input.stake / Math.max(maxFrac, 0.01);
  const kellyStake = edge.side === input.side
    ? bankroll * Math.min(edge.kellyFraction, maxFrac)
    : 0;

  const timeToExpiryDays = computeDaysToExpiry(input.endDate);

  const warnings = buildWarnings({
    evPerDollar,
    stake: input.stake,
    bankroll,
    bankrollProvided,
    maxFrac,
    timeToExpiryDays,
    volume24h: input.volume24h,
    recommendedSide: edge.side,
    actualSide: input.side,
    winProb,
  });

  const recommendation = chooseRecommendation({
    evPerDollar,
    side: input.side,
    recommendedSide: edge.side,
    stake: input.stake,
    kellyStake,
    bankroll,
    bankrollProvided,
    maxFrac,
  });

  return {
    recommendation,
    side: input.side,
    stake: input.stake,
    expectedValue,
    variance,
    stddev,
    sharpe,
    probProfit,
    worstCase,
    bestCase,
    evPerDollar,
    edgeNet: edge.edgeNet,
    kellySuggestedStake: Math.round(kellyStake * 100) / 100,
    timeToExpiryDays,
    warnings,
    reasoning: buildReasoning({
      recommendation,
      side: input.side,
      trueProb,
      yes,
      evPerDollar,
      sharpe,
      kellyStake,
      stake: input.stake,
    }),
  };
}

function computeDaysToExpiry(endDate: string | undefined): number | null {
  if (!endDate) return null;
  const t = new Date(endDate).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (t - Date.now()) / (1000 * 60 * 60 * 24));
}

function buildWarnings(ctx: {
  evPerDollar: number;
  stake: number;
  bankroll: number;
  bankrollProvided: boolean;
  maxFrac: number;
  timeToExpiryDays: number | null;
  volume24h: number;
  recommendedSide: 'YES' | 'NO' | 'HOLD';
  actualSide: 'YES' | 'NO';
  winProb: number;
}): string[] {
  const w: string[] = [];
  if (ctx.evPerDollar < 0) {
    w.push('Expected value is negative after fees and slippage.');
  }
  if (ctx.recommendedSide !== 'HOLD' && ctx.recommendedSide !== ctx.actualSide) {
    w.push(`Model prefers ${ctx.recommendedSide} side; you chose ${ctx.actualSide}.`);
  }
  if (!ctx.bankrollProvided) {
    w.push('Bankroll not provided; SCALE_DOWN checks against wealth are skipped. Pass `bankroll` for a full assessment.');
  } else if (ctx.bankroll > 0 && ctx.stake / ctx.bankroll > ctx.maxFrac) {
    w.push(`Stake is ${((ctx.stake / ctx.bankroll) * 100).toFixed(1)}% of bankroll, above ${(ctx.maxFrac * 100).toFixed(0)}% cap.`);
  }
  if (ctx.volume24h < 5_000) {
    w.push(`Low liquidity: 24h volume is only $${ctx.volume24h.toFixed(0)}. Expect slippage.`);
  }
  if (ctx.timeToExpiryDays !== null && ctx.timeToExpiryDays < 1 / 24) {
    w.push('Market expires in under an hour — execution risk is elevated.');
  }
  if (ctx.winProb < 0.1 || ctx.winProb > 0.9) {
    w.push('Probability is near the tails; small estimation errors lead to large relative losses.');
  }
  return w;
}

function chooseRecommendation(ctx: {
  evPerDollar: number;
  side: Side;
  recommendedSide: 'YES' | 'NO' | 'HOLD';
  stake: number;
  kellyStake: number;
  bankroll: number;
  bankrollProvided: boolean;
  maxFrac: number;
}): Recommendation {
  if (ctx.evPerDollar <= 0) return 'AVOID';
  if (ctx.recommendedSide !== 'HOLD' && ctx.recommendedSide !== ctx.side) return 'AVOID';
  if (ctx.kellyStake > 0 && ctx.stake > ctx.kellyStake * 1.5) return 'SCALE_DOWN';
  // Bankroll-fraction check only fires when the caller supplied a real
  // bankroll. Without one we cannot meaningfully compare the stake to
  // wealth, so we defer to the Kelly-vs-stake check above.
  if (ctx.bankrollProvided && ctx.bankroll > 0 && ctx.stake / ctx.bankroll > ctx.maxFrac) return 'SCALE_DOWN';
  return 'TAKE';
}

function buildReasoning(ctx: {
  recommendation: Recommendation;
  side: Side;
  trueProb: number;
  yes: number;
  evPerDollar: number;
  sharpe: number;
  kellyStake: number;
  stake: number;
}): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const header = `${ctx.recommendation} ${ctx.side}: your p=${pct(ctx.trueProb)} vs market YES=${pct(ctx.yes)}.`;
  const ev = `EV/$ = ${ctx.evPerDollar.toFixed(3)}, single-trade Sharpe = ${ctx.sharpe.toFixed(2)}.`;
  const kelly = ctx.kellyStake > 0
    ? `Kelly suggests $${ctx.kellyStake.toFixed(2)} vs. your $${ctx.stake.toFixed(2)}.`
    : 'Kelly recommends zero size on this side.';
  return `${header} ${ev} ${kelly}`;
}
