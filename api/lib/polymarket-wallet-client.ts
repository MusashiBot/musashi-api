/**
 * Polymarket public wallet data client.
 *
 * Uses read-only Data API endpoints for wallet activity, open positions, and
 * aggregate position value. No authentication or wallet signing required.
 */

import type {
  WalletActivity,
  WalletActivityType,
  WalletPosition,
} from '../../src/types/wallet';

const POLYMARKET_DATA_API =
  process.env.POLYMARKET_DATA_API_URL || 'https://data-api.polymarket.com';
const FETCH_TIMEOUT_MS = parsePositiveInt(process.env.POLYMARKET_WALLET_TIMEOUT_MS, 10000);

export type PolymarketActivityApiType =
  | 'TRADE'
  | 'SPLIT'
  | 'MERGE'
  | 'REDEEM'
  | 'REWARD'
  | 'CONVERSION'
  | 'MAKER_REBATE'
  | 'REFERRAL_REWARD';

export type PolymarketActivitySortBy = 'TIMESTAMP' | 'TOKENS' | 'CASH';
export type PolymarketActivitySide = 'BUY' | 'SELL';
export type PolymarketPositionSortBy =
  | 'CURRENT'
  | 'INITIAL'
  | 'TOKENS'
  | 'CASHPNL'
  | 'PERCENTPNL'
  | 'TITLE'
  | 'RESOLVING'
  | 'PRICE'
  | 'AVGPRICE';
export type PolymarketSortDirection = 'ASC' | 'DESC';

export interface FetchWalletActivityOptions {
  /** Max activity rows to request. */
  limit?: number;
  /** Pagination offset from Polymarket. */
  offset?: number;
  /** ISO timestamp lower bound. */
  since?: string;
  /** ISO timestamp upper bound. */
  until?: string;
  /** One or more Polymarket condition ids. */
  market?: string | string[];
  /** Polymarket activity types to include. */
  type?: PolymarketActivityApiType | PolymarketActivityApiType[];
  /** Trade side filter. */
  side?: PolymarketActivitySide;
  /** Upstream sort field. */
  sortBy?: PolymarketActivitySortBy;
  /** Upstream sort direction. */
  sortDirection?: PolymarketSortDirection;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

export interface FetchWalletPositionsOptions {
  /** Max position rows to request. */
  limit?: number;
  /** Pagination offset from Polymarket. */
  offset?: number;
  /** One or more Polymarket condition ids. */
  market?: string | string[];
  /** Local post-filter for current position value. */
  minValue?: number;
  /** Upstream minimum token size filter. */
  sizeThreshold?: number;
  /** Upstream sort field. */
  sortBy?: PolymarketPositionSortBy;
  /** Upstream sort direction. */
  sortDirection?: PolymarketSortDirection;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

export interface FetchWalletValueOptions {
  /** One or more Polymarket condition ids. */
  market?: string | string[];
}

export interface FetchMarketTradesOptions {
  /** Max activity rows to request. */
  limit?: number;
  /** Pagination offset from Polymarket. */
  offset?: number;
  /** ISO timestamp lower bound. */
  since?: string;
  /** ISO timestamp upper bound. */
  until?: string;
  /** Trade side filter. */
  side?: PolymarketActivitySide;
  /** Upstream sort field. */
  sortBy?: PolymarketActivitySortBy;
  /** Upstream sort direction. */
  sortDirection?: PolymarketSortDirection;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Fetch recent on-chain wallet activity from Polymarket's public Data API.
 *
 * @param wallet Public Polymarket proxy wallet address.
 * @param options Optional upstream filters and pagination.
 */
export async function fetchWalletActivity(
  wallet: string,
  options: FetchWalletActivityOptions = {},
): Promise<WalletActivity[]> {
  const params = new URLSearchParams({
    user: normalizeWallet(wallet),
    limit: normalizeInteger(options.limit, 100, 1, 500).toString(),
    offset: normalizeInteger(options.offset, 0, 0, 10000).toString(),
    sortBy: options.sortBy || 'TIMESTAMP',
    sortDirection: options.sortDirection || 'DESC',
  });

  appendCsvParam(params, 'market', options.market);
  appendCsvParam(params, 'type', options.type);
  if (options.side) params.set('side', options.side);
  appendUnixTimestampParam(params, 'start', options.since);
  appendUnixTimestampParam(params, 'end', options.until);

  const data = await fetchPolymarketArray('/activity', params, options.timeoutMs);
  return data
    .map(item => toWalletActivity(item, wallet))
    .filter((item): item is WalletActivity => item !== null);
}

/**
 * Fetch current open wallet positions from Polymarket's public Data API.
 *
 * @param wallet Public Polymarket proxy wallet address.
 * @param options Optional upstream filters and pagination.
 */
export async function fetchWalletPositions(
  wallet: string,
  options: FetchWalletPositionsOptions = {},
): Promise<WalletPosition[]> {
  const params = new URLSearchParams({
    user: normalizeWallet(wallet),
    limit: normalizeInteger(options.limit, 100, 1, 500).toString(),
    offset: normalizeInteger(options.offset, 0, 0, 10000).toString(),
    sizeThreshold: normalizeNumber(options.sizeThreshold, 0, 0).toString(),
    sortBy: options.sortBy || 'CURRENT',
    sortDirection: options.sortDirection || 'DESC',
  });

  appendCsvParam(params, 'market', options.market);

  const fetchedAt = new Date().toISOString();
  const data = await fetchPolymarketArray('/positions', params, options.timeoutMs);
  const positions = data
    .map(item => toWalletPosition(item, wallet, fetchedAt))
    .filter((item): item is WalletPosition => item !== null);

  if (options.minValue == null) {
    return positions;
  }

  const minValue = normalizeNumber(options.minValue, 0, 0);
  return positions.filter(position =>
    position.currentValue !== undefined && position.currentValue >= minValue
  );
}

/**
 * Fetch the total current value of a wallet's Polymarket positions.
 *
 * @param wallet Public Polymarket proxy wallet address.
 * @param options Optional market filter.
 */
export async function fetchWalletValue(
  wallet: string,
  options: FetchWalletValueOptions = {},
): Promise<number | null> {
  const params = new URLSearchParams({
    user: normalizeWallet(wallet),
  });

  appendCsvParam(params, 'market', options.market);

  const data = await fetchPolymarketArray('/value', params);
  const row = data.find(isRecord);
  if (!row) return null;

  return getNumber(row.value) ?? null;
}

/**
 * Fetch recent public trades for a Polymarket market.
 *
 * @param market Polymarket condition id accepted by the Data API.
 * @param options Optional upstream filters and pagination.
 */
export async function fetchMarketTrades(
  market: string,
  options: FetchMarketTradesOptions = {},
): Promise<WalletActivity[]> {
  const params = new URLSearchParams({
    market,
    limit: normalizeInteger(options.limit, 100, 1, 500).toString(),
    offset: normalizeInteger(options.offset, 0, 0, 10000).toString(),
    sortBy: options.sortBy || 'TIMESTAMP',
    sortDirection: options.sortDirection || 'DESC',
  });

  if (options.side) params.set('side', options.side);
  appendUnixTimestampParam(params, 'start', options.since);
  appendUnixTimestampParam(params, 'end', options.until);

  const data = await fetchPolymarketArray('/trades', params, options.timeoutMs);
  return data
    .map(item => toWalletTrade(item))
    .filter((item): item is WalletActivity => item !== null);
}

/**
 * Fetch a Data API endpoint and require an array response.
 *
 * @param path Data API path such as /activity or /trades.
 * @param params Already-normalized query params.
 */
async function fetchPolymarketArray(
  path: string,
  params: URLSearchParams,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<unknown[]> {
  const url = buildUrl(path, params);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Polymarket Data API ${path} responded with ${response.status}`);
    }

    const data: unknown = await response.json();
    if (!Array.isArray(data)) {
      throw new Error(`Unexpected Polymarket Data API response shape for ${path}`);
    }

    return data;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Polymarket Data API ${path} timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function toWalletActivity(item: unknown, requestedWallet: string): WalletActivity | null {
  if (!isRecord(item)) return null;

  const timestamp = getIsoTimestamp(item.timestamp);
  if (!timestamp) return null;

  const rawWallet = getString(item.proxyWallet) || requestedWallet;
  if (!rawWallet) return null;

  const wallet = normalizeWallet(rawWallet);
  const conditionId = getString(item.conditionId);
  const tokenId = getString(item.asset);
  const marketSlug = getString(item.slug);
  const eventSlug = getString(item.eventSlug);
  const side = normalizeSide(getString(item.side));
  const price = getNumber(item.price);
  const size = getNumber(item.size);
  const value = getNumber(item.usdcSize) ?? multiplyNumbers(price, size);

  return {
    wallet,
    activityType: normalizeActivityType(getString(item.type)),
    platform: 'polymarket',
    marketId: conditionId ? `polymarket-${conditionId}` : undefined,
    conditionId,
    tokenId,
    marketTitle: getString(item.title),
    marketSlug,
    outcome: getString(item.outcome),
    side,
    price,
    size,
    value,
    timestamp,
    url: buildMarketUrl(eventSlug, marketSlug),
  };
}

function toWalletTrade(item: unknown): WalletActivity | null {
  if (!isRecord(item)) return null;

  const timestamp = getIsoTimestamp(item.timestamp);
  if (!timestamp) return null;

  const rawWallet = getString(item.proxyWallet);
  if (!rawWallet) return null;

  const conditionId = getString(item.conditionId);
  const tokenId = getString(item.asset);
  const marketSlug = getString(item.slug);
  const eventSlug = getString(item.eventSlug);
  const side = normalizeSide(getString(item.side));
  const price = getNumber(item.price);
  const size = getNumber(item.size);
  const value = getNumber(item.usdcSize) ?? multiplyNumbers(price, size);

  return {
    wallet: normalizeWallet(rawWallet),
    activityType: 'trade',
    platform: 'polymarket',
    marketId: conditionId ? `polymarket-${conditionId}` : undefined,
    conditionId,
    tokenId,
    marketTitle: getString(item.title),
    marketSlug,
    outcome: getString(item.outcome),
    side,
    price,
    size,
    value,
    timestamp,
    url: buildMarketUrl(eventSlug, marketSlug),
  };
}

function toWalletPosition(
  item: unknown,
  requestedWallet: string,
  fetchedAt: string,
): WalletPosition | null {
  if (!isRecord(item)) return null;

  const wallet = normalizeWallet(getString(item.proxyWallet) || requestedWallet);
  const conditionId = getString(item.conditionId);
  const tokenId = getString(item.asset);
  const marketSlug = getString(item.slug);
  const eventSlug = getString(item.eventSlug);
  const quantity = getNumber(item.size);

  if (quantity === undefined) return null;

  return {
    wallet,
    platform: 'polymarket',
    marketId: conditionId ? `polymarket-${conditionId}` : undefined,
    conditionId,
    tokenId,
    marketTitle: getString(item.title) || 'Unknown market',
    marketSlug,
    outcome: getString(item.outcome) || 'Unknown',
    quantity,
    averagePrice: getNumber(item.avgPrice),
    currentPrice: getNumber(item.curPrice),
    currentValue: getNumber(item.currentValue),
    realizedPnl: getNumber(item.realizedPnl),
    unrealizedPnl: getNumber(item.cashPnl),
    url: buildMarketUrl(eventSlug, marketSlug),
    updatedAt: fetchedAt,
  };
}

function buildUrl(path: string, params: URLSearchParams): string {
  const baseUrl = POLYMARKET_DATA_API.endsWith('/')
    ? POLYMARKET_DATA_API
    : `${POLYMARKET_DATA_API}/`;
  const url = new URL(path.replace(/^\//, ''), baseUrl);
  params.forEach((value, key) => url.searchParams.set(key, value));
  return url.toString();
}

function buildMarketUrl(eventSlug?: string, marketSlug?: string): string | undefined {
  const slug = eventSlug || marketSlug;
  return slug ? `https://polymarket.com/event/${slug}` : undefined;
}

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

function normalizeActivityType(type?: string): WalletActivityType {
  switch (type?.toUpperCase()) {
    case 'TRADE':
      return 'trade';
    case 'REDEEM':
      return 'redeemed';
    default:
      return 'unknown';
  }
}

function normalizeSide(side?: string): 'buy' | 'sell' | undefined {
  if (side?.toUpperCase() === 'BUY') return 'buy';
  if (side?.toUpperCase() === 'SELL') return 'sell';
  return undefined;
}

function appendCsvParam(
  params: URLSearchParams,
  key: string,
  value?: string | string[],
): void {
  if (Array.isArray(value) && value.length > 0) {
    params.set(key, value.join(','));
  } else if (typeof value === 'string' && value.length > 0) {
    params.set(key, value);
  }
}

function appendUnixTimestampParam(
  params: URLSearchParams,
  key: string,
  value?: string,
): void {
  if (!value) return;

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid ${key} timestamp. Use ISO 8601 format.`);
  }

  params.set(key, Math.floor(timestamp / 1000).toString());
}

function getIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }

  if (typeof value === 'string' && value.length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return getIsoTimestamp(numeric);
    }

    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function multiplyNumbers(left?: number, right?: number): number | undefined {
  if (left === undefined || right === undefined) return undefined;
  return left * right;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Expected integer between ${min} and ${max}.`);
  }

  return value;
}

function normalizeNumber(
  value: number | undefined,
  fallback: number,
  min: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`Expected number greater than or equal to ${min}.`);
  }

  return value;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
