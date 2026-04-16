import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Market } from '../../src/types/market';
import type { MarketWalletFlow, WalletActivity } from '../../src/types/wallet';
import { getMarketMetadata, getMarkets } from '../lib/market-cache';
import {
  type CachedMarketWalletFlow,
  getCachedMarketWalletFlow,
  getMarketWalletFlowKey,
  getStaleWalletMemoryCache,
  setCachedMarketWalletFlow,
} from '../lib/wallet-cache';
import {
  getMarketWalletFlow,
  resolveMarketWalletFlowCacheId,
} from '../lib/wallet-flow';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_WINDOW: MarketWalletFlow['window'] = '24h';
const VALID_WINDOWS = new Set(['1h', '24h', '7d']);

interface ParseError {
  error: string;
}

interface MarketWalletFlowFilters {
  marketId?: string;
  conditionId?: string;
  query?: string;
  window: MarketWalletFlow['window'];
  limit: number;
}

interface MarketWalletFlowResponse {
  success: true;
  data: {
    flow: MarketWalletFlow;
    activity: WalletActivity[];
    count: number;
    market: Market | null;
    flow_agrees_with_price_move: boolean | null;
  };
  filters: MarketWalletFlowFilters;
  timestamp: string;
  metadata: {
    source: 'polymarket';
    processing_time_ms: number;
    cached: boolean;
    cached_at?: string | null;
    cache_age_seconds: number | null;
    market_match_confidence?: number;
    activities_analyzed: number;
    data_age_seconds?: number;
    fetched_at?: string;
    sources?: Record<string, unknown>;
  };
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
    const filters = parseFilters(req);
    if ('error' in filters) {
      res.status(400).json({
        success: false,
        error: filters.error,
      });
      return;
    }

    const markets = await loadMarketsForFilters(filters);
    const cacheId = resolveMarketWalletFlowCacheId(filters, markets);
    if (!cacheId) {
      res.status(400).json({
        success: false,
        error: 'Could not resolve market. Provide a valid marketId, conditionId, or query.',
      });
      return;
    }

    const cached = await getCachedMarketWalletFlow(cacheId, filters.window);
    if (cached) {
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
      res.status(200).json(buildResponse(
        filters,
        cached.data.flow,
        cached.data.activity,
        cached.data.market ?? null,
        cached.data.matchConfidence,
        cached.data.flowAgreesWithPriceMove,
        startTime,
        true,
        cached.cached_at,
        cached.cache_age_seconds,
        cached.data.activitiesAnalyzed,
      ));
      return;
    }

    const result = await getMarketWalletFlow(filters, markets);
    await setCachedMarketWalletFlow(cacheId, filters.window, {
      flow: result.flow,
      activity: result.activity,
      market: result.market ?? null,
      matchConfidence: result.matchConfidence,
      flowAgreesWithPriceMove: result.flowAgreesWithPriceMove,
      activitiesAnalyzed: result.activitiesAnalyzed,
    });

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json(buildResponse(
      filters,
      result.flow,
      result.activity,
      result.market || null,
      result.matchConfidence,
      result.flowAgreesWithPriceMove,
      startTime,
      false,
      null,
      null,
      result.activitiesAnalyzed,
    ));
  } catch (error) {
    const fallback = await getStaleFlow(req);
    if (fallback) {
      res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
      res.status(200).json(buildResponse(
        fallback.filters,
        fallback.cached.data.flow,
        fallback.cached.data.activity,
        fallback.cached.data.market ?? null,
        fallback.cached.data.matchConfidence,
        fallback.cached.data.flowAgreesWithPriceMove,
        startTime,
        true,
        fallback.cached.cached_at,
        fallback.cached.cache_age_seconds,
        fallback.cached.data.activitiesAnalyzed,
      ));
      return;
    }

    const message = error instanceof Error ? error.message : 'Market wallet flow temporarily unavailable.';
    const status = isClientError(message) ? 400 : 503;
    console.error('[Market Wallet Flow API] Error:', error);
    res.status(status).json({
      success: false,
      error: status === 400 ? message : 'Market wallet flow temporarily unavailable. Try again later.',
      metadata: {
        processing_time_ms: Date.now() - startTime,
      },
    });
  }
}

/**
 * Parse and validate market wallet-flow query filters.
 *
 * @param req Vercel request with market identity params.
 */
function parseFilters(req: VercelRequest): MarketWalletFlowFilters | { error: string } {
  const marketId = getSingleQueryValue(req.query.marketId)?.trim();
  const conditionId = getSingleQueryValue(req.query.conditionId)?.trim();
  const query = getSingleQueryValue(req.query.query)?.trim();

  if (!marketId && !conditionId && !query) {
    return { error: 'Missing market identity. Use marketId, conditionId, or query.' };
  }

  const windowResult = parseWindow(getSingleQueryValue(req.query.window));
  if (isParseError(windowResult)) {
    return windowResult;
  }

  const limit = parseLimit(getSingleQueryValue(req.query.limit));
  if (typeof limit === 'string') {
    return { error: limit };
  }

  return {
    marketId,
    conditionId,
    query,
    window: windowResult,
    limit,
  };
}

/**
 * Build the market wallet-flow response envelope.
 *
 * @param filters Validated query filters.
 * @param flow Aggregated wallet flow.
 * @param activity Recent activity rows.
 * @param market Matched Musashi market.
 * @param matchConfidence Query match confidence.
 * @param agrees Whether flow matches price movement.
 * @param startTime Request start time in milliseconds.
 * @param cached Whether the data came from cache.
 * @param cachedAt Cache write timestamp.
 * @param cacheAgeSeconds Cache age in seconds.
 * @param activitiesAnalyzed Upstream rows used for aggregation.
 */
function buildResponse(
  filters: MarketWalletFlowFilters,
  flow: MarketWalletFlow,
  activity: WalletActivity[],
  market: Market | null,
  matchConfidence: number | undefined | null,
  agrees: boolean | null,
  startTime: number,
  cached: boolean,
  cachedAt: string | null,
  cacheAgeSeconds: number | null,
  activitiesAnalyzed = activity.length,
): MarketWalletFlowResponse {
  const freshness = getMarketMetadata();

  return {
    success: true,
    data: {
      flow,
      activity,
      count: activity.length,
      market,
      flow_agrees_with_price_move: agrees,
    },
    filters,
    timestamp: new Date().toISOString(),
    metadata: {
      source: 'polymarket',
      processing_time_ms: Date.now() - startTime,
      cached,
      cached_at: cachedAt,
      cache_age_seconds: cacheAgeSeconds,
      market_match_confidence: matchConfidence ?? undefined,
      activities_analyzed: activitiesAnalyzed,
      data_age_seconds: freshness.data_age_seconds,
      fetched_at: freshness.fetched_at,
      sources: freshness.sources,
    },
  };
}

async function loadMarketsForFilters(filters: MarketWalletFlowFilters): Promise<Market[]> {
  if (!filters.query && !filters.marketId && !filters.conditionId) return [];
  try {
    return await getMarkets();
  } catch (error) {
    console.warn('[Market Wallet Flow API] Market cache unavailable:', error);
    return [];
  }
}

async function getStaleFlow(req: VercelRequest): Promise<{
  filters: MarketWalletFlowFilters;
  cached: {
    data: CachedMarketWalletFlow;
    cached_at: string | null;
    cache_age_seconds: number | null;
  };
} | null> {
  const filters = parseFilters(req);
  if ('error' in filters) return null;

  const cacheId = resolveMarketWalletFlowCacheId(filters, []);
  if (!cacheId) return null;

  const key = getMarketWalletFlowKey(cacheId, filters.window);
  const stale = getStaleWalletMemoryCache<CachedMarketWalletFlow>(key);
  if (!stale) return null;

  return {
    filters,
    cached: stale,
  };
}

function parseWindow(value: string | undefined): MarketWalletFlow['window'] | ParseError {
  if (value === undefined) return DEFAULT_WINDOW;
  if (!VALID_WINDOWS.has(value)) {
    return { error: 'Invalid window. Must be one of 1h, 24h, or 7d.' };
  }
  return value as MarketWalletFlow['window'];
}

function parseLimit(value: string | undefined): number | string {
  if (value === undefined) return DEFAULT_LIMIT;

  if (!/^\d+$/.test(value)) {
    return `Invalid limit. Must be between 1 and ${MAX_LIMIT}.`;
  }

  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return `Invalid limit. Must be between 1 and ${MAX_LIMIT}.`;
  }

  return limit;
}

function isClientError(message: string): boolean {
  return message.includes('Missing market identity') || message.includes('Could not resolve market');
}

function isParseError(value: unknown): value is ParseError {
  return typeof value === 'object' && value !== null && 'error' in value;
}

function getSingleQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
