/**
 * Shared market cache for Vercel API endpoints
 * Prevents duplicate market fetching across endpoints
 * Stage 0: Added per-source tracking and freshness metadata
 */

import { Market, ArbitrageOpportunity } from '../../src/types/market';
import { fetchPolymarkets } from '../../src/api/polymarket-client';
import { fetchKalshiMarkets } from '../../src/api/kalshi-client';
import { detectArbitrage } from '../../src/api/arbitrage-detector';
import { detectIntraEventArbitrage } from '../../src/api/intra-event-arbitrage';
import type { GroupArbitrageOpportunity } from '../../src/types/market';
import { FreshnessMetadata, SourceStatus } from './types';

// In-memory cache for markets
// Default: 20 seconds (configurable via MARKET_CACHE_TTL_SECONDS env var)
let cachedMarkets: Market[] = [];
let cacheTimestamp = 0;
const CACHE_TTL_MS = (parseInt(process.env.MARKET_CACHE_TTL_SECONDS || '20', 10)) * 1000;

// Stage 0: Per-source tracking for freshness metadata
let polyTimestamp = 0;
let kalshiTimestamp = 0;
let polyMarketCount = 0;
let kalshiMarketCount = 0;
let polyError: string | null = null;
let kalshiError: string | null = null;

// In-memory cache for arbitrage opportunities
// Default: 20 seconds (configurable via ARBITRAGE_CACHE_TTL_SECONDS env var)
let cachedArbitrage: ArbitrageOpportunity[] = [];
let arbCacheTimestamp = 0;
const ARB_CACHE_TTL_MS = (parseInt(process.env.ARBITRAGE_CACHE_TTL_SECONDS || '20', 10)) * 1000;

// In-memory cache for intra-event (group) arbitrage opportunities
let cachedGroupArbitrage: GroupArbitrageOpportunity[] = [];
let groupArbCacheTimestamp = 0;

const POLYMARKET_TARGET_COUNT = parsePositiveInt(process.env.MUSASHI_POLYMARKET_TARGET_COUNT, 1200);
const POLYMARKET_MAX_PAGES = parsePositiveInt(process.env.MUSASHI_POLYMARKET_MAX_PAGES, 20);
const KALSHI_TARGET_COUNT = parsePositiveInt(process.env.MUSASHI_KALSHI_TARGET_COUNT, 1000);
const KALSHI_MAX_PAGES = parsePositiveInt(process.env.MUSASHI_KALSHI_MAX_PAGES, 20);

// Stage 0 Session 2: Per-source timeout (5 seconds)
const SOURCE_TIMEOUT_MS = 5000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Stage 0 Session 2: Wrap a promise with a timeout
 * If the promise doesn't resolve within timeoutMs, reject with timeout error
 *
 * @param promise - The promise to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param sourceName - Name of the source (for error message)
 * @returns Promise that rejects if timeout is exceeded
 */
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
    console.log(`[Market Cache] Using cached ${cachedMarkets.length} markets (TTL: ${CACHE_TTL_MS}ms, age: ${now - cacheTimestamp}ms)`);
    return cachedMarkets;
  }

  // Fetch fresh markets
  console.log(`[Market Cache] Fetching fresh markets... (TTL: ${CACHE_TTL_MS}ms)`);

  try {
    // Stage 0 Session 2: Wrap each source with 5-second timeout
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

    // Stage 0: Track Polymarket fetch
    if (polyResult.status === 'fulfilled') {
      polyTimestamp = now;
      polyMarketCount = polyResult.value.length;
      polyError = null;
    } else {
      polyError = polyResult.reason?.message || 'Failed to fetch Polymarket markets';
      console.error('[Market Cache] Polymarket fetch failed:', polyError);
    }

    // Stage 0: Track Kalshi fetch
    if (kalshiResult.status === 'fulfilled') {
      kalshiTimestamp = now;
      kalshiMarketCount = kalshiResult.value.length;
      kalshiError = null;
    } else {
      kalshiError = kalshiResult.reason?.message || 'Failed to fetch Kalshi markets';
      console.error('[Market Cache] Kalshi fetch failed:', kalshiError);
    }

    const polyMarkets = polyResult.status === 'fulfilled' ? polyResult.value : [];
    const kalshiMarkets = kalshiResult.status === 'fulfilled' ? kalshiResult.value : [];

    cachedMarkets = [...polyMarkets, ...kalshiMarkets];
    cacheTimestamp = now;

    console.log(`[Market Cache] Cached ${cachedMarkets.length} markets (${polyMarkets.length} Poly + ${kalshiMarkets.length} Kalshi)`);
    return cachedMarkets;
  } catch (error) {
    console.error('[Market Cache] Failed to fetch markets:', error);
    // Return stale cache if available
    return cachedMarkets;
  }
}

/**
 * Stage 0: Get freshness metadata for current cached data
 * Tells bots/agents how old the data is and which sources are healthy
 *
 * @returns FreshnessMetadata with data age and source health status
 */
export function getMarketMetadata(): FreshnessMetadata {
  const now = Date.now();

  // Find oldest fetch timestamp (or use cache timestamp if no individual source timestamps)
  const oldestTimestamp = Math.min(
    polyTimestamp || cacheTimestamp,
    kalshiTimestamp || cacheTimestamp
  );

  // Calculate data age in seconds
  const dataAgeMs = now - oldestTimestamp;
  const dataAgeSeconds = Math.floor(dataAgeMs / 1000);

  // Build source status
  const polymarketStatus: SourceStatus = {
    available: polyError === null && polyMarketCount > 0,
    last_successful_fetch: polyTimestamp > 0 ? new Date(polyTimestamp).toISOString() : null,
    error: polyError || undefined,
    market_count: polyMarketCount,
  };

  const kalshiStatus: SourceStatus = {
    available: kalshiError === null && kalshiMarketCount > 0,
    last_successful_fetch: kalshiTimestamp > 0 ? new Date(kalshiTimestamp).toISOString() : null,
    error: kalshiError || undefined,
    market_count: kalshiMarketCount,
  };

  return {
    data_age_seconds: dataAgeSeconds,
    fetched_at: new Date(oldestTimestamp).toISOString(),
    sources: {
      polymarket: polymarketStatus,
      kalshi: kalshiStatus,
    },
  };
}

/**
 * Get cached arbitrage opportunities
 *
 * Caches with low minSpread (0.01) and filters client-side.
 * This allows different callers to request different thresholds
 * without recomputing the expensive O(n×m) scan.
 *
 * @param minSpread - Minimum spread threshold (default: 0.03)
 * @returns Arbitrage opportunities filtered by minSpread
 */
export async function getArbitrage(minSpread: number = 0.03): Promise<ArbitrageOpportunity[]> {
  const markets = await getMarkets();
  const now = Date.now();

  // Recompute if cache is stale
  if (cachedArbitrage.length === 0 || (now - arbCacheTimestamp) >= ARB_CACHE_TTL_MS) {
    console.log('[Arbitrage Cache] Computing arbitrage opportunities...');
    // Cache with low threshold (0.01) so we can filter client-side
    cachedArbitrage = detectArbitrage(markets, 0.01);
    arbCacheTimestamp = now;
    console.log(`[Arbitrage Cache] Cached ${cachedArbitrage.length} opportunities (minSpread: 0.01, TTL: ${ARB_CACHE_TTL_MS}ms)`);
  }

  // Filter cached results by requested minSpread
  const filtered = cachedArbitrage.filter(arb => arb.spread >= minSpread);
  console.log(`[Arbitrage Cache] Returning ${filtered.length}/${cachedArbitrage.length} opportunities (minSpread: ${minSpread})`);

  return filtered;
}

/**
 * Get cached intra-event (group) arbitrage opportunities.
 *
 * These are opportunities within a single platform where multiple markets
 * represent mutually-exclusive outcomes of the same event (e.g. Kalshi range
 * buckets) and their YES prices do not sum to 1.
 *
 * Cache is computed with minEdge=0 so that callers can filter to any threshold
 * without triggering a recompute (same pattern as getArbitrage).
 *
 * @param minEdge - Minimum net edge required (default: 0.01)
 * @returns GroupArbitrageOpportunity array, sorted by edge descending
 */
export async function getGroupArbitrage(minEdge: number = 0.01): Promise<GroupArbitrageOpportunity[]> {
  const markets = await getMarkets();
  const now = Date.now();

  // Recompute alongside the cross-platform cache (same TTL).
  // Use minEdge=0 so every profitable group is cached; callers filter client-side.
  if (cachedGroupArbitrage.length === 0 || (now - groupArbCacheTimestamp) >= ARB_CACHE_TTL_MS) {
    console.log('[GroupArbitrage Cache] Computing intra-event arbitrage opportunities...');
    cachedGroupArbitrage = detectIntraEventArbitrage(markets, 0);
    groupArbCacheTimestamp = now;
    console.log(`[GroupArbitrage Cache] Cached ${cachedGroupArbitrage.length} opportunities (TTL: ${ARB_CACHE_TTL_MS}ms)`);
  }

  const filtered = cachedGroupArbitrage.filter(op => op.edge >= minEdge);
  console.log(`[GroupArbitrage Cache] Returning ${filtered.length}/${cachedGroupArbitrage.length} opportunities (minEdge: ${minEdge})`);

  return filtered;
}
