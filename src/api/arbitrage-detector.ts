// Cross-platform arbitrage detector
// Matches equivalent Polymarket/Kalshi contracts and prices covered YES/NO bundles.

import { Market, ArbitrageOpportunity } from '../types/market';
import { detectContractType, contractTypeCompatibility } from '../analysis/contract-type';

const STOP_WORDS = new Set([
  'will', 'the', 'a', 'an', 'in', 'on', 'at', 'by', 'for', 'to', 'of',
  'and', 'or', 'is', 'be', 'has', 'have', 'are', 'was', 'were', 'been',
  'do', 'does', 'did', 'before', 'after', 'end', 'yes', 'no', 'than',
  'major', 'us', 'use', 'its', 'their', 'any', 'all', 'into', 'out',
  'as', 'from', 'with', 'this', 'that', 'not', 'new', 'more', 'most',
  'least', 'how', 'what', 'when', 'where', 'who', 'get', 'got', 'put',
  'set', 'per', 'via', 'if', 'whether', 'each', 'such', 'also',
]);

const OUTCOME_PHRASES = [
  'win', 'wins', 'won', 'nominee', 'nomination', 'elected', 'election',
  'above', 'below', 'over', 'under', 'reach', 'reaches', 'hit', 'hits',
  'pass', 'passes', 'rate hike', 'rate cut', 'cut rates', 'raise rates',
  'shutdown', 'resign', 'indicted', 'approved', 'land', 'launch',
];

interface ContractSignature {
  terms: Set<string>;
  years: Set<string>;
  dates: Set<string>;
  numbers: Set<string>;
  outcomes: Set<string>;
  scopes: Set<string>;
}

interface MatchResult {
  isSimilar: boolean;
  confidence: number;
  reason: string;
}

interface BundleCandidate {
  direction: ArbitrageOpportunity['direction'];
  yesPlatform: 'polymarket' | 'kalshi';
  noPlatform: 'polymarket' | 'kalshi';
  yesPrice: number;
  noPrice: number;
  costPerBundle: number;
  edge: number;
}

const DEFAULT_FEES_AND_SLIPPAGE = Number.parseFloat(
  process.env.MUSASHI_ARB_COST_BUFFER ?? '0.02',
);

// Contract types that are structurally interchangeable for arbitrage matching.
// Both settle to a single YES/NO outcome; the time-window qualifier is a detail
// that one platform may omit in its title while the other includes it.
const BINARY_COMPATIBLE_TYPES = new Set<string>(['TIME_WINDOW_BINARY', 'BINARY_OUTCOME']);

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[$,]/g, '')
    .replace(/[^a-z0-9.%\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(title: string): string[] {
  return normalizeTitle(title)
    .split(' ')
    .filter(word => word.length > 1 && !STOP_WORDS.has(word));
}

function extractTerms(title: string): Set<string> {
  return new Set(tokens(title).filter(word => word.length >= 3));
}

function extractYears(title: string, endDate?: string): Set<string> {
  const years = new Set<string>();
  for (const match of normalizeTitle(title).matchAll(/\b20\d{2}\b/g)) {
    years.add(match[0]);
  }
  if (endDate) {
    const year = new Date(endDate).getUTCFullYear();
    if (Number.isFinite(year)) years.add(String(year));
  }
  return years;
}

function extractDates(title: string): Set<string> {
  const normalized = normalizeTitle(title);
  const dates = new Set<string>();
  const monthPattern = /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+\d{1,2}\b/g;
  for (const match of normalized.matchAll(monthPattern)) dates.add(match[0]);
  for (const match of normalized.matchAll(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g)) dates.add(match[0]);
  return dates;
}

function extractNumbers(title: string): Set<string> {
  const numbers = new Set<string>();
  for (const match of normalizeTitle(title).matchAll(/\b\d+(?:\.\d+)?\s?(?:k|m|b|%|percent|bps)?\b/g)) {
    numbers.add(match[0].replace(/\s+/g, ''));
  }
  return numbers;
}

function extractOutcomes(title: string): Set<string> {
  const normalized = normalizeTitle(title);
  const outcomes = new Set<string>();
  for (const phrase of OUTCOME_PHRASES) {
    if (normalized.includes(phrase)) outcomes.add(phrase);
  }
  return outcomes;
}

function extractScopes(title: string): Set<string> {
  const normalized = normalizeTitle(title);
  const scopes = new Set<string>();

  if (/\bmatch\b|\bvs\b|\bversus\b/.test(normalized)) scopes.add('single_match');
  if (/\bseason\b|\bplayoffs?\b|\bchampionship\b|\btournament\b|\bseries\b|\bwinner\b/.test(normalized)) scopes.add('season_or_tournament');
  if (/\belection\b|\bnominee\b|\bnomination\b/.test(normalized)) scopes.add('election');
  if (/\bby\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)|before|after/.test(normalized)) scopes.add('deadline');

  return scopes;
}

function signature(market: Market): ContractSignature {
  return {
    terms: extractTerms(market.title),
    years: extractYears(market.title, market.endDate),
    dates: extractDates(market.title),
    numbers: extractNumbers(market.title),
    outcomes: extractOutcomes(market.title),
    scopes: extractScopes(market.title),
  };
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const value of a) {
    if (b.has(value)) shared++;
  }
  return shared;
}

function hasConflict(a: Set<string>, b: Set<string>): boolean {
  return a.size > 0 && b.size > 0 && intersectionSize(a, b) === 0;
}

// Weight applied to the containment score when used as a Jaccard fallback.
// Halved so that a fully-contained short title doesn't dominate the composite
// confidence score the same way a high Jaccard score would.
const CONTAINMENT_WEIGHT = 0.5;

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const shared = intersectionSize(a, b);
  const union = a.size + b.size - shared;
  const jaccardScore = union > 0 ? shared / union : 0;
  // When one set is much smaller (e.g. a short Kalshi title after stop-word
  // filtering), pure Jaccard is unfairly penalised by the large union. Use a
  // weighted containment score (fraction of the smaller set that is covered) as
  // a fallback so short but highly-overlapping titles still match.
  const containment = shared / Math.min(a.size, b.size);
  return Math.max(jaccardScore, containment * CONTAINMENT_WEIGHT);
}

function calculateKeywordOverlap(market1: Market, market2: Market): number {
  return intersectionSize(new Set(market1.keywords), new Set(market2.keywords));
}

// Minimum composite confidence required to accept a pair as a match.
// 0.4 is exploratory: more coverage with acceptable noise.
const MIN_MATCH_CONFIDENCE = 0.4;

// Per-field conflict penalties subtracted from the base confidence score.
// Conflicts reduce confidence but no longer hard-reject the pair.
const PENALTY_YEAR    = 0.35;
const PENALTY_DATE    = 0.25;
const PENALTY_NUMBER  = 0.30;
const PENALTY_OUTCOME = 0.20;
const PENALTY_SCOPE   = 0.20;

function areMarketsSimilar(poly: Market, kalshi: Market): MatchResult {
  const strictCategoryMatch =
    poly.category === kalshi.category &&
    poly.category !== 'other' &&
    kalshi.category !== 'other';
  const categoryUnknown = poly.category === 'other' || kalshi.category === 'other';

  if (!strictCategoryMatch && !categoryUnknown) {
    return { isSimilar: false, confidence: 0, reason: 'Different categories' };
  }

  // Gate 2: Contract structure type compatibility.
  // Structurally incompatible types (e.g. RANGE_COUNT vs EVENT_MATCH_OUTCOME,
  // score 0) are still hard-rejected.  All other pairs receive a positive type
  // score that acts as a weight in the composite confidence formula.
  const polyType = detectContractType(poly);
  const kalshiType = detectContractType(kalshi);
  const typeScore = contractTypeCompatibility(polyType, kalshiType);
  // Also treat types that are both in the binary-compatible set as fully
  // compatible (TIME_WINDOW_BINARY ↔ BINARY_OUTCOME).
  const effectiveTypeScore =
    typeScore === 0 && BINARY_COMPATIBLE_TYPES.has(polyType) && BINARY_COMPATIBLE_TYPES.has(kalshiType)
      ? 1.0
      : typeScore;
  if (effectiveTypeScore === 0) {
    return {
      isSimilar: false,
      confidence: 0,
      reason: `Incompatible contract types (${polyType} vs ${kalshiType})`,
    };
  }

  const polySig = signature(poly);
  const kalshiSig = signature(kalshi);

  // Accumulate penalties for field conflicts instead of hard-rejecting.
  // Each mismatch reduces confidence; a single mismatch no longer kills the pair.
  let penaltyTotal = 0;
  const penaltyReasons: string[] = [];

  if (hasConflict(polySig.years, kalshiSig.years)) {
    penaltyTotal += PENALTY_YEAR;
    penaltyReasons.push('year mismatch');
  }

  if (hasConflict(polySig.dates, kalshiSig.dates)) {
    penaltyTotal += PENALTY_DATE;
    penaltyReasons.push('date mismatch');
  }

  if (hasConflict(polySig.numbers, kalshiSig.numbers)) {
    penaltyTotal += PENALTY_NUMBER;
    penaltyReasons.push('numeric threshold mismatch');
  }

  if (hasConflict(polySig.outcomes, kalshiSig.outcomes)) {
    penaltyTotal += PENALTY_OUTCOME;
    penaltyReasons.push('outcome wording mismatch');
  }

  if (hasConflict(polySig.scopes, kalshiSig.scopes)) {
    penaltyTotal += PENALTY_SCOPE;
    penaltyReasons.push('scope mismatch');
  }

  const titleSim = jaccard(polySig.terms, kalshiSig.terms);
  const keywordOverlap = calculateKeywordOverlap(poly, kalshi);
  const sharedTerms = intersectionSize(polySig.terms, kalshiSig.terms);

  const semanticScore = Math.max(titleSim, Math.min(keywordOverlap / 8, 0.85));

  // Base confidence: weighted semantic + type score, minus accumulated penalties.
  // Floored at 0 so penalties cannot make confidence negative.
  // penaltyTotal is capped at 0.6 so that even when every field conflicts a
  // pair with strong semantic + type alignment can still reach the threshold.
  const cappedPenalty = Math.min(penaltyTotal, 0.6);
  let confidence = Math.max(0, semanticScore * 0.6 + effectiveTypeScore * 0.4 - cappedPenalty);

  const blockersMatched =
    (polySig.years.size === 0 || kalshiSig.years.size === 0 || intersectionSize(polySig.years, kalshiSig.years) > 0) &&
    (polySig.numbers.size === 0 || kalshiSig.numbers.size === 0 || intersectionSize(polySig.numbers, kalshiSig.numbers) > 0);

  // Strong-match fast paths: floor confidence at a high value when hard signals agree.
  if (strictCategoryMatch && blockersMatched && titleSim >= 0.45) {
    confidence = Math.max(confidence, 0.75);
    return {
      isSimilar: true,
      confidence,
      reason: `Strict category + contract fields + title similarity (${(titleSim * 100).toFixed(0)}%)`,
    };
  }

  if (strictCategoryMatch && blockersMatched && keywordOverlap >= 4 && sharedTerms >= 2) {
    confidence = Math.max(confidence, 0.65);
    return {
      isSimilar: true,
      confidence,
      reason: `${keywordOverlap} shared keywords with matching contract fields`,
    };
  }

  if (categoryUnknown && blockersMatched && titleSim >= 0.85 && sharedTerms >= 4) {
    confidence = Math.max(confidence, 0.7);
    return {
      isSimilar: true,
      confidence,
      reason: `Unknown category but strong title similarity (${(titleSim * 100).toFixed(0)}%)`,
    };
  }

  // Graded match: accept any pair whose composite score meets the minimum threshold.
  if (confidence >= MIN_MATCH_CONFIDENCE) {
    const parts = [`Graded match (score: ${confidence.toFixed(2)})`];
    if (penaltyReasons.length > 0) parts.push(`penalties: ${penaltyReasons.join(', ')}`);
    return { isSimilar: true, confidence, reason: parts.join('; ') };
  }

  return { isSimilar: false, confidence, reason: 'Score below match threshold' };
}

function buyYesPrice(market: Market): number {
  return market.yesAsk ?? market.yesPrice;
}

function buyNoPrice(market: Market): number {
  return market.noAsk ?? market.noPrice;
}

function priceBundle(poly: Market, kalshi: Market, feesAndSlippage: number): BundleCandidate[] {
  const polyYesKalshiNo = buyYesPrice(poly) + buyNoPrice(kalshi) + feesAndSlippage;
  const kalshiYesPolyNo = buyYesPrice(kalshi) + buyNoPrice(poly) + feesAndSlippage;

  return [
    {
      direction: 'buy_poly_sell_kalshi',
      yesPlatform: 'polymarket',
      noPlatform: 'kalshi',
      yesPrice: buyYesPrice(poly),
      noPrice: buyNoPrice(kalshi),
      costPerBundle: polyYesKalshiNo,
      edge: 1 - polyYesKalshiNo,
    },
    {
      direction: 'buy_kalshi_sell_poly',
      yesPlatform: 'kalshi',
      noPlatform: 'polymarket',
      yesPrice: buyYesPrice(kalshi),
      noPrice: buyNoPrice(poly),
      costPerBundle: kalshiYesPolyNo,
      edge: 1 - kalshiYesPolyNo,
    },
  ];
}

function candidatesFor(poly: Market, kalshiByCategory: Map<string, Market[]>): Market[] {
  if (poly.category === 'other') {
    return kalshiByCategory.get('other') ?? [];
  }

  const sameCategory = kalshiByCategory.get(poly.category) ?? [];
  const fallback = (kalshiByCategory.get('other') ?? []).slice(0, 5);

  return [...sameCategory, ...fallback];
}

/**
 * Detect covered arbitrage opportunities across Polymarket and Kalshi.
 *
 * Real cross-venue arbitrage buys complementary outcomes:
 *   YES on venue A + NO on venue B + fees/slippage < $1 payout.
 *
 * The legacy absolute YES-vs-YES spread is exposed as rawPriceGap only; the
 * spread field now represents net edge after modeled costs.
 */
export function detectArbitrage(
  markets: Market[],
  minSpread: number = 0.03, //FOR DEBUG: FROM 0.03 TO 0.01
  feesAndSlippage: number = DEFAULT_FEES_AND_SLIPPAGE,
): ArbitrageOpportunity[] {
  const opportunities: ArbitrageOpportunity[] = [];
  const polymarkets = markets.filter(m => m.platform === 'polymarket');
  const kalshiMarkets = markets.filter(m => m.platform === 'kalshi');
  const kalshiByCategory = new Map<string, Market[]>();

  for (const market of kalshiMarkets) {
    const bucket = kalshiByCategory.get(market.category) ?? [];
    bucket.push(market);
    kalshiByCategory.set(market.category, bucket);
  }

  console.log(`[Arbitrage] Checking ${polymarkets.length} Polymarket markets against category-filtered Kalshi buckets`);

  for (const poly of polymarkets) {
    for (const kalshi of candidatesFor(poly, kalshiByCategory)) {
      const similarity = areMarketsSimilar(poly, kalshi);
      //DEBUGGING
      console.log("[Arbitrage] pair:", poly.title, kalshi.title);
      console.log("[Arbitrage] similarity:", similarity.confidence, similarity.reason);

      if (!similarity.isSimilar) {
        //DEBUG LOGGING
        console.log("[Arbitrage] rejected pair:", poly.title, kalshi.title);
        continue;
      }

      const bestBundle = priceBundle(poly, kalshi, feesAndSlippage)
        .sort((a, b) => b.edge - a.edge)[0];

      //DEBUG

      console.log("[Arbitrage] candidate edge:", bestBundle.edge);
      console.log("[Arbitrage] costPerBundle:", bestBundle.costPerBundle);
      console.log("[Arbitrage] direction:", bestBundle.direction);

      if (bestBundle.edge < minSpread) continue;

      opportunities.push({
        polymarket: poly,
        kalshi,
        spread: +bestBundle.edge.toFixed(4),
        rawPriceGap: +Math.abs(poly.yesPrice - kalshi.yesPrice).toFixed(4),
        costPerBundle: +bestBundle.costPerBundle.toFixed(4),
        feesAndSlippage,
        profitPotential: +bestBundle.edge.toFixed(4),
        direction: bestBundle.direction,
        legs: {
          yes: { platform: bestBundle.yesPlatform, price: bestBundle.yesPrice },
          no: { platform: bestBundle.noPlatform, price: bestBundle.noPrice },
        },
        confidence: similarity.confidence,
        matchReason: similarity.reason,
      });
    }
  }

  opportunities.sort((a, b) => b.profitPotential - a.profitPotential);
  console.log(`[Arbitrage] Found ${opportunities.length} covered opportunities (min edge: ${minSpread})`);

  return opportunities;
}

/**
 * Get top arbitrage opportunities.
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

  opportunities = opportunities.filter(op => op.confidence >= minConfidence);

  if (category) {
    opportunities = opportunities.filter(
      op => op.polymarket.category === category || op.kalshi.category === category
    );
  }

  return opportunities.slice(0, limit);
}
