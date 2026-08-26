/** Shared benchmark dataset schema + JSONL helpers. */

import fs from 'fs/promises';
import path from 'path';

export interface BenchmarkMarket {
  market_id: string;
  source: 'kalshi' | 'polymarket';
  question: string;
  category: string;
  resolution: string;
  resolved_at: string;
  prob_30m: number | null;
  prob_1h: number | null;
  prob_2h: number | null;
  snapshot_fetched_at: string;
  raw_payload: unknown;
}

export interface MatcherResult {
  status: 'accepted' | 'rejected';
  score: number;
  assigned_market_id: string | null;
  assigned_category: string | null;
}

export type RelevanceLabel = 'yes' | 'no';
export type SentimentLabel = 'bullish' | 'bearish' | 'neutral';
export type ConfidenceLabel = 'high' | 'medium' | 'low';

export interface BenchmarkTweet {
  tweet_id: string;
  market_id: string;
  text: string;
  author_id: string;
  created_at: string;
  offset_minutes: 30 | 60 | 120;
  collection_query: string;
  matcher_result: MatcherResult;
  is_relevant: RelevanceLabel | null;
  sentiment_label: SentimentLabel | null;
  label_confidence: ConfidenceLabel | null;
  labeler_id: string | null;
}

export interface BenchmarkSplits {
  version: string;
  created_at: string;
  seed: number;
  ratios: { train: number; validation: number; test: number };
  stratified_by: 'category';
  train: string[];
  validation: string[];
  test: string[];
}

export function benchmarkDir(version: string): string {
  return path.join(__dirname, version);
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l) as T);
}

export async function writeJsonl(filePath: string, rows: object[]): Promise<void> {
  const body = rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  await fs.writeFile(filePath, body, 'utf8');
}

export function isLabeled(t: BenchmarkTweet): boolean {
  return (
    t.is_relevant != null &&
    t.sentiment_label != null &&
    t.label_confidence != null &&
    t.labeler_id != null
  );
}
