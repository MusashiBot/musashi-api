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
}

export interface MarketMatch {
  market: Market;
  confidence: number; // 0.0 to 1.0
  matchedKeywords: string[];
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
