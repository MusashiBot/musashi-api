/**
 * Snapshot active markets from the hosted Musashi API.
 *
 * Pulls up to ~280 markets across 7 categories from /api/markets/movers,
 * dedupes by market id, strips mover-specific fields, and writes the result
 * to scripts/eval-fixtures/markets-snapshot-{today}.json.
 *
 * Overwrites any existing file with today's date.
 *
 * Usage:
 *   pnpm tsx scripts/snapshot-markets.ts
 *
 * Next step after running: manually trim the output to ~100-150 markets,
 * keeping a balanced spread across categories and a mix of obvious-match
 * markets, trap markets, and edge cases. See eval-fixtures/README.md.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const HOSTED_API = 'https://musashi-api.vercel.app';
const PER_CATEGORY_LIMIT = 40;
const FETCH_TIMEOUT_MS = 15_000;

const CATEGORIES = [
  'crypto',
  'us_politics',
  'economics',
  'technology',
  'sports',
  'climate',
  'geopolitics',
  'other',
] as const;

interface Market {
  id: string;
  platform: 'polymarket' | 'kalshi';
  title: string;
  description: string;
  keywords: string[];
  yesPrice: number;
  noPrice: number;
  volume24h: number;
  url: string;
  category: string;
  lastUpdated: string;
  endDate?: string;
  oneDayPriceChange?: number;
}

interface MoverEntry {
  market: Market;
  priceChange1h: number;
  previousPrice: number;
  currentPrice: number;
  direction: 'up' | 'down';
  timestamp: number;
}

interface MoversApiResponse {
  success: boolean;
  data?: {
    movers: MoverEntry[];
    count: number;
  };
  error?: string;
}

async function fetchCategory(category: string): Promise<MoverEntry[]> {
  const url = `${HOSTED_API}/api/markets/movers?limit=${PER_CATEGORY_LIMIT}&minChange=0&category=${category}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      console.error(`[snapshot] ${category}: HTTP ${resp.status}`);
      return [];
    }

    const json = (await resp.json()) as MoversApiResponse;
    if (!json.success || !json.data) {
      console.error(`[snapshot] ${category}: ${json.error ?? 'unknown error'}`);
      return [];
    }

    return json.data.movers;
  } catch (err) {
    clearTimeout(timer);
    console.error(`[snapshot] ${category}: ${(err as Error).message}`);
    return [];
  }
}

async function fetchBroad(): Promise<MoverEntry[]> {
  const url = `${HOSTED_API}/api/markets/movers?limit=100&minChange=0`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      console.error(`[snapshot] broad: HTTP ${resp.status}`);
      return [];
    }

    const json = (await resp.json()) as MoversApiResponse;
    if (!json.success || !json.data) {
      console.error(`[snapshot] broad: ${json.error ?? 'unknown error'}`);
      return [];
    }

    return json.data.movers;
  } catch (err) {
    clearTimeout(timer);
    console.error(`[snapshot] broad: ${(err as Error).message}`);
    return [];
  }
}

async function main(): Promise<void> {
  console.log(`[snapshot] Source: ${HOSTED_API}`);
  console.log(`[snapshot] Categories: ${CATEGORIES.join(', ')}`);
  console.log(`[snapshot] Per-category limit: ${PER_CATEGORY_LIMIT}`);
  console.log('');

  const dedupedById = new Map<string, Market>();
  const perCategoryAdded: Record<string, number> = {};

  for (const cat of CATEGORIES) {
    const movers = await fetchCategory(cat);
    let added = 0;
    for (const m of movers) {
      if (!dedupedById.has(m.market.id)) {
        dedupedById.set(m.market.id, m.market);
        added++;
      }
    }
    perCategoryAdded[cat] = added;
    console.log(`[snapshot] ${cat}: ${movers.length} fetched, ${added} new (cumulative: ${dedupedById.size})`);
  }

  // Broad call (no category filter) to backstop categories that returned little.
  console.log('');
  console.log('[snapshot] Broad call (no category filter)...');
  const broadMovers = await fetchBroad();
  let broadAdded = 0;
  for (const m of broadMovers) {
    if (!dedupedById.has(m.market.id)) {
      dedupedById.set(m.market.id, m.market);
      broadAdded++;
    }
  }
  console.log(`[snapshot] broad: ${broadMovers.length} fetched, ${broadAdded} new (cumulative: ${dedupedById.size})`);

  const markets = Array.from(dedupedById.values());
  const platformCounts = {
    polymarket: markets.filter((m) => m.platform === 'polymarket').length,
    kalshi: markets.filter((m) => m.platform === 'kalshi').length,
  };

  const today = new Date().toISOString().slice(0, 10);
  const outDir = resolve(process.cwd(), 'scripts', 'eval-fixtures');
  const outPath = resolve(outDir, `markets-snapshot-${today}.json`);

  mkdirSync(outDir, { recursive: true });

  const payload = {
    generated_at: new Date().toISOString(),
    source: `${HOSTED_API}/api/markets/movers`,
    per_category_limit: PER_CATEGORY_LIMIT,
    count: markets.length,
    breakdown: {
      by_category_new: perCategoryAdded,
      broad_call_new: broadAdded,
      by_platform: platformCounts,
    },
    markets,
  };

  writeFileSync(outPath, JSON.stringify(payload, null, 2));

  console.log('');
  console.log('[snapshot] === Summary ===');
  console.log(`[snapshot] Total unique markets: ${markets.length}`);
  console.log(`[snapshot] By category (new contributions): ${JSON.stringify(perCategoryAdded)}`);
  console.log(`[snapshot] By platform: ${JSON.stringify(platformCounts)}`);
  console.log(`[snapshot] Written to: ${outPath}`);
  console.log('');
  console.log('[snapshot] Next: manually trim to ~100-150 markets with category balance.');
}

main().catch((err) => {
  console.error('[snapshot] Fatal:', err);
  process.exit(1);
});
