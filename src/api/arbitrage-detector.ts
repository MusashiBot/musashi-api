// Cross-platform arbitrage detector
// Matches markets across Polymarket and Kalshi to find price discrepancies

import { Market, ArbitrageOpportunity } from '../types/market';

declare const process: {
  env: Record<string, string | undefined>;
};

const FEE_POLY_BPS = Number(process.env.ARB_POLY_FEE_BPS || process.env.ARB_FEE_BPS || 20);
const FEE_KALSHI_BPS = Number(process.env.ARB_KALSHI_FEE_BPS || process.env.ARB_FEE_BPS || 20);
const SLIPPAGE_BPS = Number(process.env.ARB_SLIPPAGE_BPS || 10);
const LATENCY_BPS = Number(process.env.ARB_LATENCY_BPS || 5);
const MIN_VOLUME_FLOOR = Number(process.env.ARB_MIN_VOL || 500);
const ARB_V15_ENABLED = process.env.ARB_V15_ENABLED !== '0';
const ARB_NET_EDGE_ENABLED = process.env.ARB_NET_EDGE_ENABLED !== '0';
const ARB_STRICT_MATCH_ENABLED = process.env.ARB_STRICT_MATCH_ENABLED !== '0';

/**
 * Helper to group markets by category for faster scanning (O(N) vs O(N*M))
 */
function groupByCategory(markets: Market[]): Record<string, Market[]> {
  return markets.reduce((acc, market) => {
    const cat = market.category || 'other';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(market);
    return acc;
  }, {} as Record<string, Market[]>);
}

/**
 * Normalize a title for fuzzy matching
 * Removes punctuation, dates, common question words, normalizes spacing
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\?/g, '') // Remove question marks
    .replace(/\b(will|before|after|by|in|on|at|the|a|an)\b/g, '') // Remove filler words
    .replace(/\b(2024|2025|2026|2027|2028)\b/g, '') // Remove years
    .replace(/[^a-z0-9\s]/g, ' ') // Remove all punctuation
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}

/**
 * Extract key entities from a market title
 * Looks for: names, tickers, numbers, organizations
 */
function extractEntities(title: string): Set<string> {
  const normalized = normalizeTitle(title);
  const words = normalized.split(' ');
  const entities = new Set<string>();

  // Extract significant words (3+ chars, not in stop list)
  const stopWords = new Set(['will', 'hit', 'reach', 'win', 'lose', 'pass', 'than', 'over', 'under']);

  for (const word of words) {
    if (word.length >= 3 && !stopWords.has(word)) {
      entities.add(word);
    }
  }

  return entities;
}

/**
 * Calculate similarity score between two titles
 * Returns 0-1 based on shared entities
 */
function calculateTitleSimilarity(title1: string, title2: string): number {
  const entities1 = extractEntities(title1);
  const entities2 = extractEntities(title2);

  if (entities1.size === 0 || entities2.size === 0) return 0;

  // Count shared entities
  let sharedCount = 0;
  for (const entity of entities1) {
    if (entities2.has(entity)) {
      sharedCount++;
    }
  }

  // Jaccard similarity: intersection / union
  const union = entities1.size + entities2.size - sharedCount;
  return union > 0 ? sharedCount / union : 0;
}

/**
 * Calculate keyword overlap between two markets
 * Returns the number of shared keywords
 */
function calculateKeywordOverlap(market1: Market, market2: Market): number {
  const keywords1 = new Set(market1.keywords);
  const keywords2 = new Set(market2.keywords);

  let overlap = 0;
  for (const kw of keywords1) {
    if (keywords2.has(kw)) {
      overlap++;
    }
  }

  return overlap;
}

/**
 * Check if two markets refer to the same event
 * Uses title similarity + keyword overlap + category matching
 */
function areMarketsSimilar(poly: Market, kalshi: Market): {
  isSimilar: boolean;
  confidence: number;
  titleSim: number;
  keywordOverlap: number;
  reason: string;
} {
  // Must be in the same category (or one is 'other')
  const categoryMatch = poly.category === kalshi.category ||
                       poly.category === 'other' ||
                       kalshi.category === 'other';

  if (!categoryMatch) {
    return {
      isSimilar: false,
      confidence: 0,
      titleSim: 0,
      keywordOverlap: 0,
      reason: 'Different categories',
    };
  }

  // Calculate title similarity
  const titleSim = calculateTitleSimilarity(poly.title, kalshi.title);

  // Calculate keyword overlap
  const keywordOverlap = calculateKeywordOverlap(poly, kalshi);

  // Matching criteria (needs at least one strong signal):
  // 1. High title similarity OR
  // 2. Strong keyword overlap (3+ shared keywords)
  const titleThreshold = ARB_STRICT_MATCH_ENABLED ? 0.6 : 0.5;
  const entityThreshold = ARB_STRICT_MATCH_ENABLED ? 0.35 : 0.3;

  if (titleSim > titleThreshold) {
    return {
      isSimilar: true,
      confidence: titleSim,
      titleSim,
      keywordOverlap,
      reason: `High title similarity (${(titleSim * 100).toFixed(0)}%)`,
    };
  }

  if (keywordOverlap >= 3) {
    const confidence = Math.min(keywordOverlap / 10, 0.85); // Cap at 0.85
    return {
      isSimilar: true,
      confidence,
      titleSim,
      keywordOverlap,
      reason: `${keywordOverlap} shared keywords`,
    };
  }

  // Check for exact entity matches (strong signal even with low overall similarity)
  const polyEntities = extractEntities(poly.title);
  const kalshiEntities = extractEntities(kalshi.title);
  const sharedEntities = Array.from(polyEntities).filter(e => kalshiEntities.has(e));

  if (sharedEntities.length >= 2 && titleSim > entityThreshold) {
    return {
      isSimilar: true,
      confidence: 0.7,
      titleSim,
      keywordOverlap,
      reason: `Shared entities: ${sharedEntities.slice(0, 3).join(', ')}`,
    };
  }

  return {
    isSimilar: false,
    confidence: 0,
    titleSim,
    keywordOverlap,
    reason: 'Insufficient similarity',
  };
}

function safePriceForBuy(market: Market): number {
  return market.yesAsk ?? market.yesPrice;
}

function safePriceForSell(market: Market): number {
  return market.yesBid ?? market.yesPrice;
}

/**
 * Detect arbitrage opportunities
 *
 * @param markets - Combined array of markets from both platforms
 * @param minNetEdgeBps - Minimum basis points profit (default, 50bps/0.5%)
 */
export function detectArbitrage(
  markets: Market[],
  minNetEdgeBps: number = 10
): ArbitrageOpportunity[] {
  const opportunities: ArbitrageOpportunity[] = [];
  const polyByCat = groupByCategory(markets.filter(m => m.platform === 'polymarket'));
  const kalshiByCat = groupByCategory(markets.filter(m => m.platform === 'kalshi'));

  for (const cat in polyByCat) {
    if (!kalshiByCat[cat]) continue;
    for (const poly of polyByCat[cat]) {
      for (const kalshi of kalshiByCat[cat]) {
        
        // Expiry Delta
        let expiryDeltaMinutes: number | null = null;
        if (poly.endDate && kalshi.endDate) {
          expiryDeltaMinutes = Math.abs(new Date(poly.endDate).getTime() - new Date(kalshi.endDate).getTime()) / 60000;
          if (expiryDeltaMinutes > 1440) continue;
        }

        const similarity = areMarketsSimilar(poly, kalshi);
        if (!similarity.isSimilar) continue;

        // Executable Edge (Buy at Ask, Sell at Bid)
        const polyBuy = ARB_V15_ENABLED ? (poly.yesAsk ?? poly.yesPrice) : poly.yesPrice;
        const polySell = ARB_V15_ENABLED ? (poly.yesBid ?? poly.yesPrice) : poly.yesPrice;
        const kalshiBuy = ARB_V15_ENABLED ? (kalshi.yesAsk ?? kalshi.yesPrice) : kalshi.yesPrice;
        const kalshiSell = ARB_V15_ENABLED ? (kalshi.yesBid ?? kalshi.yesPrice) : kalshi.yesPrice;

        const edgePolyBuy = kalshiSell - polyBuy;
        const edgeKalshiBuy = polySell - kalshiBuy;

        const isPolyCheaper = edgePolyBuy >= edgeKalshiBuy;
        const buyPrice = isPolyCheaper ? safePriceForBuy(poly) : safePriceForBuy(kalshi);
        const sellPrice = isPolyCheaper ? safePriceForSell(kalshi) : safePriceForSell(poly);
        if (buyPrice <= 0 || sellPrice <= 0 || sellPrice <= buyPrice) continue;
        
        // Summed Venue Fees
        const totalFees = ARB_NET_EDGE_ENABLED
          ? (FEE_POLY_BPS + FEE_KALSHI_BPS + SLIPPAGE_BPS + LATENCY_BPS)
          : 0;
        const grossBps = ((sellPrice - buyPrice) / buyPrice) * 10000;
        const netEdge = grossBps - totalFees;

        if (netEdge < minNetEdgeBps) continue;

        // Real Liquidity Score
        const combinedVol = (poly.volume24h || 0) + (kalshi.volume24h || 0);
        if (combinedVol < MIN_VOLUME_FLOOR) continue;

        opportunities.push({
          polymarket: poly,
          kalshi,
          buyPrice,
          sellPrice,
          buyVenue: isPolyCheaper ? 'polymarket' : 'kalshi',
          sellVenue: isPolyCheaper ? 'kalshi' : 'polymarket',
          netEdgeBps: Math.round(netEdge),
          grossEdgeBps: Math.round(grossBps),
          estimatedFeesBps: FEE_POLY_BPS + FEE_KALSHI_BPS,
          slippageBps: SLIPPAGE_BPS,
          latencyRiskBps: LATENCY_BPS,
          confidence: similarity.confidence,
          matchReason: similarity.reason,
          spread: sellPrice - buyPrice,
          profitPotential: sellPrice - buyPrice,
          direction: isPolyCheaper ? 'buy_poly_sell_kalshi' : 'buy_kalshi_sell_poly',
          matchConfidence: {
            score: similarity.confidence,
            titleSimilarity: similarity.titleSim,
            keywordOverlap: similarity.keywordOverlap,
            categoryAligned: true,
            expiryAligned: (expiryDeltaMinutes || 0) < 60,
            liquidityAligned: combinedVol >= MIN_VOLUME_FLOOR,
          },
          sourceTimestamps: {
            polymarket: poly.lastUpdated || null,
            kalshi: kalshi.lastUpdated || null,
          },
          expiryDeltaMinutes,
          asOfTs: new Date().toISOString(),
          liquidityScore: Math.min(combinedVol / 10000, 1),
        });
      }
    }
  }

  // Deterministic Sort + Tie-break
  return opportunities.sort((a, b) => {
    if (b.netEdgeBps !== a.netEdgeBps) return b.netEdgeBps - a.netEdgeBps;
    if (b.matchConfidence.score !== a.matchConfidence.score) return b.matchConfidence.score - a.matchConfidence.score;
    return `${a.polymarket.id}${a.kalshi.id}`.localeCompare(`${b.polymarket.id}${b.kalshi.id}`);
  });
}

/**
 * Get top arbitrage opportunities
 * Filters by minimum spread and confidence, returns top N
 */
export function getTopArbitrage(
  markets: Market[],
  options: {
    minNetEdgeBps?: number;
    limit?: number;
    category?: string;
  } = {}
): ArbitrageOpportunity[] {
  const {
    minNetEdgeBps = 50,
    limit = 20,
    category,
  } = options;

  let opportunities = detectArbitrage(markets, minNetEdgeBps);

  // Filter by category if specified
  if (category) {
    opportunities = opportunities.filter(
      op => op.polymarket.category === category || op.kalshi.category === category
    );
  }

  // Return top N
  return opportunities.slice(0, limit);
}
