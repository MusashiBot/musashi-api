// Polymarket public API client
// Fetches live binary prediction markets and maps them to the internal Market interface.
// No authentication required — public read-only endpoint with no CORS restrictions.

import { Market } from '../types/market';
import { generateKeywords } from './keyword-generator';

const POLYMARKET_API = 'https://gamma-api.polymarket.com';
const FETCH_TIMEOUT_MS = 10000; // 10s timeout to prevent hanging on cold starts

// Shape of an event object nested inside a market
interface PolymarketEvent {
  slug: string;
}

// Shape of a market object returned by the Polymarket gamma API
interface PolymarketMarket {
  id: string;
  conditionId: string;
  question: string;
  description?: string;
  slug: string;
  events?: PolymarketEvent[];  // parent event(s); events[0].slug is used for the URL
  outcomes: string;             // JSON string: '["Yes","No"]'
  outcomePrices: string;        // JSON string: '["0.65","0.35"]'
  volume: number;
  volume24hr: number;
  active: boolean;
  closed: boolean;
  category?: string;
  oneDayPriceChange?: number;   // 24h YES price delta
  endDateIso?: string;          // ISO date e.g. "2026-03-31"
}

/**
 * Returns true only for simple binary Yes/No markets.
 * Filters out multi-outcome and non-binary markets.
 */
function isBinaryMarket(pm: PolymarketMarket): boolean {
  if (!pm.question || !pm.conditionId || !pm.slug) return false;
  if (!pm.active || pm.closed) return false;

  try {
    const outcomes: string[] = JSON.parse(pm.outcomes);
    if (outcomes.length !== 2) return false;
    // Must be a Yes/No market
    const lower = outcomes.map(o => o.toLowerCase());
    if (!lower.includes('yes') || !lower.includes('no')) return false;
  } catch {
    return false;
  }

  return true;
}

/**
 * Fetch active binary markets from Polymarket's public gamma API.
 * Uses cursor-based pagination until we have enough markets.
 */
export async function fetchPolymarkets(
  targetCount = 500,
  maxPages = 10,
): Promise<Market[]> {
  const PAGE_SIZE = 100;
  const allMarkets: Market[] = [];
  let offset = 0;

  for (let page = 0; page < maxPages; page++) {
    const url =
      `${POLYMARKET_API}/markets?closed=false&active=true` +
      `&order=volume24hrClob&ascending=false` +
      `&limit=${PAGE_SIZE}&offset=${offset}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        console.error(`[Musashi SW] Polymarket HTTP ${resp.status}`);
        throw new Error(`Polymarket API responded with ${resp.status}`);
      }

      const data = await resp.json() as PolymarketMarket[];
      if (!Array.isArray(data)) {
        throw new Error('Unexpected Polymarket API response shape');
      }

      if (data.length === 0) break; // no more results

      const pageBinary = data
        .filter(isBinaryMarket)
        .map(toMarket)
        .filter(m => m.yesPrice > 0 && m.yesPrice < 1);

      allMarkets.push(...pageBinary);

      console.log(
        `[Musashi] Polymarket page ${page + 1}: ${data.length} raw → ` +
        `${pageBinary.length} binary (total: ${allMarkets.length})`
      );

      if (allMarkets.length >= targetCount || data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error(`Polymarket API request timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
      throw error;
    }
  }

  console.log(`[Musashi] Fetched ${allMarkets.length} live markets from Polymarket`);
  return allMarkets.slice(0, targetCount);
}

/** Map a raw Polymarket market object to our Market interface */
function toMarket(pm: PolymarketMarket): Market {
  let yesPrice = 0.5;

  try {
    const prices: string[] = JSON.parse(pm.outcomePrices);
    const outcomes: string[] = JSON.parse(pm.outcomes);
    // Find the index of "Yes" in outcomes
    const yesIdx = outcomes.findIndex(o => o.toLowerCase() === 'yes');
    if (yesIdx !== -1 && prices[yesIdx] != null) {
      yesPrice = parseFloat(prices[yesIdx]);
    }
  } catch {
    // fallback to 0.5
  }

  const safeYes = Math.min(Math.max(yesPrice, 0.01), 0.99);
  const safeNo  = +((1 - safeYes).toFixed(2));

  return {
    id: `polymarket-${pm.conditionId}`,
    platform: 'polymarket',
    title: pm.question,
    description: pm.description ?? '',
    keywords: generateKeywords(pm.question, pm.description),
    yesPrice: +safeYes.toFixed(2),
    noPrice: safeNo,
    volume24h: pm.volume24hr ?? 0,
    url: `https://polymarket.com/event/${pm.events?.[0]?.slug ?? pm.slug}`,
    category: inferCategory(pm.question, pm.category),
    lastUpdated: new Date().toISOString(),
    numericId: pm.id,
    oneDayPriceChange: pm.oneDayPriceChange ?? 0,
    endDate: pm.endDateIso ?? undefined,
  };
}

/** Infer a rough category from the market question text */
function inferCategory(question: string, apiCategory?: string): string {
  if (apiCategory) {
    const c = apiCategory.toLowerCase();
    if (c.includes('crypto') || c.includes('bitcoin')) return 'crypto';
    if (c.includes('politic') || c.includes('elect')) return 'us_politics';
    if (c.includes('sport') || c.includes('nfl') || c.includes('nba')) return 'sports';
    if (c.includes('tech')) return 'technology';
  }

  const q = question.toUpperCase();
  if (/BTC|ETH|CRYPTO|SOL|XRP|DOGE|BITCOIN|ETHEREUM/.test(q)) return 'crypto';
  if (/FED|CPI|GDP|INFLATION|RATE|RECESSION|UNEMP|JOBS/.test(q))  return 'economics';
  if (/TRUMP|BIDEN|HARRIS|PRES|CONGRESS|SENATE|ELECT|GOP|DEM|HOUSE/.test(q)) return 'us_politics';
  if (/NVDA|AAPL|MSFT|GOOGLE|META|AMAZON|AI|OPENAI|TECH|TESLA/.test(q)) return 'technology';
  if (/NFL|NBA|MLB|NHL|SUPER BOWL|WORLD CUP|FIFA|GOLF|TENNIS/.test(q)) return 'sports';
  if (/CLIMATE|WEATHER|CARBON|ENERGY|OIL/.test(q)) return 'climate';
  if (/UKRAINE|RUSSIA|CHINA|NATO|TAIWAN|ISRAEL|GAZA|IRAN/.test(q)) return 'geopolitics';
  return 'other';
}
