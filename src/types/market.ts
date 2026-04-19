// Market data types

export interface Market {
  id: string;
  platform: 'kalshi' | 'polymarket';
  title: string;
  description: string;
  keywords: string[];
  yesPrice: number; // 0.0 to 1.0 (0.65 = 65%)
  noPrice: number; // 0.0 to 1.0 (0.35 = 35%)
  volume24h: number; // 24h trading volume in dollars
  url: string;
  category: string;
  lastUpdated: string; // ISO timestamp
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  liquidity?: number;
  numericId?: string; // Polymarket numeric ID for live price polling
  oneDayPriceChange?: number; // 24h price delta for YES (e.g. 0.05 = +5%)
  endDate?: string; // ISO date string (e.g. "2026-03-31")
}

export interface MarketMatch {
  market: Market;
  confidence: number; // 0.0 to 1.0
  matchedKeywords: string[];
}

export interface ArbitrageOpportunity {
  polymarket: Market;
  kalshi: Market;
  buyPrice: number;
  sellPrice: number;
  buyVenue: 'polymarket' | 'kalshi';
  sellVenue: 'polymarket' | 'kalshi';
  netEdgeBps: number;
  grossEdgeBps: number;
  estimatedFeesBps: number;
  slippageBps: number;
  latencyRiskBps: number;
  confidence: number;
  matchReason: string;
  spread: number;
  profitPotential: number;
  direction: 'buy_poly_sell_kalshi' | 'buy_kalshi_sell_poly';
  matchConfidence: {
    score: number;
    titleSimilarity: number;
    keywordOverlap: number;
    categoryAligned: boolean;
    expiryAligned: boolean;
    liquidityAligned?: boolean;
  };
  sourceTimestamps: {
    polymarket: string | null;
    kalshi: string | null;
  };
  expiryDeltaMinutes: number | null;
  asOfTs: string;
  liquidityScore: number;

  /** Optional bundle-reporting fields (e.g. case-study script vs upstream-style payloads). */
  rawPriceGap?: number;
  costPerBundle?: number;
  feesAndSlippage?: number;
  legs?: {
    yes: { platform: 'polymarket' | 'kalshi'; price: number };
    no: { platform: 'polymarket' | 'kalshi'; price: number };
  };
}
