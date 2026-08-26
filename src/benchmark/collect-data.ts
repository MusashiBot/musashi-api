/**
 * Benchmark dataset collector (proposal-aligned).
 *
 * Collects frozen snapshots of resolved Kalshi/Polymarket markets and broadly
 * retrieved tweets around resolution. Does NOT filter with KeywordMatcher.match()
 * at collection time — match() is recorded as a labeled pipeline stage only.
 *
 * Output layout (reproducible, no re-fetch needed for eval):
 *   src/benchmark/v1/
 *     markets.jsonl
 *     tweets.jsonl
 *     outputs/            (model runs written later)
 *     collection_log.json
 */

import fs from 'fs/promises';
import path from 'path';
import { twitterClient, TwitterApiError } from '../api/twitter-client';
import { generateKeywords } from '../api/keyword-generator';
import { isSimpleMarket } from '../api/kalshi-filters';
import { KeywordMatcher } from '../analysis/keyword-matcher';
import { Market } from '../types/market';

// ─── Config ─────────────────────────────────────────────────────────────────

const BENCHMARK_VERSION = process.env.BENCHMARK_VERSION ?? 'v1';
/** Cap resolved markets pulled per exchange (rate-limit / cost control). */
const MAX_MARKETS_PER_SOURCE = Number(process.env.BENCHMARK_MAX_MARKETS ?? 20);
/** Skip tweet search (markets + probs only). Useful for dry runs. */
const SKIP_TWEETS = process.env.BENCHMARK_SKIP_TWEETS === '1';
const TWEETS_PER_MARKET = Number(process.env.BENCHMARK_TWEETS_PER_MARKET ?? 50);
/** Production pipeline drops matches below this confidence. */
const MATCHER_MIN_CONFIDENCE = 0.2;
const OFFSET_MINUTES = [30, 60, 120] as const;
const FETCH_TIMEOUT_MS = 15_000;

const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
const POLYMARKET_GAMMA = 'https://gamma-api.polymarket.com';
const POLYMARKET_CLOB = 'https://clob.polymarket.com';

// ─── Schema types ───────────────────────────────────────────────────────────

export interface BenchmarkMarket {
  market_id: string;
  source: 'kalshi' | 'polymarket';
  question: string;
  category: string;
  resolution: string;
  resolved_at: string;
  prob_30m: number | null;
  prob_1h: number | null;
  prob_2h: number | null;
  snapshot_fetched_at: string;
  raw_payload: unknown;
}

export interface MatcherResult {
  status: 'accepted' | 'rejected';
  score: number;
  assigned_market_id: string | null;
  assigned_category: string | null;
}

export interface BenchmarkTweet {
  tweet_id: string;
  market_id: string;
  text: string;
  author_id: string;
  created_at: string;
  offset_minutes: 30 | 60 | 120;
  collection_query: string;
  matcher_result: MatcherResult;
  /** Human labels filled in during labeling; null at collection time. */
  is_relevant: 'yes' | 'no' | null;
  sentiment_label: 'bullish' | 'bearish' | 'neutral' | null;
  label_confidence: 'high' | 'medium' | 'low' | null;
  labeler_id: string | null;
}

interface CollectionLog {
  version: string;
  started_at: string;
  finished_at: string;
  max_markets_per_source: number;
  skip_tweets: boolean;
  market_count: number;
  tweet_count: number;
  kalshi_count: number;
  polymarket_count: number;
  notes: string[];
  errors: string[];
}

// ─── Raw API shapes ─────────────────────────────────────────────────────────

interface KalshiSettledMarket {
  ticker: string;
  event_ticker: string;
  series_ticker?: string;
  title: string;
  result?: string;
  status?: string;
  close_time?: string;
  settlement_ts?: string;
  mve_collection_ticker?: string;
  [key: string]: unknown;
}

interface PolymarketClosedMarket {
  id: string;
  conditionId: string;
  question: string;
  description?: string;
  slug: string;
  outcomes: string;
  outcomePrices: string;
  closed: boolean;
  category?: string;
  closedTime?: string;
  umaEndDate?: string;
  endDate?: string;
  umaResolutionStatus?: string;
  clobTokenIds?: string;
  events?: Array<{ slug: string }>;
  [key: string]: unknown;
}

interface KalshiCandlestick {
  end_period_ts: number;
  price?: {
    close_dollars?: string;
    previous_dollars?: string;
    mean_dollars?: string;
  };
  yes_bid?: { close_dollars?: string };
  yes_ask?: { close_dollars?: string };
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, name: string): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      throw new Error(`${name} HTTP ${resp.status} for ${url}`);
    }
    return (await resp.json()) as T;
  } catch (error) {
    clearTimeout(timeoutId);
    if ((error as Error).name === 'AbortError') {
      throw new Error(`${name} timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  }
}

async function withRetry<T>(
  fn: () => Promise<T>,
  name: string,
  retries = 3,
  delayMs = 2000
): Promise<T | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const is429 = message.includes('429');
      if (is429 && attempt < retries) {
        console.warn(`${name} rate limited, retrying in ${attempt * delayMs}ms...`);
        await sleep(attempt * delayMs);
        continue;
      }
      console.warn(`${name} failed:`, message);
      return null;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Category / ticker helpers ──────────────────────────────────────────────

function inferCategory(text: string, apiCategory?: string): string {
  if (apiCategory) {
    const c = apiCategory.toLowerCase();
    if (c.includes('crypto') || c.includes('bitcoin')) return 'Crypto';
    if (c.includes('politic') || c.includes('elect')) return 'Politics';
    if (c.includes('sport')) return 'Sports';
    if (c.includes('tech')) return 'Finance';
    if (c.includes('financ') || c.includes('econ')) return 'Finance';
  }
  const q = text.toUpperCase();
  if (/BTC|ETH|CRYPTO|SOL|XRP|DOGE|BITCOIN|ETHEREUM/.test(q)) return 'Crypto';
  if (/FED|CPI|GDP|INFLATION|RATE|RECESSION|UNEMP|JOBS|STOCK|NASDAQ|S&P/.test(q)) return 'Finance';
  if (/TRUMP|BIDEN|HARRIS|PRES|CONGRESS|SENATE|ELECT|GOP|DEM|HOUSE/.test(q)) return 'Politics';
  if (/NFL|NBA|MLB|NHL|SUPER BOWL|WORLD CUP|FIFA|GOLF|TENNIS|SOCCER/.test(q)) return 'Sports';
  return 'Other';
}

function extractSeriesTicker(ticker: string): string {
  const parts = ticker.split('-');
  if (parts.length === 1) return parts[0];
  if (/^\d/.test(parts[1])) return parts[0];
  return parts[0];
}

function nearestOffsetMinutes(createdAt: Date, resolvedAt: Date): 30 | 60 | 120 {
  const minutesBefore = (resolvedAt.getTime() - createdAt.getTime()) / 60_000;
  let best: 30 | 60 | 120 = 30;
  let bestDist = Infinity;
  for (const offset of OFFSET_MINUTES) {
    const dist = Math.abs(minutesBefore - offset);
    if (dist < bestDist) {
      bestDist = dist;
      best = offset;
    }
  }
  return best;
}

function priceAtTimestamp(
  points: Array<{ t: number; p: number }>,
  targetUnix: number
): number | null {
  if (points.length === 0) return null;
  let best = points[0];
  let bestDist = Math.abs(points[0].t - targetUnix);
  for (const pt of points) {
    const dist = Math.abs(pt.t - targetUnix);
    if (dist < bestDist) {
      best = pt;
      bestDist = dist;
    }
  }
  // Ignore points more than 45 minutes away from the requested offset
  if (bestDist > 45 * 60) return null;
  return best.p;
}

function kalshiCandlePrice(c: KalshiCandlestick): number | null {
  const close = parseFloat(c.price?.close_dollars ?? '');
  if (isFinite(close) && close >= 0) return close;
  const mean = parseFloat(c.price?.mean_dollars ?? '');
  if (isFinite(mean) && mean >= 0) return mean;
  const prev = parseFloat(c.price?.previous_dollars ?? '');
  if (isFinite(prev) && prev >= 0) return prev;
  const bid = parseFloat(c.yes_bid?.close_dollars ?? '');
  const ask = parseFloat(c.yes_ask?.close_dollars ?? '');
  if (isFinite(bid) && bid > 0 && isFinite(ask) && ask > 0) return (bid + ask) / 2;
  if (isFinite(ask) && ask > 0) return ask;
  if (isFinite(bid) && bid > 0) return bid;
  return null;
}

// ─── Market collection ──────────────────────────────────────────────────────

async function fetchSettledKalshi(limit: number): Promise<KalshiSettledMarket[]> {
  const PAGE_SIZE = 100;
  const collected: KalshiSettledMarket[] = [];
  let cursor: string | undefined;

  while (collected.length < limit) {
    const url = cursor
      ? `${KALSHI_API}/markets?status=settled&mve_filter=exclude&limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
      : `${KALSHI_API}/markets?status=settled&mve_filter=exclude&limit=${PAGE_SIZE}`;

    const data = await fetchJson<{ markets: KalshiSettledMarket[]; cursor?: string }>(
      url,
      'Kalshi'
    );
    if (!Array.isArray(data.markets) || data.markets.length === 0) break;

    for (const km of data.markets) {
      if (!isSimpleMarket({
        title: km.title,
        tickerOrPlatformId: km.ticker,
        mveCollectionTicker: km.mve_collection_ticker,
      })) continue;
      if (!km.result || (km.result !== 'yes' && km.result !== 'no')) continue;
      if (!km.settlement_ts && !km.close_time) continue;
      collected.push(km);
      if (collected.length >= limit) break;
    }

    if (!data.cursor) break;
    cursor = data.cursor;
  }

  return collected.slice(0, limit);
}

async function fetchClosedPolymarket(limit: number): Promise<PolymarketClosedMarket[]> {
  const PAGE_SIZE = 50;
  const collected: PolymarketClosedMarket[] = [];
  let offset = 0;

  while (collected.length < limit) {
    const url =
      `${POLYMARKET_GAMMA}/markets?closed=true` +
      `&order=closedTime&ascending=false` +
      `&limit=${PAGE_SIZE}&offset=${offset}`;

    const data = await fetchJson<PolymarketClosedMarket[]>(url, 'Polymarket');
    if (!Array.isArray(data) || data.length === 0) break;

    for (const pm of data) {
      if (!pm.question || !pm.conditionId || !pm.closed) continue;
      try {
        const outcomes: string[] = JSON.parse(pm.outcomes);
        if (outcomes.length !== 2) continue;
        const lower = outcomes.map(o => o.toLowerCase());
        if (!lower.includes('yes') || !lower.includes('no')) continue;
      } catch {
        continue;
      }
      if (!pm.closedTime && !pm.umaEndDate && !pm.endDate) continue;
      collected.push(pm);
      if (collected.length >= limit) break;
    }

    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return collected.slice(0, limit);
}

async function kalshiProbOffsets(
  km: KalshiSettledMarket,
  resolvedAt: Date
): Promise<{ prob_30m: number | null; prob_1h: number | null; prob_2h: number | null }> {
  const series = (km.series_ticker || extractSeriesTicker(km.event_ticker || km.ticker)).toUpperCase();
  const endTs = Math.floor(resolvedAt.getTime() / 1000);
  const startTs = endTs - 3 * 60 * 60;
  const url =
    `${KALSHI_API}/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(km.ticker)}` +
    `/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1`;

  const data = await withRetry(
    () => fetchJson<{ candlesticks: KalshiCandlestick[] }>(url, 'Kalshi candles'),
    `Kalshi candles ${km.ticker}`
  );

  const points = (data?.candlesticks ?? [])
    .map(c => {
      const p = kalshiCandlePrice(c);
      return p == null ? null : { t: c.end_period_ts, p };
    })
    .filter((x): x is { t: number; p: number } => x != null);

  return {
    prob_30m: priceAtTimestamp(points, endTs - 30 * 60),
    prob_1h: priceAtTimestamp(points, endTs - 60 * 60),
    prob_2h: priceAtTimestamp(points, endTs - 120 * 60),
  };
}

async function polymarketProbOffsets(
  pm: PolymarketClosedMarket,
  resolvedAt: Date
): Promise<{ prob_30m: number | null; prob_1h: number | null; prob_2h: number | null }> {
  let yesToken: string | null = null;
  try {
    const tokens: string[] = JSON.parse(pm.clobTokenIds ?? '[]');
    const outcomes: string[] = JSON.parse(pm.outcomes);
    const yesIdx = outcomes.findIndex(o => o.toLowerCase() === 'yes');
    yesToken = tokens[yesIdx] ?? tokens[0] ?? null;
  } catch {
    yesToken = null;
  }

  if (!yesToken) {
    return { prob_30m: null, prob_1h: null, prob_2h: null };
  }

  const endTs = Math.floor(resolvedAt.getTime() / 1000);
  const startTs = endTs - 3 * 60 * 60;
  const url =
    `${POLYMARKET_CLOB}/prices-history?market=${encodeURIComponent(yesToken)}` +
    `&startTs=${startTs}&endTs=${endTs}&fidelity=5`;

  const data = await withRetry(
    () => fetchJson<{ history: Array<{ t: number; p: number }> }>(url, 'Polymarket history'),
    `Polymarket history ${pm.id}`
  );

  const points = data?.history ?? [];
  return {
    prob_30m: priceAtTimestamp(points, endTs - 30 * 60),
    prob_1h: priceAtTimestamp(points, endTs - 60 * 60),
    prob_2h: priceAtTimestamp(points, endTs - 120 * 60),
  };
}

function polymarketResolution(pm: PolymarketClosedMarket): string {
  try {
    const outcomes: string[] = JSON.parse(pm.outcomes);
    const prices: string[] = JSON.parse(pm.outcomePrices);
    const yesIdx = outcomes.findIndex(o => o.toLowerCase() === 'yes');
    const yesPrice = parseFloat(prices[yesIdx] ?? '0');
    if (yesPrice >= 0.99) return 'yes';
    if (yesPrice <= 0.01) return 'no';
    // Non-extreme: report outcome with highest price
    let bestIdx = 0;
    let best = -1;
    for (let i = 0; i < prices.length; i++) {
      const p = parseFloat(prices[i]);
      if (p > best) {
        best = p;
        bestIdx = i;
      }
    }
    return outcomes[bestIdx]?.toLowerCase() ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function toMatcherMarket(row: BenchmarkMarket): Market {
  return {
    id: row.market_id,
    platform: row.source,
    title: row.question,
    description: '',
    keywords: generateKeywords(row.question),
    yesPrice: 0.5,
    noPrice: 0.5,
    volume24h: 0,
    url: '',
    category: row.category,
    lastUpdated: row.snapshot_fetched_at,
  };
}

// ─── Tweet collection ───────────────────────────────────────────────────────

/**
 * Build a broad Twitter recent-search query from the market question.
 * Intentionally does NOT use KeywordMatcher.match() — we want tweets the
 * production matcher might miss.
 */
function buildCollectionQuery(question: string): string {
  const keywords = generateKeywords(question)
    .filter(k => k.length >= 3)
    .slice(0, 6);

  const clauses = keywords.map(k => (k.includes(' ') ? `"${k}"` : k));
  // Fall back to first meaningful words from the question
  if (clauses.length === 0) {
    const fallback = question
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 4);
    clauses.push(...fallback);
  }

  const body = clauses.join(' OR ');
  // Cap length — Twitter recent search query limit is 512 chars on most tiers
  const query = `(${body}) -is:retweet lang:en`;
  return query.length > 500 ? query.slice(0, 500) : query;
}

function recordMatcherResult(
  tweetText: string,
  matcher: KeywordMatcher
): MatcherResult {
  const matches = matcher.match(tweetText);
  const top = matches[0];
  if (!top || top.confidence < MATCHER_MIN_CONFIDENCE) {
    return {
      status: 'rejected',
      score: top?.confidence ?? 0,
      assigned_market_id: null,
      assigned_category: null,
    };
  }
  return {
    status: 'accepted',
    score: top.confidence,
    assigned_market_id: top.market.id,
    assigned_category: top.market.category,
  };
}

async function collectTweetsForMarket(
  market: BenchmarkMarket,
  matcher: KeywordMatcher,
  errors: string[]
): Promise<BenchmarkTweet[]> {
  const resolvedAt = new Date(market.resolved_at);
  const windowEnd = resolvedAt;
  // Cover 2h offset + small buffer; Twitter recent search max lookback is 7 days
  const windowStart = new Date(resolvedAt.getTime() - 135 * 60 * 1000);
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  if (windowEnd.getTime() < sevenDaysAgo) {
    errors.push(
      `Skipping tweets for ${market.market_id}: resolved_at outside Twitter recent-search window`
    );
    return [];
  }

  const startTime = new Date(Math.max(windowStart.getTime(), sevenDaysAgo + 60_000)).toISOString();
  // end_time must be at least ~10s before "now"
  const endTime = new Date(Math.min(windowEnd.getTime(), now - 15_000)).toISOString();
  if (new Date(startTime) >= new Date(endTime)) {
    errors.push(`Skipping tweets for ${market.market_id}: invalid search window`);
    return [];
  }

  const collectionQuery = buildCollectionQuery(market.question);
  const raw = await withRetry(
    () => twitterClient.searchRecent(collectionQuery, startTime, endTime, TWEETS_PER_MARKET),
    `Twitter search ${market.market_id}`
  );

  if (!raw) {
    if (errors[errors.length - 1]?.includes('Twitter')) {
      // already logged by withRetry
    }
    return [];
  }

  const seen = new Set<string>();
  const rows: BenchmarkTweet[] = [];

  for (const tweet of raw) {
    if (seen.has(tweet.id)) continue;
    seen.add(tweet.id);

    const createdAt = new Date(tweet.created_at);
    rows.push({
      tweet_id: tweet.id,
      market_id: market.market_id,
      text: tweet.text,
      author_id: tweet.author_id,
      created_at: tweet.created_at,
      offset_minutes: nearestOffsetMinutes(createdAt, resolvedAt),
      collection_query: collectionQuery,
      matcher_result: recordMatcherResult(tweet.text, matcher),
      is_relevant: null,
      sentiment_label: null,
      label_confidence: null,
      labeler_id: null,
    });
  }

  return rows;
}

// ─── IO ─────────────────────────────────────────────────────────────────────

async function writeJsonl(filePath: string, rows: object[]): Promise<void> {
  const body = rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  await fs.writeFile(filePath, body, 'utf8');
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function collect_data(): Promise<void> {
  const startedAt = new Date();
  const snapshotFetchedAt = startedAt.toISOString();
  const notes: string[] = [
    'Tweets collected with broad market-derived queries; KeywordMatcher.match() recorded but not used as a filter.',
    'Human label fields left null for the labeling step.',
    'Implied probabilities recorded at 30m / 1h / 2h before resolution when history is available.',
  ];
  const errors: string[] = [];

  console.log(`Collecting benchmark ${BENCHMARK_VERSION} (max ${MAX_MARKETS_PER_SOURCE}/source)...`);

  const kalshiRaw =
    (await withRetry(() => fetchSettledKalshi(MAX_MARKETS_PER_SOURCE), 'Kalshi settled')) ?? [];
  const polyRaw =
    (await withRetry(() => fetchClosedPolymarket(MAX_MARKETS_PER_SOURCE), 'Polymarket closed')) ?? [];

  const markets: BenchmarkMarket[] = [];

  for (const km of kalshiRaw) {
    const resolvedAt = new Date(km.settlement_ts || km.close_time!);
    const probs =
      (await kalshiProbOffsets(km, resolvedAt)) ??
      { prob_30m: null, prob_1h: null, prob_2h: null };

    markets.push({
      market_id: `kalshi-${km.ticker}`,
      source: 'kalshi',
      question: km.title,
      category: inferCategory(km.title, km.series_ticker || km.event_ticker),
      resolution: km.result!,
      resolved_at: resolvedAt.toISOString(),
      prob_30m: probs.prob_30m,
      prob_1h: probs.prob_1h,
      prob_2h: probs.prob_2h,
      snapshot_fetched_at: snapshotFetchedAt,
      raw_payload: km,
    });
  }

  for (const pm of polyRaw) {
    const resolvedAt = new Date(pm.closedTime || pm.umaEndDate || pm.endDate!);
    const probs = await polymarketProbOffsets(pm, resolvedAt);

    markets.push({
      market_id: `polymarket-${pm.conditionId}`,
      source: 'polymarket',
      question: pm.question,
      category: inferCategory(pm.question, pm.category),
      resolution: polymarketResolution(pm),
      resolved_at: resolvedAt.toISOString(),
      prob_30m: probs.prob_30m,
      prob_1h: probs.prob_1h,
      prob_2h: probs.prob_2h,
      snapshot_fetched_at: snapshotFetchedAt,
      raw_payload: pm,
    });
  }

  console.log(`Markets frozen: ${markets.length} (kalshi=${kalshiRaw.length}, polymarket=${polyRaw.length})`);

  const matcher = new KeywordMatcher(markets.map(toMatcherMarket), MATCHER_MIN_CONFIDENCE);
  const tweets: BenchmarkTweet[] = [];

  if (SKIP_TWEETS) {
    notes.push('BENCHMARK_SKIP_TWEETS=1 - tweet search skipped.');
  } else {
    for (const market of markets) {
      try {
        const rows = await collectTweetsForMarket(market, matcher, errors);
        tweets.push(...rows);
        console.log(`  ${market.market_id}: ${rows.length} tweets`);
        // Gentle pacing for Twitter rate limits
        await sleep(800);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Tweet collection failed for ${market.market_id}: ${message}`);
        if (err instanceof TwitterApiError && err.statusCode === 429) {
          notes.push('Stopped tweet collection early due to Twitter rate limit.');
          break;
        }
      }
    }
  }

  const outDir = path.join(__dirname, BENCHMARK_VERSION);
  const outputsDir = path.join(outDir, 'outputs');
  await fs.mkdir(outputsDir, { recursive: true });

  await writeJsonl(path.join(outDir, 'markets.jsonl'), markets);
  await writeJsonl(path.join(outDir, 'tweets.jsonl'), tweets);

  const finishedAt = new Date();
  const log: CollectionLog = {
    version: BENCHMARK_VERSION,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    max_markets_per_source: MAX_MARKETS_PER_SOURCE,
    skip_tweets: SKIP_TWEETS,
    market_count: markets.length,
    tweet_count: tweets.length,
    kalshi_count: kalshiRaw.length,
    polymarket_count: polyRaw.length,
    notes,
    errors,
  };
  await fs.writeFile(path.join(outDir, 'collection_log.json'), JSON.stringify(log, null, 2));

  console.log(`Saved benchmark to ${outDir}`);
  console.log(`  markets: ${markets.length}`);
  console.log(`  tweets:  ${tweets.length}`);
  if (errors.length) {
    console.log(`  errors:  ${errors.length} (see collection_log.json)`);
  }
}

collect_data().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
