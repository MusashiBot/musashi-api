// Net-new BM25 market-similarity matcher, living under evals/ for comparison
// against the existing keyword-overlap `areMarketsSimilar`.
//
// IMPORTANT: this is intentionally a *separate* implementation, not a
// replacement for src/api/arbitrage-detector.ts. There is no BM25 matcher in
// src/ yet; when one lands, point the runner's import at it and delete this
// file. Both matchers are scored side by side over identical inputs.
//
// Structure mirrors the existing matcher (category gate -> title similarity ->
// keyword signal) but swaps the raw keyword-overlap count for an IDF-weighted
// BM25 similarity, so a single shared rare token can't drive a match on its own.

import { Market } from '../../src/types/market';

export interface SimResult {
  isSimilar: boolean;
  confidence: number;
  reason: string;
}

/** Pluggable matcher signature, identical to `areMarketsSimilar`. */
export type Matcher = (poly: Market, kalshi: Market) => SimResult;

const BM25_K1 = 1.5; // term-frequency saturation
const BM25_B = 0.75; // document-length normalization
const BM25_MATCH_THRESHOLD = 0.4; // symmetric BM25 similarity [0,1]
const TITLE_MATCH_THRESHOLD = 0.5; // Jaccard title similarity

export interface BM25Stats {
  idf: Map<string, number>;
  avgdl: number;
  N: number;
}

function termFreqs(keywords: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const k of keywords) {
    const t = k.toLowerCase();
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  return tf;
}

/**
 * Build corpus-level IDF over the candidate pool so rare terms (specific
 * company names, tickers) outweigh common ones (e.g. "election"). Computed once
 * per run and shared across all comparisons.
 */
export function buildBM25Stats(corpus: Market[]): BM25Stats {
  const N = corpus.length;
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const m of corpus) {
    totalLen += m.keywords.length;
    for (const t of new Set(m.keywords.map(k => k.toLowerCase()))) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [t, d] of df) {
    // BM25 idf with +1 smoothing to keep it non-negative.
    idf.set(t, Math.log(1 + (N - d + 0.5) / (d + 0.5)));
  }

  return { idf, avgdl: N > 0 ? totalLen / N : 0, N };
}

/** Asymmetric BM25: score a query document's terms against a target document. */
function bm25Score(
  queryTf: Map<string, number>,
  docTf: Map<string, number>,
  docLen: number,
  stats: BM25Stats
): number {
  let score = 0;
  for (const term of queryTf.keys()) {
    const f = docTf.get(term) ?? 0;
    if (f === 0) continue;
    const idf = stats.idf.get(term) ?? 0;
    const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (stats.avgdl > 0 ? docLen / stats.avgdl : 0));
    score += (idf * (f * (BM25_K1 + 1))) / denom;
  }
  return score;
}

/**
 * Symmetric similarity in [0,1]: score both directions, normalize each by the
 * query's self-score, then average. Self-normalization bounds the result and
 * makes it comparable across markets of different keyword-list lengths.
 */
export function bm25Similarity(a: Market, b: Market, stats: BM25Stats): number {
  const tfA = termFreqs(a.keywords);
  const tfB = termFreqs(b.keywords);

  const rawAB = bm25Score(tfA, tfB, b.keywords.length, stats);
  const selfA = bm25Score(tfA, tfA, a.keywords.length, stats);
  const rawBA = bm25Score(tfB, tfA, a.keywords.length, stats);
  const selfB = bm25Score(tfB, tfB, b.keywords.length, stats);

  const normAB = selfA > 0 ? rawAB / selfA : 0;
  const normBA = selfB > 0 ? rawBA / selfB : 0;

  return Math.max(0, Math.min(1, (normAB + normBA) / 2));
}

// ── Title similarity (self-contained; the src/ versions are not exported) ────

const TITLE_STOPS = new Set([
  'will', 'before', 'after', 'by', 'in', 'on', 'at', 'the', 'a', 'an',
  'hit', 'reach', 'win', 'lose', 'pass', 'than', 'over', 'under',
]);

function titleEntities(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/\?/g, '')
    .replace(/\b(2024|2025|2026|2027|2028)\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');

  const entities = new Set<string>();
  for (const w of words) {
    if (w.length >= 3 && !TITLE_STOPS.has(w)) entities.add(w);
  }
  return entities;
}

function titleSimilarity(a: string, b: string): number {
  const ea = titleEntities(a);
  const eb = titleEntities(b);
  if (ea.size === 0 || eb.size === 0) return 0;

  let shared = 0;
  for (const e of ea) if (eb.has(e)) shared++;

  const union = ea.size + eb.size - shared; // Jaccard
  return union > 0 ? shared / union : 0;
}

/**
 * Build a BM25-based matcher bound to a corpus. Same gate/signal shape as
 * `areMarketsSimilar`, with BM25 replacing the keyword-overlap count.
 */
export function makeBM25Matcher(corpus: Market[]): Matcher {
  const stats = buildBM25Stats(corpus);

  return (poly: Market, kalshi: Market): SimResult => {
    if (poly.category !== kalshi.category) {
      return { isSimilar: false, confidence: 0, reason: 'Different categories' };
    }

    const titleSim = titleSimilarity(poly.title, kalshi.title);
    if (titleSim > TITLE_MATCH_THRESHOLD) {
      return {
        isSimilar: true,
        confidence: titleSim,
        reason: `High title similarity (${(titleSim * 100).toFixed(0)}%)`,
      };
    }

    const bm = bm25Similarity(poly, kalshi, stats);
    if (bm > BM25_MATCH_THRESHOLD) {
      return {
        isSimilar: true,
        confidence: bm,
        reason: `BM25 similarity ${(bm * 100).toFixed(0)}%`,
      };
    }

    return { isSimilar: false, confidence: 0, reason: 'Insufficient similarity' };
  };
}
