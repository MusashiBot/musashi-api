import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getMarketMetadata } from '../lib/market-cache';
import { kv } from '../lib/vercel-kv';
import {
  MarketMover,
  getMoversKey,
} from '../lib/price-snapshots';

// Bucket precomputed every cron tick. Caller-supplied minChange snaps down to
// the nearest available bucket; results are filtered in-memory for any
// minChange above that bucket. Keep in sync with MOVERS_BUCKETS in
// api/cron/refresh-markets.ts.
const BUCKETS = [0.02, 0.05, 0.1, 0.2];

interface MoversCacheEntry {
  computedAt: string;
  minChange: number;
  markets_analyzed: number;
  movers: MarketMover[];
}

const RESPONSE_CACHE_TTL_MS = 20_000;
const responseCache = new Map<string, { at: number; body: unknown }>();

function pickBucket(minChange: number): number {
  // Largest bucket ≤ minChange so we don't under-serve. If minChange is below
  // the smallest bucket, use the smallest.
  const eligible = BUCKETS.filter((b) => b <= minChange);
  if (eligible.length === 0) return BUCKETS[0];
  return Math.max(...eligible);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({ success: false, error: 'Method not allowed. Use GET.' });
    return;
  }

  const startTime = Date.now();

  try {
    const {
      minChange = '0.05',
      limit = '20',
      category,
    } = req.query;

    const minChangeNum = parseFloat(minChange as string);
    const limitNum = parseInt(limit as string, 10);

    if (isNaN(minChangeNum) || minChangeNum < 0 || minChangeNum > 1) {
      res.status(400).json({
        success: false,
        error: 'Invalid minChange. Must be between 0 and 1.',
      });
      return;
    }

    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      res.status(400).json({
        success: false,
        error: 'Invalid limit. Must be between 1 and 100.',
      });
      return;
    }

    const categoryStr = typeof category === 'string' ? category : undefined;
    const bucket = pickBucket(minChangeNum);
    const cacheKey = `${bucket}|${minChangeNum}|${limitNum}|${categoryStr ?? ''}`;
    const cached = responseCache.get(cacheKey);
    if (cached && Date.now() - cached.at < RESPONSE_CACHE_TTL_MS) {
      res.status(200).json(cached.body);
      return;
    }

    const entry = await kv.get<MoversCacheEntry>(getMoversKey(bucket.toString()));

    if (!entry) {
      // No precomputed result yet — the cron either hasn't run since deploy
      // or KV is unreachable. Return 503 so monitors fire instead of silently
      // serving empty data.
      res.status(503).json({
        success: false,
        error: 'Movers data not yet computed. Cron job may not have completed first run.',
        bucket,
        retry_after_seconds: 120,
      });
      return;
    }

    let movers = entry.movers;
    if (minChangeNum > bucket) {
      movers = movers.filter((m) => Math.abs(m.priceChange1h) >= minChangeNum);
    }
    if (categoryStr) {
      movers = movers.filter((m) => m.market.category === categoryStr);
    }
    movers = movers.slice(0, limitNum);

    const freshnessMetadata = getMarketMetadata();

    const body = {
      success: true,
      data: {
        movers,
        count: movers.length,
        timestamp: new Date().toISOString(),
        filters: {
          minChange: minChangeNum,
          limit: limitNum,
          category: categoryStr ?? null,
        },
        metadata: {
          processing_time_ms: Date.now() - startTime,
          markets_analyzed: entry.markets_analyzed,
          precomputed_at: entry.computedAt,
          precomputed_bucket: bucket,
          storage: 'Vercel KV (Redis) — precomputed via cron',
          history_retention: '7 days',
          data_age_seconds: freshnessMetadata.data_age_seconds,
          fetched_at: freshnessMetadata.fetched_at,
          sources: freshnessMetadata.sources,
        },
      },
    };

    responseCache.set(cacheKey, { at: Date.now(), body });
    res.status(200).json(body);
  } catch (error) {
    console.error('[Movers API] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    const isKVError = errorMessage.includes('KV') || errorMessage.includes('Redis');

    res.status(500).json({
      success: false,
      error: errorMessage,
      ...(isKVError && {
        note: 'Vercel KV storage error. Ensure KV_REST_API_URL and KV_REST_API_TOKEN are set in Vercel environment variables.',
      }),
    });
  }
}
