// Cross-platform arbitrage detector
// Matches markets across Polymarket and Kalshi to find price discrepancies.
//
// Improvements over legacy text-similarity approach:
//   1. Semantic embedding similarity: uses transformer models (all-MiniLM-L6-v2)
//      to capture deep semantic relationships beyond keyword overlap.
//   2. Liquidity-adjusted spread: raw spread is discounted by estimated friction
//      based on minimum 24h volume of the two markets.
//   3. Directional opposition guard: titles that appear semantically similar
//      but express opposite outcomes (above/below, pass/fail, yes/no antonyms)
//      are flagged as `is_directionally_opposed` so bots can skip false pairs.
//   4. Synonym expansion: common prediction-market paraphrases ("FOMC" ↔ "Fed",
//      "rate cut" ↔ "reduction", etc.) are normalised before comparison as fallback.

import { Market, ArbitrageOpportunity } from '../types/market';
import { computeMarketSimilarity } from '../analysis/semantic-matcher';

// ─── Synonym expansion ────────────────────────────────────────────────────────

// Groups of interchangeable terms in prediction markets.
// Any word in a group is replaced by the group's canonical form (index 0)
// before similarity is computed, collapsing paraphrases into the same tokens.
const SYNONYM_GROUPS: readonly string[][] = [
  ['federal reserve', 'fed', 'fomc'],
  ['rate cut', 'reduction', 'decrease rates', 'lower rates'],
  ['rate hike', 'rate increase', 'raise rates'],
  ['bitcoin', 'btc'],
  ['ethereum', 'eth'],
  ['president', 'potus'],
  ['congress', 'senate', 'house of representatives'],
  ['election', 'vote', 'ballot'],
  ['gdp', 'gross domestic product'],
  ['cpi', 'consumer price index', 'inflation'],
  ['ukraine', 'russia', 'war in ukraine'],
  ['artificial intelligence', 'ai'],
  ['december', 'dec'],
  ['january', 'jan'],
  ['february', 'feb'],
  ['march', 'mar'],
  ['april', 'apr'],
  ['september', 'sep', 'sept'],
  ['october', 'oct'],
  ['november', 'nov'],
];

// Build a flat lookup map: alias → canonical
const SYNONYM_MAP = new Map<string, string>();
for (const group of SYNONYM_GROUPS) {
  const canonical = group[0];
  for (const alias of group) {
    SYNONYM_MAP.set(alias, canonical);
  }
}

// ─── Directional opposition detection ────────────────────────────────────────

// Pairs of terms that indicate opposite directions.
// If one title contains term A and the other contains term B (or vice versa)
// for any pair, the markets are directionally opposed.
const DIRECTIONAL_PAIRS: readonly [string, string][] = [
  ['above', 'below'],
  ['over', 'under'],
  ['exceed', 'miss'],
  ['pass', 'fail'],
  ['win', 'lose'],
  ['increase', 'decrease'],
  ['rise', 'fall'],
  ['higher', 'lower'],
  ['more than', 'less than'],
  ['at least', 'at most'],
];

function isDirectionallyOpposed(title1: string, title2: string): boolean {
  const t1 = title1.toLowerCase();
  const t2 = title2.toLowerCase();
  for (const [a, b] of DIRECTIONAL_PAIRS) {
    const aIn1 = t1.includes(a);
    const bIn2 = t2.includes(b);
    const bIn1 = t1.includes(b);
    const aIn2 = t2.includes(a);
    if ((aIn1 && bIn2) || (bIn1 && aIn2)) return true;
  }
  return false;
}

// ─── Title normalisation ──────────────────────────────────────────────────────

function normalizeTitle(title: string): string {
  let text = title
    .toLowerCase()
    .replace(/\?/g, '')
    .replace(/\b(will|before|after|by|in|on|at|the|a|an|to|be|is|are|was|were)\b/g, '')
    .replace(/\b(2024|2025|2026|2027|2028)\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Apply synonym expansion (longest-match first to avoid partial replacements)
  const sortedAliases = Array.from(SYNONYM_MAP.keys()).sort((a, b) => b.length - a.length);
  for (const alias of sortedAliases) {
    const canonical = SYNONYM_MAP.get(alias)!;
    if (alias !== canonical) {
      text = text.replace(new RegExp(`\\b${alias}\\b`, 'g'), canonical);
    }
  }

  return text.replace(/\s+/g, ' ').trim();
}

function extractEntities(title: string): Set<string> {
  const normalized = normalizeTitle(title);
  const words = normalized.split(' ');
  const stopWords = new Set([
    'will', 'hit', 'reach', 'win', 'lose', 'pass', 'than', 'over',
    'under', 'get', 'have', 'make', 'take', 'new', 'first', 'last',
  ]);
  const entities = new Set<string>();
  for (const word of words) {
    if (word.length >= 3 && !stopWords.has(word)) {
      entities.add(word);
    }
  }
  return entities;
}

// ─── Similarity scoring ───────────────────────────────────────────────────────

function calculateTitleSimilarity(title1: string, title2: string): number {
  const e1 = extractEntities(title1);
  const e2 = extractEntities(title2);
  if (e1.size === 0 || e2.size === 0) return 0;
  let shared = 0;
  for (const e of e1) {
    if (e2.has(e)) shared++;
  }
  const union = e1.size + e2.size - shared;
  return union > 0 ? shared / union : 0;
}

function calculateKeywordOverlap(market1: Market, market2: Market): number {
  const kw1 = new Set(market1.keywords);
  let overlap = 0;
  for (const kw of market2.keywords) {
    if (kw1.has(kw)) overlap++;
  }
  return overlap;
}

async function areMarketsSimilar(
  poly: Market,
  kalshi: Market
): Promise<{ isSimilar: boolean; confidence: number; reason: string }> {
  const categoryMatch =
    poly.category === kalshi.category ||
    poly.category === 'other' ||
    kalshi.category === 'other';

  if (!categoryMatch) {
    return { isSimilar: false, confidence: 0, reason: 'Different categories' };
  }

  const semanticDisabled = process.env.MUSASHI_DISABLE_SEMANTIC_MATCHING === '1';

  // ═══ PRIMARY: Semantic embedding similarity ════════════════════════════════
  // Try semantic matching first - this captures deep semantic relationships
  // that keyword/token methods miss (e.g., "Fed rate cut" ≈ "FOMC reduction").
  // Skip when MUSASHI_DISABLE_SEMANTIC_MATCHING=1 (no transformers/sharp cold path).
  if (!semanticDisabled) {
  try {
    const semanticSim = await computeMarketSimilarity(poly, kalshi);
    
    // Semantic threshold: 0.75+ is high confidence, 0.65+ is moderate
    if (semanticSim >= 0.75) {
      return {
        isSimilar: true,
        confidence: semanticSim,
        reason: `Semantic embedding similarity ${(semanticSim * 100).toFixed(0)}%`,
      };
    }
    
    if (semanticSim >= 0.65) {
      // Moderate semantic match - validate with keyword overlap
      const keywordOverlap = calculateKeywordOverlap(poly, kalshi);
      if (keywordOverlap >= 2) {
        return {
          isSimilar: true,
          confidence: semanticSim,
          reason: `Semantic match ${(semanticSim * 100).toFixed(0)}% + ${keywordOverlap} keywords`,
        };
      }
    }
  } catch (err) {
    console.warn('[Arbitrage] Semantic matching failed, falling back to text-based:', err);
  }
  }

  // ═══ FALLBACK: Text-based similarity methods ══════════════════════════════
  // Use the original token/keyword methods as backup if semantic fails
  // or produces low confidence scores.

  const titleSim = calculateTitleSimilarity(poly.title, kalshi.title);
  const keywordOverlap = calculateKeywordOverlap(poly, kalshi);

  if (titleSim > 0.5) {
    return {
      isSimilar: true,
      confidence: titleSim,
      reason: `Title similarity ${(titleSim * 100).toFixed(0)}% (synonym-expanded)`,
    };
  }

  if (keywordOverlap >= 3) {
    const confidence = Math.min(keywordOverlap / 10, 0.9);
    return {
      isSimilar: true,
      confidence,
      reason: `${keywordOverlap} shared keywords`,
    };
  }

  const polyEntities = extractEntities(poly.title);
  const kalshiEntities = extractEntities(kalshi.title);
  const sharedEntities = Array.from(polyEntities).filter(e => kalshiEntities.has(e));

  if (sharedEntities.length >= 2 && titleSim > 0.3) {
    return {
      isSimilar: true,
      confidence: 0.7,
      reason: `Shared entities: ${sharedEntities.slice(0, 3).join(', ')}`,
    };
  }

  return { isSimilar: false, confidence: 0, reason: 'Insufficient similarity' };
}

// ─── Liquidity-adjusted spread ────────────────────────────────────────────────

/**
 * Estimate the round-trip friction cost (half-spread) from 24h volume.
 *
 * Tier thresholds are conservative proxies for bid/ask width.
 * Illiquid markets (<$5k/day) carry ~4% friction; deep markets (>$50k) ~0.5%.
 */
function liquidityPenalty(volume24h: number): number {
  if (volume24h < 5_000) return 0.04;   // illiquid
  if (volume24h < 50_000) return 0.015; // mid-tier
  return 0.005;                          // liquid
}

/**
 * Compute net executable spread after deducting round-trip liquidity cost.
 * Uses the minimum volume of the two markets (the binding constraint).
 */
function netSpread(arb: {
  spread: number;
  polymarket: Market;
  kalshi: Market;
}): { net_spread: number; liquidity_penalty: number } {
  const volMin = Math.min(arb.polymarket.volume24h, arb.kalshi.volume24h);
  const penalty = liquidityPenalty(volMin);
  return {
    net_spread: parseFloat(Math.max(0, arb.spread - penalty).toFixed(4)),
    liquidity_penalty: parseFloat(penalty.toFixed(4)),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect arbitrage opportunities across Polymarket and Kalshi.
 *
 * Returned opportunities are sorted by net_spread (highest first).
 * Only opportunities where net_spread > 0 represent executable edge.
 *
 * @param markets    Combined array of markets from both platforms
 * @param minSpread  Minimum RAW spread to consider (default 0.03 = 3%)
 */
export async function detectArbitrage(
  markets: Market[],
  minSpread = 0.03
): Promise<ArbitrageOpportunity[]> {
  const opportunities: ArbitrageOpportunity[] = [];

  const polymarkets = markets.filter(m => m.platform === 'polymarket');
  const kalshiMarkets = markets.filter(m => m.platform === 'kalshi');

  console.log(
    `[Arbitrage] Checking ${polymarkets.length} Polymarket × ${kalshiMarkets.length} Kalshi markets`
  );

  for (const poly of polymarkets) {
    for (const kalshi of kalshiMarkets) {
      const similarity = await areMarketsSimilar(poly, kalshi);
      if (!similarity.isSimilar) continue;

      const spread = Math.abs(poly.yesPrice - kalshi.yesPrice);
      if (spread < minSpread) continue;

      const opposed = isDirectionallyOpposed(poly.title, kalshi.title);

      const direction: ArbitrageOpportunity['direction'] =
        poly.yesPrice < kalshi.yesPrice ? 'buy_poly_sell_kalshi' : 'buy_kalshi_sell_poly';

      const { net_spread, liquidity_penalty } = netSpread({ spread, polymarket: poly, kalshi });

      opportunities.push({
        polymarket: poly,
        kalshi,
        spread: parseFloat(spread.toFixed(4)),
        net_spread,
        liquidity_penalty,
        // Use net_spread as the true profit potential — more honest than raw spread
        profitPotential: net_spread,
        direction,
        confidence: similarity.confidence,
        matchReason: similarity.reason,
        is_directionally_opposed: opposed,
      });
    }
  }

  // Sort by net_spread descending (best executable edge first)
  opportunities.sort((a, b) => b.net_spread - a.net_spread);

  console.log(`[Arbitrage] Found ${opportunities.length} opportunities (minSpread: ${minSpread})`);

  return opportunities;
}

/**
 * Get top arbitrage opportunities with filtering.
 * By default, excludes directionally-opposed pairs (common false positives).
 */
export async function getTopArbitrage(
  markets: Market[],
  options: {
    minSpread?: number;
    minConfidence?: number;
    limit?: number;
    category?: string;
    excludeOpposed?: boolean;
  } = {}
): Promise<ArbitrageOpportunity[]> {
  const {
    minSpread = 0.03,
    minConfidence = 0.5,
    limit = 20,
    category,
    excludeOpposed = true,
  } = options;

  let opportunities = await detectArbitrage(markets, minSpread);

  opportunities = opportunities.filter(op => op.confidence >= minConfidence);

  if (excludeOpposed) {
    opportunities = opportunities.filter(op => !op.is_directionally_opposed);
  }

  if (category) {
    opportunities = opportunities.filter(
      op => op.polymarket.category === category || op.kalshi.category === category
    );
  }

  return opportunities.slice(0, limit);
}
