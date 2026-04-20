/**
 * Historical Data Fetcher
 * 
 * Fetches price snapshots from KV storage for backtesting.
 * Organizes 7-day price history by market and timestamp.
 */

import { kv, listKvKeys } from '../../api/lib/vercel-kv';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PriceSnapshot {
  marketId: string;
  yesPrice: number;
  timestamp: number;
}

export interface HistoricalPriceData {
  marketId: string;
  snapshots: PriceSnapshot[];
  startDate: Date;
  endDate: Date;
}

// ─── Main Functions ───────────────────────────────────────────────────────────

/**
 * Get historical prices for a specific market within a date range
 * 
 * @param marketId The market ID to fetch prices for
 * @param startDate Start of date range (inclusive)
 * @param endDate End of date range (inclusive)
 * @returns Array of price snapshots, sorted by timestamp (oldest first)
 */
export async function getHistoricalPrices(
  marketId: string,
  startDate: Date,
  endDate: Date
): Promise<PriceSnapshot[]> {
  try {
    const key = `price_history:${marketId}`;
    const snapshots = await kv.get<PriceSnapshot[]>(key);

    if (!snapshots || snapshots.length === 0) {
      console.warn(`[HistoricalData] No price history found for market: ${marketId}`);
      return [];
    }

    const startTimestamp = startDate.getTime();
    const endTimestamp = endDate.getTime();

    // Filter by date range and sort
    const filtered = snapshots
      .filter(s => s.timestamp >= startTimestamp && s.timestamp <= endTimestamp)
      .sort((a, b) => a.timestamp - b.timestamp);

    return filtered;
  } catch (error) {
    console.error(`[HistoricalData] Failed to fetch prices for ${marketId}:`, error);
    return [];
  }
}

/**
 * Get historical prices for multiple markets at once
 * 
 * @param marketIds Array of market IDs
 * @param startDate Start of date range
 * @param endDate End of date range
 * @returns Map of marketId to price snapshots
 */
export async function getBulkHistoricalPrices(
  marketIds: string[],
  startDate: Date,
  endDate: Date
): Promise<Map<string, PriceSnapshot[]>> {
  const results = new Map<string, PriceSnapshot[]>();

  // Fetch in parallel
  const promises = marketIds.map(async (marketId) => {
    const snapshots = await getHistoricalPrices(marketId, startDate, endDate);
    return { marketId, snapshots };
  });

  const settled = await Promise.allSettled(promises);

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      results.set(result.value.marketId, result.value.snapshots);
    }
  }

  return results;
}

/**
 * Get all available markets with price history in KV
 * 
 * @returns Array of market IDs that have price history stored
 */
export async function getAvailableMarkets(): Promise<string[]> {
  try {
    const keys = await listKvKeys('price_history:*');
    
    // Extract market IDs from keys
    const marketIds = keys.map(key => key.replace('price_history:', ''));
    
    console.log(`[HistoricalData] Found ${marketIds.length} markets with price history`);
    return marketIds;
  } catch (error) {
    console.error('[HistoricalData] Failed to list available markets:', error);
    return [];
  }
}

/**
 * Get price at a specific timestamp (or closest available)
 * 
 * @param marketId Market ID
 * @param targetTimestamp Target timestamp to find price for
 * @param maxDeviationMs Maximum allowed deviation from target time (default: 1 hour)
 * @returns Price snapshot closest to target time, or null if none found within tolerance
 */
export async function getPriceAtTime(
  marketId: string,
  targetTimestamp: number,
  maxDeviationMs: number = 60 * 60 * 1000 // 1 hour default
): Promise<PriceSnapshot | null> {
  try {
    const key = `price_history:${marketId}`;
    const snapshots = await kv.get<PriceSnapshot[]>(key);

    if (!snapshots || snapshots.length === 0) {
      return null;
    }

    // Find closest snapshot
    let closest: PriceSnapshot | null = null;
    let minDiff = Infinity;

    for (const snapshot of snapshots) {
      const diff = Math.abs(snapshot.timestamp - targetTimestamp);
      if (diff < minDiff && diff <= maxDeviationMs) {
        minDiff = diff;
        closest = snapshot;
      }
    }

    return closest;
  } catch (error) {
    console.error(`[HistoricalData] Failed to get price at time for ${marketId}:`, error);
    return null;
  }
}

/**
 * Get the date range of available data for a market
 * 
 * @param marketId Market ID
 * @returns Start and end dates of available data, or null if no data
 */
export async function getDataRange(
  marketId: string
): Promise<{ start: Date; end: Date } | null> {
  try {
    const key = `price_history:${marketId}`;
    const snapshots = await kv.get<PriceSnapshot[]>(key);

    if (!snapshots || snapshots.length === 0) {
      return null;
    }

    const timestamps = snapshots.map(s => s.timestamp).sort((a, b) => a - b);
    
    return {
      start: new Date(timestamps[0]),
      end: new Date(timestamps[timestamps.length - 1]),
    };
  } catch (error) {
    console.error(`[HistoricalData] Failed to get data range for ${marketId}:`, error);
    return null;
  }
}

/**
 * Calculate statistics for a market's price history
 * 
 * @param snapshots Array of price snapshots
 * @returns Price statistics (mean, volatility, range, etc.)
 */
export function calculatePriceStats(snapshots: PriceSnapshot[]): {
  mean: number;
  min: number;
  max: number;
  volatility: number;
  priceRange: number;
  sampleSize: number;
} {
  if (snapshots.length === 0) {
    return {
      mean: 0,
      min: 0,
      max: 0,
      volatility: 0,
      priceRange: 0,
      sampleSize: 0,
    };
  }

  const prices = snapshots.map(s => s.yesPrice);
  const mean = prices.reduce((sum, p) => sum + p, 0) / prices.length;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  
  // Calculate standard deviation (volatility)
  const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
  const volatility = Math.sqrt(variance);

  return {
    mean,
    min,
    max,
    volatility,
    priceRange: max - min,
    sampleSize: prices.length,
  };
}
