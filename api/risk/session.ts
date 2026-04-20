/**
 * POST /api/risk/session
 *
 * Three-layer session risk management and circuit-breaker endpoint.
 * Accepts session P&L data and returns a throttle_level that bots
 * should honour before opening new positions.
 *
 * Throttle levels:
 *   normal  — no restrictions; full Kelly fractions apply
 *   caution — reduce all position sizes by 50%; continue trading
 *   halt    — stop opening new positions until next UTC day reset
 *
 * Daily loss thresholds (configurable via env vars):
 *   RISK_CAUTION_THRESHOLD  (default: -0.05 = -5%)
 *   RISK_HALT_THRESHOLD     (default: -0.10 = -10%)
 *
 * Additionally returns:
 *   - per-trade stop_loss_pct: if a single open position moves against
 *     you by more than this fraction, close it immediately.
 *   - max_position_pct: Kelly cap adjusted for current throttle level.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

// ─── Thresholds ───────────────────────────────────────────────────────────────

const CAUTION_THRESHOLD = parseFloat(
  process.env.RISK_CAUTION_THRESHOLD ?? '-0.05'
);
const HALT_THRESHOLD = parseFloat(
  process.env.RISK_HALT_THRESHOLD ?? '-0.10'
);

// Per-trade stop-loss: exit if single position drops more than this
const DEFAULT_STOP_LOSS_PCT = 0.15; // 15% of position value

// Default max position fraction at each throttle level
const MAX_POSITION_BY_LEVEL: Record<ThrottleLevel, number> = {
  normal: 0.10,  // 10% per trade
  caution: 0.05, // 50% reduction → 5%
  halt: 0.00,    // No new positions
};

type ThrottleLevel = 'normal' | 'caution' | 'halt';

interface SessionRiskRequest {
  session_pnl_pct: number;    // Fractional session P&L (e.g. -0.07 = -7%)
  open_positions?: number;    // Number of currently open positions
  largest_position_pct?: number; // Largest single position as % of capital
  session_trade_count?: number;  // How many trades taken this session
}

interface SessionRiskResponse {
  throttle_level: ThrottleLevel;
  max_position_pct: number;
  stop_loss_pct: number;
  kelly_multiplier: number;   // Apply this to all Kelly fractions this session
  resets_at: string;          // ISO timestamp of next UTC midnight reset
  reasoning: string;
  warnings: string[];
}

function nextUtcMidnight(): string {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return midnight.toISOString();
}

function assessThrottle(pnlPct: number): ThrottleLevel {
  if (pnlPct <= HALT_THRESHOLD) return 'halt';
  if (pnlPct <= CAUTION_THRESHOLD) return 'caution';
  return 'normal';
}

function buildReasoning(
  level: ThrottleLevel,
  pnlPct: number,
  req: SessionRiskRequest
): { reasoning: string; warnings: string[] } {
  const warnings: string[] = [];
  let reasoning: string;

  if (level === 'halt') {
    reasoning =
      `Session P&L of ${(pnlPct * 100).toFixed(1)}% has breached the ` +
      `${(HALT_THRESHOLD * 100).toFixed(0)}% halt threshold. ` +
      `No new positions until next UTC day reset.`;
    warnings.push('HALT: All new position entries are blocked.');
    warnings.push(`Daily loss limit reached. Losses this session: ${(Math.abs(pnlPct) * 100).toFixed(1)}%`);
  } else if (level === 'caution') {
    reasoning =
      `Session P&L of ${(pnlPct * 100).toFixed(1)}% has breached the ` +
      `${(CAUTION_THRESHOLD * 100).toFixed(0)}% caution threshold. ` +
      `Position sizes halved until session recovers.`;
    warnings.push('CAUTION: Position sizes capped at 50% of normal Kelly fractions.');
  } else {
    reasoning = `Session P&L of ${(pnlPct * 100).toFixed(1)}% is within normal operating range.`;
  }

  if (req.open_positions !== undefined && req.open_positions > 10) {
    warnings.push(`High concentration risk: ${req.open_positions} open positions.`);
  }

  if (req.largest_position_pct !== undefined && req.largest_position_pct > 0.08) {
    warnings.push(
      `Oversized position detected: ${(req.largest_position_pct * 100).toFixed(1)}% of capital in one trade.`
    );
  }

  return { reasoning, warnings };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
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

  try {
    const body = req.body as SessionRiskRequest | null;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ success: false, error: 'Request body must be a JSON object.' });
      return;
    }

    if (typeof body.session_pnl_pct !== 'number' || !Number.isFinite(body.session_pnl_pct)) {
      res.status(400).json({
        success: false,
        error: 'session_pnl_pct is required and must be a finite number (e.g. -0.07 for -7%).',
      });
      return;
    }

    if (body.session_pnl_pct < -1 || body.session_pnl_pct > 10) {
      res.status(400).json({
        success: false,
        error: 'session_pnl_pct must be between -1.0 and 10.0.',
      });
      return;
    }

    const { session_pnl_pct } = body;
    const throttleLevel = assessThrottle(session_pnl_pct);
    const { reasoning, warnings } = buildReasoning(throttleLevel, session_pnl_pct, body);

    const kellyMultiplier =
      throttleLevel === 'halt' ? 0
      : throttleLevel === 'caution' ? 0.5
      : 1.0;

    const responseBody: SessionRiskResponse = {
      throttle_level: throttleLevel,
      max_position_pct: MAX_POSITION_BY_LEVEL[throttleLevel],
      stop_loss_pct: DEFAULT_STOP_LOSS_PCT,
      kelly_multiplier: kellyMultiplier,
      resets_at: nextUtcMidnight(),
      reasoning,
      warnings,
    };

    res.status(200).json({ success: true, data: responseBody });
  } catch (error) {
    console.error('[Risk Session API] Error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
