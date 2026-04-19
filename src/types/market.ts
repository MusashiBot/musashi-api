// Market data types

export interface Market {
  id: string;
  platform: 'kalshi' | 'polymarket';
  title: string;
  category: string;
  yesPrice: number; // 0.0 to 1.0 (0.65 = 65%)
  yesBid?: number; 
  yesAsk?: number;
  volume24h: number; // 24h trading volume in dollars
  liquidity?: number;
  endDate?: string; // ISO date string (e.g. "2026-03-31")
  keywords: string[];
  lastUpdated?: string; // ISO timestamp
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
  buyVenue: string;
  sellVenue: string;
  netEdgeBps: number;
  grossEdgeBps: number;
  matchConfidence: {
    score: number;
    titleSimilarity: number;
    keywordOverlap: number;
    categoryAligned: boolean;
    expiryAligned: boolean;
  };
  sourceTimestamps: {
    polymarket: string | null;
    kalshi: string | null;
  };
  expiryDeltaMinutes: number | null;
  asOfTs: string;
  liquidityScore: number;

}
