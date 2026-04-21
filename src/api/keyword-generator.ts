// Generates market keywords from title + description.
// Uses unigrams only (no bigram noise) plus SYNONYM_MAP forward expansion.
// Including the description means company names, tickers, and context words
// appear as keywords without needing hand-coded SYNONYM_MAP entries.

import { SYNONYM_MAP } from '../analysis/keyword-matcher';

const TITLE_STOPS = new Set([
  'will', 'the', 'a', 'an', 'in', 'on', 'at', 'by', 'for', 'to', 'of',
  'and', 'or', 'is', 'be', 'has', 'have', 'are', 'was', 'were', 'been',
  'do', 'does', 'did', '2024', '2025', '2026', '2027', '2028', 'before',
  'after', 'end', 'yes', 'no', 'than', 'over', 'under', 'above', 'below',
  'hit', 'reach', 'win', 'lose', 'pass', 'major', 'us', 'use', 'its',
  'their', 'any', 'all', 'into', 'out', 'up', 'down', 'as', 'from',
  'with', 'this', 'that', 'not', 'new', 'more', 'than', 'most', 'least',
  'how', 'what', 'when', 'where', 'who', 'get', 'got', 'put', 'set',
  'per', 'via', 'vs', 'vs.', 'than', 'if', 'whether', 'close', 'below',
  'least', 'value', 'level', 'least', 'each', 'such', 'also', 'still',
  'next', 'last', 'first', 'time', 'market', 'price', 'would',
  // Generic English words that appear in everyday speech but carry no
  // market-specific signal when seen in isolation (e.g. "world" in a
  // FIFA World Cup title would create a spurious keyword that matches
  // tweets mentioning "the world" in an unrelated context).
  // "man city" / "man united" are handled via SYNONYM_MAP bigrams instead.
  'world', 'cup', 'game', 'games', 'live', 'work', 'way', 'show', 'back',
  'know', 'good', 'big', 'take', 'top', 'open', 'run', 'real', 'right',
  'mean', 'only', 'even', 'well', 'off', 'look', 'find', 'going', 'come',
  'make', 'made', 'day', 'days', 'part', 'true', 'keep', 'left', 'try',
  'give', 'once', 'ever', 'much', 'many', 'other', 'every', 'again',
  'move', 'play', 'long', 'high', 'side', 'line', 'lead', 'role', 'hold',
  'plan', 'place', 'start', 'see', 'say', 'said', 'goes',
  'man', 'men', 'city', 'united', 'new', 'old', 'final', 'league',
]);

/** Extract unigrams from a text string, applying stop-word filtering */
function extractUnigrams(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'&$]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 2 && !TITLE_STOPS.has(w));
}

/** Extract bigrams + trigrams that are keys in SYNONYM_MAP */
function extractSynonymPhrases(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 0);

  const phrases: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = words[i] + ' ' + words[i + 1];
    if (SYNONYM_MAP[bigram]) phrases.push(bigram);
    if (i < words.length - 2) {
      const trigram = words[i] + ' ' + words[i + 1] + ' ' + words[i + 2];
      if (SYNONYM_MAP[trigram]) phrases.push(trigram);
    }
  }
  return phrases;
}

// Max keywords per market. Keeps the keyword list focused and prevents the
// scoring denominator from being inflated by verbose description text.
const MAX_KEYWORDS = 20;

/**
 * Generates market keywords from title and optional description.
 *
 * Strategy:
 * 1. Extract unigrams from title (stop-word filtered) — no bigram noise
 * 2. Extract bigrams/trigrams from title ONLY if they are SYNONYM_MAP keys
 * 3. Apply SYNONYM_MAP forward expansion for all tokens found
 * 4. Extract unigrams from first 300 chars of description for extra context
 *    (company names, tickers, etc. not present in the title)
 * 5. Cap total at MAX_KEYWORDS, prioritising title-derived keywords
 * 6. Deduplicate and return
 */
export function generateKeywords(title: string, description?: string): string[] {
  const titleKeywords = new Set<string>();
  const descKeywords  = new Set<string>();

  // ── Title: unigrams ──────────────────────────────────────────────────────
  const titleUnigrams = extractUnigrams(title);
  for (const token of titleUnigrams) {
    titleKeywords.add(token);
    const syns = SYNONYM_MAP[token];
    if (syns) syns.forEach(s => titleKeywords.add(s));
  }

  // ── Title: known multi-word aliases (bigrams/trigrams in SYNONYM_MAP) ───
  for (const phrase of extractSynonymPhrases(title)) {
    titleKeywords.add(phrase);
    const syns = SYNONYM_MAP[phrase];
    if (syns) syns.forEach(s => titleKeywords.add(s));
  }

  // ── Description: unigrams from first 300 chars (supplementary only) ─────
  if (description) {
    const descUnigrams = extractUnigrams(description.slice(0, 300));
    for (const token of descUnigrams) {
      if (!titleKeywords.has(token)) {
        descKeywords.add(token);
        const syns = SYNONYM_MAP[token];
        if (syns) syns.forEach(s => descKeywords.add(s));
      }
    }
  }

  // Title keywords always included first; description fills up to the cap.
  const result = Array.from(titleKeywords);
  for (const k of descKeywords) {
    if (result.length >= MAX_KEYWORDS) break;
    result.push(k);
  }

  return result;
}
