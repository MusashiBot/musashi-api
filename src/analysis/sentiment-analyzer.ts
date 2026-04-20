/**
 * Sentiment analyzer for tweets and multi-tweet aggregation
 * Detects bullish/bearish/neutral sentiment via keyword analysis.
 * Weighted aggregation applies recency decay and author influence scoring.
 */

export type Sentiment = 'bullish' | 'bearish' | 'neutral';

export interface SentimentResult {
  sentiment: Sentiment;
  confidence: number; // 0-1, how confident we are in this classification
}

/** A single tweet with author metadata for weighted aggregation */
export interface TweetInput {
  text: string;
  timestamp: number;           // Unix ms — used for recency decay
  author?: {
    followers: number;
    engagementRate: number;    // 0-1 (e.g. 0.03 = 3%)
  };
}

/** Weighted aggregate sentiment across multiple tweets */
export interface WeightedSentiment {
  direction: Sentiment;
  conviction: number;          // 0-1, weighted confidence in direction
  tweet_count: number;
  consensus_ratio: number;     // Fraction of tweets agreeing with direction (0-1)
  bullish_count: number;
  bearish_count: number;
  neutral_count: number;
}

// Bullish indicators
const BULLISH_KEYWORDS = [
  'bullish', 'moon', 'rally', 'pump', 'surge', 'soar', 'skyrocket',
  'buy', 'long', 'calls', 'green', 'win', 'winning', 'yes', 'definitely',
  'confirmed', 'happening', 'inevitable', 'obvious', 'clearly', 'certain',
  'guarantee', 'lock', 'easy', 'confident', 'predict', 'will happen',
  'going to', 'up', 'rise', 'increase', 'gain', 'profit', 'success',
  'boom', 'growth', 'explosive', 'parabolic', 'breakout'
];

// Bearish indicators
const BEARISH_KEYWORDS = [
  'bearish', 'dump', 'crash', 'plunge', 'tank', 'collapse', 'fall',
  'sell', 'short', 'puts', 'red', 'lose', 'losing', 'no', 'impossible',
  'unlikely', 'doubt', 'skeptical', 'concern', 'worried', 'fear', 'risk',
  'down', 'decline', 'drop', 'decrease', 'loss', 'fail', 'failure',
  'bubble', 'overvalued', 'recession', 'bear', 'correction'
];

// Strong modifiers (increase weight)
const STRONG_MODIFIERS = [
  'very', 'extremely', 'highly', 'absolutely', 'completely', 'totally',
  'definitely', 'certainly', 'obviously', 'clearly', 'strongly', 'really'
];

// Negations (reverse sentiment)
const NEGATIONS = [
  'not', 'no', "don't", "won't", "can't", "isn't", "aren't", "doesn't",
  'never', 'neither', 'nor', 'none', 'nobody', 'nothing', 'nowhere'
];

/**
 * Analyze tweet text and return sentiment
 */
export function analyzeSentiment(tweetText: string): SentimentResult {
  const text = tweetText.toLowerCase();
  const words = text.split(/\s+/);

  let bullishScore = 0;
  let bearishScore = 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/[^a-z]/g, '');
    const prevWord = i > 0 ? words[i - 1].replace(/[^a-z]/g, '') : '';

    // Check for negation
    const isNegated = NEGATIONS.includes(prevWord);

    // Check for strong modifier
    const isStrong = STRONG_MODIFIERS.includes(prevWord);
    const weight = isStrong ? 2 : 1;

    // Check bullish
    if (BULLISH_KEYWORDS.includes(word)) {
      if (isNegated) {
        bearishScore += weight;
      } else {
        bullishScore += weight;
      }
    }

    // Check bearish
    if (BEARISH_KEYWORDS.includes(word)) {
      if (isNegated) {
        bullishScore += weight;
      } else {
        bearishScore += weight;
      }
    }
  }

  // Calculate total and determine sentiment
  const total = bullishScore + bearishScore;

  if (total === 0) {
    return { sentiment: 'neutral', confidence: 0 };
  }

  const bullishRatio = bullishScore / total;
  const bearishRatio = bearishScore / total;

  // Need strong signal to classify (>60%)
  if (bullishRatio > 0.6) {
    return { sentiment: 'bullish', confidence: bullishRatio };
  }

  if (bearishRatio > 0.6) {
    return { sentiment: 'bearish', confidence: bearishRatio };
  }

  // Mixed or weak signal
  return { sentiment: 'neutral', confidence: 1 - Math.abs(bullishRatio - bearishRatio) };
}

/**
 * Aggregate sentiment across multiple tweets using:
 *   - Recency decay: exponential half-life of 15 minutes
 *   - Author influence: log(followers) × engagement rate
 *   - Per-tweet sentiment confidence as signal strength
 *
 * @param tweets  Array of tweet inputs with optional author metadata
 * @returns       WeightedSentiment aggregate
 */
export function aggregateWeightedSentiment(tweets: TweetInput[]): WeightedSentiment {
  if (tweets.length === 0) {
    return {
      direction: 'neutral',
      conviction: 0,
      tweet_count: 0,
      consensus_ratio: 0,
      bullish_count: 0,
      bearish_count: 0,
      neutral_count: 0,
    };
  }

  const now = Date.now();
  let bullishCount = 0;
  let bearishCount = 0;
  let neutralCount = 0;

  const weightedScores = tweets.map(t => {
    const result = analyzeSentiment(t.text);

    // Recency decay — half-life of 15 minutes
    const ageMins = Math.max(0, (now - t.timestamp) / 60_000);
    const recencyDecay = Math.exp(-ageMins / 15);

    // Author influence (floor at 1 follower to avoid log(0))
    const followers = t.author?.followers ?? 0;
    const engagementRate = t.author?.engagementRate ?? 0.01;
    const authorWeight = Math.log1p(Math.max(1, followers)) * (engagementRate + 0.01);

    // Directional score: +1 bullish, -1 bearish, 0 neutral
    const direction = result.sentiment === 'bullish' ? 1
      : result.sentiment === 'bearish' ? -1
      : 0;

    if (result.sentiment === 'bullish') bullishCount++;
    else if (result.sentiment === 'bearish') bearishCount++;
    else neutralCount++;

    return direction * result.confidence * recencyDecay * authorWeight;
  });

  const totalWeight = weightedScores.reduce((a, b) => a + Math.abs(b), 0);
  const netScore = weightedScores.reduce((a, b) => a + b, 0);

  if (totalWeight < 1e-9) {
    return {
      direction: 'neutral',
      conviction: 0,
      tweet_count: tweets.length,
      consensus_ratio: 0.5,
      bullish_count: bullishCount,
      bearish_count: bearishCount,
      neutral_count: neutralCount,
    };
  }

  const direction: Sentiment =
    netScore > 0.05 * totalWeight ? 'bullish'
    : netScore < -0.05 * totalWeight ? 'bearish'
    : 'neutral';

  const conviction = Math.min(1, Math.abs(netScore / totalWeight));

  // Fraction of tweets that agree with the majority direction
  const agreeingCount =
    direction === 'bullish' ? bullishCount
    : direction === 'bearish' ? bearishCount
    : neutralCount;
  const consensusRatio = agreeingCount / tweets.length;

  return {
    direction,
    conviction: parseFloat(conviction.toFixed(4)),
    tweet_count: tweets.length,
    consensus_ratio: parseFloat(consensusRatio.toFixed(4)),
    bullish_count: bullishCount,
    bearish_count: bearishCount,
    neutral_count: neutralCount,
  };
}
