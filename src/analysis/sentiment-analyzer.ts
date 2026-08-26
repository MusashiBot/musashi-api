/**
 * Simple sentiment analyzer for tweets
 * Detects bullish/bearish/neutral sentiment based on keyword analysis
 */

export type Sentiment = 'bullish' | 'bearish' | 'neutral';

export interface SentimentResult {
  sentiment: Sentiment;
  confidence: number; // 0-1, how confident we are in this classification
}

// Bullish indicators
const BULLISH_KEYWORDS = [
  'bullish', 'moon', 'rally', 'pump', 'surge', 'soar', 'skyrocket',
  'buy', 'long', 'calls', 'green', 'win', 'winning', 'yes', 'definitely',
  'confirmed', 'happening', 'inevitable', 'obvious', 'clearly', 'certain',
  'guarantee', 'lock', 'easy', 'confident', 'predict', 'will happen',
  'going to', 'up', 'rise', 'increase', 'gain', 'profit', 'success',
  'boom', 'growth', 'explosive', 'parabolic', 'breakout',
  'succeed',
];

// Bearish indicators
const BEARISH_KEYWORDS = [
  'bearish', 'dump', 'crash', 'plunge', 'tank', 'collapse', 'fall',
  'sell', 'short', 'puts', 'red', 'lose', 'losing', 'no', 'doubt',
  'skeptical', 'concern', 'worried', 'fear', 'risk',
  'down', 'decline', 'drop', 'decrease', 'loss', 'fail', 'failure',
  'bubble', 'overvalued', 'recession', 'bear', 'correction',
  'unlikely', 'impossible',
];

// Strong modifiers — double the weight of the following keyword (e.g. "extremely bullish")
const STRONG_MODIFIERS = [
  'very', 'extremely', 'highly', 'absolutely', 'completely', 'totally',
  'definitely', 'certainly', 'obviously', 'clearly', 'strongly', 'really',
];

// Weak modifiers — probability/likelihood words that boost weight by 1.5×
// These don't score on their own; they amplify an adjacent sentiment keyword.
// e.g. "likely crash" → crash scored at 1.5 instead of 1
const WEAK_MODIFIERS = [
  'likely', 'probable', 'probably', 'possible', 'possibly',
  'expected', 'anticipated', 'projected', 'seemingly', 'apparently',
  'arguably', 'presumably', 'supposedly', 'reportedly',
  'could', 'should', 'might', 'may', 'seems',
];

// Negations (reverse sentiment)
const NEGATIONS = [
  'not', 'no', "don't", "won't", "can't", "isn't", "aren't", "doesn't",
  'dont', 'wont', 'cant', 'isnt', 'arent', 'doesnt',
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

    // Walk backwards through adjacent negations/modifiers.
    // Odd negation count = negated; strong modifier = 2× weight; weak modifier = 1.5× weight.
    let negationCount = 0;
    let hasStrong = false;
    let hasWeak = false;
    for (let j = i - 1; j >= 0; j--) {
      if (/[.!?;]/.test(words[j])) break;
      const prev = words[j].replace(/[^a-z]/g, '');
      if (NEGATIONS.includes(prev)) {
        negationCount++;
      } else if (STRONG_MODIFIERS.includes(prev)) {
        hasStrong = true;
      } else if (WEAK_MODIFIERS.includes(prev)) {
        hasWeak = true;
      } else if (BULLISH_KEYWORDS.includes(prev) || BEARISH_KEYWORDS.includes(prev)) {
        break;
      }
      // else: filler word (article, preposition, noun) — skip and keep looking back
    }
    const isNegated = negationCount % 2 === 1;
    const weight = hasStrong ? 2 : hasWeak ? 1.5 : 1;

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
  // FIX 5: confidence should be LOW when the signal is evenly split (high ambiguity).
  // The original formula (1 - diff) returned ~1.0 for a 50/50 split, which is backwards —
  // a perfectly tied signal is maximally uncertain, not maximally confident.
  return { sentiment: 'neutral', confidence: Math.abs(bullishRatio - bearishRatio) };
}
