// Kalshi public API client
// Fetches live open markets and maps them to the internal Market interface.
// No authentication required — these are public read-only endpoints.

import { Market } from '../types/market';
import { generateKeywords } from './keyword-generator';

// ptl issue: Kalshi API is returning 404 error
const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';   
const FETCH_TIMEOUT_MS = 10000; // 10s timeout to prevent hanging on cold starts

// Shape of a market object returned by the Kalshi REST API
interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  series_ticker?: string;
  title: string;
  market_type?: string;
  mve_collection_ticker?: string; // present only on multi-variable event (parlay) markets
  yes_ask?: number | string | null;          // cents (0–100)
  yes_ask_dollars?: number | string | null;  // same in dollars (0–1), prefer this if present
  yes_bid?: number | string | null;
  yes_bid_dollars?: number | string | null;
  no_ask?: number | string | null;
  no_ask_dollars?: number | string | null;
  no_bid?: number | string | null;
  no_bid_dollars?: number | string | null;
  last_price?: number | string | null;       // last trade price for YES in cents
  last_price_dollars?: number | string | null;
  volume?: number;
  volume_24h?: number;
  open_interest?: number;
  close_time?: string;
  status?: string;
}

interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor?: string;
}

/**
 * Returns true for simple binary YES/NO markets.
 * Filters out complex multi-variable event (parlay/combo) markets whose
 * titles are multi-leg strings like "yes Lakers, yes Celtics, no Bulls..."
 * basically filtering out events that require more than 1 thing to be predicted 
 * correctly to profit
 */
function getMarketFilterReason(km: KalshiMarket): string | null {
  if (!km.title || !km.ticker) return 'missing_title_or_ticker';

  // MVE / multi-game parlay markets
  if (km.mve_collection_ticker) return 'mve_collection';
  if (/MULTIGAME|MVE/i.test(km.ticker)) return 'mve_ticker';

  // We only want markets that settle to a binary YES/NO payout.
  if (km.market_type && km.market_type.toLowerCase() !== 'binary') return 'not_binary';

  // Titles that start with "yes " are multi-leg combo selections
  if (/^yes\s/i.test(km.title.trim())) return 'combo_title';

  // More than 2 commas = likely a multi-leg title
  const commas = (km.title.match(/,/g) || []).length;
  if (commas > 2) return 'too_many_commas';

  return null;
}

function isSimpleMarket(km: KalshiMarket): boolean {
  return getMarketFilterReason(km) === null;
}

function summarizeFilterReasons(markets: KalshiMarket[]): string {
  const counts = new Map<string, number>();
  for (const market of markets) {
    const reason = getMarketFilterReason(market) ?? 'accepted';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}:${count}`)
    .join(', ');
}

/**
 * Fetch open markets from Kalshi's public API using cursor pagination.
 *
 * The default API ordering puts thousands of MVE (parlay/sports) markets first.
 * isSimpleMarket() filters those out, so we must page through until we have
 * enough simple binary markets for meaningful tweet matching.
 *
 * Stops when we reach `targetSimpleCount` simple markets or exhaust `maxPages`.
 */
export async function fetchKalshiMarkets(
  targetSimpleCount = 400,
  maxPages = 15,
): Promise<Market[]> {
  const PAGE_SIZE = 200;
  const allSimple: Market[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const url = cursor
      ? `${KALSHI_API}/markets?status=open&mve_filter=exclude&limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
      : `${KALSHI_API}/markets?status=open&mve_filter=exclude&limit=${PAGE_SIZE}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        console.error(`[Musashi SW] Kalshi HTTP ${resp.status} — declarativeNetRequest header stripping may not be active yet`);
        throw new Error(`Kalshi API responded with ${resp.status}`);
      }

      const data = await resp.json() as KalshiMarketsResponse;
      if (!Array.isArray(data.markets)) {
        throw new Error('Unexpected Kalshi API response shape');
      }

      const pageSimple = data.markets
        .filter(isSimpleMarket)
        .map(toMarket)
        .filter(m => m.yesPrice > 0 && m.yesPrice < 1);

      allSimple.push(...pageSimple);

      console.log(
        `[Musashi] Page ${page + 1}: ${data.markets.length} raw → ` +
        `${pageSimple.length} simple (total simple: ${allSimple.length}; ` +
        `${summarizeFilterReasons(data.markets)})`
      );

      // Stop early once we have enough, or when the API has no more pages
      if (allSimple.length >= targetSimpleCount || !data.cursor) break;
      cursor = data.cursor;
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error(`Kalshi API request timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
      throw error;
    }
  }

  console.log(`[Musashi] Fetched ${allSimple.length} live markets from Kalshi`);
  return allSimple;
}

/** Map a raw Kalshi market object to our Market interface */
function toMarket(km: KalshiMarket): Market {
  // Prefer the _dollars variant (already 0–1); fall back to /100 conversion
  let yesPrice: number;
  const yesBid = normalizePrice(km.yes_bid_dollars, km.yes_bid);
  const yesAsk = normalizePrice(km.yes_ask_dollars, km.yes_ask);
  const noBid = normalizePrice(km.no_bid_dollars, km.no_bid);
  const noAsk = normalizePrice(km.no_ask_dollars, km.no_ask);
  const lastPrice = normalizePrice(km.last_price_dollars, km.last_price);

  if (yesBid != null && yesAsk != null) {
    yesPrice = (yesBid + yesAsk) / 2;
  } else if (lastPrice != null) {
    yesPrice = lastPrice;
  } else {
    yesPrice = 0.5;
  }

  const safeYes = Math.min(Math.max(yesPrice, 0.01), 0.99);
  const safeNo  = +((1 - safeYes).toFixed(2));

  // ── URL construction ───────────────────────────────────────────────────────
  // Kalshi web URLs follow: kalshi.com/markets/{series}/{slug}/{event_ticker}
  // The API does NOT return series_ticker, so we always derive it via extractSeriesTicker().
  // The middle slug segment is SEO-only; Kalshi redirects any slug to the canonical one.
  // The final segment MUST be the event_ticker (not market ticker), lowercase.
  const seriesTicker = (km.series_ticker || extractSeriesTicker(km.event_ticker ?? km.ticker))
    .toLowerCase();
  const eventTickerLower = (km.event_ticker ?? km.ticker).toLowerCase();
  const titleSlug = slugify(km.title);
  const marketUrl = `https://kalshi.com/markets/${seriesTicker}/${titleSlug}/${eventTickerLower}`;

  return {
    id: `kalshi-${km.ticker}`,
    platform: 'kalshi',
    title: km.title,
    description: '',
    keywords: generateKeywords(km.title),
    yesPrice: +safeYes.toFixed(2),
    noPrice: safeNo,
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    volume24h: km.volume_24h ?? km.volume ?? 0,
    url: marketUrl,
    category: inferCategory(km.series_ticker || km.event_ticker || km.ticker),
    lastUpdated: new Date().toISOString(),
    endDate: km.close_time,
  };
}

function toNumber(value: number | string | null | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizePrice(
  dollars?: number | string | null,
  cents?: number | string | null,
): number | undefined {
  const dollarValue = toNumber(dollars);
  const centValue = toNumber(cents);
  const value = dollarValue != null ? dollarValue : centValue != null ? centValue / 100 : undefined;
  if (value == null || !Number.isFinite(value) || value <= 0 || value >= 1) return undefined;
  return +value.toFixed(2);
}

/** Convert a market title to a URL-safe slug (middle segment of Kalshi URLs) */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Extracts the series ticker from an event_ticker or market ticker.
 * Kalshi event tickers follow: {SERIES}-{DATE_OR_DESCRIPTOR}
 * e.g. "KXBTC-26FEB1708"  → "KXBTC"
 *      "KXGEMINI-VS-CHATGPT" → "KXGEMINI"
 *      "PRES-DEM-2024" → "PRES"
 */
function extractSeriesTicker(ticker: string): string {
  // Try splitting on '-' and returning up to the first segment that
  // looks like a date (digits followed by letters) or is all-caps alpha-only
  const parts = ticker.split('-');
  if (parts.length === 1) return parts[0];

  // If second segment starts with digits (looks like a date: 26FEB, 2024, etc.)
  // → series is just the first part
  if (/^\d/.test(parts[1])) return parts[0];

  // Otherwise return the first two parts joined
  // e.g. KXGEMINI-VS → "KXGEMINI-VS" would still 404; just use first segment
  return parts[0];
}

/** Infer a rough category from the market's series/event ticker prefix */
function inferCategory(ticker: string): string {
  const t = ticker.toUpperCase();
  if (/LOL|VALORANT|ESPORT|DOTA|CS2|GAM(E|ING)/.test(t)) return 'esports';
  if (/BTC|ETH|CRYPTO|SOL|XRP|DOGE|NFT|DEFI/.test(t))  return 'crypto';
  if (/FED|CPI|GDP|INFL|RATE|ECON|UNEMP|JOBS|RECESS/.test(t)) return 'economics';
  if (/TRUMP|BIDEN|PRES|CONG|SENATE|ELECT|GOP|DEM|HOUSE/.test(t)) return 'us_politics';
  if (/NVDA|AAPL|MSFT|GOOGL|META|AMZN|AI|TECH|TSLA|OPENAI/.test(t)) return 'technology';
  if (/NFL|NBA|MLB|NHL|SPORT|SUPER|WORLD|FIFA|GOLF|TENNIS|ITFMATCH|ITFWMATCH|SOCCER/.test(t)) return 'sports';
  if (/CLIMATE|TEMP|WEATHER|CARBON|EMISS|ENERGY|OIL/.test(t)) return 'climate';
  if (/UKRAIN|RUSSIA|CHINA|NATO|TAIWAN|ISRAEL|GAZA|IRAN/.test(t)) return 'geopolitics';
  return 'other';
}
