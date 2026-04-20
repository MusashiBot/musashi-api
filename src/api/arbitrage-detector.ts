// Cross-platform arbitrage detector
// Matches equivalent Polymarket/Kalshi contracts and prices covered YES/NO bundles.

import { Market, ArbitrageOpportunity } from '../types/market';
import { costFraction, getFeeModel } from '../analysis/fees';

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

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const shared = intersectionSize(a, b);
  const union = a.size + b.size - shared;
  return union > 0 ? shared / union : 0;
}

function calculateKeywordOverlap(market1: Market, market2: Market): number {
  return intersectionSize(new Set(market1.keywords), new Set(market2.keywords));
}

function areMarketsSimilar(poly: Market, kalshi: Market): MatchResult {
  const strictCategoryMatch =
    poly.category === kalshi.category &&
    poly.category !== 'other' &&
    kalshi.category !== 'other';
  const categoryUnknown = poly.category === 'other' || kalshi.category === 'other';

  if (!strictCategoryMatch && !categoryUnknown) {
    return { isSimilar: false, confidence: 0, reason: 'Different categories' };
  }

  const polySig = signature(poly);
  const kalshiSig = signature(kalshi);

  if (hasConflict(polySig.years, kalshiSig.years)) {
    return { isSimilar: false, confidence: 0, reason: 'Different contract years' };
  }

  if (hasConflict(polySig.dates, kalshiSig.dates)) {
    return { isSimilar: false, confidence: 0, reason: 'Different contract dates' };
  }

  if (hasConflict(polySig.numbers, kalshiSig.numbers)) {
    return { isSimilar: false, confidence: 0, reason: 'Different numeric thresholds' };
  }

  if (hasConflict(polySig.outcomes, kalshiSig.outcomes)) {
    return { isSimilar: false, confidence: 0, reason: 'Different outcome wording' };
  }

  if (hasConflict(polySig.scopes, kalshiSig.scopes)) {
    return { isSimilar: false, confidence: 0, reason: 'Different contract scope' };
  }

  const titleSim = jaccard(polySig.terms, kalshiSig.terms);
  const keywordOverlap = calculateKeywordOverlap(poly, kalshi);
  const sharedTerms = intersectionSize(polySig.terms, kalshiSig.terms);

  let confidence = Math.max(titleSim, Math.min(keywordOverlap / 8, 0.85));
  const blockersMatched =
    (polySig.years.size === 0 || kalshiSig.years.size === 0 || intersectionSize(polySig.years, kalshiSig.years) > 0) &&
    (polySig.numbers.size === 0 || kalshiSig.numbers.size === 0 || intersectionSize(polySig.numbers, kalshiSig.numbers) > 0);

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

  return { isSimilar: false, confidence: 0, reason: 'Insufficient contract equivalence' };
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

  return [
    ...(kalshiByCategory.get(poly.category) ?? []),
    ...(kalshiByCategory.get('other') ?? []),
  ];
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
  minSpread: number = 0.03,
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
      if (!similarity.isSimilar) continue;

      const bestBundle = priceBundle(poly, kalshi, feesAndSlippage)
        .sort((a, b) => b.edge - a.edge)[0];

      if (bestBundle.edge < minSpread) continue;

      const sizing = estimateExecutableSizing(
        poly,
        kalshi,
        bestBundle.yesPlatform,
        bestBundle.noPlatform,
        bestBundle.yesPrice,
        bestBundle.noPrice,
        bestBundle.edge,
        feesAndSlippage,
      );

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
        maxStake: sizing.maxStake,
        expectedDollarProfit: sizing.expectedDollarProfit,
        annualisedReturn: sizing.annualisedReturn,
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

// ─── Liquidity-aware sizing ───────────────────────────────────────────────
//
// The core detector charges a flat `feesAndSlippage` buffer (default 2%) on
// every bundle. That keeps the "is this still +EV?" test cheap, but it
// doesn't tell a bot *how much* it can actually put through. The helper
// below looks at the thinner leg's 24h volume, estimates additional
// impact-based slippage via `src/analysis/fees.ts`, and returns:
//
//   • maxStake             — dollars we think can clear both legs before
//                            post-hoc slippage halves the modeled edge
//   • expectedDollarProfit — modeled edge × maxStake, minus extra impact
//   • annualisedReturn     — standardised horizon so opportunities with
//                            different expiries can be compared

function estimateExecutableSizing(
  poly: Market,
  kalshi: Market,
  yesPlatform: 'polymarket' | 'kalshi',
  noPlatform: 'polymarket' | 'kalshi',
  yesPrice: number,
  noPrice: number,
  modeledEdge: number,
  baseFeesAndSlippage: number,
): { maxStake: number; expectedDollarProfit: number; annualisedReturn: number } {
  const yesLeg = yesPlatform === 'polymarket' ? poly : kalshi;
  const noLeg = noPlatform === 'polymarket' ? poly : kalshi;
  const liquidity = Math.max(500, Math.min(yesLeg.volume24h, noLeg.volume24h));

  // Rule of thumb: we're willing to take stake sizes until expected impact
  // on both legs equals the modeled edge. That prevents us from walking the
  // book beyond a break-even.
  let maxStake = Math.min(10_000, Math.max(10, liquidity * modeledEdge * 0.5));

  // Refine: compute impact-aware slippage at that stake and clamp if the
  // refined edge goes negative.
  const yesCost = costFraction(maxStake, yesLeg.volume24h, yesPrice, getFeeModel(yesPlatform));
  const noCost = costFraction(maxStake, noLeg.volume24h, noPrice, getFeeModel(noPlatform));
  const impactDraw = Math.max(0, yesCost * yesPrice + noCost * noPrice - baseFeesAndSlippage);
  const refinedEdge = modeledEdge - impactDraw;
  if (refinedEdge <= 0) {
    maxStake = Math.min(maxStake, 10);
  }

  const expectedDollarProfit = Math.max(0, refinedEdge) * maxStake;

  const daysToExpiry = soonestExpiryDays(poly, kalshi) ?? 30;
  const annualisedReturn = daysToExpiry > 0 && maxStake > 0
    ? (expectedDollarProfit / maxStake) * (365 / daysToExpiry)
    : 0;

  return {
    maxStake: round2(maxStake),
    expectedDollarProfit: round2(expectedDollarProfit),
    annualisedReturn: round4(annualisedReturn),
  };
}

function soonestExpiryDays(a: Market, b: Market): number | null {
  const stamps: number[] = [];
  for (const m of [a, b]) {
    if (!m.endDate) continue;
    const t = new Date(m.endDate).getTime();
    if (Number.isFinite(t)) stamps.push(t);
  }
  if (stamps.length === 0) return null;
  return Math.max(0, (Math.min(...stamps) - Date.now()) / (1000 * 60 * 60 * 24));
}

function round2(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
}

function round4(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 10_000) / 10_000 : 0;
}
