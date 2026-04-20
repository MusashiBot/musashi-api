// Edge, Expected Value, and Kelly sizing utilities.
//
// Every trading-signal surface in Musashi funnels through these functions so
// that the numbers returned to bot developers are mutually consistent:
//
//   true_prob      — our estimate of the real probability of YES
//   market_price   — current YES price on the chosen platform
//   edge_raw       — true_prob - market_price  (signed, can be negative)
//   edge_net       — edge after fees & slippage for the recommended stake
//   ev_per_dollar  — expected return per $1 staked
//   kelly_fraction — optimal bankroll fraction (capped, sign-aware)
//
// This file is deliberately free of I/O; it only does math so it can be
// reused from endpoints, SDK, tests, and the signal generator.

import { costFraction, FeeModel } from './fees';

export type Side = 'YES' | 'NO' | 'HOLD';

export interface EdgeInputs {
  trueProb: number;       // 0..1 — caller's best estimate
  yesPrice: number;       // 0..1 — current market YES price
  volume24h: number;      // liquidity proxy
  fees: FeeModel;
  /** Stake in dollars we are evaluating for. Defaults to a small reference size. */
  stake?: number;
  /**
   * Caller's confidence in `trueProb` on [0, 1]. Used to shrink Kelly
   * toward zero. If omitted we assume 1.0 (take the estimate at face value).
   */
  confidence?: number;
  /**
   * Kelly fraction cap (aka "fractional Kelly"). Defaults to 0.25 which is
   * the canonical quarter-Kelly sizing used by most prop-trading desks to
   * control drawdown.
   */
  kellyCap?: number;
}

export interface EdgeResult {
  side: Side;
  trueProb: number;
  marketPrice: number;      // price of the side we would buy
  edgeRaw: number;          // signed, pre-cost
  edgeNet: number;          // signed, post-cost
  evPerDollar: number;      // signed, post-cost
  kellyFraction: number;    // 0..1, capped
  breakevenProb: number;    // min true_prob for non-negative EV
  worstCaseLoss: number;    // fraction of stake lost if we're wrong
  bestCaseGain: number;     // fraction of stake gained if we're right
  reasoning: string;
}

/**
 * Clamp `x` into `[lo, hi]`. Defensive against NaN / Infinity.
 */
export function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Compute the Kelly fraction for a binary bet priced at `p` with true
 * probability `q`.
 *
 * For "buy YES at price p, wins $1 if YES":
 *   payout_if_win  = (1 - p) / p   (dollars won per dollar staked)
 *   payout_if_lose = -1
 *   f* = q - (1 - q) / b,  where b = payout_if_win
 *      = (q - p) / (1 - p)
 *
 * If f* <= 0, we should not take the bet (edge is non-positive).
 * Returns a *signed* fraction: positive → buy YES, negative → buy NO.
 */
export function kellyFraction(trueProb: number, marketPrice: number): number {
  const q = clamp(trueProb, 1e-4, 1 - 1e-4);
  const p = clamp(marketPrice, 1e-4, 1 - 1e-4);

  const fYes = (q - p) / (1 - p);
  const fNo = ((1 - q) - (1 - p)) / p; // equivalent form for buying NO at (1 - p)

  // Choose the side with positive expectation. If both are non-positive
  // (shouldn't normally happen), return 0.
  if (fYes >= fNo && fYes > 0) return fYes;
  if (fNo > fYes && fNo > 0) return -fNo;
  return 0;
}

/**
 * Main entry point used by the signal generator, arbitrage code, and the
 * position-sizing endpoint.
 */
export function computeEdge(input: EdgeInputs): EdgeResult {
  const {
    trueProb,
    yesPrice,
    volume24h,
    fees,
    stake = 100,
    confidence = 1,
    kellyCap = 0.25,
  } = input;

  const q = clamp(trueProb, 0, 1);
  const yes = clamp(yesPrice, 1e-4, 1 - 1e-4);
  const no = 1 - yes;

  // Which side has positive raw edge?
  const edgeYes = q - yes;
  const edgeNo = (1 - q) - no;

  let side: Side;
  let price: number;
  let edgeRaw: number;
  let payoutIfWin: number;
  let winProb: number;

  if (edgeYes > 0 && edgeYes >= edgeNo) {
    side = 'YES';
    price = yes;
    edgeRaw = edgeYes;
    payoutIfWin = (1 - yes) / yes; // dollars won per $1 staked when YES hits
    winProb = q;
  } else if (edgeNo > 0) {
    side = 'NO';
    price = no;
    edgeRaw = edgeNo;
    payoutIfWin = (1 - no) / no;
    winProb = 1 - q;
  } else {
    side = 'HOLD';
    price = yes;
    edgeRaw = Math.max(edgeYes, edgeNo);
    payoutIfWin = 0;
    winProb = q;
  }

  // Fee-adjusted EV per dollar staked.
  // EV = winProb * payoutIfWin - (1 - winProb) * 1 - costFraction
  const cost = costFraction(stake, volume24h, price, fees);
  const evPerDollarPreCost = winProb * payoutIfWin - (1 - winProb);
  const evPerDollar = evPerDollarPreCost - cost;
  const edgeNet = edgeRaw - cost * price; // convert cost frac back to price space

  // Confidence shrinkage: if the caller isn't sure about `trueProb`, we
  // shade the implied probability toward the market price before sizing.
  const shrunkProb = confidence * q + (1 - confidence) * yes;

  // Signed Kelly on the same side we recommended.
  let signedKelly = kellyFraction(shrunkProb, yes);
  // If shrinkage flipped the side (rare), force 0 to avoid confusing bots.
  if ((side === 'YES' && signedKelly <= 0) || (side === 'NO' && signedKelly >= 0)) {
    signedKelly = 0;
  }

  const absKelly = Math.abs(signedKelly);
  const kelly = clamp(absKelly, 0, clamp(kellyCap, 0, 1));

  // Breakeven: solve evPerDollar = 0 for q, side held fixed.
  // For YES side: q * (1 - yes)/yes - (1 - q) - cost = 0
  //   → q = (yes + cost * yes) / (1 - yes + yes) = yes * (1 + cost)   (approx)
  // We compute numerically for robustness.
  const breakevenProb = side === 'NO'
    ? 1 - (no + cost * no)
    : yes + cost * yes;

  const reasoning = buildReasoning({
    side,
    q,
    yes,
    edgeRaw,
    edgeNet,
    cost,
    evPerDollar,
    kelly,
    confidence,
  });

  return {
    side,
    trueProb: q,
    marketPrice: price,
    edgeRaw,
    edgeNet,
    evPerDollar,
    kellyFraction: side === 'HOLD' ? 0 : kelly,
    breakevenProb: clamp(breakevenProb, 0, 1),
    worstCaseLoss: side === 'HOLD' ? 0 : 1 + cost, // you lose stake + costs
    bestCaseGain: side === 'HOLD' ? 0 : payoutIfWin - cost,
    reasoning,
  };
}

function buildReasoning(ctx: {
  side: Side;
  q: number;
  yes: number;
  edgeRaw: number;
  edgeNet: number;
  cost: number;
  evPerDollar: number;
  kelly: number;
  confidence: number;
}): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  if (ctx.side === 'HOLD') {
    if (ctx.evPerDollar < 0) {
      return `Costs (${pct(ctx.cost)}) exceed the ${pct(Math.abs(ctx.edgeRaw))} raw edge. Expected value is negative — HOLD.`;
    }
    return `No clear directional edge between your estimate (${pct(ctx.q)}) and the market (${pct(ctx.yes)}). HOLD.`;
  }

  const direction = ctx.side === 'YES'
    ? `YES underpriced at ${pct(ctx.yes)}`
    : `YES overpriced at ${pct(ctx.yes)} (so buy NO)`;

  const confNote = ctx.confidence < 0.9
    ? ` Shrunk by ${pct(1 - ctx.confidence)} confidence discount.`
    : '';

  return `Your estimate ${pct(ctx.q)} vs. market ${pct(ctx.yes)} ⇒ ${direction}. ` +
    `Net edge ${pct(ctx.edgeNet)} after ${pct(ctx.cost)} costs; EV/$ = ${ctx.evPerDollar.toFixed(3)}. ` +
    `Suggested Kelly fraction ${pct(ctx.kelly)} of bankroll.${confNote}`;
}

/**
 * Brier score for evaluating the quality of a probability forecast.
 * Lower is better. `outcome` must be 0 or 1.
 */
export function brierScore(prob: number, outcome: 0 | 1): number {
  const p = clamp(prob, 0, 1);
  return (p - outcome) ** 2;
}

/**
 * Log loss (cross-entropy) — an alternative calibration metric. Lower is
 * better. Caps probabilities away from {0, 1} to avoid -Infinity.
 */
export function logLoss(prob: number, outcome: 0 | 1): number {
  const p = clamp(prob, 1e-6, 1 - 1e-6);
  return outcome === 1 ? -Math.log(p) : -Math.log(1 - p);
}
