// Cross-platform arbitrage detector
// Matches markets across Polymarket and Kalshi to find price discrepancies

import { Market, ArbitrageOpportunity } from '../types/market';

// Words that carry no information about what a bet is actually about.
// Stripping these before comparison prevents "Fed no change April" from
// matching "Fed above 5% June" on generic finance words alone.
const STOP_WORDS = new Set([
  'will','the','a','an','of','in','on','by','at','to','is','be','for',
  'that','this','are','was','were','been','have','has','had',
  'than','or','and',
  'next','new','first','last','no','not','any','all','its',
  'following','after','before','between','within','until','since',
  'federal','funds','fed','rate','rates','upper','bound','price','market',
  'change','meeting','interest','united','states','kingdom',
  'there','what','when','who','which','where','how','does',
  'from','with','out','end','ago','get','got','let','set','put',
  // Role/title words — too generic across different markets
  'prime','minister','president','senator','governor','secretary',
  // Economic modifiers that add no topic specificity
  'real','rise','fall','increase','decrease','grow','growth',
  // Structural prediction-market words
  'least','most','many','much','some','such','only','also',
  'dollars','percent','dollar','amount','total','number','level',
  'happen','occur','take','place','round','second','third','fourth',
  // "Election" / "electoral" are too generic — every election market has them.
  // Country/candidate names carry the actual specificity.
  'election','electoral',
  // "Win" is too generic across prediction markets — sports, elections, awards.
  // Genuine matches use the subject (candidate, team) as the shared anchor, not "win".
  'win','wins','winner','winning',
]);

// Common prediction market rephrasing patterns.
// Each key and its synonyms are treated as equivalent during word overlap
// comparison so "trump out president" matches "trump resign president".
// Keys must be single tokens (no spaces) — multi-word phrases like
// "peace deal" are handled by normalizing to the first token ("ceasefire").
const EQUIVALENCES: Record<string, string[]> = {
  // Leaving office
  resign:    ['removed', 'leave', 'step', 'cease', 'exit', 'fired', 'ousted'],
  removed:   ['resign', 'leave', 'fired', 'ousted'],
  // Price direction
  exceed:    ['surpass', 'hit', 'reach', 'pass'],
  surpass:   ['exceed', 'hit', 'reach', 'pass'],
  below:     ['under', 'fall', 'drop', 'miss', 'fail'],
  // Agreements / peace
  ceasefire: ['truce', 'armistice', 'peace'],
  truce:     ['ceasefire', 'armistice', 'peace'],
  // Elections / confirmation
  win:       ['elected', 'chosen', 'confirmed', 'nominated', 'appointed'],
  elected:   ['win', 'chosen', 'confirmed', 'nominated', 'appointed'],
  confirmed: ['win', 'elected', 'chosen', 'appointed', 'nominated'],
  // Conflict
  war:       ['conflict', 'invasion', 'attack', 'strike'],
  attack:    ['war', 'conflict', 'strike', 'invasion'],
  // Price movement direction
  fall:      ['drop', 'decline', 'decrease', 'sink', 'plunge'],
  drop:      ['fall', 'decline', 'decrease', 'sink', 'plunge'],
  // Crypto abbreviations — same asset, different naming conventions
  btc:       ['bitcoin'],
  bitcoin:   ['btc'],
  eth:       ['ethereum'],
  ethereum:  ['eth'],
  xrp:       ['ripple'],
  ripple:    ['xrp'],
  // Government / policy
  shutdown:  ['shut'],
  shut:      ['shutdown'],
  // Central bank body abbreviations — intentionally NOT equivalenced:
  // fed↔fomc would cause "11 Fed cuts" to match "FOMC rate upper bound" bets,
  // which are related but different propositions. Genuine Fed/FOMC pairs share
  // other meaningful words (e.g. "raise rates March 2025") and don't need this bridge.
  // Economic cycles — recession is defined by GDP contraction
  recession: ['contraction', 'downturn', 'gdp', 'shrink'],
  gdp:       ['recession', 'contraction', 'downturn'],
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
 * Normalize a single word token: expand magnitude suffixes so that
 * "100k" and "100000" produce the same string for comparison.
 */
function normalizeToken(word: string): string {
  if (/^\d/.test(word)) {
    const lower = word.toLowerCase();
    if (lower.endsWith('k')) return String(Math.round(parseFloat(lower) * 1_000));
    if (lower.endsWith('m')) return String(Math.round(parseFloat(lower) * 1_000_000));
    if (lower.endsWith('b')) return String(Math.round(parseFloat(lower) * 1_000_000_000));
  }
  return word;
}

/**
 * Extract meaningful content words from a title — everything that
 * actually describes what the bet is about, with stop words removed.
 * Numbers are magnitude-normalized so "100k" and "100000" compare equal.
 */
function meaningfulWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
      .map(normalizeToken)
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

type MarketDirection = 'above' | 'below';

function extractDirection(title: string): MarketDirection | null {
  const normalized = title.toLowerCase();

  if (/\b(above|over|exceed|exceeds|exceeding|greater than|more than|at least)\b/.test(normalized)) {
    return 'above';
  }

  if (/\b(below|under|less than|fewer than|at most|lower than)\b/.test(normalized)) {
    return 'below';
  }

  return null;
}

function extractYears(title: string): string[] {
  return title.match(/\b20\d{2}\b/g) ?? [];
}

function hasOverlap(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some(value => rightSet.has(value));
}

/**
 * Extract and normalize numeric values for strike/threshold comparison.
 * All variants of the same number normalize to the same string:
 * "$70,000" → "70000", "70k" → "70000", "70K" → "70000", "1.5m" → "1500000"
 * This prevents "BTC above $100K" and "BTC above $100,000" from being treated
 * as different bets simply due to formatting differences.
 */
function extractNumbers(title: string): string[] {
  const matches = title.match(/[\d,]+(?:\.\d+)?[kKmMbB%]?/g) ?? [];
  return matches.map(n => {
    const clean = n.replace(/,/g, '').toLowerCase();
    // Expand magnitude suffixes to full integers for comparison
    if (clean.endsWith('k')) return String(Math.round(parseFloat(clean) * 1_000));
    if (clean.endsWith('m')) return String(Math.round(parseFloat(clean) * 1_000_000));
    if (clean.endsWith('b')) return String(Math.round(parseFloat(clean) * 1_000_000_000));
    return clean;
  }).filter(n => n !== 'nan');
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

  const polyDirection = extractDirection(poly.title);
  const kalshiDirection = extractDirection(kalshi.title);
  if (polyDirection && kalshiDirection && polyDirection !== kalshiDirection) {
    return { isSimilar: false, confidence: 0, reason: `Different directions (${polyDirection} vs ${kalshiDirection})` };
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

  const polyYears = extractYears(poly.title);
  const kalshiYears = extractYears(kalshi.title);
  if (polyYears.length > 0 && kalshiYears.length > 0 && !hasOverlap(polyYears, kalshiYears)) {
    return { isSimilar: false, confidence: 0, reason: `Different years (${polyYears[0]} vs ${kalshiYears[0]})` };
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

  // Gate 4 & 5: count shared words using raw direct matches + synonym bridges.
  // Crucially we do NOT expand both sides and intersect — that inflates shared
  // counts when both titles share the same generic word (e.g. "win" → 7 synonyms
  // in common, making sports "win" match political "win").
  // Instead: a word counts as shared only if it appears directly in both raw sets,
  // OR it has a synonym (via EQUIVALENCES) that appears in the other raw set AND
  // that synonym is a DIFFERENT word. Each poly word contributes at most once.
  const polyWords   = meaningfulWords(poly.title);
  const kalshiWords = meaningfulWords(kalshi.title);

  const directMatches = new Set([...polyWords].filter(w => kalshiWords.has(w)));

  // Synonym bridges: poly word whose synonym (a DIFFERENT word) is in kalshi raw set
  const synonymBridges = new Set<string>();
  for (const pw of polyWords) {
    if (directMatches.has(pw)) continue;
    const syns = EQUIVALENCES[pw] ?? [];
    if (syns.some(syn => kalshiWords.has(syn) && !directMatches.has(syn))) {
      synonymBridges.add(pw);
    }
  }

  const sharedCount = directMatches.size + synonymBridges.size;

  // Gate 4a: at least 2 genuinely shared content words
  if (sharedCount < 2) {
    return { isSimilar: false, confidence: 0, reason: `Only ${sharedCount} shared words (need 2)` };
  }

  // Gate 4b: at least 1 shared word must be a topic word — not a year (2024, 2025)
  // and not a month abbreviation (apr, jan, etc.). Sharing only timeframe tokens
  // ("April 2026") causes Fed-rate markets to match CPI markets, or Elon tweet
  // markets to match CPI markets — they're in the same month but different bets.
  const TIMEFRAME_TOKENS = new Set([
    'jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec',
    'january','february','march','april','june','july','august','september',
    'october','november','december','q1','q2','q3','q4',
  ]);
  const sharedTopicWords = [...directMatches, ...synonymBridges]
    .filter(w => !/^\d{4}$/.test(w) && !TIMEFRAME_TOKENS.has(w));
  if (sharedTopicWords.length < 2) {
    return { isSimilar: false, confidence: 0, reason: `Only ${sharedTopicWords.length} shared topic word(s) (need 2)` };
  }

  // Gate 5: Dice coefficient (F1 / harmonic-mean overlap) ≥ 0.60.
  // Dice = 2 × sharedCount / (|polyWords| + |kalshiWords|).
  //
  // Why Dice over plain overlap coefficient:
  // Overlap = shared / min(A, B). When one title is very short (e.g. Kalshi's
  // "Who will win the next presidential election?" → only 2 meaningful words
  // after stop-word removal), ANY Poly market containing those 2 words reaches
  // 100% overlap — Peru elections, sports finals, US elections all look the same.
  // Dice penalises that imbalance: a Peru market (6 meaningful words) sharing 2
  // generic words gets Dice 2*2/(6+2) = 50%, well below the 0.60 threshold.
  const totalSize = polyWords.size + kalshiWords.size;
  const dice      = totalSize > 0 ? (2 * sharedCount) / totalSize : 0;
  if (dice < 0.60) {
    return { isSimilar: false, confidence: 0, reason: `Similarity ${(dice * 100).toFixed(0)}% (need 60%)` };
  }

  return {
    isSimilar: true,
    confidence: dice,
    reason: `${sharedCount} shared words, dice=${(dice * 100).toFixed(0)}%`,
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
