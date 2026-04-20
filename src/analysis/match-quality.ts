/**
 * Post-match quality gate.
 *
 * The keyword-matcher produces *candidate* matches: markets whose keyword
 * overlap clears a minimum confidence threshold. Many of those candidates
 * are still junk — generally for one of four reasons:
 *
 *   1. Liquidity: the market has ~$0 of 24h volume, so even a "correct"
 *      signal can't be executed. Trading bots shouldn't even see it.
 *   2. Extreme-price: markets resolved near 0¢ or 100¢ are effectively
 *      already decided; sentiment-shift signals against them never clear
 *      fees and are dominated by adverse selection.
 *   3. Single-token broad hits: matching on a generic token like "win" or
 *      "breaks" pulls in unrelated markets (classic: a Fed-rate-cut tweet
 *      matching an NBA penny market on the word "win").
 *   4. Broken category signal: when a tweet is clearly about one domain
 *      but the top match is cross-domain, confidence alone isn't enough.
 *
 * This module adds a deterministic gate that drops candidates failing any
 * of the first three checks. It is designed to be cheap (O(n) over the
 * match list), backwards-compatible (keep the top candidates at the top,
 * never reorder surviving matches), and tunable via options.
 */

import { Market, MarketMatch } from '../types/market';

export interface QualityGateOptions {
  /**
   * Minimum 24h market volume (in dollars) to allow. Markets thinner
   * than this can't be traded in size — see the liquidity-aware
   * arbitrage sizing for context. Default $5,000.
   */
  minVolume?: number;
  /**
   * Drop markets priced in the extreme tails (price < extremeBand or
   * price > 1 - extremeBand) *unless* the candidate confidence is very
   * strong. Default 0.02 (markets at <2% or >98%).
   */
  extremeBand?: number;
  /**
   * Confidence threshold above which a match bypasses the "requires a
   * strong signal" gate. Default 0.55.
   */
  strongConfidence?: number;
  /**
   * If true (default), require at least one of:
   *   • a multi-word phrase match (`matchedKeywords` contains a space)
   *   • confidence ≥ `strongConfidence`
   * Rationale: bigram/trigram matches are inherently specific; broad
   * unigram hits need a much stronger aggregate signal to survive.
   */
  requireStrongSignal?: boolean;
}

export interface GateResult {
  /** Candidates that survived every check. */
  kept: MarketMatch[];
  /** Per-reason drop counts, for telemetry. */
  dropped: {
    lowVolume: number;
    extremePrice: number;
    weakSignal: number;
  };
}

const DEFAULTS: Required<QualityGateOptions> = {
  minVolume: 5_000,
  extremeBand: 0.02,
  strongConfidence: 0.55,
  requireStrongSignal: true,
};

export function applyQualityGate(
  matches: MarketMatch[],
  opts: QualityGateOptions = {},
): GateResult {
  const cfg = { ...DEFAULTS, ...opts };
  const kept: MarketMatch[] = [];
  const dropped = { lowVolume: 0, extremePrice: 0, weakSignal: 0 };

  for (const m of matches) {
    if (!passesVolume(m.market, cfg)) {
      dropped.lowVolume++;
      continue;
    }
    if (!passesExtremePrice(m, cfg)) {
      dropped.extremePrice++;
      continue;
    }
    if (cfg.requireStrongSignal && !passesStrongSignal(m, cfg)) {
      dropped.weakSignal++;
      continue;
    }
    kept.push(m);
  }

  return { kept, dropped };
}

function passesVolume(market: Market, cfg: Required<QualityGateOptions>): boolean {
  const v = Number(market.volume24h);
  if (!Number.isFinite(v)) return false;
  return v >= cfg.minVolume;
}

function passesExtremePrice(m: MarketMatch, cfg: Required<QualityGateOptions>): boolean {
  const yes = Number(m.market.yesPrice);
  if (!Number.isFinite(yes)) return true; // no price info → allow, don't punish
  const extreme = yes < cfg.extremeBand || yes > 1 - cfg.extremeBand;
  if (!extreme) return true;
  // Even at strong confidence, extreme-priced markets have near-zero
  // expected value after fees. We only let them through on the very
  // narrow case of a multi-word phrase match AND very high confidence.
  const hasPhrase = m.matchedKeywords.some(k => k.includes(' '));
  return hasPhrase && m.confidence >= cfg.strongConfidence + 0.2;
}

function passesStrongSignal(m: MarketMatch, cfg: Required<QualityGateOptions>): boolean {
  // Accept if either:
  //   • a multi-word phrase matched (high specificity by construction), OR
  //   • confidence is already strong, AND there are at least 2 matched
  //     keywords (single strong unigrams alone are still noisy).
  const hasPhrase = m.matchedKeywords.some(k => k.includes(' '));
  if (hasPhrase) return true;
  return m.confidence >= cfg.strongConfidence && m.matchedKeywords.length >= 2;
}
