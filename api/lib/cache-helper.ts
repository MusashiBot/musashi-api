/**
 * Multi-layer caching helper for API endpoints
 *
 * Provides in-memory caching to dramatically reduce KV requests
 * and handle quota exceeded errors gracefully.
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

class MemoryCache {
  private cache = new Map<string, CacheEntry<any>>();
  private maxSize = 100; // Prevent memory leaks

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    // Enforce max size
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttlMs,
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

// Global in-memory cache (persists across invocations in warm lambdas)
const memoryCache = new MemoryCache();

/**
 * Batch fetch multiple keys from KV using mget
 * Falls back to empty array on quota errors
 */
export async function batchGetFromKV<T>(
  kv: any,
  keys: string[]
): Promise<(T | null)[]> {
  if (keys.length === 0) return [];

  try {
    // Use mget for batch fetch (single request instead of N requests!)
    const results = await kv.mget(...keys) as (T | null)[];
    return results;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Handle quota exceeded gracefully
    if (errorMsg.includes('max requests limit exceeded') ||
        errorMsg.includes('quota') ||
        errorMsg.includes('ERR max')) {
      console.warn('[Cache Helper] KV quota exceeded, returning empty results');
      return keys.map(() => null);
    }

    // Re-throw other errors
    throw error;
  }
}

/**
 * Get from cache with automatic KV fallback
 * Uses in-memory cache first, then KV
 */
export async function getCached<T>(
  cacheKey: string,
  fetcher: () => Promise<T>,
  ttlMs: number = 60000
): Promise<T> {
  // Try memory cache first
  const cached = memoryCache.get<T>(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Fetch fresh data
  try {
    const data = await fetcher();
    memoryCache.set(cacheKey, data, ttlMs);
    return data;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // If quota exceeded, return stale cache or throw
    if (errorMsg.includes('max requests limit exceeded') ||
        errorMsg.includes('quota')) {
      console.error('[Cache Helper] KV quota exceeded, no fallback available');
      throw new Error('Service temporarily unavailable due to quota limits. Please try again later.');
    }

    throw error;
  }
}

/**
 * Clear all memory caches (useful for testing)
 */
export function clearMemoryCache(): void {
  memoryCache.clear();
}

// ─── Feed-Specific Cache ──────────────────────────────────────────────────────

/**
 * Feed-specific cache for fallback when KV quota is exhausted
 * Persists across warm lambda invocations
 */
const feedCache = new Map<string, {
  data: any;
  timestamp: number;
  ttl: number;
}>();

const MAX_FEED_CACHE_ENTRIES = 50;

/**
 * Store feed data in memory for fallback.
 * Evicts the oldest entry (insertion order) when the cap is reached so
 * the Map cannot grow unboundedly inside a warm lambda.
 */
export function setFeedCache(key: string, data: any, ttlMs: number): void {
  if (feedCache.size >= MAX_FEED_CACHE_ENTRIES) {
    feedCache.delete(feedCache.keys().next().value!);
  }
  feedCache.set(key, {
    data,
    timestamp: Date.now(),
    ttl: ttlMs,
  });
}

/**
 * Get feed data from memory cache
 * Returns data even if expired (better to serve stale data than no data)
 */
export function getFeedCache(key: string): any | null {
  const entry = feedCache.get(key);
  if (!entry) return null;

  // Always return cached data, even if expired
  // (better to serve stale data than no data when KV is down)
  return entry.data;
}

/**
 * Get timestamp when feed data was cached
 */
export function getFeedCacheTimestamp(key: string): number | null {
  const entry = feedCache.get(key);
  return entry ? entry.timestamp : null;
}

export { memoryCache };
