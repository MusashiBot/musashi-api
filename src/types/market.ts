// Market data types

export interface Market {
  id: string;
  platform: 'kalshi' | 'polymarket';
  title: string;
  description: string;
  keywords: string[];
  yesPrice: number; // 0.0 to 1.0 (0.65 = 65%)
  noPrice: number;  // 0.0 to 1.0 (0.35 = 35%)
  yesBid?: number;  // best executable YES bid when available
  yesAsk?: number;  // best executable YES ask when available
  noBid?: number;   // best executable NO bid when available
  noAsk?: number;   // best executable NO ask when available
  volume24h: number; // 24h trading volume in dollars
  url: string;
  category: string;
  lastUpdated: string; // ISO timestamp
  numericId?: string;          // Polymarket numeric ID for live price polling
  oneDayPriceChange?: number;  // 24h price delta for YES (e.g. 0.05 = +5%)
  endDate?: string;            // ISO date string (e.g. "2026-03-31")
  eventTicker?: string;        // Kalshi event_ticker: shared key across all outcome markets in the same event
}

export interface MarketMatch {
  market: Market;
  confidence: number; // 0.0 to 1.0
  matchedKeywords: string[];
}

export interface CanonicalEvent {
  id: string;
  title: string;
  normalizedTitle: string;
  category?: string;
  markets: {
    polymarket?: Market;
    kalshi?: Market;
  };
}

export interface ArbitrageOpportunity {
  polymarket: Market;
  kalshi: Market;
  spread: number; // Net covered-position edge after modeled costs
  rawPriceGap?: number; // Difference between indicative YES prices
  costPerBundle?: number; // Cost to buy YES on one venue and NO on the other
  feesAndSlippage?: number; // Conservative cost buffer used in the calculation
  profitPotential: number; // Expected profit per $1 payout bundle
  direction: 'buy_poly_sell_kalshi' | 'buy_kalshi_sell_poly';
  legs?: {
    yes: { platform: 'polymarket' | 'kalshi'; price: number };
    no: { platform: 'polymarket' | 'kalshi'; price: number };
  };
  confidence: number; // 0-1, how confident we are this is the same event
  matchReason: string; // Why we think these are the same market
}

/**
 * A single position within an intra-event arbitrage group.
 */
export interface GroupArbitrageLeg {
  market: Market;
  /** BUY = buy YES; SELL = sell YES (collect premium). */
  action: 'BUY' | 'SELL';
  price: number; // Executable price used in the calculation
}

/**
 * Intra-event arbitrage: multiple markets that represent mutually-exclusive
 * outcomes of the same event (e.g. Kalshi range buckets, or the
 * two sides of a head-to-head match) but whose prices do not sum to 1.
 *
 * This is not the same as ArbitrageOpportunity (cross-platform, two venues).
 */
export interface GroupArbitrageOpportunity {
  // Shared event key = the Kalshi event_ticker.
  eventKey: string;
  platform: 'kalshi' | 'polymarket';
  type: 'RANGE_SUM' | 'BINARY_COMPLEMENT' | 'MATCH_OUTCOME';
  action: 'BUY_ALL' | 'SELL_ALL';
  legs: GroupArbitrageLeg[];
  priceSum: number;
  // Net profit edge 
  edge: number;
  spread: number;
  feesAndSlippage: number;
  profitPotential: number;
  marketCount: number;
}
