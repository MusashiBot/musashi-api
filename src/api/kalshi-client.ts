// Kalshi public API client
// Fetches live open markets and maps them to the internal Market interface.
// No authentication required — these are public read-only endpoints.

import { Market } from '../types/market';
import { generateKeywords } from './keyword-generator';

const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
const FETCH_TIMEOUT_MS = 10000; // 10s timeout to prevent hanging on cold starts
const INTER_PAGE_DELAY_MS = 500; // throttle: wait 500ms between page requests
const RATE_LIMIT_RETRY_DELAY_MS = 5000; // on 429: wait 5s and retry once
const KALSHI_CACHE_TTL_MS = 60_000; // cache Kalshi results for 60 seconds

let kalshiCache: { markets: Market[]; fetchedAt: number } | null = null;

// Shape of a market object returned by the Kalshi REST API
interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  series_ticker?: string;
  title: string;
  market_type?: string;
  mve_collection_ticker?: string; // present only on multi-variable event (parlay) markets
  yes_ask: number;                    // cents (0–100)
  yes_ask_dollars?: number | string;  // same in dollars (0–1), may be returned as string
  yes_bid: number;
  yes_bid_dollars?: number | string;
  no_ask: number;
  no_bid: number;
  last_price?: number;                // last trade price for YES in cents
  last_price_dollars?: number | string;
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch a single page from Kalshi with one 429-retry before giving up.
 */
async function fetchKalshiPage(url: string): Promise<KalshiMarketsResponse> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (resp.status === 429) {
        if (attempt === 0) {
          console.warn(`[Kalshi] Rate limited (429) — waiting ${RATE_LIMIT_RETRY_DELAY_MS}ms before retry`);
          await sleep(RATE_LIMIT_RETRY_DELAY_MS);
          continue;
        }
        throw new Error('Kalshi API rate limit exceeded after retry');
      }

      if (!resp.ok) {
        console.error(`[Musashi SW] Kalshi HTTP ${resp.status} — declarativeNetRequest header stripping may not be active yet`);
        throw new Error(`Kalshi API responded with ${resp.status}`);
      }

      const data = await resp.json() as KalshiMarketsResponse;
      if (!Array.isArray(data.markets)) {
        throw new Error('Unexpected Kalshi API response shape');
      }

      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error(`Kalshi API request timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
      throw error;
    }
  }

  throw new Error('Kalshi fetch failed after all attempts');
}

// Series tickers that overlap with Polymarket categories.
// Fetching by series_ticker skips the thousands of sports/baseball markets
// that dominate blind pagination and returns only topic-relevant markets.
const OVERLAP_SERIES = [
  // Crypto
  'KXBTC',   // Bitcoin price
  'KXETH',   // Ethereum price
  'KXXRP',   // XRP price
  // Economics / Fed
  'KXFED',   // Federal funds rate
  'KXCPI',   // CPI inflation
  'KXGDP',   // GDP growth
  // US Politics
  'KXTRUMPRESIGN',  // Trump resignation
  'KXTRUMPPARDONS', // Trump pardons
  'KXNEXTSPEAKER',  // House Speaker
  'KXPRESPERSON',   // Next president
  'KXPRESPARTY',    // Presidential party
  'KXNEXTPRESSEC',  // Next press secretary
  'KXAMEND22',      // 22nd Amendment
  // Geopolitics
  'KXZELENSKYPUTIN', // Russia-Ukraine
  'KXTAIWANLVL4',   // Taiwan conflict
  'KXNEXTISRAELPM', // Israel PM
  'KXWITHDRAW',     // US troop withdrawal
  'KXUSTAKEOVER',   // US foreign policy
  // Tech / AI
  'KXOAIANTH',      // OpenAI vs Anthropic IPO
  'KXAGICO',        // AGI company
  'KXDATACENTER',   // Data center
  // Elections
  'KXNEWPOPE',      // New Pope
  'KXNEXTUKPM',     // UK PM
  'KXUKPARTY',      // UK party
];

/**
 * Fetch all open markets for a single series_ticker.
 * Returns an empty array if the series has no active markets.
 */
async function fetchSeriesMarkets(seriesTicker: string): Promise<Market[]> {
  const url = `${KALSHI_API}/markets?status=open&mve_filter=exclude&limit=100&series_ticker=${seriesTicker}`;

  try {
    const data = await fetchKalshiPage(url);
    const markets = data.markets
      .filter(isSimpleMarket)
      .map(toMarket)
      .filter(m => m.yesPrice > 0 && m.yesPrice < 1);

    if (markets.length > 0) {
      console.log(`[Kalshi] ${seriesTicker}: ${markets.length} markets`);
    }
    return markets;
  } catch (error) {
    console.warn(`[Kalshi] ${seriesTicker} fetch failed: ${(error as Error).message}`);
    return [];
  }
}

/**
 * Fetch Kalshi markets using targeted series_ticker fetches instead of
 * blind pagination. Blind pagination puts thousands of sports games first —
 * targeted fetches go directly to crypto, economics, and politics markets
 * that actually overlap with Polymarket.
 *
 * Keeps 500ms delay between series fetches and a 60-second result cache.
 */
export async function fetchKalshiMarkets(
  _targetSimpleCount = 400,
  _maxPages = 15,
): Promise<Market[]> {
  // Return cached result if still fresh
  if (kalshiCache && (Date.now() - kalshiCache.fetchedAt) < KALSHI_CACHE_TTL_MS) {
    console.log(`[Kalshi] Returning cached ${kalshiCache.markets.length} markets (age: ${Date.now() - kalshiCache.fetchedAt}ms)`);
    return kalshiCache.markets;
  }

  const seen = new Set<string>(); // deduplicate by ticker
  const allMarkets: Market[] = [];

  for (let i = 0; i < OVERLAP_SERIES.length; i++) {
    if (i > 0) await sleep(INTER_PAGE_DELAY_MS);

    const markets = await fetchSeriesMarkets(OVERLAP_SERIES[i]);
    for (const m of markets) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        allMarkets.push(m);
      }
    }
  }

  console.log(`[Kalshi] Fetched ${allMarkets.length} targeted markets across ${OVERLAP_SERIES.length} series`);

  kalshiCache = { markets: allMarkets, fetchedAt: Date.now() };
  return allMarkets;
}

/** Map a raw Kalshi market object to our Market interface */
function toMarket(km: KalshiMarket): Market {
  // Kalshi API returns _dollars fields as strings in some responses — coerce to number
  const yesBidDollars = km.yes_bid_dollars != null ? Number(km.yes_bid_dollars) : null;
  const yesAskDollars = km.yes_ask_dollars != null ? Number(km.yes_ask_dollars) : null;
  const lastPriceDollars = km.last_price_dollars != null ? Number(km.last_price_dollars) : null;

  // Prefer the _dollars variant (already 0–1); fall back to /100 conversion
  let yesPrice: number;
  if (yesBidDollars != null && yesAskDollars != null && yesAskDollars > 0) {
    yesPrice = (yesBidDollars + yesAskDollars) / 2;
  } else if (km.yes_bid != null && km.yes_ask != null && km.yes_ask > 0) {
    yesPrice = ((km.yes_bid + km.yes_ask) / 2) / 100;
  } else if (lastPriceDollars != null && lastPriceDollars > 0) {
    yesPrice = lastPriceDollars;
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
    volume24h: km.volume_24h ?? km.volume ?? 0,
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
