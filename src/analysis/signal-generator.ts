// Signal Generator — converts matched markets into actionable trading signals.
//
// Changes vs. the legacy version:
//   • Edge is now SIGNED (buying YES has positive edge only if YES is
//     underpriced relative to our estimate). The old code used |diff|
//     which meant a bullish tweet on a 95¢ market returned a big edge
//     despite there being no room to trade.
//   • Fees and slippage are applied to every edge/EV number via the
//     shared `edge.ts` module, so arbitrage spreads and signal EVs use the
//     same math.
//   • Adds `ev_per_dollar` and `kelly_fraction` to each signal for bot
//     developers who want to consume sizing directly.
//   • Response shape is backwards compatible — new fields are additive,
//     existing consumers keep working.

import { Market, MarketMatch, ArbitrageOpportunity } from '../types/market';
import { analyzeSentimentForMarket, SentimentResult } from './sentiment-analyzer';
import { computeEdge, EdgeResult } from './edge';
import { getFeeModel } from './fees';

export type SignalType = 'arbitrage' | 'news_event' | 'sentiment_shift' | 'user_interest';
export type UrgencyLevel = 'low' | 'medium' | 'high' | 'critical';
export type Direction = 'YES' | 'NO' | 'HOLD';

export interface SuggestedAction {
  direction: Direction;
  confidence: number;     // 0..1 — confidence to act on this signal
  edge: number;           // signed, net of fees, in price units
  ev_per_dollar: number;  // expected profit per $1 staked
  kelly_fraction: number; // 0..1 capped (quarter-Kelly by default)
  breakeven_prob: number; // min prob needed for positive EV
  reasoning: string;
}

export interface TradingSignal {
  event_id: string;
  signal_type: SignalType;
  urgency: UrgencyLevel;
  matches: MarketMatch[];
  suggested_action?: SuggestedAction;
  sentiment?: SentimentResult;
  arbitrage?: ArbitrageOpportunity;
  metadata: {
    processing_time_ms: number;
    tweet_text?: string;
    /** Our derived P(YES) used to compute the edge — useful for debugging. */
    implied_true_prob?: number;
  };
}

// ─── Context helpers ─────────────────────────────────────────────────────

const BREAKING_KEYWORDS = [
  'breaking', 'just in', 'announced', 'confirmed', 'official', 'reports',
  'alert', 'urgent', 'developing', 'live', 'update:',
];

function isBreakingNews(text: string): boolean {
  const lower = text.toLowerCase();
  return BREAKING_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Derive a probability estimate for YES from sentiment.
 *
 * We deliberately under-shift here. Tweet-level sentiment is noisy and
 * rarely justifies more than a ±25 percentage-point deviation from an
 * uninformative 50/50 prior. Callers who want sharper priors should use
 * /api/ground-probability (where they supply their own explicit estimate).
 */
function sentimentToProbability(sentiment: SentimentResult): number {
  if (sentiment.sentiment === 'neutral') return 0.5;
  const sign = sentiment.sentiment === 'bullish' ? 1 : -1;
  const shift = sign * sentiment.confidence * 0.25;
  return Math.min(0.9, Math.max(0.1, 0.5 + shift));
}

/**
 * Confidence to feed into the edge / Kelly calc. A pure sentiment read on
 * a tweet is NEVER 100% evidence of the true outcome; we cap at 0.6 so
 * Kelly sizing stays conservative.
 */
function sentimentEdgeConfidence(sentiment: SentimentResult): number {
  return Math.min(0.6, sentiment.confidence);
}

function expiresSoonDays(market: Market): number | null {
  if (!market.endDate) return null;
  const t = new Date(market.endDate).getTime();
  if (!Number.isFinite(t)) return null;
  return (t - Date.now()) / (1000 * 60 * 60 * 24);
}

/**
 * Urgency is driven by fee-adjusted edge + liquidity + time to expiry.
 *
 * We cap urgency by liquidity: a 90% edge on a $200-volume market is not
 * actionable, so we refuse to escalate past `medium` unless the market is
 * tradable in size.
 */
function computeUrgency(
  edgeNet: number,
  market: Market,
  arbitrage: ArbitrageOpportunity | undefined,
): UrgencyLevel {
  // NB: with the covered-bundle detector upstream, `spread` is already the
  // edge *after* modeled fees + slippage (1 - costPerBundle). So we can
  // read it straight into urgency tiers — no netProfit subtraction needed.
  if (arbitrage) {
    if (arbitrage.spread > 0.03) return 'critical';
    if (arbitrage.spread > 0.015) return 'high';
  }

  const days = expiresSoonDays(market);
  const highVolume = market.volume24h > 500_000;
  const tradable = market.volume24h > 25_000; // ≈ enough depth to get $500 filled
  const soon = days !== null && days <= 7 && days > 0;

  let urgency: UrgencyLevel = 'low';
  if (edgeNet > 0.15 && highVolume && soon) urgency = 'critical';
  else if (edgeNet > 0.10) urgency = 'high';
  else if (edgeNet > 0.05) urgency = 'medium';

  if (!tradable && (urgency === 'critical' || urgency === 'high')) {
    return 'medium';
  }
  return urgency;
}

function computeSignalType(
  text: string,
  sentiment: SentimentResult,
  edgeNet: number,
  hasArbitrage: boolean,
): SignalType {
  if (hasArbitrage) return 'arbitrage';
  if (isBreakingNews(text)) return 'news_event';
  if (edgeNet > 0.10 && sentiment.sentiment !== 'neutral') return 'sentiment_shift';
  return 'user_interest';
}

function buildSuggestedAction(
  market: Market,
  sentiment: SentimentResult,
  edgeResult: EdgeResult,
): SuggestedAction {
  const direction: Direction = edgeResult.side;

  if (direction === 'HOLD' || edgeResult.evPerDollar <= 0) {
    return {
      direction: 'HOLD',
      confidence: 0,
      edge: edgeResult.edgeNet,
      ev_per_dollar: edgeResult.evPerDollar,
      kelly_fraction: 0,
      breakeven_prob: edgeResult.breakevenProb,
      reasoning: edgeResult.reasoning,
    };
  }

  // Confidence combines sentiment strength and fee-adjusted edge magnitude.
  const actionConfidence = Math.min(
    0.95,
    0.5 * sentiment.confidence + 0.5 * Math.min(1, Math.abs(edgeResult.edgeNet) * 4),
  );

  return {
    direction,
    confidence: actionConfidence,
    edge: edgeResult.edgeNet,
    ev_per_dollar: edgeResult.evPerDollar,
    kelly_fraction: edgeResult.kellyFraction,
    breakeven_prob: edgeResult.breakevenProb,
    reasoning: edgeResult.reasoning,
  };
}

/**
 * Deterministic 32-bit hash → base36 event id. Same input ⇒ same id, so
 * downstream consumers can dedupe tweets that we've already scored.
 */
function generateEventId(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash = hash & hash;
  }
  return `evt_${Math.abs(hash).toString(36)}`;
}

export function generateSignal(
  tweetText: string,
  matches: MarketMatch[],
  arbitrageOpportunity?: ArbitrageOpportunity,
): TradingSignal {
  const startTime = Date.now();

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

  const topMatch = matches[0];
  const topMarket = topMatch.market;

  const sentiment = analyzeSentimentForMarket(tweetText, topMarket.title);

  // Neutral sentiment means we have no directional evidence. The legacy
  // behaviour was to set trueProb = 0.5 and let computeEdge pick whichever
  // side was cheapest — which amounts to betting against the market price
  // using a hardcoded 50/50 prior. That's a false signal. If there's no
  // arbitrage to dominate, defer to the market and return HOLD.
  if (sentiment.sentiment === 'neutral' && !arbitrageOpportunity) {
    return {
      event_id: generateEventId(tweetText),
      signal_type: 'user_interest',
      urgency: 'low',
      matches,
      suggested_action: {
        direction: 'HOLD',
        confidence: 0,
        edge: 0,
        ev_per_dollar: 0,
        kelly_fraction: 0,
        breakeven_prob: topMarket.yesPrice,
        reasoning: 'Sentiment provides no directional evidence; deferring to the market.',
      },
      sentiment,
      metadata: {
        processing_time_ms: Date.now() - startTime,
        tweet_text: tweetText,
        implied_true_prob: topMarket.yesPrice,
      },
    };
  }

  const trueProb = sentimentToProbability(sentiment);

  // Use shared edge / Kelly math so arbitrage and position-sizing agree.
  const edgeResult = computeEdge({
    trueProb,
    yesPrice: topMarket.yesPrice,
    volume24h: topMarket.volume24h,
    fees: getFeeModel(topMarket.platform),
    stake: 100,
    confidence: sentimentEdgeConfidence(sentiment),
  });

  const urgency = computeUrgency(edgeResult.edgeNet, topMarket, arbitrageOpportunity);
  const signal_type = computeSignalType(
    tweetText,
    sentiment,
    edgeResult.edgeNet,
    !!arbitrageOpportunity,
  );
  const suggested_action = buildSuggestedAction(topMarket, sentiment, edgeResult);

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
      implied_true_prob: trueProb,
    },
  };
}

export function batchGenerateSignals(
  tweets: { text: string; matches: MarketMatch[] }[],
): TradingSignal[] {
  return tweets.map(tweet => generateSignal(tweet.text, tweet.matches));
}
