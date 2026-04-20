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

// In-memory cache for markets
// Default: 20 seconds (configurable via MARKET_CACHE_TTL_SECONDS env var)
let cachedMarkets: Market[] = [];
let cacheTimestamp = 0;
const CACHE_TTL_MS = (parseInt(process.env.MARKET_CACHE_TTL_SECONDS || '20', 10)) * 1000;

// ─── Stale-while-revalidate ───────────────────────────────────────────────
// Beyond the hard TTL we will still *serve* stale data for up to
// `STALE_WHILE_REVALIDATE_MS` milliseconds while kicking off a single
// background refresh. This keeps p50 latency near the in-memory cost even
// right at the TTL boundary, and prevents thundering-herd on expiry.
const STALE_WHILE_REVALIDATE_MS =
  (parseInt(process.env.MARKET_CACHE_SWR_SECONDS || '60', 10)) * 1000;

// In-flight request deduplication. If multiple concurrent callers arrive
// during a cache miss, they all await the same promise instead of each
// triggering their own Polymarket/Kalshi fetch.
let inFlightFetch: Promise<Market[]> | null = null;

// Stage 0: Per-source tracking for freshness metadata
let polyTimestamp = 0;
let kalshiTimestamp = 0;
let polyMarketCount = 0;
let kalshiMarketCount = 0;
let polyError: string | null = null;
let kalshiError: string | null = null;

// In-memory cache for arbitrage opportunities
// Default: 15 seconds (configurable via ARBITRAGE_CACHE_TTL_SECONDS env var)
let cachedArbitrage: ArbitrageOpportunity[] = [];
let arbCacheTimestamp = 0;
const ARB_CACHE_TTL_MS = (parseInt(process.env.ARBITRAGE_CACHE_TTL_SECONDS || '15', 10)) * 1000;

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
 * Fetch and cache markets from both platforms.
 *
 * Caching strategy (in order of preference per request):
 *   1. **Hot cache** — within `CACHE_TTL_MS`, return cached data instantly.
 *   2. **Stale-while-revalidate** — if cache age is beyond TTL but inside
 *      `STALE_WHILE_REVALIDATE_MS`, return stale data immediately AND
 *      kick off a single background refresh so the next caller gets
 *      fresh data. Keeps p50 latency near the in-memory cost even at
 *      TTL expiry.
 *   3. **In-flight deduplication** — when multiple concurrent callers
 *      arrive during a hard miss, they all await the same promise
 *      instead of each triggering their own Polymarket/Kalshi fetch.
 *   4. **Graceful degradation** — on fetch failure we return whatever
 *      is still in memory rather than propagating the error.
 */
export async function getMarkets(): Promise<Market[]> {
  const now = Date.now();
  const ageMs = now - cacheTimestamp;

  // 1. Hot cache: within TTL → return immediately.
  if (cachedMarkets.length > 0 && ageMs < CACHE_TTL_MS) {
    console.log(`[Market Cache] hot hit: ${cachedMarkets.length} markets (age: ${ageMs}ms, TTL: ${CACHE_TTL_MS}ms)`);
    return cachedMarkets;
  }

  // 2. Stale-while-revalidate: beyond TTL but inside SWR window → serve
  //    stale immediately, background-refresh on fire-and-forget basis.
  if (
    cachedMarkets.length > 0 &&
    ageMs < CACHE_TTL_MS + STALE_WHILE_REVALIDATE_MS
  ) {
    if (!inFlightFetch) {
      console.log(`[Market Cache] SWR hit: age ${ageMs}ms, kicking off background refresh`);
      // We don't await this — the caller gets stale data, the next caller
      // gets the refreshed data. `inFlightFetch` is cleared in the finally.
      void refreshMarkets();
    }
    return cachedMarkets;
  }

  // 3. Hard miss — dedupe concurrent callers onto a single in-flight fetch.
  if (inFlightFetch) {
    console.log('[Market Cache] hard miss but dedupe hit: awaiting in-flight fetch');
    return inFlightFetch;
  }

  console.log(`[Market Cache] hard miss: fetching fresh markets (TTL: ${CACHE_TTL_MS}ms, age: ${ageMs}ms)`);
  return refreshMarkets();
}

/**
 * Refresh the cache. Single-flight: concurrent callers share one promise
 * via the `inFlightFetch` guard. On any failure we fall back to the last
 * known good cache; this path should never throw.
 */
function refreshMarkets(): Promise<Market[]> {
  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = (async () => {
    const now = Date.now();
    try {
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

      if (polyResult.status === 'fulfilled') {
        polyTimestamp = now;
        polyMarketCount = polyResult.value.length;
        polyError = null;
      } else {
        polyError = polyResult.reason?.message || 'Failed to fetch Polymarket markets';
        console.error('[Market Cache] Polymarket fetch failed:', polyError);
      }

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

      // Only overwrite the cache if we actually got *something* — don't
      // clobber the last known good snapshot with two empties.
      if (polyMarkets.length + kalshiMarkets.length > 0) {
        cachedMarkets = [...polyMarkets, ...kalshiMarkets];
        cacheTimestamp = now;
      }

      console.log(`[Market Cache] refresh done: ${cachedMarkets.length} markets (${polyMarkets.length} Poly + ${kalshiMarkets.length} Kalshi)`);
      return cachedMarkets;
    } catch (error) {
      console.error('[Market Cache] refresh failed, returning last known good cache:', error);
      return cachedMarkets;
    } finally {
      inFlightFetch = null;
    }
  })();

  return inFlightFetch;
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
