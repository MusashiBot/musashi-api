// Signal Generator - Converts matched markets into actionable trading signals
// Computes edge, urgency, signal_type, and suggested_action for bot developers

import { Market, MarketMatch, ArbitrageOpportunity } from '../types/market';
import { analyzeSentiment, SentimentResult } from './sentiment-analyzer';

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
 */
function calculateImpliedProbability(sentiment: SentimentResult): number {
  if (sentiment.sentiment === 'neutral') {
    return 0.5; // No directional bias
  }

  if (sentiment.sentiment === 'bullish') {
    // Bullish: high confidence = higher YES probability
    return 0.5 + (sentiment.confidence * 0.4); // Range: 0.5 to 0.9
  }

  // Bearish: high confidence = lower YES probability
  return 0.5 - (sentiment.confidence * 0.4); // Range: 0.1 to 0.5
}

/**
 * Calculate trading edge for a market given sentiment
 * Edge = how much the sentiment-implied probability differs from market price
 */
function calculateEdge(market: Market, sentiment: SentimentResult): number {
  const impliedProb = calculateImpliedProbability(sentiment);
  const currentPrice = market.yesPrice;

  // Raw difference between implied and actual price
  // FIX 1: removed redundant sentiment.confidence multiplication — calculateImpliedProbability
  // already scales by confidence, so multiplying again was double-discounting edge by ~40-80%
  const edge = Math.abs(impliedProb - currentPrice);

  return edge;
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

  if (edge > 0.15 && market.volume24h > 500000 && expiresSoon(market)) {
    return 'critical';
  }

  // High: Good edge OR moderate arbitrage
  if (edge > 0.10) {
    return 'high';
  }

  if (hasArbitrage && arbitrageSpread && arbitrageSpread > 0.03) {
    return 'high';
  }

  // Medium: Decent edge
  if (edge > 0.05) {
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
 * Generate suggested trading action
 */
function generateSuggestedAction(
  market: Market,
  sentiment: SentimentResult,
  edge: number,
  urgency: UrgencyLevel
): SuggestedAction {
  // Don't suggest action if edge is too low
  if (edge < 0.10) {
    return {
      direction: 'HOLD',
      confidence: 0,
      edge: 0,
      reasoning: 'Insufficient edge to justify a trade',
    };
  }

  const impliedProb = calculateImpliedProbability(sentiment);
  const currentPrice = market.yesPrice;

  let direction: Direction;
  let reasoning: string;

  // FIX 2: direction is determined purely by whether impliedProb is above or below
  // currentPrice — not by the sentiment label. The old code returned HOLD when sentiment
  // was "bearish" but impliedProb still exceeded currentPrice (e.g. mildly bearish signal
  // on a market already priced at 20¢), missing profitable YES entries.
  if (sentiment.sentiment === 'neutral') {
    direction = 'HOLD';
    reasoning = 'Neutral sentiment, no clear directional bias';
  } else if (impliedProb > currentPrice) {
    direction = 'YES';
    reasoning = `${sentiment.sentiment === 'bullish' ? 'Bullish' : 'Mildly bearish'} sentiment (${(sentiment.confidence * 100).toFixed(0)}% confidence) suggests YES is underpriced at ${(currentPrice * 100).toFixed(0)}%`;
  } else if (impliedProb < currentPrice) {
    direction = 'NO';
    reasoning = `${sentiment.sentiment === 'bearish' ? 'Bearish' : 'Mildly bullish'} sentiment (${(sentiment.confidence * 100).toFixed(0)}% confidence) suggests YES is overpriced at ${(currentPrice * 100).toFixed(0)}%`;
  } else {
    direction = 'HOLD';
    reasoning = 'Implied probability matches current price, no edge';
  }

  // Confidence based on edge and urgency
  let actionConfidence = edge;
  if (urgency === 'critical') actionConfidence = Math.min(edge * 1.5, 0.95);
  else if (urgency === 'high') actionConfidence = Math.min(edge * 1.2, 0.9);

  return {
    direction,
    confidence: actionConfidence,
    edge,
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
 * Generate a trading signal from matched markets and tweet text
 */
export function generateSignal(
  tweetText: string,
  matches: MarketMatch[],
  arbitrageOpportunity?: ArbitrageOpportunity
): TradingSignal {
  const startTime = Date.now();

  // If no matches, return minimal signal
  if (matches.length === 0) {
    return {
      event_id: generateEventId(tweetText),
      signal_type: 'user_interest',
      urgency: 'low',
      matches: [],
      metadata: {
        processing_time_ms: Date.now() - startTime,
        tweet_text: tweetText,
      },
    };
  }

  // Analyze tweet sentiment
  const sentiment = analyzeSentiment(tweetText);

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

  // Generate suggested action
  const suggested_action = generateSuggestedAction(topMarket, sentiment, edge, urgency);

  return {
    event_id: generateEventId(tweetText),
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
