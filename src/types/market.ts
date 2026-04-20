// Market data types

export interface Market {
  id: string;
  platform: 'kalshi' | 'polymarket';
  title: string;
  description: string;
  keywords: string[];
  yesPrice: number; // 0.0 to 1.0 (0.65 = 65%)
  noPrice: number;  // 0.0 to 1.0 (0.35 = 35%)
  volume24h: number; // 24h trading volume in dollars
  url: string;
  category: string;
  lastUpdated: string; // ISO timestamp
  numericId?: string;          // Polymarket numeric ID for live price polling
  oneDayPriceChange?: number;  // 24h price delta for YES (e.g. 0.05 = +5%)
  endDate?: string;            // ISO date string (e.g. "2026-03-31")
  is_anomalous?: boolean;      // True if price moved 3+ std devs in last 10 min
}

export interface MarketMatch {
  market: Market;
  confidence: number; // 0.0 to 1.0
  matchedKeywords: string[];
}

export interface ArbitrageOpportunity {
  polymarket: Market;
  kalshi: Market;
  spread: number;             // Raw absolute price difference (e.g., 0.05 = 5%)
  net_spread: number;         // Liquidity-adjusted net executable spread
  liquidity_penalty: number;  // Estimated friction cost subtracted from spread
  profitPotential: number;    // Expected profit per $1 invested (net of liquidity)
  direction: 'buy_poly_sell_kalshi' | 'buy_kalshi_sell_poly';
  confidence: number;         // 0-1, how confident we are this is the same event
  matchReason: string;        // Why we think these are the same market
  is_directionally_opposed?: boolean; // True if titles suggest opposite outcomes
}

// Kelly Criterion position sizing result
export type VolatilityRegime = 'low' | 'normal' | 'high';
export type RiskLevel = 'minimal' | 'moderate' | 'elevated';

export interface PositionSize {
  fraction: number;        // 0-1, recommended fraction of capital to deploy
  kelly_full: number;      // Full Kelly fraction before scaling
  kelly_quarter: number;   // Quarter-Kelly before vol scaling
  rationale: string;       // Human-readable explanation
  risk_level: RiskLevel;
  vol_regime: VolatilityRegime;
}
