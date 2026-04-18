// Generates market keywords from title + optional description.
// Contract-defining terms such as years, thresholds, and outcome verbs are
// intentionally preserved because they decide whether two markets are equivalent.

import { SYNONYM_MAP } from '../analysis/keyword-matcher';

const TITLE_STOPS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but',
  'in', 'on', 'at', 'by', 'for', 'to', 'of', 'from', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'has', 'have', 'had',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'will', 'would', 'could', 'should', 'may', 'might', 'can', 'must', 'shall',
  'what', 'when', 'where', 'who', 'why', 'how', 'whether',
  'any', 'all', 'each', 'every', 'other', 'another', 'such',
  'market', 'price', 'contract',
]);

const CONTRACT_WORDS = new Set([
  'yes', 'no', 'win', 'wins', 'lose', 'loses', 'reach', 'reaches', 'hit', 'hits',
  'pass', 'passes', 'over', 'under', 'above', 'below', 'before', 'after',
  'nominee', 'nomination', 'elected', 'election', 'hike', 'cut',
]);

const MAX_TITLE_KEYWORDS = 28;
const MAX_DESCRIPTION_KEYWORDS = 8;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[$,]/g, '')
    .replace(/[^a-z0-9.%\s'&-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract unigrams from a text string, preserving contract-critical words. */
function extractUnigrams(text: string): string[] {
  return normalize(text)
    .split(' ')
    .filter(word => {
      if (!word) return false;
      if (CONTRACT_WORDS.has(word)) return true;
      if (/\b20\d{2}\b/.test(word)) return true;
      if (/^\d+(?:\.\d+)?(?:k|m|b|%|percent|bps)?$/.test(word)) return true;
      return word.length > 2 && !TITLE_STOPS.has(word);
    });
}

/** Extract adjacent bigrams/trigrams so phrases like "rate cut" survive. */
function extractPhrases(text: string): string[] {
  const words = normalize(text).split(' ').filter(Boolean);
  const phrases: string[] = [];

  for (let i = 0; i < words.length - 1; i++) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    if (SYNONYM_MAP[bigram] || CONTRACT_WORDS.has(words[i]) || CONTRACT_WORDS.has(words[i + 1])) {
      phrases.push(bigram);
    }

    if (i < words.length - 2) {
      const trigram = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      if (SYNONYM_MAP[trigram]) phrases.push(trigram);
    }
  }

  return phrases;
}

function addWithSynonyms(target: Set<string>, token: string): void {
  target.add(token);
  const syns = SYNONYM_MAP[token];
  if (syns) syns.forEach(s => target.add(s));
}

/**
 * Generates market keywords from title and optional description.
 *
 * Title-derived terms are prioritized. Description terms are supplementary and
 * capped separately so low-signal prose cannot crowd out the contract itself.
 */
export function generateKeywords(title: string, description?: string): string[] {
  const titleKeywords = new Set<string>();
  const descKeywords = new Set<string>();

  for (const token of extractUnigrams(title)) addWithSynonyms(titleKeywords, token);
  for (const phrase of extractPhrases(title)) addWithSynonyms(titleKeywords, phrase);

  if (description) {
    for (const token of extractUnigrams(description.slice(0, 220))) {
      if (!titleKeywords.has(token)) addWithSynonyms(descKeywords, token);
    }
  }

  return [
    ...Array.from(titleKeywords).slice(0, MAX_TITLE_KEYWORDS),
    ...Array.from(descKeywords).slice(0, MAX_DESCRIPTION_KEYWORDS),
  ];
}
