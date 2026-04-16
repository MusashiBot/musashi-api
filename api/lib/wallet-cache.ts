/**
 * Wallet cache helpers.
 *
 * Uses a warm-lambda memory cache first, then the existing KV wrapper for
 * shared short-lived wallet intelligence responses.
 */

import type {
  MarketWalletFlow,
  SmartMoneyMarket,
  WalletActivity,
  WalletPosition,
} from '../../src/types/wallet';
import type { Market } from '../../src/types/market';
import { kv, setKvWithTtl } from './vercel-kv';

export const WALLET_ACTIVITY_TTL_SECONDS = parsePositiveInt(
  process.env.WALLET_ACTIVITY_CACHE_TTL_SECONDS,
  30,
);
export const WALLET_POSITIONS_TTL_SECONDS = parsePositiveInt(
  process.env.WALLET_POSITIONS_CACHE_TTL_SECONDS,
  60,
);
export const WALLET_VALUE_TTL_SECONDS = parsePositiveInt(
  process.env.WALLET_VALUE_CACHE_TTL_SECONDS,
  60,
);
export const MARKET_WALLET_FLOW_TTL_SECONDS = parsePositiveInt(
  process.env.MARKET_WALLET_FLOW_CACHE_TTL_SECONDS,
  30,
);
export const SMART_MONEY_MARKETS_TTL_SECONDS = parsePositiveInt(
  process.env.SMART_MONEY_MARKETS_CACHE_TTL_SECONDS,
  60,
);

export interface WalletCacheEntry<T> {
  data: T;
  cached_at: string;
}

export interface WalletCacheHit<T> {
  data: T;
  cached: boolean;
  cached_at: string | null;
  cache_age_seconds: number | null;
}

export interface CachedMarketWalletFlow {
  flow: MarketWalletFlow;
  activity: WalletActivity[];
  market: Market | null;
  matchConfidence?: number;
  flowAgreesWithPriceMove: boolean | null;
  activitiesAnalyzed: number;
}

const memoryCache = new Map<string, {
  entry: WalletCacheEntry<unknown>;
  expiresAt: number;
}>();

/**
 * Cache recent wallet activity for a normalized wallet query.
 *
 * @param wallet Public Polymarket wallet address.
 * @param limit Activity row limit.
 * @param since Optional ISO lower bound.
 */
export async function getCachedWalletActivity(
  wallet: string,
  limit: number,
  since?: string,
): Promise<WalletCacheHit<WalletActivity[]> | null> {
  return getWalletCache<WalletActivity[]>(getWalletActivityKey(wallet, limit, since));
}

/**
 * Store recent wallet activity for a normalized wallet query.
 *
 * @param wallet Public Polymarket wallet address.
 * @param limit Activity row limit.
 * @param since Optional ISO lower bound.
 * @param activity Normalized activity rows.
 */
export async function setCachedWalletActivity(
  wallet: string,
  limit: number,
  since: string | undefined,
  activity: WalletActivity[],
): Promise<WalletCacheEntry<WalletActivity[]>> {
  return setWalletCache(
    getWalletActivityKey(wallet, limit, since),
    activity,
    WALLET_ACTIVITY_TTL_SECONDS,
  );
}

/**
 * Cache current open positions for a normalized wallet query.
 *
 * @param wallet Public Polymarket wallet address.
 * @param minValue Current-value filter.
 * @param limit Position row limit.
 */
export async function getCachedWalletPositions(
  wallet: string,
  minValue: number,
  limit: number,
): Promise<WalletCacheHit<WalletPosition[]> | null> {
  return getWalletCache<WalletPosition[]>(getWalletPositionsKey(wallet, minValue, limit));
}

/**
 * Store current open positions for a normalized wallet query.
 *
 * @param wallet Public Polymarket wallet address.
 * @param minValue Current-value filter.
 * @param limit Position row limit.
 * @param positions Normalized position rows.
 */
export async function setCachedWalletPositions(
  wallet: string,
  minValue: number,
  limit: number,
  positions: WalletPosition[],
): Promise<WalletCacheEntry<WalletPosition[]>> {
  return setWalletCache(
    getWalletPositionsKey(wallet, minValue, limit),
    positions,
    WALLET_POSITIONS_TTL_SECONDS,
  );
}

/**
 * Cache total wallet position value.
 *
 * @param wallet Public Polymarket wallet address.
 */
export async function getCachedWalletValue(
  wallet: string,
): Promise<WalletCacheHit<number | null> | null> {
  return getWalletCache<number | null>(getWalletValueKey(wallet));
}

/**
 * Store total wallet position value.
 *
 * @param wallet Public Polymarket wallet address.
 * @param value Total current position value.
 */
export async function setCachedWalletValue(
  wallet: string,
  value: number | null,
): Promise<WalletCacheEntry<number | null>> {
  return setWalletCache(getWalletValueKey(wallet), value, WALLET_VALUE_TTL_SECONDS);
}

/**
 * Cache derived market wallet flow by market identity and window.
 *
 * @param marketId Musashi or Polymarket market id.
 * @param window Flow aggregation window.
 * @param limit Activity row limit used for aggregation.
 */
export async function getCachedMarketWalletFlow(
  marketId: string,
  window: MarketWalletFlow['window'],
  limit: number,
): Promise<WalletCacheHit<CachedMarketWalletFlow> | null> {
  return getWalletCache<CachedMarketWalletFlow>(getMarketWalletFlowKey(marketId, window, limit));
}

/**
 * Store derived market wallet flow by market identity and window.
 *
 * @param marketId Musashi or Polymarket market id.
 * @param window Flow aggregation window.
 * @param limit Activity row limit used for aggregation.
 * @param flow Normalized wallet flow.
 */
export async function setCachedMarketWalletFlow(
  marketId: string,
  window: MarketWalletFlow['window'],
  limit: number,
  flow: CachedMarketWalletFlow,
): Promise<WalletCacheEntry<CachedMarketWalletFlow>> {
  return setWalletCache(
    getMarketWalletFlowKey(marketId, window, limit),
    flow,
    MARKET_WALLET_FLOW_TTL_SECONDS,
  );
}

/**
 * Cache ranked smart-money markets for a filter set.
 *
 * @param category Optional Musashi category filter.
 * @param window Ranking window.
 * @param minVolume Minimum flow volume.
 * @param limit Ranked market limit.
 */
export async function getCachedSmartMoneyMarkets(
  category: string | undefined,
  window: MarketWalletFlow['window'],
  minVolume: number,
  limit: number,
): Promise<WalletCacheHit<SmartMoneyMarket[]> | null> {
  return getWalletCache<SmartMoneyMarket[]>(
    getSmartMoneyMarketsKey(category, window, minVolume, limit),
  );
}

/**
 * Store ranked smart-money markets for a filter set.
 *
 * @param category Optional Musashi category filter.
 * @param window Ranking window.
 * @param minVolume Minimum flow volume.
 * @param limit Ranked market limit.
 * @param markets Ranked market rows.
 */
export async function setCachedSmartMoneyMarkets(
  category: string | undefined,
  window: MarketWalletFlow['window'],
  minVolume: number,
  limit: number,
  markets: SmartMoneyMarket[],
): Promise<WalletCacheEntry<SmartMoneyMarket[]>> {
  return setWalletCache(
    getSmartMoneyMarketsKey(category, window, minVolume, limit),
    markets,
    SMART_MONEY_MARKETS_TTL_SECONDS,
  );
}

/**
 * Build the wallet activity cache key.
 *
 * @param wallet Public Polymarket wallet address.
 * @param limit Activity row limit.
 * @param since Optional ISO lower bound.
 */
export function getWalletActivityKey(wallet: string, limit: number, since?: string): string {
  return `wallet:activity:${normalizeKeyPart(wallet)}:${limit}:${hashKeyPart(since || 'none')}`;
}

/**
 * Build the wallet positions cache key.
 *
 * @param wallet Public Polymarket wallet address.
 * @param minValue Current-value filter.
 * @param limit Position row limit.
 */
export function getWalletPositionsKey(wallet: string, minValue: number, limit: number): string {
  return `wallet:positions:${normalizeKeyPart(wallet)}:${normalizeNumberKey(minValue)}:${limit}`;
}

/**
 * Build the wallet value cache key.
 *
 * @param wallet Public Polymarket wallet address.
 */
export function getWalletValueKey(wallet: string): string {
  return `wallet:value:${normalizeKeyPart(wallet)}`;
}

/**
 * Build the market wallet-flow cache key.
 *
 * @param marketId Musashi or Polymarket market id.
 * @param window Flow aggregation window.
 * @param limit Activity row limit used for aggregation.
 */
export function getMarketWalletFlowKey(
  marketId: string,
  window: MarketWalletFlow['window'],
  limit: number,
): string {
  return `market:wallet_flow:v3:${normalizeKeyPart(marketId)}:${window}:${limit}`;
}

/**
 * Build the smart-money ranking cache key.
 *
 * @param category Optional Musashi category filter.
 * @param window Ranking window.
 * @param minVolume Minimum flow volume.
 * @param limit Ranked market limit.
 */
export function getSmartMoneyMarketsKey(
  category: string | undefined,
  window: MarketWalletFlow['window'],
  minVolume: number,
  limit: number,
): string {
  return [
    'smart_money:markets',
    normalizeKeyPart(category || 'all'),
    window,
    normalizeNumberKey(minVolume),
    limit,
  ].join(':');
}

export function clearWalletMemoryCache(): void {
  memoryCache.clear();
}

/**
 * Return stale warm-lambda data when upstream/KV is unavailable.
 *
 * @param key Full wallet cache key.
 */
export function getStaleWalletMemoryCache<T>(key: string): WalletCacheHit<T> | null {
  const cached = memoryCache.get(key);
  return cached ? toCacheHit(cached.entry as WalletCacheEntry<T>) : null;
}

async function getWalletCache<T>(key: string): Promise<WalletCacheHit<T> | null> {
  const memoryEntry = getMemoryEntry<T>(key);
  if (memoryEntry) {
    return toCacheHit(memoryEntry);
  }

  try {
    const kvEntry = await kv.get<WalletCacheEntry<T>>(key);
    if (!isCacheEntry(kvEntry)) return null;

    memoryCache.set(key, {
      entry: kvEntry,
      expiresAt: Date.now() + getRemainingTtlMs(key, kvEntry),
    });

    return toCacheHit(kvEntry);
  } catch (error) {
    console.warn(`[Wallet Cache] KV read failed for ${key}:`, getErrorMessage(error));
    return null;
  }
}

async function setWalletCache<T>(
  key: string,
  data: T,
  ttlSeconds: number,
): Promise<WalletCacheEntry<T>> {
  const entry: WalletCacheEntry<T> = {
    data,
    cached_at: new Date().toISOString(),
  };

  memoryCache.set(key, {
    entry,
    expiresAt: Date.now() + (ttlSeconds * 1000),
  });

  try {
    await setKvWithTtl(key, ttlSeconds, entry);
  } catch (error) {
    console.warn(`[Wallet Cache] KV write failed for ${key}:`, getErrorMessage(error));
  }

  return entry;
}

function getMemoryEntry<T>(key: string): WalletCacheEntry<T> | null {
  const cached = memoryCache.get(key);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    return null;
  }

  return cached.entry as WalletCacheEntry<T>;
}

function toCacheHit<T>(entry: WalletCacheEntry<T>): WalletCacheHit<T> {
  return {
    data: entry.data,
    cached: true,
    cached_at: entry.cached_at,
    cache_age_seconds: getCacheAgeSeconds(entry.cached_at),
  };
}

function isCacheEntry<T>(value: unknown): value is WalletCacheEntry<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    typeof (value as { cached_at?: unknown }).cached_at === 'string'
  );
}

function getRemainingTtlMs(key: string, entry: WalletCacheEntry<unknown>): number {
  const cachedAt = Date.parse(entry.cached_at);
  if (Number.isNaN(cachedAt)) return 0;

  return Math.max(0, cachedAt + (getTtlSecondsForKey(key) * 1000) - Date.now());
}

function getTtlSecondsForKey(key: string): number {
  if (key.startsWith('wallet:activity:')) return WALLET_ACTIVITY_TTL_SECONDS;
  if (key.startsWith('wallet:positions:')) return WALLET_POSITIONS_TTL_SECONDS;
  if (key.startsWith('wallet:value:')) return WALLET_VALUE_TTL_SECONDS;
  if (key.startsWith('market:wallet_flow:')) return MARKET_WALLET_FLOW_TTL_SECONDS;
  if (key.startsWith('smart_money:markets:')) return SMART_MONEY_MARKETS_TTL_SECONDS;
  return WALLET_POSITIONS_TTL_SECONDS;
}

function getCacheAgeSeconds(cachedAt: string): number | null {
  const parsed = Date.parse(cachedAt);
  if (Number.isNaN(parsed)) return null;

  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

function normalizeKeyPart(value: string): string {
  return encodeURIComponent(value.trim().toLowerCase());
}

function normalizeNumberKey(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(4);
}

function hashKeyPart(value: string): string {
  let hash = 5381;

  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash) + value.charCodeAt(index);
    hash &= 0xffffffff;
  }

  return (hash >>> 0).toString(36);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
