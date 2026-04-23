import axios from 'axios';

const API_BASE_URL = '/api';

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
    id: string;
    text: string;
    created_at: string;
    author: string;
    matches: MarketMatch[];
    urgency: string;
  }>;
  count: number;
  timestamp: string;
}

export const analyzeText = (text: string, minConfidence = 0.3) =>
  unwrapAnalyzeText(apiClient.post<AnalyzeTextResponse>('/analyze-text', { text, minConfidence }));

export const getArbitrage = (minSpread = 0.03) =>
  unwrapApiData<ArbitrageResponse>(apiClient.get(`/markets/arbitrage?minSpread=${minSpread}`));

export const getMovers = () =>
  unwrapApiData(apiClient.get('/markets/movers'));

export const getFeed = (limit = 20) =>
  unwrapApiData<FeedData>(apiClient.get(`/feed?limit=${limit}`));

export const getHealth = () =>
  unwrapApiData<HealthStatus>(apiClient.get('/health'));
