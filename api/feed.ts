import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { AnalyzedTweet, FeedResponse, AccountCategory } from '../src/types/feed';
import { batchGetFromKV, setFeedCache, getFeedCache, getFeedCacheTimestamp } from './lib/cache-helper';
import { kv } from './lib/vercel-kv';
import { checkRateLimit } from './lib/rate-limit';

// ─── KV Storage Keys ───────────────────────────────────────────────────────

const FEED_LATEST_KEY = 'feed:latest';
const FEED_CACHE_KEY_PREFIX = 'feed_memory_';
const FEED_CACHE_CONTROL = 's-maxage=60, stale-while-revalidate=300';

function getTweetKey(tweetId: string): string {
  return `tweet:${tweetId}`;
}

function getCategoryKey(category: AccountCategory): string {
  return `feed:category:${category}`;
}

function getFeedCacheKey(params: {
  category?: string;
  minUrgency?: string;
  limit: number;
  since?: string;
  cursor?: string;
}): string {
  return [
    FEED_CACHE_KEY_PREFIX,
    params.category || 'all',
    params.minUrgency || 'all',
    params.limit,
    params.since || 'none',
    params.cursor || 'none',
  ].join('_');
}

function isInfraError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('kv') ||
    normalized.includes('redis') ||
    normalized.includes('upstash') ||
    normalized.includes('quota') ||
    normalized.includes('token') ||
    normalized.includes('credential') ||
    normalized.includes('connect') ||
    normalized.includes('fetch failed') ||
    normalized.includes('missing') && normalized.includes('rest')
  );
}

function getSanitizedFeedError(message: string): { status: number; error: string; note?: string } {
  if (isInfraError(message)) {
    return {
      status: 503,
      error: 'Feed service temporarily unavailable. Check KV configuration and try again.',
      note: 'Ensure the local KV REST URL and credential are configured for feed endpoints.',
    };
  }

  return {
    status: 500,
    error: 'Internal server error',
  };
}

// ─── Main Handler ──────────────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const startTime = Date.now();

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow GET
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({
      success: false,
      error: 'Method not allowed. Use GET.',
    });
    return;
  }

  if (!await checkRateLimit(req, res)) return;

  try {
    // Parse query parameters
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const category = req.query.category as AccountCategory | undefined;
    const minUrgency = req.query.minUrgency as string | undefined;
    const since = req.query.since as string | undefined;
    const cursor = req.query.cursor as string | undefined;

    // Build cache key for in-memory fallback
    const cacheKey = getFeedCacheKey({ category, minUrgency, limit, since, cursor });

    // Validate parameters
    if (limit < 1 || limit > 100) {
      res.status(400).json({
        success: false,
        error: 'Limit must be between 1 and 100.',
      });
      return;
    }

    if (category && !isValidCategory(category)) {
      res.status(400).json({
        success: false,
        error: `Invalid category. Must be one of: politics, economics, crypto, technology, geopolitics, sports, breaking_news, finance`,
      });
      return;
    }

    if (minUrgency && !isValidUrgency(minUrgency)) {
      res.status(400).json({
        success: false,
        error: `Invalid minUrgency. Must be one of: low, medium, high, critical`,
      });
      return;
    }

    if (since) {
      const sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) {
        res.status(400).json({
          success: false,
          error: 'Invalid "since" timestamp. Use ISO 8601 format.',
        });
        return;
      }
    }

    // Step 1: Get feed index (category-specific or latest)
    const feedKey = category ? getCategoryKey(category) : FEED_LATEST_KEY;
    const feedIndex = await kv.get<string[]>(feedKey) || [];

    if (feedIndex.length === 0) {
      // Empty feed (not an error)
      const response: FeedResponse = {
        success: true,
        data: {
          tweets: [],
          count: 0,
          timestamp: new Date().toISOString(),
          filters: {
            limit,
            category,
            minUrgency,
            since,
          },
          metadata: {
            processing_time_ms: Date.now() - startTime,
            total_in_kv: 0,
          },
        },
      };

      // Cache for 30 seconds
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate');
      res.status(200).json(response);
      return;
    }

    // Step 2: Apply cursor pagination
    let startIndex = 0;
    if (cursor) {
      const cursorIndex = feedIndex.indexOf(cursor);
      if (cursorIndex !== -1) {
        startIndex = cursorIndex + 1; // Start after cursor
      }
    }

    // Step 3: Slice for limit
    const tweetIds = feedIndex.slice(startIndex, startIndex + limit);

    // Step 4: OPTIMIZED: Batch fetch tweets from KV using mget
    // This reduces N requests → 1 request (massive improvement!)
    const tweetKeys = tweetIds.map((id: string) => getTweetKey(id));
    const tweets = await batchGetFromKV<AnalyzedTweet>(kv, tweetKeys);

    // Step 5: Filter nulls (expired tweets)
    let validTweets = tweets.filter(t => t !== null) as AnalyzedTweet[];

    // Step 6: Apply filters (urgency, since)
    if (minUrgency) {
      const urgencyOrder = ['low', 'medium', 'high', 'critical'];
      const minIndex = urgencyOrder.indexOf(minUrgency);
      validTweets = validTweets.filter(t => urgencyOrder.indexOf(t.urgency) >= minIndex);
    }

    if (since) {
      const sinceDate = new Date(since);
      validTweets = validTweets.filter(t => new Date(t.tweet.created_at) > sinceDate);
    }

    // Step 7: Determine next cursor
    const nextCursor = tweetIds.length === limit ? tweetIds[tweetIds.length - 1] : undefined;

    // Step 8: Build response
    const response: FeedResponse = {
      success: true,
      data: {
        tweets: validTweets,
        count: validTweets.length,
        timestamp: new Date().toISOString(),
        cursor: nextCursor,
        filters: {
          limit,
          category,
          minUrgency,
          since,
        },
        metadata: {
          processing_time_ms: Date.now() - startTime,
          total_in_kv: feedIndex.length,
          cached: false,  // Indicates fresh data from KV
        },
      },
    };

    // Cache successful response in memory for fallback
    setFeedCache(cacheKey, response, 5 * 60 * 1000); // 5 min TTL

    // Cache for 60 seconds at edge with stale-while-revalidate
    res.setHeader('Cache-Control', FEED_CACHE_CONTROL);
    res.status(200).json(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Feed API] Error:', errorMessage);

    // Attempt stale cache fallback for ALL KV errors — not just quota errors.
    // A network timeout, auth failure, or Upstash outage should still serve
    // the last known-good feed rather than returning a hard 500 that breaks
    // the bot's polling loop. cacheKey is re-derived here because it is
    // scoped inside the try block above.
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const category = req.query.category as AccountCategory | undefined;
    const minUrgency = req.query.minUrgency as string | undefined;
    const since = req.query.since as string | undefined;
    const cursor = req.query.cursor as string | undefined;
    const cacheKey = getFeedCacheKey({ category, minUrgency, limit, since, cursor });

    const cachedResponse = getFeedCache(cacheKey);
    const cachedAt = getFeedCacheTimestamp(cacheKey);

    if (cachedResponse) {
      const fallbackResponse = {
        ...cachedResponse,
        data: {
          ...cachedResponse.data,
          metadata: {
            ...cachedResponse.data.metadata,
            stale: true,
            cached: true,
            cached_at: cachedAt ? new Date(cachedAt).toISOString() : null,
            cache_age_seconds: cachedAt ? Math.floor((Date.now() - cachedAt) / 1000) : null,
          },
        },
      };

      console.log(`[Feed API] Serving stale cache (age: ${fallbackResponse.data.metadata.cache_age_seconds}s) after error: ${errorMessage}`);
      res.setHeader('Cache-Control', FEED_CACHE_CONTROL);
      res.status(200).json(fallbackResponse);
      return;
    }

    res.setHeader('Cache-Control', FEED_CACHE_CONTROL);
    res.status(503).json({
      success: false,
      error: 'Feed unavailable. No cached data available.',
    });
  }
}

// ─── Validation Helpers ────────────────────────────────────────────────────

function isValidCategory(category: string): category is AccountCategory {
  return [
    'politics',
    'economics',
    'crypto',
    'technology',
    'geopolitics',
    'sports',
    'breaking_news',
    'finance',
  ].includes(category);
}

function isValidUrgency(urgency: string): boolean {
  return ['low', 'medium', 'high', 'critical'].includes(urgency);
}
