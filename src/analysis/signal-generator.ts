// Signal Generator — converts matched markets into actionable trading signals.
//
// Improvements over legacy rule-based system:
//   • Kelly Criterion position sizing with volatility regime scaling
//   • valid_until_seconds: downstream bots know exactly when this signal expires
//   • is_near_resolution: allows bots to apply urgency/time-decay pressure
//   • Weighted sentiment (multi-tweet) support via aggregateWeightedSentiment
//   • More nuanced urgency: proximity-to-resolution factor
//
// All additions are backward-compatible — new fields are purely additive.

import { Market, MarketMatch, ArbitrageOpportunity, PositionSize } from '../types/market';
import { analyzeSentiment, SentimentResult } from './sentiment-analyzer';
import { kellySizing, VolatilityRegime } from './kelly-sizing';
import { logSignal } from '../db/signal-outcomes';
import {
  predictSignalQuality,
  SignalFeatures,
  SignalQualityPrediction,
  isModelAvailable,
} from '../ml/signal-scorer-model';

// Gate: refuse ML-based scoring unless this env var is explicitly "true".
// Prevents circular-prior contamination from synthetic-only training data.
// See src/ml/README.md § WARNING: Circular ML Priors for details.
function isMLEnabledByOperator(): boolean {
  return process.env.MUSASHI_ML_ENABLED === 'true';
}

export type SignalType = 'arbitrage' | 'news_event' | 'sentiment_shift' | 'user_interest';
export type UrgencyLevel = 'low' | 'medium' | 'high' | 'critical';
export type Direction = 'YES' | 'NO' | 'HOLD';

export interface SuggestedAction {
  direction: Direction;
  confidence: number;        // 0-1
  edge: number;              // Expected profit edge
  reasoning: string;
  position_size: PositionSize; // Kelly-sized position recommendation
}

export interface TradingSignal {
  event_id: string;
  signal_type: SignalType;
  urgency: UrgencyLevel;
  matches: MarketMatch[];
  suggested_action?: SuggestedAction;
  sentiment?: SentimentResult;
  arbitrage?: ArbitrageOpportunity;
  // ── New fields ───────────────────────────────────────────────────────────
  valid_until_seconds: number;  // How many seconds this signal remains valid
  is_near_resolution: boolean;  // True if top market resolves within 7 days
  ml_score?: {
    probability: number;      // ML model's predicted probability of success (0-1)
    confidence: number;       // Model confidence in the prediction (0-1)
    source: 'ml_model' | 'heuristic';
    model_version?: string;
  };
  /** When MUSASHI_ML_SHADOW=1 and use_ml_scorer is false: ML prediction without changing rule-based action. */
  ml_score_shadow?: SignalQualityPrediction;
  metadata: {
    processing_time_ms: number;
    tweet_text?: string;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isBreakingNews(text: string): boolean {
  const breakingKeywords = [
    'breaking', 'just in', 'announced', 'confirmed', 'official',
    'reports', 'alert', 'urgent', 'developing',
  ];
  const lower = text.toLowerCase();
  return breakingKeywords.some(kw => lower.includes(kw));
}

function calculateImpliedProbability(sentiment: SentimentResult): number {
  if (sentiment.sentiment === 'neutral') return 0.5;
  if (sentiment.sentiment === 'bullish') {
    return 0.5 + sentiment.confidence * 0.4; // 0.5 → 0.9
  }
  return 0.5 - sentiment.confidence * 0.4;   // 0.1 → 0.5
}

function calculateEdge(market: Market, sentiment: SentimentResult): number {
  const impliedProb = calculateImpliedProbability(sentiment);
  return sentiment.confidence * Math.abs(impliedProb - market.yesPrice);
}

function daysUntilExpiry(market: Market): number | null {
  if (!market.endDate) return null;
  const days = (new Date(market.endDate).getTime() - Date.now()) / 86_400_000;
  return days > 0 ? days : 0;
}

function expiresSoon(market: Market): boolean {
  const days = daysUntilExpiry(market);
  return days !== null && days <= 7;
}

/**
 * How long (seconds) this signal should be considered valid.
 * Breaking news signals expire fast; long-horizon signals last longer.
 */
function computeValidUntilSeconds(
  signalType: SignalType,
  urgency: UrgencyLevel,
  market: Market
): number {
  const days = daysUntilExpiry(market);

  if (signalType === 'news_event' || urgency === 'critical') return 300;   // 5 min
  if (urgency === 'high') return 600;                                       // 10 min
  if (days !== null && days <= 1) return 1800;                              // 30 min (same-day)
  if (urgency === 'medium') return 3600;                                    // 1 hour
  return 7200;                                                              // 2 hours
}

function computeUrgency(
  edge: number,
  market: Market,
  hasArbitrage: boolean,
  arbitrageNetSpread?: number
): UrgencyLevel {
  const nearRes = expiresSoon(market);

  if (hasArbitrage && arbitrageNetSpread && arbitrageNetSpread > 0.05) return 'critical';
  if (edge > 0.15 && market.volume24h > 500_000 && nearRes) return 'critical';

  if (edge > 0.10) return 'high';
  if (hasArbitrage && arbitrageNetSpread && arbitrageNetSpread > 0.03) return 'high';

  // Boost urgency one level if market resolves very soon (≤24h)
  const days = daysUntilExpiry(market);
  if (days !== null && days <= 1 && edge > 0.05) return 'high';

  if (edge > 0.05) return 'medium';
  return 'low';
}

function computeSignalType(
  text: string,
  sentiment: SentimentResult,
  edge: number,
  hasArbitrage: boolean
): SignalType {
  if (hasArbitrage) return 'arbitrage';
  if (isBreakingNews(text)) return 'news_event';
  if (edge > 0.10 && sentiment.sentiment !== 'neutral') return 'sentiment_shift';
  return 'user_interest';
}

function generateSuggestedAction(
  market: Market,
  sentiment: SentimentResult,
  edge: number,
  urgency: UrgencyLevel,
  volRegime: VolatilityRegime = 'normal'
): SuggestedAction {
  if (edge < 0.10) {
    return {
      direction: 'HOLD',
      confidence: 0,
      edge: 0,
      reasoning: 'Insufficient edge to justify a trade',
      position_size: kellySizing(0, 0.5, market.yesPrice, volRegime),
    };
  }

  const impliedProb = calculateImpliedProbability(sentiment);
  const currentPrice = market.yesPrice;

  let direction: Direction;
  let reasoning: string;

  if (sentiment.sentiment === 'neutral') {
    direction = 'HOLD';
    reasoning = 'Neutral sentiment — no directional bias';
  } else if (sentiment.sentiment === 'bullish') {
    if (impliedProb > currentPrice) {
      direction = 'YES';
      reasoning = `Bullish (${(sentiment.confidence * 100).toFixed(0)}% conf) — YES underpriced at ${(currentPrice * 100).toFixed(0)}¢`;
    } else {
      direction = 'HOLD';
      reasoning = 'Bullish sentiment but YES already fully priced';
    }
  } else {
    if (impliedProb < currentPrice) {
      direction = 'NO';
      reasoning = `Bearish (${(sentiment.confidence * 100).toFixed(0)}% conf) — YES overpriced at ${(currentPrice * 100).toFixed(0)}¢`;
    } else {
      direction = 'HOLD';
      reasoning = 'Bearish sentiment but YES already priced low';
    }
  }

  // Confidence scales with urgency
  let actionConfidence = edge;
  if (urgency === 'critical') actionConfidence = Math.min(edge * 1.5, 0.95);
  else if (urgency === 'high') actionConfidence = Math.min(edge * 1.2, 0.90);

  // Kelly sizing uses the model confidence and current market price
  const positionSize = kellySizing(edge, actionConfidence, currentPrice, volRegime);

  return { direction, confidence: actionConfidence, edge, reasoning, position_size: positionSize };
}

function generateEventId(_text: string): string {
  return crypto.randomUUID();
}

function buildMlFeatureVector(
  sentiment: SentimentResult,
  topMatch: MarketMatch,
  matches: MarketMatch[],
  arbitrageOpportunity: ArbitrageOpportunity | undefined,
  suggested_action: SuggestedAction,
  signal_type: SignalType,
  urgency: UrgencyLevel,
  isNearRes: boolean,
  edge: number,
  startTime: number
): SignalFeatures {
  const topMarket = topMatch.market;
  return {
    sentiment_confidence: sentiment.confidence,
    yes_price: topMarket.yesPrice,
    volume_24h: topMarket.volume24h,
    match_confidence: topMatch.confidence,
    num_matches: matches.length,
    edge,
    one_day_price_change: topMarket.oneDayPriceChange ?? 0,
    is_anomalous: topMarket.is_anomalous ?? false,
    is_near_resolution: isNearRes,
    has_arbitrage: !!arbitrageOpportunity,
    arbitrage_spread: arbitrageOpportunity?.spread ?? 0,
    kelly_fraction: suggested_action.position_size.fraction,
    processing_time_ms: Date.now() - startTime,
    sentiment: sentiment.sentiment,
    signal_type,
    urgency,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a trading signal from tweet text and matched markets.
 *
 * @param tweetText           The raw tweet / news text
 * @param matches             Markets matched by KeywordMatcher
 * @param arbitrageOpportunity  Optional cross-platform arb pairing
 * @param volRegime           Volatility regime for Kelly scaling (default: 'normal')
 * @param options             Optional configuration
 * @param options.use_ml_scorer  If true, use ML model to adjust confidence (default: false)
 */
export function generateSignal(
  tweetText: string,
  matches: MarketMatch[],
  arbitrageOpportunity?: ArbitrageOpportunity,
  volRegime: VolatilityRegime = 'normal',
  options?: { use_ml_scorer?: boolean }
): TradingSignal {
  const startTime = Date.now();

  if (matches.length === 0) {
    return {
      event_id: generateEventId(tweetText),
      signal_type: 'user_interest',
      urgency: 'low',
      matches: [],
      valid_until_seconds: 7200,
      is_near_resolution: false,
      metadata: { processing_time_ms: Date.now() - startTime, tweet_text: tweetText },
    };
  }

  const sentiment = analyzeSentiment(tweetText);
  const topMatch = matches[0];
  const topMarket = topMatch.market;

  const edge = calculateEdge(topMarket, sentiment);

  // Use net_spread for urgency so liquidity cost is baked in
  const arbNetSpread = arbitrageOpportunity?.net_spread ?? arbitrageOpportunity?.spread;
  const urgency = computeUrgency(edge, topMarket, !!arbitrageOpportunity, arbNetSpread);
  const signal_type = computeSignalType(tweetText, sentiment, edge, !!arbitrageOpportunity);
  const suggested_action = generateSuggestedAction(topMarket, sentiment, edge, urgency, volRegime);

  const isNearRes = expiresSoon(topMarket);
  const valid_until_seconds = computeValidUntilSeconds(signal_type, urgency, topMarket);

  const signal: TradingSignal = {
    event_id: generateEventId(tweetText),
    signal_type,
    urgency,
    matches,
    suggested_action,
    sentiment,
    arbitrage: arbitrageOpportunity,
    valid_until_seconds,
    is_near_resolution: isNearRes,
    metadata: { processing_time_ms: Date.now() - startTime, tweet_text: tweetText },
  };

  // ── ML-based confidence adjustment ────────────────────────────────────────
  // If ML scorer is enabled and available, use it to refine the signal confidence.
  // The ML model predicts the probability that this signal will be correct based on
  // historical performance of similar signals.
  if (options?.use_ml_scorer && suggested_action && isModelAvailable() && isMLEnabledByOperator()) {
    try {
      const mlFeatures = buildMlFeatureVector(
        sentiment,
        topMatch,
        matches,
        arbitrageOpportunity,
        suggested_action,
        signal_type,
        urgency,
        isNearRes,
        edge,
        startTime
      );

      const mlPrediction = predictSignalQuality(mlFeatures);
      signal.ml_score = mlPrediction;

      // Adjust action confidence based on ML prediction
      // Blend rule-based confidence with ML prediction (70% ML, 30% rule-based)
      const originalConfidence = suggested_action.confidence;
      const blendedConfidence = mlPrediction.probability * 0.7 + originalConfidence * 0.3;
      
      suggested_action.confidence = blendedConfidence;
      suggested_action.reasoning += ` [ML-adjusted: ${(mlPrediction.probability * 100).toFixed(0)}% success probability]`;
      
      // Recalculate position size with adjusted confidence
      suggested_action.position_size = kellySizing(edge, blendedConfidence, topMarket.yesPrice, volRegime);
    } catch (err) {
      // ML scoring failed - continue with rule-based confidence
      console.warn('[generateSignal] ML scoring failed:', err);
    }
  } else if (
    process.env.MUSASHI_ML_SHADOW === '1' &&
    !options?.use_ml_scorer &&
    suggested_action &&
    isModelAvailable()
  ) {
    try {
      const mlFeatures = buildMlFeatureVector(
        sentiment,
        topMatch,
        matches,
        arbitrageOpportunity,
        suggested_action,
        signal_type,
        urgency,
        isNearRes,
        edge,
        startTime
      );
      signal.ml_score_shadow = predictSignalQuality(mlFeatures);
    } catch (err) {
      console.warn('[generateSignal] ML shadow scoring failed:', err);
    }
  }

  // ── Log signal for ML training (async, non-blocking) ──────────────────────
  // Extract all features used in signal generation for future model training.
  // This runs asynchronously and does not block the API response.
  if (typeof window === 'undefined') {
    // Only log on server-side (not in browser)
    logSignal(signal).catch(err => {
      console.error('[generateSignal] Failed to log signal for ML training:', err);
    });
  }

  return signal;
}

/** Batch generate signals for multiple tweets */
export function batchGenerateSignals(
  tweets: { text: string; matches: MarketMatch[] }[],
  options?: { use_ml_scorer?: boolean }
): TradingSignal[] {
  return tweets.map(t => generateSignal(t.text, t.matches, undefined, 'normal', options));
}
