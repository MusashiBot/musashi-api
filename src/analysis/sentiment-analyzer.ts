/**
 * Weighted lexicon sentiment analyzer for prediction-market tweets & news.
 *
 * Key upgrades over the legacy bag-of-words implementation:
 *   • Word- AND emoji-level scoring with per-token weights.
 *   • Multi-word phrases ("rate cut", "up only", "to the moon").
 *   • Negation scope (next 3 tokens after "not", "no", "won't", …).
 *   • Intensifiers and hedges ("very" vs. "maybe") multiply magnitude.
 *   • ALL-CAPS words and trailing "!!" boost magnitude.
 *   • Category-aware reweighting via `analyzeSentimentForMarket()`, so
 *     "crash" next to a crypto market tags bearish, but next to a "Will
 *     <plane> crash?" market tags *bullish for YES* (aligned with the
 *     market's own resolution criteria).
 *
 * Output shape (`sentiment`, `confidence`) is backward compatible with the
 * existing signal-generator, so callers don't break.
 */

export type Sentiment = 'bullish' | 'bearish' | 'neutral';

export interface SentimentResult {
  sentiment: Sentiment;
  confidence: number;       // 0..1 — strength of the net signal
  score: number;            // signed net score (bullish positive)
  magnitude: number;        // sum of absolute weights encountered
  signals: string[];        // tokens/phrases that contributed (top 8)
}

// ─── Lexicons ────────────────────────────────────────────────────────────

type WeightMap = Record<string, number>;

// Positive sentiment words. Weights calibrated so that a single rocket
// emoji (+3) outweighs a generic "up" (+1), and hype phrases like "to the
// moon" (+4) dominate casual language.
const BULLISH_LEXICON: WeightMap = {
  // Market slang
  'moon': 3, 'mooning': 3, 'moonshot': 3, 'rocket': 3, 'rocketing': 3,
  'pump': 2, 'pumping': 2, 'rally': 2, 'rallying': 2, 'surge': 2, 'surging': 2,
  'soar': 2, 'soaring': 2, 'skyrocket': 3, 'parabolic': 3, 'breakout': 2,
  'explode': 2, 'exploding': 2, 'ripping': 2, 'ripped': 2, 'melt-up': 3,
  'meltup': 3, 'bullish': 2, 'bull': 1, 'bulls': 1, 'green': 1,
  'gmi': 2, 'wagmi': 2, 'btfd': 2, 'ath': 2,

  // Directional
  'up': 1, 'higher': 1, 'rise': 1, 'rising': 1, 'rose': 1, 'climb': 1,
  'climbing': 1, 'gain': 1, 'gaining': 1, 'gained': 1, 'grow': 1,
  'growing': 1, 'boom': 2, 'booming': 2, 'strong': 1, 'stronger': 1,

  // Certainty / conviction (positive framing)
  'confirmed': 2, 'confirming': 2, 'confirm': 1, 'announced': 1, 'approved': 2,
  'approval': 1, 'win': 2, 'wins': 2, 'winning': 2, 'won': 2, 'victory': 2,
  'landslide': 3, 'lock': 2, 'inevitable': 2, 'certain': 2, 'guaranteed': 3,
  'definitely': 1, 'obvious': 1, 'clearly': 1, 'easy': 1,

  // Policy-flavored bullish
  'rate cut': 3, 'rate-cut': 3, 'ratecut': 3, 'cutting rates': 3,
  'dovish': 2, 'stimulus': 2, 'qe': 2, 'liquidity': 1, 'injection': 2,
  'soft landing': 2, 'softlanding': 2,

  // Outcome-flavored bullish
  'passed': 2, 'passes': 2, 'signed': 2, 'ratified': 2, 'ceasefire': 2,
  'deal reached': 3, 'agreement': 1,
};

const BEARISH_LEXICON: WeightMap = {
  // Market slang
  'dump': 2, 'dumping': 2, 'crash': 3, 'crashing': 3, 'plunge': 3, 'plunging': 3,
  'tank': 2, 'tanking': 2, 'collapse': 3, 'collapsing': 3, 'meltdown': 3,
  'capitulation': 3, 'capitulate': 3, 'rekt': 3, 'rug': 3, 'rugged': 3,
  'ngmi': 2, 'bagholder': 2, 'bearish': 2, 'bear': 1, 'bears': 1, 'red': 1,

  // Directional
  'down': 1, 'lower': 1, 'fall': 1, 'falling': 1, 'fell': 1, 'drop': 1,
  'dropping': 1, 'dropped': 1, 'decline': 1, 'declining': 1, 'loss': 1,
  'losing': 1, 'lost': 1, 'weak': 1, 'weaker': 1, 'slump': 2, 'slumping': 2,

  // Negative framing
  'failed': 2, 'fails': 2, 'fail': 2, 'failure': 2, 'rejected': 2, 'rejection': 2,
  'denied': 2, 'impossible': 2, 'doubt': 1, 'skeptical': 1, 'unlikely': 1,
  'concern': 1, 'worried': 1, 'worry': 1, 'fear': 2, 'panic': 3, 'crisis': 2,
  'risk': 1, 'risky': 1, 'dangerous': 1, 'default': 2,

  // Policy-flavored bearish
  'rate hike': 2, 'rate-hike': 2, 'ratehike': 2, 'hiking rates': 2,
  'hawkish': 2, 'austerity': 2, 'tightening': 2, 'tighten': 1,
  'recession': 2, 'depression': 3, 'stagflation': 3, 'shutdown': 2,
  'downgrade': 2, 'downgraded': 2, 'bubble': 2, 'overvalued': 2, 'correction': 1,

  // Outcome-flavored bearish
  'vetoed': 2, 'blocked': 2, 'filibuster': 2, 'defeat': 2, 'defeated': 2,
  'war': 2, 'invasion': 3, 'strike': 2, 'sanctions': 2, 'escalation': 2,
};

const INTENSIFIERS: WeightMap = {
  'very': 1.5, 'extremely': 2, 'highly': 1.5, 'absolutely': 2, 'completely': 1.8,
  'totally': 1.8, 'definitely': 1.5, 'certainly': 1.5, 'obviously': 1.3,
  'clearly': 1.3, 'strongly': 1.5, 'really': 1.3, 'insanely': 2, 'massively': 2,
  'super': 1.5, 'mega': 1.5, 'hella': 1.5,
};

const HEDGES: WeightMap = {
  'maybe': 0.5, 'possibly': 0.5, 'perhaps': 0.5, 'might': 0.6, 'could': 0.7,
  'probably': 0.85, 'likely': 0.9, 'somewhat': 0.7, 'kinda': 0.6, 'sorta': 0.6,
  'slightly': 0.6, 'rumor': 0.5, 'rumored': 0.5, 'allegedly': 0.5,
};

// Words that flip the following clause's polarity.
const NEGATIONS = new Set([
  'not', 'no', "don't", 'dont', "won't", 'wont', "can't", 'cant', "isn't", 'isnt',
  "aren't", 'arent', "doesn't", 'doesnt', "didn't", 'didnt', "wouldn't", 'wouldnt',
  "couldn't", 'couldnt', "shouldn't", 'shouldnt', 'never', 'neither', 'nor',
  'none', 'nobody', 'nothing', 'nowhere', 'without',
]);

const NEGATION_SCOPE = 3; // tokens after a negation that get flipped.

// Emoji / symbol lexicon. Scored separately because they usually carry the
// strongest tone signal in prediction-market tweets.
const EMOJI_LEXICON: WeightMap = {
  '🚀': 3, '🌙': 2, '📈': 2, '💎': 2, '🔥': 1.5, '🟢': 2, '✅': 1.5,
  '💪': 1.5, '🤑': 2, '💰': 1.5, '🏆': 2, '🎉': 1.5, '🥳': 1.5,
  '📉': -2, '🔴': -2, '💀': -2, '🪦': -2, '😱': -1.5, '😭': -1.5,
  '🐻': -1.5, '🐂': 1.5, '⚠️': -1, '❌': -1.5, '☠️': -2, '💸': -1.5,
};

// Multi-word phrases that must be detected before unigrams. Stored as
// space-joined lowercase strings so we can test against sliding windows.
const PHRASE_LEXICON: WeightMap = {
  'to the moon': 4, 'all time high': 3, 'all-time high': 3, 'up only': 3,
  'breaking out': 2, 'break out': 2, 'number go up': 3, 'risk on': 2,
  'risk-on': 2, 'green candle': 2, 'green candles': 2,
  'going to zero': -4, 'to zero': -3, 'dead cat': -2, 'dead-cat': -2,
  'bear market': -2, 'risk off': -2, 'risk-off': -2, 'blood bath': -3,
  'bloodbath': -3, 'red candle': -2, 'red candles': -2, 'dead money': -2,
  'rug pull': -3, 'rugpull': -3, 'game over': -2,
};

// ─── Tokenization ────────────────────────────────────────────────────────

interface Token {
  raw: string;
  lower: string;
  alpha: string;       // letters only, used for lexicon lookups
  allCaps: boolean;
  emphasized: boolean; // trailing "!"
}

function tokenize(text: string): Token[] {
  // Split on whitespace but preserve emoji / punctuation for emphasis detection.
  const parts = text.split(/\s+/).filter(Boolean);
  const tokens: Token[] = [];

  for (const raw of parts) {
    const lower = raw.toLowerCase();
    const alpha = lower.replace(/[^a-z']/g, '');
    if (!alpha && !/[\p{Extended_Pictographic}]/u.test(raw)) continue;

    tokens.push({
      raw,
      lower,
      alpha,
      allCaps: raw.length >= 3 && raw === raw.toUpperCase() && /[A-Z]/.test(raw),
      emphasized: /[!?]{2,}$/.test(raw),
    });
  }

  return tokens;
}

// ─── Core scoring ────────────────────────────────────────────────────────

interface ScoreAccumulator {
  bullish: number;
  bearish: number;
  magnitude: number;
  signals: Array<{ token: string; weight: number }>;
}

function recordSignal(acc: ScoreAccumulator, token: string, weight: number): void {
  if (weight > 0) acc.bullish += weight;
  if (weight < 0) acc.bearish += -weight;
  acc.magnitude += Math.abs(weight);
  acc.signals.push({ token, weight });
}

function getContextMultiplier(tokens: Token[], idx: number): { mult: number; negated: boolean } {
  let mult = 1;
  let negated = false;

  // Look back up to NEGATION_SCOPE tokens for negation / intensifier / hedge.
  for (let back = 1; back <= NEGATION_SCOPE && idx - back >= 0; back++) {
    const prev = tokens[idx - back];
    if (NEGATIONS.has(prev.alpha) || NEGATIONS.has(prev.lower)) {
      negated = true;
      break;
    }
    const intens = INTENSIFIERS[prev.alpha];
    if (intens !== undefined) mult *= intens;
    const hedge = HEDGES[prev.alpha];
    if (hedge !== undefined) mult *= hedge;
  }

  return { mult, negated };
}

function scorePhrases(text: string, acc: ScoreAccumulator): void {
  const lower = ' ' + text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ') + ' ';
  for (const [phrase, weight] of Object.entries(PHRASE_LEXICON)) {
    if (lower.includes(` ${phrase} `)) {
      recordSignal(acc, phrase, weight);
    }
  }
}

function scoreEmojis(text: string, acc: ScoreAccumulator): void {
  // Iterate graphemes for emoji support.
  const chars = Array.from(text);
  for (const ch of chars) {
    const weight = EMOJI_LEXICON[ch];
    if (weight !== undefined) recordSignal(acc, ch, weight);
  }
}

/**
 * Analyze the sentiment of a piece of text. Backwards compatible with the
 * previous `analyzeSentiment` signature.
 */
export function analyzeSentiment(text: string): SentimentResult {
  if (!text || typeof text !== 'string') {
    return { sentiment: 'neutral', confidence: 0, score: 0, magnitude: 0, signals: [] };
  }

  const acc: ScoreAccumulator = { bullish: 0, bearish: 0, magnitude: 0, signals: [] };

  scorePhrases(text, acc);
  scoreEmojis(text, acc);

  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const key = tok.alpha;
    if (!key) continue;

    let weight = BULLISH_LEXICON[key] ?? 0;
    if (weight === 0) {
      const neg = BEARISH_LEXICON[key];
      if (neg !== undefined) weight = -neg;
    }
    if (weight === 0) continue;

    const { mult, negated } = getContextMultiplier(tokens, i);
    let w = weight * mult;
    if (negated) w = -w;
    if (tok.allCaps) w *= 1.3;
    if (tok.emphasized) w *= 1.2;

    recordSignal(acc, key, w);
  }

  const score = acc.bullish - acc.bearish;
  const total = acc.bullish + acc.bearish;

  if (total < 0.5) {
    return { sentiment: 'neutral', confidence: 0, score: 0, magnitude: acc.magnitude, signals: [] };
  }

  const topSignals = acc.signals
    .slice()
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, 8)
    .map(s => s.token);

  const ratio = Math.abs(score) / total;
  // Squash magnitude into 0..1 confidence using a soft curve. Capped at 0.98
  // to signal we are never 100% certain from lexicon analysis alone.
  const magnitudeBoost = 1 - Math.exp(-total / 4);
  const confidence = Math.min(0.98, 0.5 * ratio + 0.5 * magnitudeBoost);

  if (ratio < 0.15) {
    return { sentiment: 'neutral', confidence, score, magnitude: acc.magnitude, signals: topSignals };
  }

  const sentiment: Sentiment = score > 0 ? 'bullish' : 'bearish';
  return { sentiment, confidence, score, magnitude: acc.magnitude, signals: topSignals };
}

/**
 * Convenience helper: sentiment interpreted in the context of a specific
 * market title. A positive score on "Bitcoin goes to 100k" is bullish YES;
 * a positive score on "Will the Fed cut rates?" is also bullish YES, but a
 * *negative* score on "Will BTC crash?" is bullish YES (the crash is what
 * the market is *asking about*).
 *
 * We flip the sign if the market title contains any bearish keyword as a
 * whole-token match — "fall" triggers on "will Tesla fall" but not on
 * "Falcons roster", "red" triggers on "red wave" but not on "redux".
 */
export function analyzeSentimentForMarket(
  text: string,
  marketTitle: string,
): SentimentResult {
  const base = analyzeSentiment(text);
  if (base.sentiment === 'neutral') return base;

  const titleLower = marketTitle.toLowerCase();
  const bearishHit = findKeyAsWord(titleLower, Object.keys(BEARISH_LEXICON));
  if (!bearishHit) return base;
  // If a longer bullish phrase also matches, the bearish hit may be
  // inside it (e.g. "soft landing" contains "fail" — hypothetically).
  // Prefer the longer match.
  const bullishHit = findKeyAsWord(titleLower, Object.keys(BULLISH_LEXICON));
  if (bullishHit && bullishHit.length > bearishHit.length) return base;

  const flipped: Sentiment = base.sentiment === 'bullish' ? 'bearish' : 'bullish';
  return { ...base, sentiment: flipped, score: -base.score };
}

/**
 * Return the first key from `keys` that appears in `haystack` as a
 * whole-token match (word boundaries on both sides). Returns the
 * matched key, or `undefined` if none match. Keys containing spaces
 * match across whitespace in the haystack (phrase-level match).
 */
function findKeyAsWord(haystack: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // `\b` at both ends for unigrams; for phrases containing spaces
    // the interior spaces match any run of whitespace.
    const pattern = escaped.replace(/ /g, '\\s+');
    if (new RegExp(`\\b${pattern}\\b`).test(haystack)) return key;
  }
  return undefined;
}
