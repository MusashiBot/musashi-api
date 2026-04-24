import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getMarketMetadata, getMarkets } from './lib/market-cache';
import type { Market } from '../src/types/market';

type SortMode = 'volume' | 'updated' | 'price';
type Platform = Market['platform'];

function readSingleQueryParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return undefined;
  }

  return value;
}

function isPlatform(value: string | undefined): value is Platform {
  return value === 'polymarket' || value === 'kalshi';
}

function isSortMode(value: string | undefined): value is SortMode {
  return value === 'volume' || value === 'updated' || value === 'price';
}

function sortMarkets(markets: Market[], sort: SortMode): Market[] {
  const sorted = [...markets];

  if (sort === 'updated') {
    sorted.sort(
      (left, right) =>
        new Date(right.lastUpdated).getTime() - new Date(left.lastUpdated).getTime()
    );
    return sorted;
  }

  if (sort === 'price') {
    sorted.sort((left, right) => right.yesPrice - left.yesPrice);
    return sorted;
  }

  sorted.sort((left, right) => right.volume24h - left.volume24h);
  return sorted;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
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
    res.status(405).json({
      success: false,
      error: 'Method not allowed. Use GET.',
    });
    return;
  }

  const startTime = Date.now();

  try {
    const limitRaw = readSingleQueryParam(req.query.limit);
    const platformRaw = readSingleQueryParam(req.query.platform);
    const categoryRaw = readSingleQueryParam(req.query.category);
    const sortRaw = readSingleQueryParam(req.query.sort);

    if (
      (req.query.limit && Array.isArray(req.query.limit)) ||
      (req.query.platform && Array.isArray(req.query.platform)) ||
      (req.query.category && Array.isArray(req.query.category)) ||
      (req.query.sort && Array.isArray(req.query.sort))
    ) {
      res.status(400).json({
        success: false,
        error: 'Duplicate query parameters are not allowed.',
      });
      return;
    }

    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 8;
    const platform = platformRaw?.toLowerCase();
    const category = categoryRaw?.trim();
    const sort = sortRaw?.toLowerCase() || 'volume';

    if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
      res.status(400).json({
        success: false,
        error: 'Invalid limit. Must be between 1 and 100.',
      });
      return;
    }

    if (platform && !isPlatform(platform)) {
      res.status(400).json({
        success: false,
        error: 'Invalid platform. Must be one of: polymarket, kalshi.',
      });
      return;
    }

    if (!isSortMode(sort)) {
      res.status(400).json({
        success: false,
        error: 'Invalid sort. Must be one of: volume, updated, price.',
      });
      return;
    }

    const markets = await getMarkets();

    if (markets.length === 0) {
      res.status(503).json({
        success: false,
        error: 'No markets available. Service temporarily unavailable.',
      });
      return;
    }

    let filtered = markets;

    if (platform) {
      filtered = filtered.filter((market) => market.platform === platform);
    }

    if (category) {
      filtered = filtered.filter((market) => market.category === category);
    }

    const sorted = sortMarkets(filtered, sort).slice(0, limit);
    const freshnessMetadata = getMarketMetadata();

    res.status(200).json({
      success: true,
      data: {
        markets: sorted,
        count: sorted.length,
        timestamp: new Date().toISOString(),
        filters: {
          limit,
          platform: platform || null,
          category: category || null,
          sort,
        },
        metadata: {
          processing_time_ms: Date.now() - startTime,
          markets_analyzed: markets.length,
          data_age_seconds: freshnessMetadata.data_age_seconds,
          fetched_at: freshnessMetadata.fetched_at,
          sources: freshnessMetadata.sources,
        },
      },
    });
  } catch (error) {
    console.error('[Markets API] Error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
