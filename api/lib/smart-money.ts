import type { Market } from '../../src/types/market';
import type { MarketWalletFlow, SmartMoneyMarket } from '../../src/types/wallet';
import { getMarketWalletFlow } from './wallet-flow';

export interface SmartMoneyMarketsInput {
  /** Optional Musashi category filter. */
  category?: string;
  /** Wallet-flow aggregation window. */
  window: MarketWalletFlow['window'];
  /** Minimum total wallet-flow volume. */
  minVolume: number;
  /** Max ranked markets to return. */
  limit: number;
  /** Activity rows requested per market. */
  flowLimit?: number;
  /** Candidate markets analyzed before ranking. */
  candidateLimit?: number;
}

export interface SmartMoneyMarketsResult {
  markets: SmartMoneyMarket[];
  candidatesAnalyzed: number;
  candidatesAttempted: number;
  flowResults: number;
  timedOut: boolean;
}

interface FlowCollectionResult {
  rows: Array<{ market: Market; flow: MarketWalletFlow }>;
  candidatesAttempted: number;
  requestsFulfilled: number;
  requestsRejected: number;
  timedOut: boolean;
}

const DEFAULT_CANDIDATE_LIMIT = parsePositiveInt(process.env.SMART_MONEY_CANDIDATE_LIMIT, 12);
const MAX_CANDIDATE_LIMIT = parsePositiveInt(process.env.SMART_MONEY_MAX_CANDIDATES, 30);
const DEFAULT_FLOW_LIMIT = parsePositiveInt(process.env.SMART_MONEY_FLOW_ACTIVITY_LIMIT, 20);
const FLOW_BATCH_SIZE = parsePositiveInt(process.env.SMART_MONEY_FLOW_BATCH_SIZE, 3);
const FLOW_REQUEST_TIMEOUT_MS = parsePositiveInt(process.env.SMART_MONEY_FLOW_TIMEOUT_MS, 1200);
const TIME_BUDGET_MS = parsePositiveInt(process.env.SMART_MONEY_TIME_BUDGET_MS, 3500);
const MIN_REQUEST_TIMEOUT_MS = 500;

/**
 * Rank Polymarket markets by recent smart-wallet flow.
 *
 * @param allMarkets Cached Musashi market list.
 * @param input Ranking filters and limits.
 */
export async function getSmartMoneyMarkets(
  allMarkets: Market[],
  input: SmartMoneyMarketsInput,
): Promise<SmartMoneyMarketsResult> {
  const candidates = selectCandidates(allMarkets, input);
  const flowCollection = await collectMarketFlows(candidates, input);
  if (
    flowCollection.candidatesAttempted > 0 &&
    flowCollection.requestsFulfilled === 0 &&
    flowCollection.requestsRejected > 0
  ) {
    throw new Error('All smart-money wallet-flow requests failed.');
  }

  const flowResults = flowCollection.rows;
  const ranked = flowResults
    .map(({ market, flow }) => toSmartMoneyMarket(market, flow))
    .filter((market): market is SmartMoneyMarket =>
      market !== null && getFlowVolume(market.flow) >= input.minVolume
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit);

  return {
    markets: ranked,
    candidatesAnalyzed: candidates.length,
    candidatesAttempted: flowCollection.candidatesAttempted,
    flowResults: flowResults.length,
    timedOut: flowCollection.timedOut,
  };
}

function selectCandidates(markets: Market[], input: SmartMoneyMarketsInput): Market[] {
  const category = input.category?.trim().toLowerCase();
  const candidateLimit = normalizeCandidateLimit(input);

  return markets
    .filter(market => market.platform === 'polymarket')
    .filter(market => !category || market.category.toLowerCase() === category)
    .sort((a, b) => getMarketActivityScore(b) - getMarketActivityScore(a))
    .slice(0, candidateLimit);
}

async function collectMarketFlows(
  candidates: Market[],
  input: SmartMoneyMarketsInput,
): Promise<FlowCollectionResult> {
  const rows: Array<{ market: Market; flow: MarketWalletFlow }> = [];
  const flowLimit = normalizeFlowLimit(input.flowLimit);
  const deadline = Date.now() + TIME_BUDGET_MS;
  let candidatesAttempted = 0;
  let requestsFulfilled = 0;
  let requestsRejected = 0;
  let timedOut = false;

  for (let index = 0; index < candidates.length; index += FLOW_BATCH_SIZE) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= MIN_REQUEST_TIMEOUT_MS) {
      timedOut = true;
      break;
    }

    const batch = candidates.slice(index, index + FLOW_BATCH_SIZE);
    candidatesAttempted += batch.length;
    const timeoutMs = Math.max(
      MIN_REQUEST_TIMEOUT_MS,
      Math.min(FLOW_REQUEST_TIMEOUT_MS, remainingMs),
    );
    const settled = await Promise.allSettled(
      batch.map(async market => {
        const result = await getMarketWalletFlow({
          marketId: market.id,
          window: input.window,
          limit: flowLimit,
          timeoutMs,
        }, candidates);
        return { market, flow: result.flow };
      }),
    );

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        requestsFulfilled += 1;
        if (hasMeaningfulFlow(result.value.flow)) {
          rows.push(result.value);
        }
      } else {
        requestsRejected += 1;
      }
    }
  }

  return {
    rows,
    candidatesAttempted,
    requestsFulfilled,
    requestsRejected,
    timedOut,
  };
}

function toSmartMoneyMarket(market: Market, flow: MarketWalletFlow): SmartMoneyMarket | null {
  if (!hasMeaningfulFlow(flow)) return null;

  return {
    marketId: flow.marketId || market.id,
    conditionId: flow.conditionId || stripPolymarketPrefix(market.id),
    tokenId: flow.tokenId,
    marketTitle: flow.marketTitle || market.title,
    category: market.category,
    url: market.url,
    score: scoreSmartMoneyMarket(market, flow),
    flow: {
      ...flow,
      marketId: flow.marketId || market.id,
      conditionId: flow.conditionId || stripPolymarketPrefix(market.id),
      marketTitle: flow.marketTitle || market.title,
    },
  };
}

function scoreSmartMoneyMarket(market: Market, flow: MarketWalletFlow): number {
  const totalFlow = getFlowVolume(flow);
  const netFlow = Math.abs(flow.netVolume);
  const walletSignal = flow.walletCount * 75;
  const smartWalletSignal = flow.smartWalletCount * 250;
  const marketVolumeSignal = Math.log10(Math.max(0, market.volume24h) + 1) * 100;
  const priceMoveSignal = Math.abs(market.oneDayPriceChange || 0) * 1000;
  const directionSignal = flow.netDirection === 'unknown' ? 0 : 100;

  return roundScore(
    netFlow +
      (totalFlow * 0.25) +
      walletSignal +
      smartWalletSignal +
      marketVolumeSignal +
      priceMoveSignal +
      directionSignal,
  );
}

function hasMeaningfulFlow(flow: MarketWalletFlow): boolean {
  return flow.smartWalletCount > 0 && getFlowVolume(flow) > 0;
}

function getFlowVolume(flow: MarketWalletFlow): number {
  return Math.max(0, flow.buyVolume) + Math.max(0, flow.sellVolume);
}

function getMarketActivityScore(market: Market): number {
  const priceMove = Math.abs(market.oneDayPriceChange || 0) * 1000;
  return Math.max(0, market.volume24h) + priceMove;
}

function normalizeCandidateLimit(input: SmartMoneyMarketsInput): number {
  const requested = input.candidateLimit ?? Math.max(DEFAULT_CANDIDATE_LIMIT, input.limit * 4);
  const lowerBound = Math.max(1, input.limit);
  const upperBound = Math.max(lowerBound, MAX_CANDIDATE_LIMIT);
  return clampInteger(requested, lowerBound, upperBound);
}

function normalizeFlowLimit(value: number | undefined): number {
  return clampInteger(value ?? DEFAULT_FLOW_LIMIT, 1, 100);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function stripPolymarketPrefix(marketId: string): string | undefined {
  const stripped = marketId.replace(/^polymarket-/i, '').trim();
  return stripped || undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
