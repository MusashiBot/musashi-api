// Cross-platform arbitrage detector
// Matches markets across Polymarket and Kalshi to find price discrepancies

import { Market, ArbitrageOpportunity } from '../types/market';

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
  reason: string;
} {
  // Must be in the same category (or one is 'other')
  const categoryMatch = poly.category === kalshi.category ||
                       poly.category === 'other' ||
                       kalshi.category === 'other';

  if (!categoryMatch) {
    return { isSimilar: false, confidence: 0, reason: 'Different categories' };
  }

  // Calculate title similarity
  const titleSim = calculateTitleSimilarity(poly.title, kalshi.title);

  // Calculate keyword overlap
  const keywordOverlap = calculateKeywordOverlap(poly, kalshi);

  // Matching criteria (needs at least one strong signal):
  // 1. High title similarity (>0.5) OR
  // 2. Strong keyword overlap (3+ shared keywords)

  if (titleSim > 0.5) {
    return {
      isSimilar: true,
      confidence: titleSim,
      reason: `High title similarity (${(titleSim * 100).toFixed(0)}%)`
    };
  }

  if (keywordOverlap >= 3) {
    const confidence = Math.min(keywordOverlap / 10, 0.9); // Cap at 0.9
    return {
      isSimilar: true,
      confidence,
      reason: `${keywordOverlap} shared keywords`
    };
  }

  // Check for exact entity matches (strong signal even with low overall similarity)
  const polyEntities = extractEntities(poly.title);
  const kalshiEntities = extractEntities(kalshi.title);
  const sharedEntities = Array.from(polyEntities).filter(e => kalshiEntities.has(e));

  if (sharedEntities.length >= 2 && titleSim > 0.3) {
    return {
      isSimilar: true,
      confidence: 0.7,
      reason: `Shared entities: ${sharedEntities.slice(0, 3).join(', ')}`
    };
  }

  return { isSimilar: false, confidence: 0, reason: 'Insufficient similarity' };
}

/**
 * Detect arbitrage opportunities across Polymarket and Kalshi
 *
 * @param markets - Combined array of markets from both platforms
 * @param minSpread - Minimum spread to be considered an opportunity (default: 0.03 = 3%)
 * @returns Array of arbitrage opportunities sorted by spread (highest first)
 */
export function detectArbitrage(
  markets: Market[],
  minSpread: number = 0.03
): ArbitrageOpportunity[] {
  const opportunities: ArbitrageOpportunity[] = [];

  // Separate markets by platform
  const polymarkets = markets.filter(m => m.platform === 'polymarket');
  const kalshiMarkets = markets.filter(m => m.platform === 'kalshi');

  console.log(`[Arbitrage] Checking ${polymarkets.length} Polymarket × ${kalshiMarkets.length} Kalshi markets`);

  // Compare each Polymarket market with each Kalshi market
  for (const poly of polymarkets) {
    for (const kalshi of kalshiMarkets) {
      const similarity = areMarketsSimilar(poly, kalshi);

      if (!similarity.isSimilar) continue;

      // Calculate spread
      const spread = Math.abs(poly.yesPrice - kalshi.yesPrice);

      if (spread < minSpread) continue;

      // Determine direction and profit potential
      let direction: ArbitrageOpportunity['direction'];
      let profitPotential: number;

      if (poly.yesPrice < kalshi.yesPrice) {
        // Buy on Polymarket (cheaper), sell on Kalshi (more expensive)
        direction = 'buy_poly_sell_kalshi';
        profitPotential = spread; // Simplified: actual profit after fees would be lower
      } else {
        // Buy on Kalshi (cheaper), sell on Polymarket (more expensive)
        direction = 'buy_kalshi_sell_poly';
        profitPotential = spread;
      }

      opportunities.push({
        polymarket: poly,
        kalshi: kalshi,
        spread,
        profitPotential,
        direction,
        confidence: similarity.confidence,
        matchReason: similarity.reason,
      });
    }
  }

  // Sort by spread (highest first)
  opportunities.sort((a, b) => b.spread - a.spread);

  console.log(`[Arbitrage] Found ${opportunities.length} opportunities (min spread: ${minSpread})`);

  return opportunities;
}

/**
 * Get top arbitrage opportunities
 * Filters by minimum spread and confidence, returns top N
 */
export function getTopArbitrage(
  markets: Market[],
  options: {
    minSpread?: number;
    minConfidence?: number;
    limit?: number;
    category?: string;
  } = {}
): ArbitrageOpportunity[] {
  const {
    minSpread = 0.03,
    minConfidence = 0.5,
    limit = 20,
    category,
  } = options;

  let opportunities = detectArbitrage(markets, minSpread);

  // Filter by confidence
  opportunities = opportunities.filter(op => op.confidence >= minConfidence);

  // Filter by category if specified
  if (category) {
    opportunities = opportunities.filter(
      op => op.polymarket.category === category || op.kalshi.category === category
    );
  }

  // Return top N
  return opportunities.slice(0, limit);
}
