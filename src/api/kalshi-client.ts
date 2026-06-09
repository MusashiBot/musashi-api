// Kalshi public API client
// Fetches live open markets and maps them to the internal Market interface.
// No authentication required — these are public read-only endpoints.

import { Market } from '../types/market';
import { generateKeywords } from './keyword-generator';

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
  yes_ask: number | null;
  yes_ask_dollars?: string | null;
  yes_bid: number | null;
  yes_bid_dollars?: string | null;
  no_ask: number | null;
  no_bid: number | null;
  last_price?: number | null;
  last_price_dollars?: string | null;
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
 */
function isSimpleMarket(km: KalshiMarket): boolean {
  if (!km.title || !km.ticker) return false;

  // MVE / multi-game parlay markets
  if (km.mve_collection_ticker) return false;
  if (/MULTIGAME|MVE/i.test(km.ticker)) return false;

  // Titles that start with "yes " are multi-leg combo selections
  if (/^yes\s/i.test(km.title.trim())) return false;

  // More than 2 commas = likely a multi-leg title
  const commas = (km.title.match(/,/g) || []).length;
  if (commas > 2) return false;

  return true;
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
        `${pageSimple.length} simple (total simple: ${allSimple.length})`
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
  // Prefer the _dollars variant (already 0–1); fall back to /100 conversion.
  // The Kalshi API returns _dollars fields as strings (e.g. "0.9700"), so
  // parseFloat() is required before any arithmetic.
  let yesPrice: number;
  const yesBidD = parseFloat(km.yes_bid_dollars ?? '');
  const yesAskD = parseFloat(km.yes_ask_dollars ?? '');
  const lastD   = parseFloat(km.last_price_dollars ?? '');

  if (isFinite(yesBidD) && yesBidD > 0 && isFinite(yesAskD) && yesAskD > 0) {
    yesPrice = (yesBidD + yesAskD) / 2;
  } else if (isFinite(yesAskD) && yesAskD > 0) {
    // Empty bid side (order book thin) — use ask alone
    yesPrice = yesAskD;
  } else if (km.yes_bid != null && km.yes_bid > 0 && km.yes_ask != null && km.yes_ask > 0) {
    yesPrice = ((km.yes_bid + km.yes_ask) / 2) / 100;
  } else if (km.yes_ask != null && km.yes_ask > 0) {
    yesPrice = km.yes_ask / 100;
  } else if (isFinite(lastD) && lastD > 0) {
    yesPrice = lastD;
  } else if (km.last_price != null && km.last_price > 0) {
    yesPrice = km.last_price / 100;
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
    volume24h: km.volume_24h ?? 0,
    url: marketUrl,
    category: inferCategory(km.series_ticker || km.event_ticker || km.ticker),
    lastUpdated: new Date().toISOString(),
  };
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
  if (/BTC|ETH|CRYPTO|SOL|XRP|DOGE|NFT|DEFI/.test(t))  return 'crypto';
  if (/FED|CPI|GDP|INFL|RATE|ECON|UNEMP|JOBS|RECESS/.test(t)) return 'economics';
  if (/TRUMP|BIDEN|PRES|CONG|SENATE|ELECT|GOP|DEM|HOUSE/.test(t)) return 'us_politics';
  if (/NVDA|AAPL|MSFT|GOOGL|META|AMZN|AI|TECH|TSLA|OPENAI/.test(t)) return 'technology';
  if (/NFL|NBA|MLB|NHL|SPORT|SUPER|WORLD|FIFA|GOLF|TENNIS/.test(t)) return 'sports';
  if (/CLIMATE|TEMP|WEATHER|CARBON|EMISS|ENERGY|OIL/.test(t)) return 'climate';
  if (/UKRAIN|RUSSIA|CHINA|NATO|TAIWAN|ISRAEL|GAZA|IRAN/.test(t)) return 'geopolitics';
  return 'other';
}
