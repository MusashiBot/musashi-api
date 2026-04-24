import axios from 'axios';

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
});

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  error?: string;
}

async function unwrapApiData<T>(request: Promise<{ data: ApiEnvelope<T> }>): Promise<T> {
  const response = await request;
  if (!response.data.success) {
    throw new Error(response.data.error || 'API request failed');
  }
  return response.data.data;
}

async function unwrapAnalyzeText(request: Promise<{ data: AnalyzeTextResponse }>): Promise<AnalyzeTextResponse> {
  const response = await request;
  if (!response.data.success) {
    throw new Error(response.data.error || 'Text analysis failed');
  }
  return response.data;
}

export interface Market {
  id: string;
  platform: 'polymarket' | 'kalshi';
  title: string;
  description: string;
  yesPrice: number;
  noPrice: number;
  volume24h: number;
  url: string;
  category: string;
  lastUpdated: string;
}

export interface MarketMatch {
  market: Market;
  confidence: number;
  matchedKeywords: string[];
}

export interface ArbitrageOpportunity {
  polymarket: Market;
  kalshi: Market;
  spread: number;
  profitPotential: number;
  direction: 'buy_poly_sell_kalshi' | 'buy_kalshi_sell_poly';
  confidence: number;
  matchReason: string;
}

export interface Signal {
  event_id: string;
  signal_type: 'arbitrage' | 'news_event' | 'sentiment_shift' | 'user_interest';
  urgency: 'low' | 'medium' | 'high' | 'critical';
  matches: MarketMatch[];
  suggested_action?: {
    direction: 'YES' | 'NO' | 'HOLD';
    confidence: number;
    edge: number;
    reasoning: string;
  };
  sentiment?: {
    sentiment: 'bullish' | 'bearish' | 'neutral';
    confidence: number;
  };
  metadata: {
    processing_time_ms: number;
  };
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'down';
  timestamp: string;
  services: {
    polymarket: { status: string; markets?: number };
    kalshi: { status: string; markets?: number };
  };
  response_time_ms: number;
}

export interface ArbitrageResponse {
  opportunities: ArbitrageOpportunity[];
  count: number;
  timestamp: string;
  filters: {
    minSpread: number;
    minConfidence: number;
    limit: number;
    category: string | null;
  };
  metadata: {
    processing_time_ms: number;
    markets_analyzed: number;
    polymarket_count: number;
    kalshi_count: number;
  };
}

export interface MarketsResponse {
  markets: Market[];
  count: number;
  timestamp: string;
  filters: {
    limit: number;
    platform: Market['platform'] | null;
    category: string | null;
    sort: 'volume' | 'updated' | 'price';
  };
  metadata: {
    processing_time_ms: number;
    markets_analyzed: number;
    data_age_seconds: number;
    fetched_at: string;
    sources: {
      polymarket: {
        available: boolean;
        last_successful_fetch: string | null;
        error?: string;
        market_count: number;
      };
      kalshi: {
        available: boolean;
        last_successful_fetch: string | null;
        error?: string;
        market_count: number;
      };
    };
  };
}

export interface AnalyzeTextData {
  markets: MarketMatch[];
  matchCount: number;
  timestamp: string;
  suggested_action?: Signal['suggested_action'];
  sentiment?: Signal['sentiment'];
  arbitrage?: ArbitrageOpportunity;
  metadata: {
    processing_time_ms: number;
    sources_checked: number;
    markets_analyzed: number;
    model_version: string;
  };
}

export interface AnalyzeTextResponse {
  event_id: string;
  signal_type: Signal['signal_type'];
  urgency: Signal['urgency'];
  success: boolean;
  data: AnalyzeTextData;
  error?: string;
}

export interface FeedData {
  tweets: Array<{
    tweet: {
      id: string;
      text: string;
      created_at: string;
      author: string;
    };
    matches: MarketMatch[];
    urgency: string;
  }>;
  count: number;
  timestamp: string;
}

export interface MarketMover {
  market: Market;
  priceChange1h: number;
  previousPrice: number;
  currentPrice: number;
  direction: 'up' | 'down';
  timestamp: number;
}

export interface MoversResponse {
  movers: MarketMover[];
  count: number;
  timestamp: string;
  filters: {
    minChange: number;
    limit: number;
    category: string | null;
  };
  metadata: {
    processing_time_ms: number;
    markets_analyzed: number;
    markets_tracked: number;
    storage: string;
    history_retention: string;
  };
}

export interface FeedStatsResponse {
  timestamp: string;
  last_collection: string;
  tweets: {
    last_1h: number;
    last_6h: number;
    last_24h: number;
  };
  by_category: Record<string, number>;
  by_urgency: Record<string, number>;
  top_markets: Array<{
    market: Market;
    mention_count: number;
  }>;
  metadata: {
    processing_time_ms: number;
    cached?: boolean;
  };
}

export interface FeedAccountsResponse {
  accounts: Array<{
    username: string;
    category: string;
    priority: 'high' | 'medium';
    description: string;
  }>;
  count: number;
  by_category: Record<string, number>;
  by_priority: {
    high: number;
    medium: number;
  };
  metadata: {
    processing_time_ms: number;
  };
}

export type WalletActivityType =
  | 'trade'
  | 'position_opened'
  | 'position_increased'
  | 'position_reduced'
  | 'position_closed'
  | 'redeemed'
  | 'unknown';

export interface WalletActivity {
  wallet: string;
  activityType: WalletActivityType;
  platform: 'polymarket';
  marketId?: string;
  conditionId?: string;
  tokenId?: string;
  marketTitle?: string;
  marketSlug?: string;
  outcome?: string;
  side?: 'buy' | 'sell';
  price?: number;
  size?: number;
  value?: number;
  timestamp: string;
  url?: string;
}

export interface WalletPosition {
  wallet: string;
  platform: 'polymarket';
  marketId?: string;
  conditionId?: string;
  tokenId?: string;
  marketTitle: string;
  marketSlug?: string;
  outcome: string;
  quantity: number;
  averagePrice?: number;
  currentPrice?: number;
  currentValue?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  url?: string;
  updatedAt: string;
}

export interface WalletPositionsResponse {
  positions: WalletPosition[];
  count: number;
}

export interface WalletActivityResponse {
  activity: WalletActivity[];
  count: number;
}

export const analyzeText = (text: string, minConfidence = 0.3) =>
  unwrapAnalyzeText(apiClient.post<AnalyzeTextResponse>('/analyze-text', { text, minConfidence }));

export const getMarkets = (limit = 8, sort: MarketsResponse['filters']['sort'] = 'volume') =>
  unwrapApiData<MarketsResponse>(apiClient.get(`/markets?limit=${limit}&sort=${sort}`));

export const getArbitrage = (minSpread = 0.03) =>
  unwrapApiData<ArbitrageResponse>(apiClient.get(`/markets/arbitrage?minSpread=${minSpread}`));

export const getMovers = (minChange = 0.05, limit = 5) =>
  unwrapApiData<MoversResponse>(apiClient.get(`/markets/movers?minChange=${minChange}&limit=${limit}`));

export const getFeed = (limit = 20) =>
  unwrapApiData<FeedData>(apiClient.get(`/feed?limit=${limit}`));

export const getFeedStats = () =>
  unwrapApiData<FeedStatsResponse>(apiClient.get('/feed/stats'));

export const getFeedAccounts = () =>
  unwrapApiData<FeedAccountsResponse>(apiClient.get('/feed/accounts'));

export const getWalletPositions = (wallet: string, limit = 20, minValue = 0) =>
  unwrapApiData<WalletPositionsResponse>(
    apiClient.get(`/wallet/positions?wallet=${encodeURIComponent(wallet)}&limit=${limit}&minValue=${minValue}`)
  );

export const getWalletActivity = (wallet: string, limit = 20) =>
  unwrapApiData<WalletActivityResponse>(
    apiClient.get(`/wallet/activity?wallet=${encodeURIComponent(wallet)}&limit=${limit}`)
  );

export const getHealth = () =>
  unwrapApiData<HealthStatus>(
    apiClient.get('/health', {
      validateStatus: status => (status >= 200 && status < 300) || status === 503,
    })
  );
