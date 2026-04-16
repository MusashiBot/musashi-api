// Musashi API Client
// Handles communication with the Musashi backend API

import { MarketMatch, ArbitrageOpportunity } from '../types/market';
import { SentimentResult } from '../analysis/sentiment-analyzer';

export type SignalType = 'arbitrage' | 'news_event' | 'sentiment_shift' | 'user_interest';
export type UrgencyLevel = 'low' | 'medium' | 'high' | 'critical';
export type Direction = 'YES' | 'NO' | 'HOLD';

export interface SuggestedAction {
  direction: Direction;
  confidence: number; // 0-1
  edge: number; // Expected profit edge
  reasoning: string;
}

// Enhanced API response with trading signals
export interface AnalyzeTextResponse {
  // Trading signal fields
  event_id: string;
  signal_type: SignalType;
  urgency: UrgencyLevel;

  // Original fields
  success: boolean;
  data?: {
    markets: MarketMatch[];
    matchCount: number;
    timestamp: string;
    // New enriched fields
    suggested_action?: SuggestedAction;
    sentiment?: SentimentResult;
    arbitrage?: ArbitrageOpportunity;
    metadata?: {
      processing_time_ms: number;
      sources_checked: number;
      markets_analyzed: number;
      model_version: string;
    };
  };
  error?: string;
}

export class MusashiApiClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor(
    baseUrl: string = process.env.MUSASHI_API_BASE_URL || 'https://musashi-api.vercel.app',
    apiKey?: string
  ) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  /**
   * Analyze text and return matching markets
   */
  async analyzeText(
    text: string,
    options?: {
      minConfidence?: number;
      maxResults?: number;
    }
  ): Promise<AnalyzeTextResponse> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${this.baseUrl}/api/analyze-text`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text,
          minConfidence: options?.minConfidence,
          maxResults: options?.maxResults,
        }),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      const result: AnalyzeTextResponse = await response.json();

      if (!result.success) {
        throw new Error(result.error || 'Unknown API error');
      }

      return result;
    } catch (error) {
      console.error('[Musashi API] Error analyzing text:', error);
      // Return empty array on error - extension will handle gracefully
      return [];
    }
  }

  /**
   * Set the API base URL (for testing different environments)
   */
  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  /**
   * Set API key for authenticated requests
   */
  setApiKey(key: string): void {
    this.apiKey = key;
  }
}

// Singleton instance with configurable base URL
// For local development: Use 'http://localhost:3000'
// For production: Use 'https://musashi-api.vercel.app' (or your deployed URL)
export const musashiApi = new MusashiApiClient(
  process.env.MUSASHI_API_BASE_URL || 'https://musashi-api.vercel.app'
);
