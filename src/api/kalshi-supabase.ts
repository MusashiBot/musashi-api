import { Market } from '../types/market';
import { generateKeywords } from './keyword-generator';
import { getSupabaseClient } from '../../api/lib/supabase';
import { isSimpleMarket } from './kalshi-filters';

interface SupabaseMarketRow {
  id: string;
  platform_id: string;
  title: string;
  description: string | null;
  category: string;
  url: string;
  yes_price: number;
  volume_24h: number;
  closes_at: string | null;
  last_ingested_at: string | null;
  platform_raw: { mve_collection_ticker?: string } | null;
}

const PAGE_SIZE = 1000;


function toMarket(row: SupabaseMarketRow): Market {
  const yesPrice = Math.min(Math.max(row.yes_price ?? 0.5, 0.01), 0.99);
  const noPrice = +((1 - yesPrice).toFixed(2));

  return {
    // Strip the ingestion `musashi-` prefix so KV snapshot keys stay aligned with the live `kalshi-<ticker>` namespace.
    id: row.id.replace(/^musashi-/, ''),
    platform: 'kalshi',
    title: row.title,
    description: row.description ?? '',
    keywords: generateKeywords(row.title),
    yesPrice: +yesPrice.toFixed(2),
    noPrice,
    volume24h: row.volume_24h ?? 0,
    url: row.url,
    category: row.category ?? 'other',
    lastUpdated: row.last_ingested_at ?? new Date().toISOString(),
    endDate: row.closes_at ?? undefined,
  };
}

export async function fetchKalshiMarketsFromSupabase(
  targetCount = 1000,
): Promise<Market[]> {
  const supabase = getSupabaseClient();
  const results: Market[] = [];
  let from = 0;
  let page = 0;
  const MAX_PAGES = 20;

  while (results.length < targetCount && page < MAX_PAGES) {
    const { data, error } = await supabase
      .from('markets')
      .select(
        'id, platform_id, title, description, category, url, yes_price, volume_24h, closes_at, last_ingested_at, platform_raw',
      )
      .eq('platform', 'kalshi')
      .eq('status', 'open')
      .eq('is_active', true)
      .is('source_missing_at', null)
      .order('id')
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`[Kalshi Supabase] Query failed: ${error.message}`);
    }

    if (!data || data.length === 0) break;

    const simple = (data as SupabaseMarketRow[])
      .filter((row) => isSimpleMarket({
        title: row.title,
        tickerOrPlatformId: row.platform_id,
        mveCollectionTicker: row.platform_raw?.mve_collection_ticker ?? null,
      }))
      .filter((row) => row.yes_price > 0 && row.yes_price < 1)
      .map(toMarket);

    results.push(...simple);

    console.log(
      `[Kalshi Supabase] Page from=${from}: ${data.length} raw → ${simple.length} simple (total: ${results.length})`,
    );

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
    page++;
  }

  if (page >= MAX_PAGES) {
    console.warn(
      `[Kalshi Supabase] Hit MAX_PAGES=${MAX_PAGES} before reaching targetCount=${targetCount}. ` +
      `Returning ${results.length} markets. Table may be dominated by non-simple rows.`
    );
  }

  console.log(`[Kalshi Supabase] Fetched ${results.length} markets from Supabase`);

  if (results.length > 0) {
    const oldest = results.reduce((min, m) => m.lastUpdated < min ? m.lastUpdated : min, results[0].lastUpdated);
    const ageHours = ((Date.now() - new Date(oldest).getTime()) / 3_600_000).toFixed(1);
    console.log(`[Kalshi Supabase] Oldest last_ingested_at: ${oldest} (${ageHours}h ago)`);
  }

  return results;
}
