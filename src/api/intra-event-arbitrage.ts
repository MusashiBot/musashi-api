/* An intra-event arbitrage detector tries to detect arbitrage WITHIN a single event, i.e across multiple markets that
represent mutually-exclusive outcomes of the same real-world event. Unlike cross-platform arbitrage (Polymarket vs Kalshi), this
does not need similarity matching. Markets that belong to the same event are
identified by a shared structural key (Kalshi event_ticker) rather than
by comparing free-text titles.

Supported strategies
──────────────────────────────────────────────────────────────────────────────
RANGE_SUM   – Kalshi range-bucket markets (e.g. "80–84 seats", "85–89 seats")
              must collectively cover every possible outcome, so their YES
              prices must sum to exactly 1 (minus fees).
              sum < 1 leads to  BUY_ALL  (guaranteed payout for less than $1)
              sum > 1 leads to SELL_ALL (collect more than $1, pay out exactly $1)
MATCH_OUTCOME – Head-to-head markets where exactly one side wins.
               p(A wins) + p(B wins) must equal 1.

BINARY_COMPLEMENT – Two binary markets whose resolution conditions are
               complementary (e.g. "X above 50%" / "X at or below 50%").
*/
import { Market, GroupArbitrageOpportunity, GroupArbitrageLeg } from '../types/market';
import { detectContractType } from '../analysis/contract-type';

const DEFAULT_FEES_AND_SLIPPAGE = Number.parseFloat(
  process.env.MUSASHI_ARB_COST_BUFFER ?? '0.02',
);

// ─── Event key extraction ──────────────────────────────────────────────────────

/**
 * Return a canonical event key for a market.
 *
 * For Kalshi markets the `event_ticker` is a reliable, platform-assigned key
 * that is shared by every outcome market within the same event.  We use it
 * directly when available.
 *
 * For Polymarket (or Kalshi markets missing an event_ticker) we fall back to a
 * normalised title slug.  This is less precise but still useful for grouping
 * range/match pairs that share most title words.
 */
export function getEventKey(market: Market): string {
  if (market.eventTicker) {
    return `${market.platform}:${market.eventTicker.toLowerCase()}`;
  }

  // Title-based fallback: strip range suffixes ("80–84", "85 to 89") so that
  // all buckets of the same election map to the same key.
  const base = market.title
    .toLowerCase()
    // Strip numeric range suffixes so all buckets of the same event share a key.
    // The three characters are: hyphen-minus (U+002D), en-dash (U+2013), em-dash (U+2014).
    .replace(/\b\d+\s*[\u002D\u2013\u2014]\s*\d+\b/g, '')  // numeric range, e.g. 80-84
    .replace(/\b\d+\s+to\s+\d+\b/g, '')                    // "X to Y"
    .replace(/\bbetween\s+\d+\s+and\s+\d+\b/g, '')         // "between X and Y"
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .trim();

  return `${market.platform}:${base}`;
}

// GROUPING #####!!!!!

/**
 * Group a flat list of markets by their underlying event key.
 * Only groups that contain 2 or more markets from the SAME platform are
 * meaningful candidates for intra-event arbitrage.
 */
export function groupMarketsByEvent(markets: Market[]): Map<string, Market[]> {
  const groups = new Map<string, Market[]>();

  for (const market of markets) {
    const key = getEventKey(market);
    const bucket = groups.get(key) ?? [];
    bucket.push(market);
    groups.set(key, bucket);
  }

  return groups;
}

//  Price helpers 

// Best executable price to BUY YES (ask).
function buyYesPrice(market: Market): number {
  return market.yesAsk ?? market.yesPrice;
}

/* Best executable price to SELL YES (bid). */
function sellYesPrice(market: Market): number {
  return market.yesBid ?? market.yesPrice;
}

// Per-group arbitrage detection 

/**
 * Given a group of markets that share an event key, attempt to find an
 * intra-event arbitrage opportunity.
 *
 * @param eventKey         - Shared event key for logging/identification.
 * @param group            - Markets belonging to the same event (same platform).
 * @param minEdge          - Minimum net edge required to report an opportunity.
 * @param feesAndSlippage  - Per-leg cost buffer (applied once per group).
 */
function detectArbitrageInGroup(
  eventKey: string,
  group: Market[],
  minEdge: number,
  feesAndSlippage: number,
): GroupArbitrageOpportunity | null {
  if (group.length < 2) return null;
  
  // All markets in a group must be on the same platform.
  const platform = group[0].platform;
  if (!group.every(m => m.platform === platform)) return null;
  
  /* multi platforms?
  const platforms = new Set(group.map(m => m.platform));
  const platformLabel = platforms.size === 1
  ? group[0].platform
  : 'cross-platform';
  */

  const types = group.map(m => detectContractType(m));

  // ── RANGE_SUM ────────────────────────────────────────────────────────────────
  // All markets in the group are numeric range buckets (RANGE_COUNT).
  if (types.every(t => t === 'RANGE_COUNT')) {
    return buildRangeSumOpportunity(eventKey, group, platform, minEdge, feesAndSlippage);
  }
  const titles = group.map(m => m.title.toLowerCase());

  const isLikelyComplement =
    titles.some(t => t.includes('yes')) ||
    titles.some(t => t.includes('above')) ||
    titles.some(t => t.includes('below'));

  // ── MATCH_OUTCOME ─────────────────────────────────────────────────────────────
  // Exactly two markets, both classified as head-to-head match outcomes.
  if (
    group.length === 2 && types.every(t => t === 'BINARY_OUTCOME' || t === 'TIME_WINDOW_BINARY') && isLikelyComplement
  )

  // ── BINARY_COMPLEMENT ─────────────────────────────────────────────────────────
  // Exactly two binary markets that together should exhaust all outcomes.
  if (group.length === 2 && types.every(t => t === 'BINARY_OUTCOME' || t === 'TIME_WINDOW_BINARY')) {
    return buildBinaryOpportunity(eventKey, group, platform, 'BINARY_COMPLEMENT', minEdge, feesAndSlippage);
  }

  return null;
}

/**
 * Build a RANGE_SUM opportunity.
 *
 * If the sum of buy-YES prices is below 1 minus fees, buying all outcomes
 * guarantees a $1 payout for less than $1 → BUY_ALL.
 *
 * If the sum of sell-YES prices exceeds 1 plus fees, selling all YES contracts
 * collects more than $1 while paying out exactly $1 → SELL_ALL.
 */
function buildRangeSumOpportunity(
  eventKey: string,
  group: Market[],
  platform: 'kalshi' | 'polymarket',
  minEdge: number,
  feesAndSlippage: number,
): GroupArbitrageOpportunity | null {
  const buySum = group.reduce((acc, m) => acc + buyYesPrice(m), 0);
  const sellSum = group.reduce((acc, m) => acc + sellYesPrice(m), 0);

  const buyEdge = 1 - buySum - feesAndSlippage;
  const sellEdge = sellSum - 1 - feesAndSlippage;

  if (buyEdge >= minEdge) {
    const legs: GroupArbitrageLeg[] = group.map(m => ({
      market: m,
      action: 'BUY',
      price: buyYesPrice(m),
    }));
    return makeOpportunity(eventKey, platform, 'RANGE_SUM', 'BUY_ALL', legs, buySum, buyEdge, feesAndSlippage, group.length);
  }

  if (sellEdge >= minEdge) {
    const legs: GroupArbitrageLeg[] = group.map(m => ({
      market: m,
      action: 'SELL',
      price: sellYesPrice(m),
    }));
    return makeOpportunity(eventKey, platform, 'RANGE_SUM', 'SELL_ALL', legs, sellSum, sellEdge, feesAndSlippage, group.length);
  }

  return null;
}

/**
 * Build a MATCH_OUTCOME or BINARY_COMPLEMENT opportunity.
 *
 * For a two-outcome exhaustive market (A wins or B wins; above or below),
 * the YES prices must sum to exactly 1.  Any deviation (after fees) is
 * arbitrageable.
 */
function buildBinaryOpportunity(
  eventKey: string,
  group: Market[],
  platform: 'kalshi' | 'polymarket',
  type: 'MATCH_OUTCOME' | 'BINARY_COMPLEMENT',
  minEdge: number,
  feesAndSlippage: number,
): GroupArbitrageOpportunity | null {
  const [m1, m2] = group;

  const buySum = buyYesPrice(m1) + buyYesPrice(m2);
  const sellSum = sellYesPrice(m1) + sellYesPrice(m2);

  const buyEdge = 1 - buySum - feesAndSlippage;
  const sellEdge = sellSum - 1 - feesAndSlippage;

  if (buyEdge >= minEdge) {
    const legs: GroupArbitrageLeg[] = group.map(m => ({
      market: m,
      action: 'BUY',
      price: buyYesPrice(m),
    }));
    return makeOpportunity(eventKey, platform, type, 'BUY_ALL', legs, buySum, buyEdge, feesAndSlippage, 2);
  }

  if (sellEdge >= minEdge) {
    const legs: GroupArbitrageLeg[] = group.map(m => ({
      market: m,
      action: 'SELL',
      price: sellYesPrice(m),
    }));
    return makeOpportunity(eventKey, platform, type, 'SELL_ALL', legs, sellSum, sellEdge, feesAndSlippage, 2);
  }

  return null;
}

function makeOpportunity(
  eventKey: string,
  platform: 'kalshi' | 'polymarket',
  type: GroupArbitrageOpportunity['type'],
  action: GroupArbitrageOpportunity['action'],
  legs: GroupArbitrageLeg[],
  priceSum: number,
  edge: number,
  feesAndSlippage: number,
  marketCount: number,
): GroupArbitrageOpportunity {
  return {
    eventKey,
    platform,
    type,
    action,
    legs,
    priceSum: +priceSum.toFixed(4),
    edge: +edge.toFixed(4),
    spread: +edge.toFixed(4),
    feesAndSlippage,
    profitPotential: +edge.toFixed(4),
    marketCount,
  };
}

// API
/**
 * Detect intra-event arbitrage opportunities across all markets.
 *
 * Markets are grouped by their underlying event key.  Within each group the
 * sum of YES prices is compared to 1; groups whose prices deviate beyond
 * `minEdge + feesAndSlippage` are returned as opportunities.
 *
 * This replaces the pairwise cross-platform similarity scan for intra-platform
 * structural arbitrage and runs in O(n) time rather than O(n²).
 *
 * @param markets          - All markets (any platform).
 * @param minEdge          - Minimum net edge to report (default 0.01).
 * @param feesAndSlippage  - Per-group cost buffer (default from env or 0.02).
 */
export function detectIntraEventArbitrage(
  markets: Market[],
  minEdge: number = 0.01,
  feesAndSlippage: number = DEFAULT_FEES_AND_SLIPPAGE,
): GroupArbitrageOpportunity[] {
  const groups = groupMarketsByEvent(markets);
  const opportunities: GroupArbitrageOpportunity[] = [];

  for (const [eventKey, group] of groups) {
    const opportunity = detectArbitrageInGroup(eventKey, group, minEdge, feesAndSlippage);
    if (opportunity) {
      opportunities.push(opportunity);
    }
  }

  opportunities.sort((a, b) => b.edge - a.edge);

  console.log(
    `[IntraEvent] Checked ${groups.size} event groups → found ${opportunities.length} opportunity(ies) (minEdge: ${minEdge})`
  );

  return opportunities;
}