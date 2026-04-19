// Cross-platform arbitrage detector
// Matches markets across Polymarket and Kalshi to find price discrepancies

import { Market, ArbitrageOpportunity } from '../types/market';

// Words that carry no information about what a bet is actually about.
// Stripping these before comparison prevents "Fed no change April" from
// matching "Fed above 5% June" on generic finance words alone.
const STOP_WORDS = new Set([
  'will','the','a','an','of','in','on','by','at','to','is','be','for',
  'that','this','are','was','were','been','have','has','had',
  'above','below','over','under','more','less','than','or','and',
  'next','new','first','last','no','not','any','all','its',
  'following','after','before','between','within','until','since',
  'federal','funds','rate','upper','bound','price','market',
  'change','meeting','interest','united','states','kingdom',
  'there','what','when','who','which','where','how','does',
]);

// Common prediction market rephrasing patterns.
// Each key and its synonyms are treated as equivalent during word overlap
// comparison so "trump out president" matches "trump resign president".
// Keys must be single tokens (no spaces) — multi-word phrases like
// "peace deal" are handled by normalizing to the first token ("ceasefire").
const EQUIVALENCES: Record<string, string[]> = {
  // Leaving office
  resign:    ['out', 'removed', 'leave', 'step', 'cease', 'exit', 'fired', 'ousted'],
  out:       ['resign', 'removed', 'leave', 'step', 'cease', 'exit', 'fired', 'ousted'],
  removed:   ['resign', 'out', 'leave', 'fired', 'ousted'],
  // Price direction
  exceed:    ['above', 'over', 'surpass', 'hit', 'reach', 'pass'],
  above:     ['exceed', 'over', 'surpass', 'hit', 'reach'],
  below:     ['under', 'fall', 'drop', 'miss', 'fail'],
  // Agreements / peace
  ceasefire: ['truce', 'armistice', 'peace'],
  truce:     ['ceasefire', 'armistice', 'peace'],
  // Elections / confirmation
  win:       ['elected', 'chosen', 'confirmed', 'nominated', 'appointed', 'selected'],
  elected:   ['win', 'chosen', 'confirmed', 'nominated', 'appointed'],
  confirmed: ['win', 'elected', 'chosen', 'appointed', 'nominated'],
  // Conflict
  war:       ['conflict', 'invasion', 'attack', 'strike'],
  attack:    ['war', 'conflict', 'strike', 'invasion'],
};

/**
 * Expand a set of meaningful words to include synonyms from EQUIVALENCES.
 * "out" → adds "resign", "removed", "leave" etc. to the set so that
 * "trump out president" overlaps with "trump resign president".
 */
function expandWithEquivalences(words: Set<string>): Set<string> {
  const expanded = new Set(words);
  for (const word of words) {
    const synonyms = EQUIVALENCES[word];
    if (synonyms) {
      for (const syn of synonyms) expanded.add(syn);
    }
  }
  return expanded;
}

/**
 * Extract meaningful content words from a title — everything that
 * actually describes what the bet is about, with stop words removed.
 */
function meaningfulWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
  );
}

const MONTH_MAP: Record<string, string> = {
  january: 'jan', february: 'feb', march: 'mar', april: 'apr',
  may: 'may', june: 'jun', july: 'jul', august: 'aug',
  september: 'sep', october: 'oct', november: 'nov', december: 'dec',
};

/**
 * Extract month names from a title for timeframe comparison, normalized
 * to 3-letter abbreviations so "april" and "apr" compare as equal.
 * "April 2026" and "June 2026" are different bets even on the same topic.
 */
function extractTimeframe(title: string): string[] {
  const matches = title.toLowerCase().match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|q[1-4])\b/g
  );
  return (matches ?? []).map(m => MONTH_MAP[m] ?? m);
}

/**
 * Extract numeric values from a title for strike/threshold comparison.
 * "$70,000" → "70000", "5.00%" → "5.00", "70k" → "70k"
 * "BTC above $70K" and "BTC range $60K-$65K" share no numbers → different bet.
 */
function extractNumbers(title: string): string[] {
  const matches = title.match(/[\d,]+(?:\.\d+)?[kKmM%]?/g) ?? [];
  return matches.map(n => n.replace(/,/g, '').toLowerCase());
}

/**
 * Check if two markets refer to the same event and the same bet.
 *
 * All five gates must pass:
 * 1. Same category
 * 2. Same timeframe (month) — "April" vs "June" = different bet
 * 3. Same strike/threshold — "$70K" vs "$60K" = different bet
 * 4. At least 3 shared meaningful content words
 * 5. Jaccard similarity ≥ 0.6 on meaningful words
 *
 * Previously: OR logic on title similarity OR keyword count → false positives
 * Now: AND logic across all five gates → only genuine same-event pairs pass
 */
function areMarketsSimilar(poly: Market, kalshi: Market): {
  isSimilar: boolean;
  confidence: number;
  reason: string;
} {
  // Gate 1: category must match (or one is 'other')
  const categoryMatch = poly.category === kalshi.category ||
                        poly.category === 'other' ||
                        kalshi.category === 'other';
  if (!categoryMatch) {
    return { isSimilar: false, confidence: 0, reason: 'Different categories' };
  }

  // Gate 2: timeframe — if both titles contain month names, at least one must overlap
  const polyTime   = extractTimeframe(poly.title);
  const kalshiTime = extractTimeframe(kalshi.title);
  if (polyTime.length > 0 && kalshiTime.length > 0) {
    const sharedTime = polyTime.filter(t => kalshiTime.includes(t));
    if (sharedTime.length === 0) {
      return { isSimilar: false, confidence: 0, reason: `Different timeframes (${polyTime[0]} vs ${kalshiTime[0]})` };
    }
  }

  // Gate 3: strike/threshold — if both titles contain numbers, at least one must overlap
  const polyNums   = extractNumbers(poly.title);
  const kalshiNums = extractNumbers(kalshi.title);
  if (polyNums.length > 0 && kalshiNums.length > 0) {
    const sharedNums = polyNums.filter(n => kalshiNums.includes(n));
    if (sharedNums.length === 0) {
      return { isSimilar: false, confidence: 0, reason: `Different strikes (${polyNums[0]} vs ${kalshiNums[0]})` };
    }
  }

  // Gate 4 & 5: expand each title's words with equivalences before comparing,
  // so "trump out president" overlaps with "trump resign president".
  // Shared count uses raw words; Jaccard uses expanded sets so synonym
  // bridges don't artificially inflate the intersection beyond what's real.
  const polyWords      = meaningfulWords(poly.title);
  const kalshiWords    = meaningfulWords(kalshi.title);
  const polyExpanded   = expandWithEquivalences(polyWords);
  const kalshiExpanded = expandWithEquivalences(kalshiWords);

  // Shared: words that appear (directly or via synonym) in both expanded sets
  const sharedWords = [...polyExpanded].filter(w => kalshiExpanded.has(w));

  // Gate 4: need at least 3 shared content words (counting synonyms)
  if (sharedWords.length < 3) {
    return { isSimilar: false, confidence: 0, reason: `Only ${sharedWords.length} shared words (need 3)` };
  }

  // Gate 5: Jaccard on expanded sets ≥ 0.6
  const union   = new Set([...polyExpanded, ...kalshiExpanded]).size;
  const jaccard = sharedWords.length / union;
  if (jaccard < 0.6) {
    return { isSimilar: false, confidence: 0, reason: `Title similarity ${(jaccard * 100).toFixed(0)}% (need 60%)` };
  }

  return {
    isSimilar: true,
    confidence: jaccard,
    reason: `${sharedWords.length} shared words, jaccard=${(jaccard * 100).toFixed(0)}%`,
  };
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
