// Signal Generator - Converts matched markets into actionable trading signals
// Computes edge, urgency, signal_type, and suggested_action for bot developers

import { Market, MarketMatch, ArbitrageOpportunity } from '../types/market';
import { analyzeSentiment, SentimentResult } from './sentiment-analyzer';
import type { MarketWalletFlow } from '../types/wallet';

export type SignalType = 'arbitrage' | 'news_event' | 'sentiment_shift' | 'user_interest';
export type UrgencyLevel = 'low' | 'medium' | 'high' | 'critical';
export type Direction = 'YES' | 'NO' | 'HOLD';

export interface SuggestedAction {
  direction: Direction;
  confidence: number; // 0-1
  edge: number; // Expected profit edge
  reasoning: string;
}

export interface TradingSignal {
  event_id: string; // Unique ID for this event/tweet
  signal_type: SignalType;
  urgency: UrgencyLevel;
  matches: MarketMatch[];
  suggested_action?: SuggestedAction;
  sentiment?: SentimentResult;
  arbitrage?: ArbitrageOpportunity;
  metadata: {
    processing_time_ms: number;
    tweet_text?: string;
  };
}

/**
 * Check if tweet contains breaking news keywords
 */
function isBreakingNews(text: string): boolean {
  const breakingKeywords = [
    'breaking',
    'just in',
    'announced',
    'confirmed',
    'official',
    'reports',
    'alert',
    'urgent',
    'developing',
  ];

  const lowerText = text.toLowerCase();
  return breakingKeywords.some(kw => lowerText.includes(kw));
}

/**
 * Calculate implied probability from sentiment
 * Bullish sentiment implies higher YES probability
 * Bearish sentiment implies lower YES probability (higher NO)
 *
 * The shift is intentionally conservative (max ±15 percentage points when confidence = 1.0).
 * Social-media sentiment rarely justifies moving a probability by more than
 * that, and overclaiming here leads to spurious high-confidence signals.
 */
function calculateImpliedProbability(sentiment: SentimentResult): number {
  if (sentiment.sentiment === 'neutral') {
    return 0.5; // No directional bias
  }

  if (sentiment.sentiment === 'bullish') {
    // Bullish: high confidence = higher YES probability (max +15pp)
    return 0.5 + (sentiment.confidence * 0.15); // Range: 0.5 to 0.65
  }

  // Bearish: high confidence = lower YES probability (max -15pp)
  return 0.5 - (sentiment.confidence * 0.15); // Range: 0.1 to 0.5 **messing with percentages
}

/**
 * Calculate trading edge for a market given sentiment.
 * Includes a (1 - price) factor to reduce overconfidence in high-priced markets.
 */
function calculateEdge(market: Market, sentiment: SentimentResult): number {
  const impliedProb = calculateImpliedProbability(sentiment);
  const currentPrice = market.yesPrice;

  // Raw difference between implied and actual price
  const priceDiff = Math.abs(impliedProb - currentPrice);

  // Weight by sentiment confidence and dampen in high-priced markets
  const edge = sentiment.confidence * priceDiff * (1 - currentPrice);

  return edge;
}

/**
 * Convert a wallet-flow net direction into the buy/sell/neutral vocabulary
 * used by the decision gate and confidence adjuster.
 */
function deriveSmartMoneyDirection(
  flow: MarketWalletFlow,
): 'buy' | 'sell' | 'neutral' {
  if (flow.netDirection === 'YES') return 'buy';
  if (flow.netDirection === 'NO') return 'sell';
  return 'neutral';
}

/**
 * Decision gate – all conditions must pass before a trade is suggested.
 *
 * Priority order:
 *  1. Strong arbitrage always passes.
 *  2. Weak sentiment is rejected.
 *  3. Insufficient edge is rejected.
 *  4. Smart-money direction that contradicts sentiment is rejected.
 */
function passesDecisionGate(
  sentiment: SentimentResult,
  edge: number,
  arbitrage?: ArbitrageOpportunity,
  smartMoneyDirection?: 'buy' | 'sell' | 'neutral'
): boolean {
  // 1. Arbitrage with meaningful spread always passes
  if (arbitrage && arbitrage.spread > 0.03) return true;

  // 2. Weak sentiment → reject
  if (sentiment.confidence < 0.6) return false;

  // 3. Edge too small → reject
  if (edge < 0.05) return false;

  // 4. Smart money disagrees with sentiment → reject
  if (smartMoneyDirection) {
    if (
      (sentiment.sentiment === 'bullish' && smartMoneyDirection === 'sell') ||
      (sentiment.sentiment === 'bearish' && smartMoneyDirection === 'buy')
    ) {
      return false;
    }
  }

  return true;
}

const WEAK_SENTIMENT_CONFIDENCE_THRESHOLD = 0.7;
const WEAK_SENTIMENT_CONFIDENCE_PENALTY = 0.7;

/**
 * Adjust confidence based on signal quality.
 * Penalizes weak sentiment and boosts when arbitrage or smart-money agree.
 */
function adjustConfidence(
  base: number,
  sentiment: SentimentResult,
  hasArbitrage: boolean,
  smartMoneyAgreement: boolean
): number {
  let conf = base;

  // Penalize weak sentiment
  if (sentiment.confidence < WEAK_SENTIMENT_CONFIDENCE_THRESHOLD) conf *= WEAK_SENTIMENT_CONFIDENCE_PENALTY;

  // Boost if arbitrage is present
  if (hasArbitrage) conf = Math.min(conf * 1.5, 0.95);

  // Boost if smart money agrees
  if (smartMoneyAgreement) conf = Math.min(conf * 1.3, 0.9);

  return conf;
}

/**
 * Determine trade direction with a buffer to avoid noise trades.
 * Returns HOLD when sentiment is neutral or the edge vs price is within the buffer.
 */
function getDirection(
  sentiment: SentimentResult,
  impliedProb: number,
  price: number,
  buffer = 0.03
): Direction {
  if (sentiment.sentiment === 'neutral') return 'HOLD';

  if (sentiment.sentiment === 'bullish' && impliedProb > price + buffer) {
    return 'YES';
  }

  if (sentiment.sentiment === 'bearish' && impliedProb < price - buffer) {
    return 'NO';
  }

  return 'HOLD';
}


/**
 * Check if market expires soon (within 7 days)
 */
function expiresSoon(market: Market): boolean {
  if (!market.endDate) return false;

  const endDate = new Date(market.endDate);
  const now = new Date();
  const daysUntilExpiry = (endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

  return daysUntilExpiry <= 7 && daysUntilExpiry > 0;
}

/**
 * Compute urgency level based on edge, volume, and expiry
 *
 * Edge thresholds are calibrated to the conservative implied-probability shift
 * (max ±15pp), so max possible sentiment edge ≈ 0.15.
 */
function computeUrgency(
  edge: number,
  market: Market,
  hasArbitrage: boolean,
  arbitrageSpread?: number
): UrgencyLevel {
  // Critical: Strong edge + high volume + expires soon
  // OR very high arbitrage spread
  if (hasArbitrage && arbitrageSpread && arbitrageSpread > 0.05) {
    return 'critical';
  }

  if (edge > 0.08 && market.volume24h > 500000 && expiresSoon(market)) {
    return 'critical';
  }

  // High: Good edge OR moderate arbitrage
  if (edge > 0.06) {
    return 'high';
  }

  if (hasArbitrage && arbitrageSpread && arbitrageSpread > 0.03) {
    return 'high';
  }

  // Medium: Decent edge
  if (edge > 0.03) {
    return 'medium';
  }

  // Low: Match found but no clear edge
  return 'low';
}

/**
 * Determine signal type based on context
 */
function computeSignalType(
  tweetText: string,
  sentiment: SentimentResult,
  edge: number,
  hasArbitrage: boolean
): SignalType {
  // Arbitrage takes precedence
  if (hasArbitrage) {
    return 'arbitrage';
  }

  // Breaking news
  if (isBreakingNews(tweetText)) {
    return 'news_event';
  }

  // Sentiment strongly disagrees with market (high edge)
  if (edge > 0.10 && sentiment.sentiment !== 'neutral') {
    return 'sentiment_shift';
  }

  // Default: just a match without strong signal
  return 'user_interest';
}

/**
 * Generate suggested trading action.
 *
 * Uses the decision gate, direction buffer, and confidence adjustment helpers
 * to produce a higher-quality signal than a simple edge threshold check.
 */
function generateSuggestedAction(
  market: Market,
  sentiment: SentimentResult,
  edge: number,
  urgency: UrgencyLevel,
  arbitrage?: ArbitrageOpportunity,
  topMatchConfidence?: number,
  smartMoneyFlow?: MarketWalletFlow
): SuggestedAction {
  // Scale edge by the top match confidence so better matches produce stronger signals
  const scaledEdge = topMatchConfidence !== undefined ? edge * topMatchConfidence : edge;

  // Derive smart-money direction from wallet-flow data when available
  const smartMoneyDirection = smartMoneyFlow
    ? deriveSmartMoneyDirection(smartMoneyFlow)
    : undefined;

  // Run through multi-factor decision gate before committing to a trade
  if (!passesDecisionGate(sentiment, scaledEdge, arbitrage, smartMoneyDirection)) {
    return {
      direction: 'HOLD',
      confidence: 0,
      edge: 0,
      reasoning: 'Signal did not pass decision gate (weak sentiment, insufficient edge, or contradictory signals)',
    };
  }

  const impliedProb = calculateImpliedProbability(sentiment);
  const currentPrice = market.yesPrice;

  // Use buffered direction to avoid noise trades
  const direction = getDirection(sentiment, impliedProb, currentPrice);

  let reasoning: string;
  if (direction === 'YES') {
    reasoning = `Bullish sentiment (${(sentiment.confidence * 100).toFixed(0)}% confidence) suggests YES is underpriced at ${(currentPrice * 100).toFixed(0)}%`;
  } else if (direction === 'NO') {
    reasoning = `Bearish sentiment (${(sentiment.confidence * 100).toFixed(0)}% confidence) suggests YES is overpriced at ${(currentPrice * 100).toFixed(0)}%`;
  } else if (sentiment.sentiment === 'neutral') {
    reasoning = 'Neutral sentiment, no clear directional bias';
  } else {
    reasoning = 'Price already reflects sentiment direction (within noise buffer)';
  }

  // Determine whether smart money agrees with the sentiment direction
  const smartMoneyAgreement =
    smartMoneyDirection !== undefined &&
    smartMoneyDirection !== 'neutral' &&
    ((sentiment.sentiment === 'bullish' && smartMoneyDirection === 'buy') ||
      (sentiment.sentiment === 'bearish' && smartMoneyDirection === 'sell'));

  // Build adjusted confidence from multiple signals
  const hasArbitrage = !!arbitrage;
  const baseConfidence = urgency === 'critical'
    ? Math.min(scaledEdge * 1.5, 0.95)
    : urgency === 'high'
      ? Math.min(scaledEdge * 1.2, 0.9)
      : scaledEdge;

  const actionConfidence = adjustConfidence(baseConfidence, sentiment, hasArbitrage, smartMoneyAgreement);

  return {
    direction,
    confidence: actionConfidence,
    edge: scaledEdge,
    reasoning,
  };
}

/**
 * Generate event ID from tweet text (deterministic hash)
 * Same text will always produce the same event ID for deduplication
 */
function generateEventId(tweetText: string): string {
  // Simple hash function for deterministic IDs
  let hash = 0;
  for (let i = 0; i < tweetText.length; i++) {
    const char = tweetText.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  const hashStr = Math.abs(hash).toString(36);
  return `evt_${hashStr}`;
}

/**
 * Generate a trading signal from matched markets and tweet text.
 *
 * @param tweetText - Raw tweet text used for sentiment analysis and event ID.
 * @param matches - Pre-computed market matches.
 * @param arbitrageOpportunity - Optional arbitrage opportunity for the top match.
 * @param precomputedSentiment - Optional sentiment already computed upstream.
 *   Pass this when the caller has already called analyzeSentiment to avoid
 *   running the analysis twice.
 * @param eventId - Optional explicit event ID (e.g. the tweet's own ID).
 *   Falls back to a hash of tweetText when not provided.
 * @param smartMoneyFlow - Optional wallet-flow data for the top market.
 *   When provided, the smart-money direction is used by the decision gate and
 *   the confidence adjuster to validate and strengthen the signal.
 */
export function generateSignal(
  tweetText: string,
  matches: MarketMatch[],
  arbitrageOpportunity?: ArbitrageOpportunity,
  precomputedSentiment?: SentimentResult,
  eventId?: string,
  smartMoneyFlow?: MarketWalletFlow
): TradingSignal {
  const startTime = Date.now();

  // If no matches, return minimal signal
  if (matches.length === 0) {
    return {
      event_id: eventId ?? generateEventId(tweetText),
      signal_type: 'user_interest',
      urgency: 'low',
      matches: [],
      metadata: {
        processing_time_ms: Date.now() - startTime,
        tweet_text: tweetText,
      },
    };
  }

  // Use pre-computed sentiment if provided to avoid redundant analysis
  const sentiment = precomputedSentiment ?? analyzeSentiment(tweetText);

  // Use the top match (highest confidence) for signal computation
  const topMatch = matches[0];
  const topMarket = topMatch.market;

  // Calculate edge
  const edge = calculateEdge(topMarket, sentiment);

  // Compute urgency
  const urgency = computeUrgency(
    edge,
    topMarket,
    !!arbitrageOpportunity,
    arbitrageOpportunity?.spread
  );

  // Determine signal type
  const signal_type = computeSignalType(tweetText, sentiment, edge, !!arbitrageOpportunity);

  // Generate suggested action (passes arbitrage, top-match confidence, and smart-money flow)
  const suggested_action = generateSuggestedAction(topMarket, sentiment, edge, urgency, arbitrageOpportunity, topMatch.confidence, smartMoneyFlow);

  return {
    event_id: eventId ?? generateEventId(tweetText),
    signal_type,
    urgency,
    matches,
    suggested_action,
    sentiment,
    arbitrage: arbitrageOpportunity,
    metadata: {
      processing_time_ms: Date.now() - startTime,
      tweet_text: tweetText,
    },
  };
}

/**
 * Batch generate signals for multiple tweets
 */
export function batchGenerateSignals(
  tweets: { text: string; matches: MarketMatch[] }[]
): TradingSignal[] {
  return tweets.map(tweet => generateSignal(tweet.text, tweet.matches));
}
