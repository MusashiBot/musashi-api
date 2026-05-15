import { Market } from '../../src/types/market';
import { kv, setKvWithTtl } from './vercel-kv';
import { batchGetFromKV } from './cache-helper';

export interface PriceSnapshot {
  marketId: string;
  yesPrice: number;
  timestamp: number;
}

export interface MarketMover {
  market: Market;
  priceChange1h: number;
  previousPrice: number;
  currentPrice: number;
  direction: 'up' | 'down';
  timestamp: number;
}

export const HISTORY_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SNAPSHOT_KEY_PREFIX = 'price_history:';
export const MOVERS_PRECOMPUTED_PREFIX = 'movers:precomputed:';
export const META_LAST_SNAPSHOT_RUN = 'meta:last_snapshot_run';
export const META_LAST_MOVERS_RUN = 'meta:last_movers_run';

// Snapshot array hard cap. At 5-min cadence, 300 entries covers 25h — enough for
// the 1h and 24h lookbacks the movers endpoint exposes. Without this cap, arrays
// grew until 7-day TTL expired, bloating KV values and slowing mget linearly.
const MAX_SNAPSHOTS_PER_MARKET = 300;
const SNAPSHOT_DEDUP_WINDOW_MS = 60_000;
const KV_BATCH_SIZE = 100;

export function getSnapshotKey(marketId: string): string {
  return `${SNAPSHOT_KEY_PREFIX}${marketId}`;
}

export function getMoversKey(bucket: string): string {
  return `${MOVERS_PRECOMPUTED_PREFIX}${bucket}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function recordPriceSnapshots(markets: Market[]): Promise<{
  written: number;
  skipped: number;
  errors: number;
}> {
  const now = Date.now();
  const cutoff = now - HISTORY_TTL_SECONDS * 1000;

  const keys = markets.map((m) => getSnapshotKey(m.id));
  let written = 0;
  let skipped = 0;
  let errors = 0;

  for (const [chunkIdx, batchKeys] of chunk(keys, KV_BATCH_SIZE).entries()) {
    const batchMarkets = markets.slice(
      chunkIdx * KV_BATCH_SIZE,
      chunkIdx * KV_BATCH_SIZE + batchKeys.length,
    );

    const existing = await batchGetFromKV<PriceSnapshot[]>(kv, batchKeys);

    await Promise.allSettled(
      batchMarkets.map(async (market, i) => {
        try {
          const prior = existing[i] ?? [];
          const latest = prior.length > 0 ? prior[prior.length - 1] : null;

          if (latest && now - latest.timestamp < SNAPSHOT_DEDUP_WINDOW_MS) {
            skipped++;
            return;
          }

          const appended: PriceSnapshot[] = [
            ...prior.filter((s) => s.timestamp >= cutoff),
            { marketId: market.id, yesPrice: market.yesPrice, timestamp: now },
          ];

          const trimmed = appended.length > MAX_SNAPSHOTS_PER_MARKET
            ? appended.slice(appended.length - MAX_SNAPSHOTS_PER_MARKET)
            : appended;

          await setKvWithTtl(getSnapshotKey(market.id), HISTORY_TTL_SECONDS, trimmed);
          written++;
        } catch (err) {
          errors++;
          console.error(`[Snapshots] write failed for ${market.id}:`, err);
        }
      }),
    );
  }

  return { written, skipped, errors };
}

export function computePriceChange(
  snapshots: PriceSnapshot[] | null,
  hoursAgo: number,
): { change: number; previousPrice: number } | null {
  if (!snapshots || snapshots.length < 2) return null;

  const current = snapshots[snapshots.length - 1];
  const targetTime = Date.now() - hoursAgo * 60 * 60 * 1000;

  let closest = snapshots[0];
  let closestDiff = Math.abs(closest.timestamp - targetTime);
  for (const s of snapshots) {
    const d = Math.abs(s.timestamp - targetTime);
    if (d < closestDiff) {
      closest = s;
      closestDiff = d;
    }
  }

  // Tolerance ±0.5×hoursAgo (e.g. ±30 min for a 1h lookback). Anything looser
  // overstates change magnitude — see prior FIX 7 in the original code.
  if (closestDiff > hoursAgo * 60 * 60 * 1000 * 0.5) return null;

  return {
    change: current.yesPrice - closest.yesPrice,
    previousPrice: closest.yesPrice,
  };
}

export async function detectMoversBatch(
  markets: Market[],
  minChange: number,
  hoursAgo = 1,
): Promise<MarketMover[]> {
  const movers: MarketMover[] = [];
  const keys = markets.map((m) => getSnapshotKey(m.id));

  for (const [chunkIdx, batchKeys] of chunk(keys, KV_BATCH_SIZE).entries()) {
    const batchMarkets = markets.slice(
      chunkIdx * KV_BATCH_SIZE,
      chunkIdx * KV_BATCH_SIZE + batchKeys.length,
    );

    const snapshotArrays = await batchGetFromKV<PriceSnapshot[]>(kv, batchKeys);

    for (let i = 0; i < batchMarkets.length; i++) {
      const market = batchMarkets[i];
      const priceData = computePriceChange(snapshotArrays[i], hoursAgo);
      if (priceData === null) continue;
      if (Math.abs(priceData.change) < minChange) continue;

      movers.push({
        market,
        priceChange1h: priceData.change,
        previousPrice: priceData.previousPrice,
        currentPrice: market.yesPrice,
        direction: priceData.change > 0 ? 'up' : 'down',
        timestamp: Date.now(),
      });
    }
  }

  movers.sort((a, b) => Math.abs(b.priceChange1h) - Math.abs(a.priceChange1h));
  return movers;
}
