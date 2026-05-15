import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getMarkets } from '../lib/market-cache';
import { kv, setKvWithTtl } from '../lib/vercel-kv';
import {
  detectMoversBatch,
  recordPriceSnapshots,
  getMoversKey,
  META_LAST_SNAPSHOT_RUN,
  META_LAST_MOVERS_RUN,
} from '../lib/price-snapshots';

// Buckets the /api/markets/movers endpoint serves directly. Caller-provided
// minChange snaps to the nearest bucket ≤ the requested value, so adding a
// bucket here adds finer resolution without touching the read path.
const MOVERS_BUCKETS = [0.02, 0.05, 0.1, 0.2];
const MOVERS_TTL_SECONDS = 5 * 60;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  const cronSecret = req.headers.authorization?.replace('Bearer ', '');
  if (cronSecret !== process.env.CRON_SECRET) {
    console.error('[Cron refresh-markets] Unauthorized: Invalid CRON_SECRET');
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const startedAt = Date.now();
  const timings: Record<string, number> = {};

  try {
    const t0 = Date.now();
    const markets = await getMarkets();
    timings.getMarkets_ms = Date.now() - t0;

    if (markets.length === 0) {
      console.warn('[Cron refresh-markets] No markets returned, skipping');
      res.status(200).json({ success: true, skipped: 'no markets', timings });
      return;
    }

    const t1 = Date.now();
    const writeStats = await recordPriceSnapshots(markets);
    timings.recordSnapshots_ms = Date.now() - t1;

    await setKvWithTtl(META_LAST_SNAPSHOT_RUN, 24 * 60 * 60, {
      timestamp: new Date().toISOString(),
      markets_total: markets.length,
      ...writeStats,
    });

    const t2 = Date.now();
    const moversByBucket: Record<string, number> = {};

    // Compute the smallest bucket once; the larger buckets are just filters of
    // that result. One KV mget pass instead of N.
    const minBucket = Math.min(...MOVERS_BUCKETS);
    const baseMovers = await detectMoversBatch(markets, minBucket, 1);

    await Promise.all(
      MOVERS_BUCKETS.map(async (bucket) => {
        const filtered = baseMovers.filter(
          (m) => Math.abs(m.priceChange1h) >= bucket,
        );
        moversByBucket[bucket.toString()] = filtered.length;
        await setKvWithTtl(getMoversKey(bucket.toString()), MOVERS_TTL_SECONDS, {
          computedAt: new Date().toISOString(),
          minChange: bucket,
          markets_analyzed: markets.length,
          movers: filtered,
        });
      }),
    );

    timings.computeMovers_ms = Date.now() - t2;

    await setKvWithTtl(META_LAST_MOVERS_RUN, 24 * 60 * 60, {
      timestamp: new Date().toISOString(),
      buckets: moversByBucket,
      markets_analyzed: markets.length,
    });

    timings.total_ms = Date.now() - startedAt;

    console.log(
      `[Cron refresh-markets] done in ${timings.total_ms}ms — ${markets.length} markets, snapshots ${JSON.stringify(writeStats)}, movers ${JSON.stringify(moversByBucket)}`,
    );

    res.status(200).json({
      success: true,
      markets_total: markets.length,
      snapshots: writeStats,
      movers: moversByBucket,
      timings,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Cron refresh-markets] Error:', errorMessage);
    res.status(500).json({
      success: false,
      error: errorMessage,
      timings: { ...timings, total_ms: Date.now() - startedAt },
    });
  }
}
