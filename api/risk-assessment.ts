import type { VercelRequest, VercelResponse } from '@vercel/node';
import { assessRisk, Side } from '../src/analysis/risk';
import { FeeModel, getFeeModel } from '../src/analysis/fees';
import { enforceRateLimit } from './lib/rate-limit';

/**
 * POST /api/risk-assessment
 *
 * Evaluates a proposed trade. Unlike /api/position-sizing (which tells you
 * how big to bet), this endpoint tells you whether a given bet is a good
 * idea at the stake you already picked — returning EV, variance, Sharpe,
 * and an opinionated recommendation.
 *
 * Request body:
 * ```json
 * {
 *   "side": "YES",                 // required: YES | NO
 *   "yes_price": 0.42,             // required, 0..1
 *   "stake": 250,                  // required, dollars
 *   "true_prob": 0.55,             // optional; defaults to yes_price
 *   "bankroll": 10000,             // optional, used for scale-down checks
 *   "volume_24h": 400000,          // required, liquidity proxy
 *   "platform": "polymarket",      // optional, default polymarket
 *   "confidence": 0.7,             // optional
 *   "end_date": "2026-06-01",      // optional, ISO date
 *   "max_bankroll_fraction": 0.1,  // optional, default 0.1
 *   "fees": { ... }                // optional FeeModel override
 * }
 * ```
 */
interface RiskRequest {
  side?: Side;
  yes_price?: number;
  stake?: number;
  true_prob?: number;
  bankroll?: number;
  volume_24h?: number;
  platform?: string;
  confidence?: number;
  end_date?: string;
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

  if (await enforceRateLimit(req, res, { bucket: 'risk-assessment', maxRequests: 120, windowSeconds: 60 })) {
    return;
  }

  const body = (req.body ?? {}) as RiskRequest;
  if (typeof body !== 'object' || Array.isArray(body)) {
    bad(res, 'Request body must be a JSON object.');
    return;
  }

  if (body.side !== 'YES' && body.side !== 'NO') {
    bad(res, "side is required and must be 'YES' or 'NO'.");
    return;
  }
  if (typeof body.yes_price !== 'number' || !Number.isFinite(body.yes_price) || body.yes_price <= 0 || body.yes_price >= 1) {
    bad(res, 'yes_price is required and must be strictly between 0 and 1.');
    return;
  }
  if (typeof body.stake !== 'number' || !Number.isFinite(body.stake) || body.stake <= 0) {
    bad(res, 'stake is required and must be a positive dollar amount.');
    return;
  }
  if (typeof body.volume_24h !== 'number' || !Number.isFinite(body.volume_24h) || body.volume_24h < 0) {
    bad(res, 'volume_24h is required and must be a non-negative number.');
    return;
  }
  if (body.true_prob !== undefined && (typeof body.true_prob !== 'number' || body.true_prob < 0 || body.true_prob > 1)) {
    bad(res, 'true_prob must be between 0 and 1 when provided.');
    return;
  }
  if (body.confidence !== undefined && (typeof body.confidence !== 'number' || body.confidence < 0 || body.confidence > 1)) {
    bad(res, 'confidence must be between 0 and 1.');
    return;
  }
  if (body.bankroll !== undefined && (typeof body.bankroll !== 'number' || body.bankroll <= 0)) {
    bad(res, 'bankroll must be a positive number.');
    return;
  }

  const platform = (body.platform ?? 'polymarket').toLowerCase();
  const fees: FeeModel = { ...getFeeModel(platform), ...(body.fees ?? {}) };

  const assessment = assessRisk({
    side: body.side,
    yesPrice: body.yes_price,
    stake: body.stake,
    trueProb: body.true_prob,
    bankroll: body.bankroll,
    volume24h: body.volume_24h,
    platform,
    fees,
    confidence: body.confidence,
    endDate: body.end_date,
    maxBankrollFraction: body.max_bankroll_fraction,
  });

  res.status(200).json({
    success: true,
    data: {
      recommendation: assessment.recommendation,
      side: assessment.side,
      stake: assessment.stake,
      expected_value: round(assessment.expectedValue),
      variance: round(assessment.variance),
      stddev: round(assessment.stddev),
      sharpe: round(assessment.sharpe, 3),
      prob_profit: round(assessment.probProfit, 4),
      worst_case_loss: round(assessment.worstCase),
      best_case_gain: round(assessment.bestCase),
      ev_per_dollar: round(assessment.evPerDollar, 4),
      edge_net: round(assessment.edgeNet, 4),
      kelly_suggested_stake: round(assessment.kellySuggestedStake),
      time_to_expiry_days: assessment.timeToExpiryDays === null ? null : round(assessment.timeToExpiryDays, 3),
      warnings: assessment.warnings,
      reasoning: assessment.reasoning,
      inputs: {
        side: body.side,
        yes_price: body.yes_price,
        stake: body.stake,
        true_prob: body.true_prob ?? null,
        bankroll: body.bankroll ?? null,
        volume_24h: body.volume_24h,
        platform,
        confidence: body.confidence ?? null,
        end_date: body.end_date ?? null,
        max_bankroll_fraction: body.max_bankroll_fraction ?? null,
        fees,
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
