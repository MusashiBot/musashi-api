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
 * BM25 corpus statistics. Built once per detectArbitrage() call over the full
 * candidate pool so IDF reflects term-rarity across all markets being compared,
 * not just the pair under inspection.
 */
export interface BM25Stats {
  idf: Map<string, number>;
  avgdl: number;
  N: number;
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;
// Tuned against arbitrage-detector.test.ts: rejects rare-term coincidences and
// the stop-word-heavy false-positive case while still matching paraphrased
// titles and Trump-2028-style high-volume overlaps.
const BM25_MATCH_THRESHOLD = 0.4;

/**
 * Build BM25 corpus stats from a set of markets. tf is implicitly 1 per term
 * since Market.keywords is already deduplicated by the keyword generator.
 * Uses the BM25+ IDF variant (+1 inside log) so weights stay non-negative on
 * small corpora.
 */
export function buildBM25Stats(markets: Market[]): BM25Stats {
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const m of markets) {
    const terms = new Set(m.keywords);
    totalLen += terms.size;
    for (const term of terms) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const N = markets.length;
  const avgdl = N > 0 ? totalLen / N : 0;
  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    idf.set(term, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
  }

  return { idf, avgdl, N };
}

/** Asymmetric BM25: score `doc`'s relevance to `query`. */
function bm25Score(query: Market, doc: Market, stats: BM25Stats): number {
  const docTerms = new Set(doc.keywords);
  const dl = docTerms.size;
  const lenNorm = stats.avgdl > 0 ? 1 - BM25_B + BM25_B * (dl / stats.avgdl) : 1;
  const denom = 1 + BM25_K1 * lenNorm;

  let score = 0;
  for (const term of new Set(query.keywords)) {
    if (!docTerms.has(term)) continue;
    const idf = stats.idf.get(term) ?? 0;
    score += (idf * (BM25_K1 + 1)) / denom;
  }
  return score;
}

/**
 * Symmetric BM25 similarity in [0, 1] via self-score normalization.
 * Averaging both directions makes the score order-independent; dividing by
 * mean self-score keeps it bounded and interpretable as a confidence.
 */
function bm25Similarity(a: Market, b: Market, stats: BM25Stats): number {
  const raw = 0.5 * (bm25Score(a, b, stats) + bm25Score(b, a, stats));
  const selfBound = 0.5 * (bm25Score(a, a, stats) + bm25Score(b, b, stats));
  if (selfBound <= 0) return 0;
  return Math.min(raw / selfBound, 1);
}

/**
 * Check if two markets refer to the same event.
 * Three signals, in order: category gate, title similarity, BM25 keyword
 * similarity. Entity overlap acts as a tiebreaker when title similarity is
 * borderline. BM25 stats must be precomputed once over the full candidate
 * pool — passing a stats object built from only the pair degenerates IDF.
 */
export function areMarketsSimilar(poly: Market, kalshi: Market, stats: BM25Stats): {
  isSimilar: boolean;
  confidence: number;
  reason: string;
} {
  // Must be in the same category
  if (poly.category !== kalshi.category) {
    return { isSimilar: false, confidence: 0, reason: 'Different categories' };
  }

  const titleSim = calculateTitleSimilarity(poly.title, kalshi.title);

  if (titleSim > 0.5) {
    return {
      isSimilar: true,
      confidence: titleSim,
      reason: `High title similarity (${(titleSim * 100).toFixed(0)}%)`
    };
  }

  const bm25Sim = bm25Similarity(poly, kalshi, stats);

  if (bm25Sim > BM25_MATCH_THRESHOLD) {
    return {
      isSimilar: true,
      confidence: bm25Sim,
      reason: `BM25 similarity ${(bm25Sim * 100).toFixed(0)}%`
    };
  }

  // Check for exact entity matches (strong signal only when titles are still fairly similar)
  const polyEntities = extractEntities(poly.title);
  const kalshiEntities = extractEntities(kalshi.title);
  const sharedEntities = Array.from(polyEntities).filter(e => kalshiEntities.has(e));

  if (sharedEntities.length >= 3 && titleSim > 0.45) {
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

  // Build BM25 stats once over the full candidate pool so IDF reflects
  // term-rarity across all markets, not just the current pair.
  const stats = buildBM25Stats([...polymarkets, ...kalshiMarkets]);

  // Compare each Polymarket market with each Kalshi market
  for (const poly of polymarkets) {
    for (const kalshi of kalshiMarkets) {
      const similarity = areMarketsSimilar(poly, kalshi, stats);

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
