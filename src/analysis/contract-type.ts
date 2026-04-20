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
