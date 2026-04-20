// Platform fee & slippage model
// Used by edge, arbitrage, and position-sizing calculations so that
// every "profit" number returned by the API is net of realistic trading costs.

export type Platform = 'polymarket' | 'kalshi';

export interface FeeModel {
  /**
   * Proportional taker fee paid on every fill, as a fraction of notional
   * (e.g. 0.02 = 2% of stake).
   */
  takerFee: number;
  /**
   * Flat per-trade cost (gas / network / processing) in USD.
   * Used to filter out tiny trades where fixed costs dominate.
   */
  fixedCost: number;
  /**
   * Expected bid/ask spread cost as a fraction of price (one side).
   * Used as a proxy for slippage when order-book depth isn't available.
   */
  spreadCost: number;
  /**
   * Additional slippage coefficient `k` in the impact model
   * `slippage = k * sqrt(stake / volume24h)`.
   *
   * Captures the fact that larger orders walk the book further.
   */
  impactCoefficient: number;
}

/**
 * Default fee models. These are conservative — bots can override at the
 * endpoint level (see /api/position-sizing, /api/risk-assessment).
 *
 * Polymarket takes 0% maker fee but gas + spread typically costs ~2%.
 * Kalshi takes up to ~7% of profit for retail; we model as ~3% of notional
 * to keep the math linear.
 */
export const DEFAULT_FEES: Record<Platform, FeeModel> = {
  polymarket: {
    takerFee: 0.0,
    fixedCost: 0.25,
    spreadCost: 0.01,
    impactCoefficient: 0.5,
  },
  kalshi: {
    takerFee: 0.02,
    fixedCost: 0.0,
    spreadCost: 0.005,
    impactCoefficient: 0.5,
  },
};

/**
 * Estimate realized slippage for a trade of `stake` dollars in a market
 * with 24h volume `volume24h`. Returns a fraction of price (e.g. 0.01 = 1¢).
 */
export function estimateSlippage(stake: number, volume24h: number, model: FeeModel): number {
  if (stake <= 0) return 0;
  const liquidity = Math.max(volume24h, 1_000); // floor to avoid blow-ups
  const impact = model.impactCoefficient * Math.sqrt(stake / liquidity);
  return model.spreadCost + impact;
}

/**
 * Total cost of a round-trip trade expressed as a fraction of `stake`.
 * Includes taker fees + slippage + amortized fixed costs.
 *
 * The slippage term uses the "adverse execution" formulation:
 *
 *   cost_from_slippage = slippage / (price + slippage)
 *
 * which equals the fraction of stake you lose because each share costs
 * `price + slippage` instead of `price`. For thick markets the slippage is
 * tiny so this reduces to `slippage / price`, but for penny markets it
 * caps at 1.0 instead of exploding.
 *
 * The total is hard-capped at 0.9 so the EV computation remains stable
 * even on pathologically illiquid quotes.
 */
export function costFraction(
  stake: number,
  volume24h: number,
  price: number,
  model: FeeModel,
): number {
  if (stake <= 0) return 0;
  const slippage = estimateSlippage(stake, volume24h, model);
  const safePrice = Math.max(price, 1e-4);
  const slipFrac = slippage / (safePrice + slippage);
  const fixedFrac = model.fixedCost / Math.max(stake, 1);
  const raw = model.takerFee + slipFrac + fixedFrac;
  return Math.min(0.9, raw);
}

/**
 * Resolve a platform name to its fee model, falling back to Polymarket.
 */
export function getFeeModel(platform: string): FeeModel {
  if (platform === 'kalshi') return DEFAULT_FEES.kalshi;
  return DEFAULT_FEES.polymarket;
}
