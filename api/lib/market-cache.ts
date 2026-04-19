/**
 * Shared market cache for Vercel API endpoints
 * Prevents duplicate market fetching across endpoints
 * Stage 0: Added per-source tracking and freshness metadata
 */

import { Market, ArbitrageOpportunity } from '../../src/types/market';
import { fetchPolymarkets } from '../../src/api/polymarket-client';
import { fetchKalshiMarkets } from '../../src/api/kalshi-client';
import { detectArbitrage } from '../../src/api/arbitrage-detector';
import { FreshnessMetadata, SourceStatus } from './types';
import { kv } from '@vercel/kv';

// In-memory cache for markets
// Default: 20 seconds (configurable via MARKET_CACHE_TTL_SECONDS env var)
let cachedMarkets: Market[] = [];
let cacheTimestamp = 0;
const CACHE_TTL_MS = (parseInt(process.env.MARKET_CACHE_TTL_SECONDS || '20', 10)) * 1000;

// In-memory cache for arbitrage opportunities
// Default: 15 seconds (configurable via ARBITRAGE_CACHE_TTL_SECONDS env var)
let cachedArbitrage: ArbitrageOpportunity[] = [];
let arbCacheTimestamp = 0;
const ARB_CACHE_TTL_MS = (parseInt(process.env.ARBITRAGE_CACHE_TTL_SECONDS || '15', 10)) * 1000;

// Refresh Guards
let marketsRefreshPromise: Promise<Market[]> | null = null;
let arbRefreshPromise: Promise<ArbitrageOpportunity[]> | null = null;

// Stage 0: Per-source tracking for freshness metadata
let polyTimestamp = 0;
let kalshiTimestamp = 0;
let polyMarketCount = 0;
let kalshiMarketCount = 0;
let polyError: string | null = null;
let kalshiError: string | null = null;

// Stage 0 Session 2: Per-source timeout (5 seconds)
const SOURCE_TIMEOUT_MS = 5000;

// Constants for fetch limits
const POLYMARKET_TARGET_COUNT = 100;
const POLYMARKET_MAX_PAGES = 3;
const KALSHI_TARGET_COUNT = 100;
const KALSHI_MAX_PAGES = 3;

const LOCK_KEY = 'arb_recompute_lock';
const LOCK_TTL = 20000;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  sourceName: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${sourceName} request timeout after ${timeoutMs}ms`)),
        timeoutMs
      )
    ),
  ]);
}

/**
 * Fetch and cache markets from both platforms
 * Shared across all API endpoints to avoid duplicate fetches
 * Stage 0: Tracks per-source timestamps and errors for freshness metadata
 */
export async function getMarkets(): Promise<Market[]> {
  const now = Date.now();

  // Return cached if fresh
  if (cachedMarkets.length > 0 && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedMarkets;
  }

  // If a refresh is already in progress, return the existing promise
  if (marketsRefreshPromise) {
    return marketsRefreshPromise;
  }

  // Fetch fresh markets with refresh guard
  marketsRefreshPromise = (async () => {
    try {
      console.log(`[Market Cache] Fetching fresh markets... (TTL: ${CACHE_TTL_MS}ms)`);
      
      const [polyResult, kalshiResult] = await Promise.allSettled([
        withTimeout(
          fetchPolymarkets(POLYMARKET_TARGET_COUNT, POLYMARKET_MAX_PAGES),
          SOURCE_TIMEOUT_MS,
          'Polymarket'
        ),
        withTimeout(
          fetchKalshiMarkets(KALSHI_TARGET_COUNT, KALSHI_MAX_PAGES),
          SOURCE_TIMEOUT_MS,
          'Kalshi'
        ),
      ]);

      const currentFetchTime = Date.now();

      if (polyResult.status === 'fulfilled') {
        polyTimestamp = currentFetchTime;
        polyMarketCount = polyResult.value.length;
        polyError = null;
      } else {
        polyError = polyResult.reason?.message || 'Failed to fetch Polymarket';
      }

      if (kalshiResult.status === 'fulfilled') {
        kalshiTimestamp = currentFetchTime;
        kalshiMarketCount = kalshiResult.value.length;
        kalshiError = null;
      } else {
        kalshiError = kalshiResult.reason?.message || 'Failed to fetch Kalshi';
      }

      const polyMarkets = polyResult.status === 'fulfilled' ? polyResult.value : [];
      const kalshiMarkets = kalshiResult.status === 'fulfilled' ? kalshiResult.value : [];

      cachedMarkets = [...polyMarkets, ...kalshiMarkets];
      cacheTimestamp = currentFetchTime;
      
      return cachedMarkets;
    } finally {
      marketsRefreshPromise = null;
    }
  })();

  return marketsRefreshPromise;
}

/**
 * Stage 0: Get freshness metadata for current cached data
 * Tells bots/agents how old the data is and which sources are healthy
 */
export function getMarketMetadata(): FreshnessMetadata {
  const now = Date.now();
  const oldestTimestamp = Math.min(
    polyTimestamp || cacheTimestamp,
    kalshiTimestamp || cacheTimestamp
  );

  const dataAgeMs = now - oldestTimestamp;
  const dataAgeSeconds = Math.floor(dataAgeMs / 1000);

  return {
    data_age_seconds: dataAgeSeconds,
    fetched_at: new Date(oldestTimestamp).toISOString(),
    sources: {
      polymarket: {
        available: polyError === null && polyMarketCount > 0,
        last_successful_fetch: polyTimestamp > 0 ? new Date(polyTimestamp).toISOString() : null,
        error: polyError || undefined,
        market_count: polyMarketCount,
      },
      kalshi: {
        available: kalshiError === null && kalshiMarketCount > 0,
        last_successful_fetch: kalshiTimestamp > 0 ? new Date(kalshiTimestamp).toISOString() : null,
        error: kalshiError || undefined,
        market_count: kalshiMarketCount,
      },
    },
  };
}

/**
 * Get cached arbitrage opportunities
 *
 * Caches with low minNetEdgeBps (10) and filters client-side.
 * This allows different callers to request different thresholds
 * without recomputing the expensive O(n×m) scan.
 *
 * @param minNetEdgeBps - Minimum net edge in basis points (default: 50)
 * @returns Arbitrage opportunities filtered by minNetEdgeBps
 */
export async function getArbitrage(minNetEdgeBps: number = 50): Promise<ArbitrageOpportunity[]> {
  const now = Date.now();
  
  // Distributed Lock Pattern
  if (cachedArbitrage.length === 0 || (now - arbCacheTimestamp) >= ARB_CACHE_TTL_MS) {
    const instanceId = Math.random().toString(36);
    const locked = await kv.set(LOCK_KEY, instanceId, { nx: true, ex: 30 });

    if (locked) {
      try {
        const markets = await getMarkets();
        cachedArbitrage = detectArbitrage(markets, 10);
        arbCacheTimestamp = Date.now();
        // Sync to Redis for other lambdas
        await kv.set('global_arb_cache', cachedArbitrage, { ex: 60 });
      } finally {
        await kv.del(LOCK_KEY);
      }
    } else {
      // If locked by another instance try to read their global cache
      const remote = await kv.get<ArbitrageOpportunity[]>('global_arb_cache');
      if (remote) return remote.filter(a => a.netEdgeBps >= minNetEdgeBps);
    }
  }

  return cachedArbitrage.filter(arb => arb.netEdgeBps >= minNetEdgeBps);
}