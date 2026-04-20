/**
 * Polymarket CLOB Price Poller
 *
 * Lightweight price polling for Polymarket markets using the CLOB API.
 * Fetches only price data (not full market objects) for efficient updates.
 *
 * CLOB API: https://clob.polymarket.com
 */

import { Market } from '../types/market';

const CLOB_API = 'https://clob.polymarket.com';

/**
 * CLOB price response format
 */
interface CLOBPriceResponse {
  price: string;  // e.g., "0.67"
}

/**
 * CLOB L2 order book response format
 */
interface CLOBOrderBookResponse {
  timestamp: number;
  hash: string;
  market: string;
  asset_id: string;
  bids: Array<{
    price: string;
    size: string;
  }>;
  asks: Array<{
    price: string;
    size: string;
  }>;
}

/**
 * Parsed order book with bid/ask spread
 */
export interface OrderBookDepth {
  tokenId: string;
  bid: number;        // Best bid price
  ask: number;        // Best ask price
  spread: number;     // ask - bid
  spreadBps: number;  // spread in basis points (0.01 = 100 bps = 1%)
  bidSize: number;    // Size at best bid
  askSize: number;    // Size at best ask
  midPrice: number;   // (bid + ask) / 2
  timestamp: number;
  lastUpdated: string;
}

/**
 * Fetch current price for a single Polymarket market from CLOB API
 *
 * @param numericId - Polymarket numeric ID (from market.numericId)
 * @returns YES price as number (0-1), or null if fetch fails
 */
export async function fetchPolymarketPrice(numericId: string): Promise<number | null> {
  try {
    const url = `${CLOB_API}/price?token_id=${numericId}`;

    // Add 5-second timeout to prevent hanging
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[Polymarket CLOB] Failed to fetch price for ${numericId}: HTTP ${response.status}`);
      return null;
    }

    const data: CLOBPriceResponse = await response.json();
    const price = parseFloat(data.price);

    if (isNaN(price) || price < 0 || price > 1) {
      console.warn(`[Polymarket CLOB] Invalid price for ${numericId}: ${data.price}`);
      return null;
    }

    return price;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn(`[Polymarket CLOB] Timeout fetching price for ${numericId}`);
    } else {
      console.error(`[Polymarket CLOB] Error fetching price for ${numericId}:`, error);
    }
    return null;
  }
}

/**
 * Fetch L2 order book depth for a Polymarket market
 *
 * @param tokenId - Polymarket numeric token ID
 * @returns OrderBookDepth with bid/ask spread or null if fetch fails
 */
export async function fetchOrderBookDepth(tokenId: string): Promise<OrderBookDepth | null> {
  try {
    const url = `${CLOB_API}/book?token_id=${tokenId}`;

    // Add 5-second timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[Polymarket CLOB] Failed to fetch order book for ${tokenId}: HTTP ${response.status}`);
      return null;
    }

    const data: CLOBOrderBookResponse = await response.json();

    // Validate order book data
    if (!data.bids || !data.asks || data.bids.length === 0 || data.asks.length === 0) {
      console.warn(`[Polymarket CLOB] Empty order book for ${tokenId}`);
      return null;
    }

    // Parse best bid and ask
    const bestBid = data.bids[0];
    const bestAsk = data.asks[0];

    const bidPrice = parseFloat(bestBid.price);
    const askPrice = parseFloat(bestAsk.price);
    const bidSize = parseFloat(bestBid.size);
    const askSize = parseFloat(bestAsk.size);

    // Validate prices
    if (
      isNaN(bidPrice) || isNaN(askPrice) ||
      bidPrice < 0 || bidPrice > 1 ||
      askPrice < 0 || askPrice > 1 ||
      bidPrice > askPrice
    ) {
      console.warn(`[Polymarket CLOB] Invalid order book for ${tokenId}: bid=${bidPrice}, ask=${askPrice}`);
      return null;
    }

    const spread = askPrice - bidPrice;
    const spreadBps = spread * 10000; // Convert to basis points
    const midPrice = (bidPrice + askPrice) / 2;

    return {
      tokenId,
      bid: bidPrice,
      ask: askPrice,
      spread,
      spreadBps,
      bidSize,
      askSize,
      midPrice,
      timestamp: data.timestamp,
      lastUpdated: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn(`[Polymarket CLOB] Timeout fetching order book for ${tokenId}`);
    } else {
      console.error(`[Polymarket CLOB] Error fetching order book for ${tokenId}:`, error);
    }
    return null;
  }
}

/**
 * Parallel batch fetch with controlled concurrency
 *
 * Faster than sequential but respects concurrency limits.
 *
 * @param markets - Markets to update prices for
 * @param concurrency - Max concurrent requests (default: 5)
 * @returns Markets with updated prices
 */
export async function parallelFetchPolymarketPrices(
  markets: Market[],
  concurrency: number = 5
): Promise<Market[]> {
  const polymarketMarkets = markets.filter(m =>
    m.platform === 'polymarket' && m.numericId
  );

  if (polymarketMarkets.length === 0) {
    return markets;
  }

  // Fetch prices in batches with controlled concurrency
  const prices: Map<string, number> = new Map();

  for (let i = 0; i < polymarketMarkets.length; i += concurrency) {
    const batch = polymarketMarkets.slice(i, i + concurrency);

    const results = await Promise.allSettled(
      batch.map(async (m) => {
        const price = await fetchPolymarketPrice(m.numericId!);
        return { id: m.id, price };
      })
    );

    // Collect successful results
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.price !== null) {
        prices.set(result.value.id, result.value.price);
      }
    }
  }

  // Update markets with fetched prices
  const updatedMarkets = markets.map(market => {
    if (market.platform !== 'polymarket' || !prices.has(market.id)) {
      return market;
    }

    const freshPrice = prices.get(market.id)!;
    return {
      ...market,
      yesPrice: parseFloat(freshPrice.toFixed(2)),
      noPrice: parseFloat((1 - freshPrice).toFixed(2)),
      lastUpdated: new Date().toISOString(),
    };
  });

  console.log(`[Polymarket CLOB] Updated ${prices.size}/${polymarketMarkets.length} Polymarket prices (parallel)`);

  return updatedMarkets;
}
