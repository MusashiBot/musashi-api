// Contract type detection
// Classifies markets by their prediction *structure* (not topic/domain).
// Two markets should only be compared for equivalence if they share the same type.

import { Market } from '../types/market';

/**
 * Prediction structure types.
 *
 * These represent the *shape* of a contract, not its subject matter.
 *
 * | Type               | Example                                        |
 * |--------------------|------------------------------------------------|
 * | RANGE_COUNT        | Will Elon tweet 215–239 times in May?          |
 * | THRESHOLD_PRICE    | Will BTC exceed $500k by year-end?             |
 * | EVENT_MATCH_OUTCOME| Will Team A beat Team B in Game 3?            |
 * | TIME_WINDOW_BINARY | Will X happen before March 31?                |
 * | BINARY_OUTCOME     | Will the Fed cut rates in June? (generic Y/N)  |
 */
export type ContractType =
  | 'RANGE_COUNT'
  | 'THRESHOLD_PRICE'
  | 'EVENT_MATCH_OUTCOME'
  | 'TIME_WINDOW_BINARY'
  | 'BINARY_OUTCOME';

// Numeric range: "215-239", "10 to 20", "between 5 and 10"
// Dash class covers hyphen-minus U+002D, en-dash U+2013, and em-dash U+2014.
const RANGE_PATTERN = /\b\d+\s*[\u002D\u2013\u2014]\s*\d+\b|\b\d+\s+to\s+\d+\b|\bbetween\s+\d+\s+and\s+\d+\b/i;

// Head-to-head / match outcome: "vs", "beat", "defeat", "match winner"
const MATCH_OUTCOME_PATTERN =
  /\bvs\.?\b|\bversus\b|\bbeat\b|\bdefeats?\b|\bmatch winner\b|\bgame\s+\d+\b|\bseries winner\b/i;

// Price threshold: a dollar amount AND a threshold verb
const PRICE_AMOUNT_PATTERN = /\$[\d,.]+[KMBkmb]?\b/;
const THRESHOLD_VERB_PATTERN =
  /\b(exceed|surpass|hit|reach|break|cross|above|below|over|under)\b/i;

// Deadline / time-window: "by DATE", "before DATE", "within N days"
const TIME_WINDOW_PATTERN =
  /\b(by|before|prior\s+to|within)\b.{0,40}?\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|202\d|q[1-4])\b|\bwithin\s+\d+\s+(?:day|week|month)/i;

/**
 * Detect the prediction structure type of a market from its title and description.
 *
 * Detection is ordered from most-specific to least-specific so that a contract
 * like "Will BTC exceed $500k before December?" is classified as
 * THRESHOLD_PRICE rather than TIME_WINDOW_BINARY.
 */
export function detectContractType(market: Market): ContractType {
  // Use only the title for classification so that cross-platform description
  // differences (Polymarket includes deadline prose; Kalshi descriptions are
  // empty) do not cause asymmetric contract-type assignments for equivalent
  // markets.
  const text = market.title;

  // 1. RANGE_COUNT – explicit numeric interval wins over everything else
  if (RANGE_PATTERN.test(text)) {
    return 'RANGE_COUNT';
  }

  // 2. THRESHOLD_PRICE – price amount + directional verb
  if (PRICE_AMOUNT_PATTERN.test(text) && THRESHOLD_VERB_PATTERN.test(text)) {
    return 'THRESHOLD_PRICE';
  }

  // 3. EVENT_MATCH_OUTCOME – head-to-head competition
  if (MATCH_OUTCOME_PATTERN.test(text)) {
    return 'EVENT_MATCH_OUTCOME';
  }

  // 4. TIME_WINDOW_BINARY – event conditioned on a deadline
  if (TIME_WINDOW_PATTERN.test(text)) {
    return 'TIME_WINDOW_BINARY';
  }

  // 5. Generic binary yes/no
  return 'BINARY_OUTCOME';
}

/**
 * Return a compatibility score in [0, 1] between two contract types.
 *
 * A score of 0 means the pair is structurally incompatible and should be
 * hard-rejected.  Any positive score is used as a penalty multiplier in the
 * confidence formula so that type mismatches reduce confidence rather than
 * eliminating candidates outright.
 *
 * The only pair that retains a hard-zero is RANGE_COUNT ↔ EVENT_MATCH_OUTCOME:
 * a count-in-range contract cannot meaningfully map onto a head-to-head winner.
 */
export function contractTypeCompatibility(a: ContractType, b: ContractType): number {
  if (a === b) return 1.0;

  // Normalise order so we only need one entry per unordered pair.
  const [lo, hi] = a < b ? [a, b] : [b, a];

  switch (`${lo}|${hi}`) {
    // TIME_WINDOW_BINARY ↔ BINARY_OUTCOME: both are generic YES/NO, effectively
    // the same structure.  The detector in arbitrage-detector.ts also overrides
    // this pair to 1.0 via the BINARY_COMPATIBLE_TYPES set, but we return 0.8
    // here for completeness and to support callers that use this function directly.
    case 'BINARY_OUTCOME|TIME_WINDOW_BINARY':    return 0.8;

    // A generic YES/NO contract and a head-to-head winner are often the same
    // market expressed differently across platforms.
    case 'BINARY_OUTCOME|EVENT_MATCH_OUTCOME':   return 0.6;

    // A generic YES/NO can be a threshold contract with the threshold omitted
    // from the title on one platform.
    case 'BINARY_OUTCOME|THRESHOLD_PRICE':       return 0.5;

    // A time-window binary and a threshold/price contract share a deadline
    // structure and are semantically close.
    case 'THRESHOLD_PRICE|TIME_WINDOW_BINARY':   return 0.6;

    // A named match outcome paired with a time-window binary: plausible when
    // one platform qualifies the outcome with a deadline.
    case 'EVENT_MATCH_OUTCOME|TIME_WINDOW_BINARY': return 0.4;

    // A price-threshold contract paired with a match-outcome is a stretch but
    // still partially comparable (e.g. score milestones in a game).
    case 'EVENT_MATCH_OUTCOME|THRESHOLD_PRICE':  return 0.2;

    // A numeric range and a binary outcome: one platform may bucket the same
    // event into ranges while the other offers a single YES/NO.
    case 'BINARY_OUTCOME|RANGE_COUNT':           return 0.35;

    // Numeric range and price threshold share quantitative structure.
    case 'RANGE_COUNT|THRESHOLD_PRICE':          return 0.5;

    // Numeric range with a time-window qualifier: partial structural overlap.
    case 'RANGE_COUNT|TIME_WINDOW_BINARY':       return 0.35;

    // RANGE_COUNT ↔ EVENT_MATCH_OUTCOME: a count-in-range cannot map onto a
    // head-to-head winner.  Hard-reject (0).
    case 'EVENT_MATCH_OUTCOME|RANGE_COUNT':      return 0.0;

    default: return 0.0;
  }
}
