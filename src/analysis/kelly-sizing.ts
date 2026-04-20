/**
 * Kelly Criterion position sizing with volatility regime scaling
 *
 * Implements quarter-Kelly with hard capital caps and regime-based scaling.
 * The Kelly Criterion gives the theoretically optimal fraction of capital
 * to risk on a binary bet: f* = (p·b − q) / b
 *   where p = win probability, q = 1-p, b = net odds (payout ratio)
 */

import { PositionSize, VolatilityRegime } from '../types/market';

export type { VolatilityRegime };

// Tunable constants
const KELLY_FRACTION = 0.25;  // Quarter-Kelly — safer for uncertain model estimates
const MAX_POSITION_CAP = 0.10; // Hard cap: never exceed 10% of capital in one trade
const VOL_SCALAR: Record<VolatilityRegime, number> = {
  low: 1.2,
  normal: 1.0,
  high: 0.5,
};

/**
 * Compute Kelly Criterion fraction and scale by volatility regime.
 *
 * @param edge           Raw edge estimate (|model_prob − market_price|)
 * @param confidence     Model's estimated win probability (0-1)
 * @param marketPrice    Current YES price on the market (0-1)
 * @param volRegime      Current volatility regime (default: 'normal')
 * @returns              PositionSize with fraction and explanation
 */
export function kellySizing(
  edge: number,
  confidence: number,
  marketPrice: number,
  volRegime: VolatilityRegime = 'normal'
): PositionSize {
  // Clamp inputs to valid ranges
  const p = Math.max(0.01, Math.min(0.99, confidence));
  const price = Math.max(0.01, Math.min(0.99, marketPrice));
  const q = 1 - p;

  // Net odds: profit if YES resolves correctly at this price
  // b = (1 - price) / price  (buying YES at `price` cents on the dollar)
  const b = (1 - price) / price;

  const fullKelly = (p * b - q) / b;

  // Quarter-Kelly then scale by vol regime
  const quarterKelly = fullKelly * KELLY_FRACTION;
  const volScaled = quarterKelly * VOL_SCALAR[volRegime];

  // Apply floor (0 — never size a negative-edge trade) and hard cap
  const fraction = Math.max(0, Math.min(volScaled, MAX_POSITION_CAP));

  const riskLevel =
    fraction < 0.03 ? 'minimal'
    : fraction < 0.06 ? 'moderate'
    : 'elevated';

  const rationale =
    `Kelly=${(fullKelly * 100).toFixed(1)}%` +
    ` → ¼Kelly=${(quarterKelly * 100).toFixed(1)}%` +
    ` → ${volRegime}-vol-scaled=${(fraction * 100).toFixed(1)}%` +
    (fraction === 0 ? ' (negative edge — no trade)' : '');

  return {
    fraction: parseFloat(fraction.toFixed(4)),
    kelly_full: parseFloat(fullKelly.toFixed(4)),
    kelly_quarter: parseFloat(quarterKelly.toFixed(4)),
    rationale,
    risk_level: riskLevel,
    vol_regime: volRegime,
  };
}

// ─── Volatility Regime Detection ─────────────────────────────────────────────

export interface PricePoint {
  price: number;
  timestamp: number; // Unix ms
}

/**
 * Detect volatility regime from a market's price history.
 *
 * Computes rolling 1h vs 24h variance. If the 1h/24h ratio > 2.0 we call it
 * 'high'; if < 0.5 we call it 'low'; otherwise 'normal'.
 *
 * @param priceHistory   Array of {price, timestamp} sorted oldest→newest
 */
export function detectVolatilityRegime(priceHistory: PricePoint[]): VolatilityRegime {
  if (priceHistory.length < 4) return 'normal';

  const now = Date.now();
  const oneHourAgo = now - 3_600_000;
  const oneDayAgo = now - 86_400_000;

  const recentPrices = priceHistory
    .filter(p => p.timestamp >= oneHourAgo)
    .map(p => p.price);

  const dayPrices = priceHistory
    .filter(p => p.timestamp >= oneDayAgo)
    .map(p => p.price);

  if (recentPrices.length < 2 || dayPrices.length < 2) return 'normal';

  const var1h = variance(recentPrices);
  const var24h = variance(dayPrices);

  if (var24h < 1e-9) return 'normal'; // Essentially no movement at all

  const ratio = var1h / var24h;
  if (ratio > 2.0) return 'high';
  if (ratio < 0.5) return 'low';
  return 'normal';
}

/**
 * Detect whether a market has experienced an anomalous price move
 * (≥3 standard deviations) within the last `windowMinutes`.
 *
 * @param priceHistory   Array of {price, timestamp}
 * @param windowMinutes  Look-back window in minutes (default: 10)
 */
export function detectAnomalousMove(
  priceHistory: PricePoint[],
  windowMinutes = 10
): boolean {
  if (priceHistory.length < 4) return false;

  const now = Date.now();
  const windowStart = now - windowMinutes * 60_000;

  const allPrices = priceHistory.map(p => p.price);
  const recentPrices = priceHistory
    .filter(p => p.timestamp >= windowStart)
    .map(p => p.price);

  if (recentPrices.length < 2) return false;

  const mean = allPrices.reduce((a, b) => a + b, 0) / allPrices.length;
  const stddev = Math.sqrt(variance(allPrices));

  if (stddev < 1e-6) return false;

  const maxDeviation = Math.max(...recentPrices.map(p => Math.abs(p - mean)));
  return maxDeviation > 3 * stddev;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length;
}
