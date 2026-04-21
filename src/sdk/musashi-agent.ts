/**
 * Musashi Agent SDK
 *
 * A TypeScript/JavaScript client library for building AI trading bots
 * that integrate with Musashi's prediction market intelligence API.
 *
 * @example
 * ```typescript
 * import { MusashiAgent } from './musashi-agent';
 *
 * const agent = new MusashiAgent();
 *
 * // Analyze a tweet
 * const signal = await agent.analyzeText('Bitcoin just hit $100k!');
 * if (signal.urgency === 'critical') {
 *   console.log('TRADE NOW:', signal.suggested_action);
 * }
 *
 * // Get arbitrage opportunities
 * const arbs = await agent.getArbitrage({ minSpread: 0.05 });
 * arbs.forEach(arb => {
 *   console.log(`${arb.spread * 100}% spread - Profit: ${arb.profitPotential * 100}%`);
 * });
 * ```
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type SignalType = 'arbitrage' | 'news_event' | 'sentiment_shift' | 'user_interest';
export type UrgencyLevel = 'low' | 'medium' | 'high' | 'critical';
export type Direction = 'YES' | 'NO' | 'HOLD';
export type Platform = 'polymarket' | 'kalshi';

// Import feed types
export type { AnalyzedTweet, TwitterAccount, GetFeedOptions } from '../types/feed';

export interface Market {
  id: string;
  platform: Platform;
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

export interface SuggestedAction {
  direction: Direction;
  confidence: number;
  edge: number;
  reasoning: string;
}

export interface Sentiment {
  sentiment: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
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

export interface MarketMover {
  market: Market;
  priceChange1h: number;
  previousPrice: number;
  currentPrice: number;
  direction: 'up' | 'down';
  timestamp: number;
}

export interface Signal {
  event_id: string;
  signal_type: SignalType;
  urgency: UrgencyLevel;
  matches: MarketMatch[];
  suggested_action?: SuggestedAction;
  sentiment?: Sentiment;
  arbitrage?: ArbitrageOpportunity;
  metadata: {
    processing_time_ms: number;
    tweet_text?: string;
  };
}

export interface AnalyzeTextOptions {
  minConfidence?: number;
  maxResults?: number;
}

export interface GetArbitrageOptions {
  minSpread?: number;
  minConfidence?: number;
  limit?: number;
  category?: string;
}

export interface GetMoversOptions {
  timeframe?: '1h' | '6h' | '24h';
  minChange?: number;
  limit?: number;
  category?: string;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'down';
  timestamp: string;
  services: {
    polymarket: { status: string; markets?: number };
    kalshi: { status: string; markets?: number };
  };
}

export interface FeedStats {
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
  };
}

// ─── Main Agent Class ─────────────────────────────────────────────────────────

export class MusashiAgent {
  private baseUrl: string;
  private apiKey?: string;
  private previewBypassSecret?: string;

  /**
   * Create a new Musashi Agent
   *
   * @param baseUrl - API base URL (default: https://musashi-api.vercel.app)
   * @param apiKey - Optional API key for authenticated requests
   */
  constructor(
    baseUrl: string = process.env.MUSASHI_API_BASE_URL || 'https://musashi-api.vercel.app',
    apiKey?: string
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = apiKey;
    this.previewBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  }

  private buildHeaders(extraHeaders?: HeadersInit): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((extraHeaders as Record<string, string>) || {}),
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    if (this.previewBypassSecret) {
      headers['x-vercel-protection-bypass'] = this.previewBypassSecret;
      headers['x-vercel-set-bypass-cookie'] = 'true';
    }

    return headers;
  }

  /**
   * Analyze text and return trading signal with matched markets
   *
   * @example
   * ```typescript
   * const signal = await agent.analyzeText('Bitcoin mooning! $100k inevitable!');
   *
   * if (signal.urgency === 'critical') {
   *   const action = signal.suggested_action;
   *   console.log(`TRADE ${action.direction} with ${action.confidence * 100}% confidence`);
   *   console.log(`Edge: ${action.edge * 100}%`);
   * }
   * ```
   */
  async analyzeText(text: string, options?: AnalyzeTextOptions): Promise<Signal> {
    const response = await this.request('/api/analyze-text', {
      method: 'POST',
      body: JSON.stringify({
        text,
        minConfidence: options?.minConfidence,
        maxResults: options?.maxResults,
      }),
    });

    if (!response.success) {
      throw new Error(response.error || 'Analysis failed');
    }

    return {
      event_id: response.event_id,
      signal_type: response.signal_type,
      urgency: response.urgency,
      matches: response.data.markets,
      suggested_action: response.data.suggested_action,
      sentiment: response.data.sentiment,
      arbitrage: response.data.arbitrage,
      metadata: response.data.metadata,
    };
  }

  /**
   * Get cross-platform arbitrage opportunities
   *
   * @example
   * ```typescript
   * const arbs = await agent.getArbitrage({ minSpread: 0.05, limit: 10 });
   *
   * for (const arb of arbs) {
   *   console.log(`${arb.spread * 100}% spread on ${arb.polymarket.title}`);
   *   console.log(`Buy on ${arb.direction.includes('poly') ? 'Polymarket' : 'Kalshi'}`);
   *   console.log(`Expected profit: ${arb.profitPotential * 100}%`);
   * }
   * ```
   */
  async getArbitrage(options?: GetArbitrageOptions): Promise<ArbitrageOpportunity[]> {
    const params = new URLSearchParams();
    if (options?.minSpread) params.set('minSpread', options.minSpread.toString());
    if (options?.minConfidence) params.set('minConfidence', options.minConfidence.toString());
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.category) params.set('category', options.category);

    const response = await this.request(`/api/markets/arbitrage?${params.toString()}`);

    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch arbitrage');
    }

    return response.data.opportunities;
  }

  /**
   * Get markets with significant price changes
   *
   * @example
   * ```typescript
   * const movers = await agent.getMovers({ timeframe: '1h', minChange: 0.05 });
   *
   * for (const mover of movers) {
   *   const direction = mover.direction === 'up' ? '↑' : '↓';
   *   console.log(`${direction} ${mover.market.title}: ${mover.priceChange1h * 100}%`);
   * }
   * ```
   */
  async getMovers(options?: GetMoversOptions): Promise<MarketMover[]> {
    const params = new URLSearchParams();
    if (options?.timeframe) params.set('timeframe', options.timeframe);
    if (options?.minChange) params.set('minChange', options.minChange.toString());
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.category) params.set('category', options.category);

    const response = await this.request(`/api/markets/movers?${params.toString()}`);

    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch movers');
    }

    return response.data.movers;
  }

  /**
   * Check API health status
   *
   * @example
   * ```typescript
   * const health = await agent.checkHealth();
   * console.log(`API Status: ${health.status}`);
   * console.log(`Polymarket: ${health.services.polymarket.status}`);
   * console.log(`Kalshi: ${health.services.kalshi.status}`);
   * ```
   */
  async checkHealth(): Promise<HealthStatus> {
    // Don't use this.request() because it throws on 503 (degraded status)
    const url = `${this.baseUrl}/api/health`;
    const headers = this.buildHeaders();

    const res = await fetch(url, { headers });
    const response = await res.json();

    // Health endpoint returns { success: true, data: { status, timestamp, services } }
    if (response.success && response.data) {
      return {
        status: response.data.status,
        timestamp: response.data.timestamp,
        services: response.data.services,
      };
    }

    // Fallback for unexpected response shape
    throw new Error('Invalid health response format');
  }

  /**
   * Monitor text stream and invoke callback on each signal
   * Polls the API at regular intervals
   *
   * @param callback - Function to call with each signal
   * @param intervalMs - Polling interval in milliseconds (default: 30000 = 30s)
   * @returns Unsubscribe function to stop monitoring
   *
   * @example
   * ```typescript
   * const unsubscribe = agent.onSignal(
   *   (signal) => {
   *     if (signal.urgency === 'critical') {
   *       console.log('CRITICAL SIGNAL:', signal.signal_type);
   *       executeTrade(signal.suggested_action);
   *     }
   *   },
   *   30000 // Check every 30 seconds
   * );
   *
   * // Later: stop monitoring
   * unsubscribe();
   * ```
   */
  onSignal(
    textSource: () => string,
    callback: (signal: Signal) => void,
    intervalMs: number = 30000
  ): () => void {
    const interval = setInterval(async () => {
      try {
        const text = textSource();
        if (text) {
          const signal = await this.analyzeText(text);
          callback(signal);
        }
      } catch (error) {
        console.error('[Musashi Agent] Signal monitoring error:', error);
      }
    }, intervalMs);

    return () => clearInterval(interval);
  }

  /**
   * Monitor arbitrage opportunities and invoke callback
   * Polls the API at regular intervals
   *
   * @param callback - Function to call with arbitrage opportunities
   * @param options - Arbitrage filter options
   * @param intervalMs - Polling interval in milliseconds (default: 60000 = 1 min)
   * @returns Unsubscribe function to stop monitoring
   *
   * @example
   * ```typescript
   * const unsubscribe = agent.onArbitrage(
   *   (opportunities) => {
   *     for (const arb of opportunities) {
   *       if (arb.spread > 0.05) {
   *         console.log(`Arbitrage detected: ${arb.spread * 100}%`);
   *         executeArbitrageTrade(arb);
   *       }
   *     }
   *   },
   *   { minSpread: 0.03 },
   *   60000 // Check every minute
   * );
   *
   * // Later: stop monitoring
   * unsubscribe();
   * ```
   */
  onArbitrage(
    callback: (opportunities: ArbitrageOpportunity[]) => void,
    options?: GetArbitrageOptions,
    intervalMs: number = 60000
  ): () => void {
    const interval = setInterval(async () => {
      try {
        const opportunities = await this.getArbitrage(options);
        if (opportunities.length > 0) {
          callback(opportunities);
        }
      } catch (error) {
        console.error('[Musashi Agent] Arbitrage monitoring error:', error);
      }
    }, intervalMs);

    return () => clearInterval(interval);
  }

  /**
   * Monitor market movers and invoke callback
   * Polls the API at regular intervals
   *
   * @param callback - Function to call with market movers
   * @param options - Movers filter options
   * @param intervalMs - Polling interval in milliseconds (default: 120000 = 2 min)
   * @returns Unsubscribe function to stop monitoring
   *
   * @example
   * ```typescript
   * const unsubscribe = agent.onMovers(
   *   (movers) => {
   *     for (const mover of movers) {
   *       if (Math.abs(mover.priceChange1h) > 0.1) {
   *         console.log(`Big move: ${mover.market.title}`);
   *         handlePriceMovement(mover);
   *       }
   *     }
   *   },
   *   { minChange: 0.05, timeframe: '1h' },
   *   120000 // Check every 2 minutes
   * );
   *
   * // Later: stop monitoring
   * unsubscribe();
   * ```
   */
  onMovers(
    callback: (movers: MarketMover[]) => void,
    options?: GetMoversOptions,
    intervalMs: number = 120000
  ): () => void {
    const interval = setInterval(async () => {
      try {
        const movers = await this.getMovers(options);
        if (movers.length > 0) {
          callback(movers);
        }
      } catch (error) {
        console.error('[Musashi Agent] Movers monitoring error:', error);
      }
    }, intervalMs);

    return () => clearInterval(interval);
  }

  /**
   * Get analyzed tweet feed
   *
   * @param options - Feed filter options
   * @returns Array of analyzed tweets
   *
   * @example
   * ```typescript
   * const feed = await agent.getFeed({
   *   limit: 20,
   *   category: 'crypto',
   *   minUrgency: 'high'
   * });
   *
   * for (const tweet of feed) {
   *   console.log(`@${tweet.tweet.author}: ${tweet.tweet.text}`);
   *   console.log(`Matches: ${tweet.matches.length}, Urgency: ${tweet.urgency}`);
   * }
   * ```
   */
  async getFeed(options?: any): Promise<any[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.category) params.set('category', options.category);
    if (options?.minUrgency) params.set('minUrgency', options.minUrgency);
    if (options?.since) params.set('since', options.since);
    if (options?.cursor) params.set('cursor', options.cursor);

    const response = await this.request(`/api/feed?${params.toString()}`);

    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch feed');
    }

    return response.data.tweets;
  }

  /**
   * Get feed statistics
   *
   * @returns Feed statistics
   *
   * @example
   * ```typescript
   * const stats = await agent.getFeedStats();
   * console.log(`Tweets in last hour: ${stats.tweets.last_1h}`);
   * console.log(`Top market: ${stats.top_markets[0].market.title}`);
   * ```
   */
  async getFeedStats(): Promise<FeedStats> {
    const response = await this.request('/api/feed/stats');

    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch stats');
    }

    return response.data;
  }

  /**
   * Get curated Twitter account list
   *
   * @returns Array of monitored accounts
   *
   * @example
   * ```typescript
   * const accounts = await agent.getFeedAccounts();
   * console.log(`Monitoring ${accounts.length} accounts`);
   * console.log(`High priority: ${accounts.filter(a => a.priority === 'high').length}`);
   * ```
   */
  async getFeedAccounts(): Promise<any[]> {
    const response = await this.request('/api/feed/accounts');

    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch accounts');
    }

    return response.data.accounts;
  }

  /**
   * Monitor feed with polling and invoke callback on new tweets
   *
   * Automatically tracks the last seen timestamp and only calls callback
   * when new tweets are available. Polls every intervalMs.
   *
   * @param callback - Function to call with new tweets
   * @param options - Feed filter options
   * @param intervalMs - Polling interval in milliseconds (default: 30000 = 30s)
   * @returns Unsubscribe function to stop monitoring
   *
   * @example
   * ```typescript
   * const unsubscribe = agent.onFeed(
   *   (tweets) => {
   *     for (const tweet of tweets) {
   *       if (tweet.urgency === 'critical') {
   *         console.log(`CRITICAL: @${tweet.tweet.author}: ${tweet.tweet.text}`);
   *         executeTrade(tweet.suggested_action);
   *       }
   *     }
   *   },
   *   { category: 'crypto', minUrgency: 'high' },
   *   30000 // Poll every 30 seconds
   * );
   *
   * // Later: stop monitoring
   * unsubscribe();
   * ```
   */
  onFeed(
    callback: (tweets: any[]) => void,
    options?: any,
    intervalMs: number = 30000
  ): () => void {
    let lastSeen: string | undefined = new Date().toISOString();

    const interval = setInterval(async () => {
      try {
        const tweets = await this.getFeed({
          ...options,
          since: lastSeen,
          limit: options?.limit || 100, // Fetch up to 100 new tweets
        });

        if (tweets.length > 0) {
          // Update lastSeen to most recent tweet
          const newestTimestamp = tweets.reduce((latest, tweet) => {
            const tweetTime = new Date(tweet.tweet.created_at);
            return tweetTime > new Date(latest) ? tweet.tweet.created_at : latest;
          }, lastSeen || new Date(0).toISOString());

          lastSeen = newestTimestamp;

          // Call callback with new tweets
          callback(tweets);
        }
      } catch (error) {
        console.error('[Musashi Agent] Feed monitoring error:', error);
      }
    }, intervalMs);

    return () => clearInterval(interval);
  }

  /**
   * Set a custom API key for authenticated requests
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /**
   * Set a custom API base URL
   */
  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Internal request helper
   */
  private async request(path: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildHeaders(options.headers);

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }
}

// ─── Standalone Helper Functions ─────────────────────────────────────────────

/**
 * Quick helper to analyze a single text without creating an agent instance
 */
export async function analyzeText(text: string, options?: AnalyzeTextOptions): Promise<Signal> {
  const agent = new MusashiAgent();
  return agent.analyzeText(text, options);
}

/**
 * Quick helper to get arbitrage opportunities without creating an agent instance
 */
export async function getArbitrage(options?: GetArbitrageOptions): Promise<ArbitrageOpportunity[]> {
  const agent = new MusashiAgent();
  return agent.getArbitrage(options);
}

/**
 * Quick helper to get market movers without creating an agent instance
 */
export async function getMovers(options?: GetMoversOptions): Promise<MarketMover[]> {
  const agent = new MusashiAgent();
  return agent.getMovers(options);
}

// Export default instance for convenience
export default new MusashiAgent();
