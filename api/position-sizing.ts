import type { VercelRequest, VercelResponse } from '@vercel/node';
import { computeEdge, kellyFraction } from '../src/analysis/edge';
import { DEFAULT_FEES, FeeModel, getFeeModel } from '../src/analysis/fees';
import { enforceRateLimit } from './lib/rate-limit';

/**
 * POST /api/position-sizing
 *
 * Given a probability estimate, a market price, and a bankroll, return the
 * Kelly-optimal stake alongside EV, expected variance, and fee-adjusted
 * edge numbers — the canonical "how much should I bet?" endpoint for bots.
 *
 * Request body:
 * ```json
 * {
 *   "true_prob": 0.62,           // required, 0..1
 *   "yes_price": 0.50,           // required, 0..1
 *   "bankroll": 10000,           // required, dollars
 *   "volume_24h": 250000,        // required for slippage estimate
 *   "platform": "polymarket",    // optional, default polymarket
 *   "confidence": 0.8,           // optional, shrinks true_prob toward market
 *   "kelly_cap": 0.25,           // optional fractional Kelly cap (default 0.25)
 *   "max_bankroll_fraction": 0.1,// optional, hard cap (default 0.1)
 *   "fees": { "takerFee": 0.02, "fixedCost": 0, "spreadCost": 0.01, "impactCoefficient": 0.5 }
 * }
 * ```
 */
interface PositionSizingRequest {
  true_prob?: number;
  yes_price?: number;
  bankroll?: number;
  volume_24h?: number;
  platform?: string;
  confidence?: number;
  kelly_cap?: number;
  max_bankroll_fraction?: number;
  fees?: Partial<FeeModel>;
}

function bad(res: VercelResponse, message: string): void {
  res.status(400).json({ success: false, error: message });
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ success: false, error: 'Method not allowed. Use POST.' });
    return;
  }

  if (await enforceRateLimit(req, res, { bucket: 'position-sizing', maxRequests: 120, windowSeconds: 60 })) {
    return;
  }

  const body = (req.body ?? {}) as PositionSizingRequest;
  if (typeof body !== 'object' || Array.isArray(body)) {
    bad(res, 'Request body must be a JSON object.');
    return;
  }

  if (typeof body.true_prob !== 'number' || !Number.isFinite(body.true_prob) || body.true_prob < 0 || body.true_prob > 1) {
    bad(res, 'true_prob is required and must be between 0 and 1.');
    return;
  }
  if (typeof body.yes_price !== 'number' || !Number.isFinite(body.yes_price) || body.yes_price <= 0 || body.yes_price >= 1) {
    bad(res, 'yes_price is required and must be strictly between 0 and 1.');
    return;
  }
  if (typeof body.bankroll !== 'number' || !Number.isFinite(body.bankroll) || body.bankroll <= 0) {
    bad(res, 'bankroll is required and must be a positive number (dollars).');
    return;
  }
  if (typeof body.volume_24h !== 'number' || !Number.isFinite(body.volume_24h) || body.volume_24h < 0) {
    bad(res, 'volume_24h is required and must be a non-negative number.');
    return;
  }

  const confidence = body.confidence ?? 1;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    bad(res, 'confidence must be between 0 and 1.');
    return;
  }

  const kellyCap = body.kelly_cap ?? 0.25;
  if (typeof kellyCap !== 'number' || kellyCap <= 0 || kellyCap > 1) {
    bad(res, 'kelly_cap must be between 0 (exclusive) and 1.');
    return;
  }

  const maxFrac = body.max_bankroll_fraction ?? 0.1;
  if (typeof maxFrac !== 'number' || maxFrac <= 0 || maxFrac > 1) {
    bad(res, 'max_bankroll_fraction must be between 0 (exclusive) and 1.');
    return;
  }

  const platform = (body.platform ?? 'polymarket').toLowerCase();
  const defaultFees = getFeeModel(platform);
  const fees: FeeModel = {
    ...defaultFees,
    ...(body.fees ?? {}),
  };

  // Iterate: Kelly depends on cost, cost depends on stake, stake depends on Kelly.
  // Two passes are plenty for convergence because stakes move the slippage
  // term only through sqrt(stake/volume).
  const referenceStake = body.bankroll * maxFrac;
  const first = computeEdge({
    trueProb: body.true_prob,
    yesPrice: body.yes_price,
    volume24h: body.volume_24h,
    fees,
    stake: referenceStake,
    confidence,
    kellyCap,
  });

  const stakeCandidate1 = body.bankroll * Math.min(first.kellyFraction, maxFrac);
  const refined = computeEdge({
    trueProb: body.true_prob,
    yesPrice: body.yes_price,
    volume24h: body.volume_24h,
    fees,
    stake: Math.max(1, stakeCandidate1),
    confidence,
    kellyCap,
  });

  const rawKelly = refined.kellyFraction;
  const kellyFractionCapped = Math.min(rawKelly, maxFrac);
  const recommendedStake = Math.max(0, body.bankroll * kellyFractionCapped);

  // Half-Kelly and quarter-Kelly are computed against the uncapped full
  // Kelly fraction so the names match what practitioners expect. Each
  // result is still bounded by the outer risk limits (`kelly_cap` and
  // `max_bankroll_fraction`) so these "safer" sizings can never exceed
  // the recommended stake or the caller's hard risk cap.
  const shrunkProbForAlt = confidence * body.true_prob + (1 - confidence) * body.yes_price;
  const fullKellyAbs = refined.side === 'HOLD' ? 0 : Math.abs(kellyFraction(shrunkProbForAlt, body.yes_price));
  const outerCap = Math.min(kellyCap, maxFrac);
  const halfKellyStake = Math.max(0, body.bankroll * Math.min(fullKellyAbs * 0.5, outerCap));
  const quarterKellyStake = Math.max(0, body.bankroll * Math.min(fullKellyAbs * 0.25, outerCap));

  const expectedProfit = recommendedStake * refined.evPerDollar;
  const worstCase = -recommendedStake * refined.worstCaseLoss;
  const bestCase = recommendedStake * refined.bestCaseGain;

  const bankrollCapped = rawKelly > maxFrac;
  const reasoning = bankrollCapped
    ? `${refined.reasoning} Stake capped at ${(maxFrac * 100).toFixed(1)}% of bankroll (Kelly wanted ${(rawKelly * 100).toFixed(1)}%).`
    : refined.reasoning;

  res.status(200).json({
    success: true,
    data: {
      side: refined.side,
      recommended_stake: round(recommendedStake),
      alternative_sizing: {
        half_kelly: round(halfKellyStake),
        quarter_kelly: round(quarterKellyStake),
        flat_1pct_bankroll: round(body.bankroll * 0.01),
      },
      full_kelly_fraction: round(fullKellyAbs, 4),
      kelly_fraction: round(kellyFractionCapped, 4),
      edge_raw: round(refined.edgeRaw, 4),
      edge_net: round(refined.edgeNet, 4),
      ev_per_dollar: round(refined.evPerDollar, 4),
      expected_profit: round(expectedProfit),
      worst_case_loss: round(worstCase),
      best_case_gain: round(bestCase),
      breakeven_prob: round(refined.breakevenProb, 4),
      reasoning,
      inputs: {
        true_prob: body.true_prob,
        yes_price: body.yes_price,
        bankroll: body.bankroll,
        volume_24h: body.volume_24h,
        confidence,
        kelly_cap: kellyCap,
        max_bankroll_fraction: maxFrac,
        platform,
        fees,
      },
      defaults_used: {
        kelly_cap: body.kelly_cap === undefined,
        max_bankroll_fraction: body.max_bankroll_fraction === undefined,
        fees: body.fees === undefined,
        default_fees: DEFAULT_FEES,
      },
    },
    timestamp: new Date().toISOString(),
  });
}

function round(x: number, digits = 2): number {
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
