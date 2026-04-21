import axios from 'axios';

const API_BASE_URL = '/api';

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Types
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

// API functions
export const analyzeText = (text: string, minConfidence = 0.3) =>
  apiClient.post('/analyze-text', { text, minConfidence });

export const getArbitrage = (minSpread = 0.03) =>
  apiClient.get(`/markets/arbitrage?minSpread=${minSpread}`);

export const getMovers = () =>
  apiClient.get('/markets/movers');

export const getFeed = (limit = 20) =>
  apiClient.get(`/feed?limit=${limit}`);

export const getHealth = () =>
  apiClient.get('/health');
