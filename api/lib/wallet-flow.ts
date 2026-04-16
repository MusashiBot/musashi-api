import type { Market } from '../../src/types/market';
import type { MarketWalletFlow, WalletActivity } from '../../src/types/wallet';
import { fetchMarketTrades } from './polymarket-wallet-client';

export interface MarketWalletFlowInput {
  /** Musashi market id, usually polymarket-{conditionId}. */
  marketId?: string;
  /** Polymarket condition id. */
  conditionId?: string;
  /** Text used to resolve a market when ids are unavailable. */
  query?: string;
  /** Aggregation window. */
  window: MarketWalletFlow['window'];
  /** Activity row limit. */
  limit: number;
  /** Optional per-request upstream timeout in milliseconds. */
  timeoutMs?: number;
}

export interface MarketWalletFlowResult {
  flow: MarketWalletFlow;
  activity: WalletActivity[];
  market?: Market;
  matchConfidence?: number;
  flowAgreesWithPriceMove: boolean | null;
  activitiesAnalyzed: number;
}

interface ResolvedMarket {
  marketId?: string;
  conditionId?: string;
  marketTitle?: string;
  market?: Market;
  matchConfidence?: number;
}

interface DirectionalFlow {
  yesVolume: number;
  noVolume: number;
}

const LARGE_TRADE_MIN_VALUE = parsePositiveNumber(
  process.env.MARKET_WALLET_FLOW_LARGE_TRADE_USD,
  100,
);
const SMART_WALLET_MIN_VOLUME = parsePositiveNumber(
  process.env.SMART_WALLET_MIN_FLOW_USD,
  500,
);

/**
 * Fetch and aggregate recent wallet flow for one market.
 *
 * @param input Market identity and aggregation filters.
 * @param markets Optional cached market list for query resolution.
 */
export async function getMarketWalletFlow(
  input: MarketWalletFlowInput,
  markets: Market[] = [],
): Promise<MarketWalletFlowResult> {
  const resolved = resolveMarket(input, markets);
  const marketFilter = resolved.conditionId || stripPolymarketPrefix(resolved.marketId || '');

  if (!marketFilter) {
    if (input.query) {
      throw new Error('Could not resolve market query. Try marketId or conditionId.');
    }
    throw new Error('Missing market identity. Provide marketId, conditionId, or query.');
  }

  const activity = await fetchMarketTrades(marketFilter, {
    limit: input.limit,
    since: getWindowStart(input.window),
    timeoutMs: input.timeoutMs,
  });
  const flow = aggregateWalletFlow(activity, input.window, resolved);

  return {
    flow,
    activity,
    market: resolved.market,
    matchConfidence: resolved.matchConfidence,
    flowAgreesWithPriceMove: compareFlowWithPriceMove(flow, resolved.market),
    activitiesAnalyzed: activity.length,
  };
}

/**
 * Resolve the stable cache id before fetching wallet flow.
 *
 * @param input Market identity filters.
 * @param markets Optional cached market list.
 */
export function resolveMarketWalletFlowCacheId(
  input: Pick<MarketWalletFlowInput, 'marketId' | 'conditionId' | 'query'>,
  markets: Market[] = [],
): string {
  const resolved = resolveMarket({ ...input, window: '24h', limit: 1 }, markets);
  return resolved.marketId || resolved.conditionId || normalizeQuery(input.query || '');
}

function aggregateWalletFlow(
  activity: WalletActivity[],
  window: MarketWalletFlow['window'],
  market: ResolvedMarket,
): MarketWalletFlow {
  const wallets = new Set<string>();
  const walletVolumes = new Map<string, number>();
  let buyVolume = 0;
  let sellVolume = 0;
  let yesVolume = 0;
  let noVolume = 0;

  for (const item of activity) {
    wallets.add(item.wallet);

    const value = item.value ?? 0;
    if (item.side === 'buy') buyVolume += value;
    if (item.side === 'sell') sellVolume += value;

    const direction = getDirectionalFlow(item);
    yesVolume += direction.yesVolume;
    noVolume += direction.noVolume;
    walletVolumes.set(item.wallet, (walletVolumes.get(item.wallet) || 0) + value);
  }

  const smartWalletCount = [...walletVolumes.values()]
    .filter(value => value >= SMART_WALLET_MIN_VOLUME)
    .length;
  const largeTrades = activity
    .filter(item => (item.value ?? 0) >= LARGE_TRADE_MIN_VALUE)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, 10);
  const netVolume = yesVolume - noVolume;

  return {
    marketId: market.marketId,
    conditionId: market.conditionId,
    marketTitle: market.marketTitle,
    window,
    walletCount: wallets.size,
    smartWalletCount,
    buyVolume: roundCurrency(buyVolume),
    sellVolume: roundCurrency(sellVolume),
    netVolume: roundCurrency(netVolume),
    netDirection: getNetDirection(yesVolume, noVolume),
    largeTrades,
  };
}

function resolveMarket(input: MarketWalletFlowInput, markets: Market[]): ResolvedMarket {
  const marketId = input.marketId?.trim();
  const conditionId = input.conditionId?.trim() || stripPolymarketPrefix(marketId || '');
  const exactMarket = findExactMarket(markets, marketId, conditionId);

  if (exactMarket) {
    return {
      marketId: exactMarket.id,
      conditionId: stripPolymarketPrefix(exactMarket.id),
      marketTitle: exactMarket.title,
      market: exactMarket,
      matchConfidence: 1,
    };
  }

  if (marketId || conditionId) {
    return {
      marketId: marketId || (conditionId ? `polymarket-${conditionId}` : undefined),
      conditionId,
    };
  }

  const query = normalizeQuery(input.query || '');
  if (!query) {
    return {};
  }

  const match = findQueryMarket(markets, query);
  if (!match) {
    return {};
  }

  return {
    marketId: match.market.id,
    conditionId: stripPolymarketPrefix(match.market.id),
    marketTitle: match.market.title,
    market: match.market,
    matchConfidence: match.confidence,
  };
}

function findExactMarket(
  markets: Market[],
  marketId?: string,
  conditionId?: string,
): Market | undefined {
  const normalizedMarketId = marketId?.toLowerCase();
  const normalizedConditionId = conditionId?.toLowerCase();

  return markets.find(market => {
    if (market.platform !== 'polymarket') return false;
    if (normalizedMarketId && market.id.toLowerCase() === normalizedMarketId) return true;
    if (normalizedConditionId && stripPolymarketPrefix(market.id).toLowerCase() === normalizedConditionId) return true;
    return false;
  });
}

function findQueryMarket(markets: Market[], query: string): { market: Market; confidence: number } | null {
  const queryTokens = tokenize(query);
  let best: { market: Market; confidence: number } | null = null;

  for (const market of markets) {
    if (market.platform !== 'polymarket') continue;

    const haystack = `${market.title} ${market.description} ${(market.keywords || []).join(' ')}`.toLowerCase();
    const directHit = haystack.includes(query);
    const overlap = queryTokens.filter(token => haystack.includes(token)).length;
    const confidence = directHit
      ? 0.95
      : queryTokens.length > 0
        ? Math.min(0.9, overlap / queryTokens.length)
        : 0;

    if (confidence > (best?.confidence || 0)) {
      best = { market, confidence };
    }
  }

  return best && best.confidence >= 0.35 ? best : null;
}

function getDirectionalFlow(item: WalletActivity): DirectionalFlow {
  const value = item.value ?? 0;
  const outcome = (item.outcome || '').toLowerCase();

  if (outcome.includes('yes')) {
    return item.side === 'sell'
      ? { yesVolume: 0, noVolume: value }
      : { yesVolume: value, noVolume: 0 };
  }

  if (outcome.includes('no')) {
    return item.side === 'sell'
      ? { yesVolume: value, noVolume: 0 }
      : { yesVolume: 0, noVolume: value };
  }

  if (item.side === 'buy') return { yesVolume: value, noVolume: 0 };
  if (item.side === 'sell') return { yesVolume: 0, noVolume: value };
  return { yesVolume: 0, noVolume: 0 };
}

function getNetDirection(
  yesVolume: number,
  noVolume: number,
): MarketWalletFlow['netDirection'] {
  const total = yesVolume + noVolume;
  if (total <= 0) return 'unknown';

  const diff = yesVolume - noVolume;
  if (Math.abs(diff) / total < 0.1) return 'mixed';
  return diff > 0 ? 'YES' : 'NO';
}

function compareFlowWithPriceMove(flow: MarketWalletFlow, market?: Market): boolean | null {
  if (market?.oneDayPriceChange === undefined || flow.netDirection === 'unknown' || flow.netDirection === 'mixed') {
    return null;
  }

  if (market.oneDayPriceChange === 0) return null;
  return (market.oneDayPriceChange > 0 && flow.netDirection === 'YES') ||
    (market.oneDayPriceChange < 0 && flow.netDirection === 'NO');
}

function getWindowStart(window: MarketWalletFlow['window']): string {
  const hours = window === '1h' ? 1 : window === '7d' ? 24 * 7 : 24;
  return new Date(Date.now() - (hours * 60 * 60 * 1000)).toISOString();
}

function stripPolymarketPrefix(value: string): string {
  return value.replace(/^polymarket-/i, '').trim();
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3);
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
