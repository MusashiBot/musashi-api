// Text Analysis Orchestrator
// Combines keyword matching, sentiment analysis, and signal generation

import { Market, MarketMatch, ArbitrageOpportunity } from '../types/market';
import { KeywordMatcher } from './keyword-matcher';
import { generateSignal, TradingSignal } from './signal-generator';

/**
 * Analyze tweet text and return trading signal with matched markets
 * This is the main entry point for text analysis
 */
export async function analyzeText(
  text: string,
  markets: Market[],
  options?: {
    minConfidence?: number;
    maxResults?: number;
  }
): Promise<TradingSignal> {
  const startTime = Date.now();

  // Step 1: Match markets using keyword matcher
  // Fix C: pass minConfidence through (undefined → class default), no longer hardcoded.
  const matcher = new KeywordMatcher(
    markets,
    options?.minConfidence,
    options?.maxResults ?? 5
  );
  const matches = matcher.match(text);

  // Step 2: Check if any matched markets have arbitrage opportunities
  // This would require cross-referencing with stored arbitrage data
  // For now, we'll leave this as undefined and add it in the service worker
  const arbitrageOpportunity: ArbitrageOpportunity | undefined = undefined;

  // Step 3: Generate trading signal
  const signal = generateSignal(text, matches, arbitrageOpportunity);

  // Update processing time to include the full pipeline
  signal.metadata.processing_time_ms = Date.now() - startTime;

  return signal;
}

/**
 * Analyze text and check for arbitrage in the matched markets
 * This version cross-references with cached arbitrage opportunities
 */
export async function analyzeTextWithArbitrage(
  text: string,
  markets: Market[],
  arbitrageOpportunities: ArbitrageOpportunity[],
  options?: {
    minConfidence?: number;
    maxResults?: number;
  }
): Promise<TradingSignal> {
  const startTime = Date.now();

  // Step 1: Match markets
  // Fix C: pass minConfidence through (undefined → class default), no longer hardcoded.
  const matcher = new KeywordMatcher(
    markets,
    options?.minConfidence,
    options?.maxResults ?? 5
  );
  const matches = matcher.match(text);

  // Step 2: Check if any matched markets have arbitrage
  let arbitrageOpportunity: ArbitrageOpportunity | undefined;

  if (matches.length > 0 && arbitrageOpportunities.length > 0) {
    const topMatch = matches[0];
    const matchedMarketId = topMatch.market.id;

    // Find arbitrage opportunity involving this market
    arbitrageOpportunity = arbitrageOpportunities.find(
      arb => arb.polymarket.id === matchedMarketId || arb.kalshi.id === matchedMarketId
    );
  }

  // Step 3: Generate signal
  const signal = generateSignal(text, matches, arbitrageOpportunity);
  signal.metadata.processing_time_ms = Date.now() - startTime;

  return signal;
}

/**
 * Simple wrapper for backward compatibility
 * Returns just the matched markets without signal generation
 */
export function simpleMatch(
  text: string,
  markets: Market[],
  // Fix C: minConfidence now optional. Undefined → class default (0.6).
  minConfidence?: number,
  maxResults: number = 5
): MarketMatch[] {
  const matcher = new KeywordMatcher(markets, minConfidence, maxResults);
  return matcher.match(text);
}
