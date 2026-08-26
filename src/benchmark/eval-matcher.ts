/**
 * Benchmark Stage 1: Keyword matcher evaluation.
 *
 * Metrics (from proposal):
 * - Recall: of human-relevant tweets, what fraction did match() assign to the
 *   correct category?
 * - Category accuracy: of tweets match() accepted, what fraction were assigned
 *   the correct category?
 *
 * Ground truth category for a tweet is the paired market's category when
 * is_relevant=yes. Irrelevant tweets that the matcher accepts count as
 * incorrect category assignments.
 *
 * Usage:
 *   pnpm run eval:matcher
 *   pnpm run eval:matcher -- --include-low-confidence
 *   pnpm run eval:matcher -- --rerun
 */

import fs from 'fs/promises';
import path from 'path';
import { generateKeywords } from '../api/keyword-generator';
import { KeywordMatcher } from '../analysis/keyword-matcher';
import { Market } from '../types/market';
import {
  BenchmarkMarket,
  BenchmarkSplits,
  BenchmarkTweet,
  MatcherResult,
  benchmarkDir,
  isLabeled,
  readJsonl,
} from './schema';

const MATCHER_MIN_CONFIDENCE = 0.2;

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function toMatcherMarket(row: BenchmarkMarket): Market {
  return {
    id: row.market_id,
    platform: row.source,
    title: row.question,
    description: '',
    keywords: generateKeywords(row.question),
    yesPrice: 0.5,
    noPrice: 0.5,
    volume24h: 0,
    url: '',
    category: row.category,
    lastUpdated: row.snapshot_fetched_at,
  };
}

function recordMatcherResult(tweetText: string, matcher: KeywordMatcher): MatcherResult {
  const matches = matcher.match(tweetText);
  const top = matches[0];
  if (!top || top.confidence < MATCHER_MIN_CONFIDENCE) {
    return {
      status: 'rejected',
      score: top?.confidence ?? 0,
      assigned_market_id: null,
      assigned_category: null,
    };
  }
  return {
    status: 'accepted',
    score: top.confidence,
    assigned_market_id: top.market.id,
    assigned_category: top.market.category,
  };
}

export interface MatcherEvalCounts {
  labeled_tweets: number;
  relevant_tweets: number;
  matcher_accepted: number;
  /** Relevant + matcher accepted with matching category. */
  recall_hits: number;
  /** Relevant + matcher accepted with exact market_id. */
  exact_market_hits: number;
  /** Matcher accepted + relevant + category matches paired market. */
  category_correct: number;
  false_negatives: number;
  false_positives: number;
}

export interface MatcherEvalMetrics {
  recall: number | null;
  category_accuracy: number | null;
  exact_market_recall: number | null;
  counts: MatcherEvalCounts;
}

export interface TweetEvalRow {
  tweet_id: string;
  market_id: string;
  market_category: string;
  is_relevant: 'yes' | 'no';
  label_confidence: string;
  matcher_status: 'accepted' | 'rejected';
  assigned_market_id: string | null;
  assigned_category: string | null;
  category_match: boolean;
  exact_market_match: boolean;
  split: 'train' | 'validation' | 'test' | 'unassigned';
}

function emptyCounts(): MatcherEvalCounts {
  return {
    labeled_tweets: 0,
    relevant_tweets: 0,
    matcher_accepted: 0,
    recall_hits: 0,
    exact_market_hits: 0,
    category_correct: 0,
    false_negatives: 0,
    false_positives: 0,
  };
}

function ratio(num: number, den: number): number | null {
  if (den === 0) return null;
  return num / den;
}

export function evaluateMatcherRows(rows: TweetEvalRow[]): MatcherEvalMetrics {
  const counts = emptyCounts();

  for (const row of rows) {
    counts.labeled_tweets++;
    const relevant = row.is_relevant === 'yes';
    const accepted = row.matcher_status === 'accepted';

    if (relevant) counts.relevant_tweets++;
    if (accepted) counts.matcher_accepted++;

    if (relevant && accepted && row.category_match) counts.recall_hits++;
    if (relevant && accepted && row.exact_market_match) counts.exact_market_hits++;
    if (accepted && relevant && row.category_match) counts.category_correct++;

    if (relevant && !accepted) counts.false_negatives++;
    if (!relevant && accepted) counts.false_positives++;
  }

  return {
    recall: ratio(counts.recall_hits, counts.relevant_tweets),
    // Category accuracy: among matcher-accepted tweets, fraction correctly categorized.
    // Correct = human-relevant AND assigned category matches paired market category.
    category_accuracy: ratio(counts.category_correct, counts.matcher_accepted),
    exact_market_recall: ratio(counts.exact_market_hits, counts.relevant_tweets),
    counts,
  };
}

function splitForMarket(
  marketId: string,
  splits: BenchmarkSplits | null
): TweetEvalRow['split'] {
  if (!splits) return 'unassigned';
  if (splits.train.includes(marketId)) return 'train';
  if (splits.validation.includes(marketId)) return 'validation';
  if (splits.test.includes(marketId)) return 'test';
  return 'unassigned';
}

export function buildEvalRows(
  tweets: BenchmarkTweet[],
  marketsById: Map<string, BenchmarkMarket>,
  splits: BenchmarkSplits | null,
  opts: { includeLowConfidence: boolean; matcherOverride?: Map<string, MatcherResult> }
): TweetEvalRow[] {
  const rows: TweetEvalRow[] = [];

  for (const tweet of tweets) {
    if (!isLabeled(tweet) || tweet.is_relevant == null) continue;
    if (!opts.includeLowConfidence && tweet.label_confidence === 'low') continue;

    const market = marketsById.get(tweet.market_id);
    if (!market) continue;

    const key = `${tweet.tweet_id}::${tweet.market_id}`;
    const matcher = opts.matcherOverride?.get(key) ?? tweet.matcher_result;
    const categoryMatch =
      matcher.status === 'accepted' &&
      matcher.assigned_category != null &&
      matcher.assigned_category === market.category;
    const exactMarketMatch =
      matcher.status === 'accepted' && matcher.assigned_market_id === tweet.market_id;

    rows.push({
      tweet_id: tweet.tweet_id,
      market_id: tweet.market_id,
      market_category: market.category,
      is_relevant: tweet.is_relevant,
      label_confidence: tweet.label_confidence ?? 'unknown',
      matcher_status: matcher.status,
      assigned_market_id: matcher.assigned_market_id,
      assigned_category: matcher.assigned_category,
      category_match: categoryMatch,
      exact_market_match: exactMarketMatch,
      split: splitForMarket(tweet.market_id, splits),
    });
  }

  return rows;
}

function formatPct(v: number | null): string {
  if (v == null) return 'n/a';
  return `${(v * 100).toFixed(1)}%`;
}

function printMetrics(label: string, metrics: MatcherEvalMetrics): void {
  const c = metrics.counts;
  console.log(`\n[${label}]`);
  console.log(`  labeled=${c.labeled_tweets}  relevant=${c.relevant_tweets}  matcher_accepted=${c.matcher_accepted}`);
  console.log(`  recall=${formatPct(metrics.recall)}  (${c.recall_hits}/${c.relevant_tweets})`);
  console.log(`  exact_market_recall=${formatPct(metrics.exact_market_recall)}  (${c.exact_market_hits}/${c.relevant_tweets})`);
  console.log(`  category_accuracy=${formatPct(metrics.category_accuracy)}  (${c.category_correct}/${c.matcher_accepted})`);
  console.log(`  false_negatives=${c.false_negatives}  false_positives=${c.false_positives}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const version = argValue(args, '--version') ?? process.env.BENCHMARK_VERSION ?? 'v1';
  const includeLowConfidence = hasFlag(args, '--include-low-confidence');
  const rerun = hasFlag(args, '--rerun');

  const dir = benchmarkDir(version);
  const markets = await readJsonl<BenchmarkMarket>(path.join(dir, 'markets.jsonl'));
  const tweets = await readJsonl<BenchmarkTweet>(path.join(dir, 'tweets.jsonl'));
  const marketsById = new Map(markets.map(m => [m.market_id, m]));

  let splits: BenchmarkSplits | null = null;
  try {
    splits = JSON.parse(await fs.readFile(path.join(dir, 'splits.json'), 'utf8')) as BenchmarkSplits;
  } catch {
    console.warn('No splits.json found; reporting overall metrics only.');
  }

  let matcherOverride: Map<string, MatcherResult> | undefined;
  if (rerun) {
    const matcher = new KeywordMatcher(markets.map(toMatcherMarket), MATCHER_MIN_CONFIDENCE);
    matcherOverride = new Map();
    for (const tweet of tweets) {
      matcherOverride.set(
        `${tweet.tweet_id}::${tweet.market_id}`,
        recordMatcherResult(tweet.text, matcher)
      );
    }
    console.log('Re-ran KeywordMatcher.match() on all tweets.');
  } else {
    console.log('Using frozen matcher_result from collection.');
  }

  const rows = buildEvalRows(tweets, marketsById, splits, {
    includeLowConfidence,
    matcherOverride,
  });

  if (rows.length === 0) {
    throw new Error('No labeled tweets available for evaluation.');
  }

  const overall = evaluateMatcherRows(rows);
  printMetrics('overall', overall);

  const bySplit: Record<string, MatcherEvalMetrics> = {};
  for (const split of ['train', 'validation', 'test', 'unassigned'] as const) {
    const subset = rows.filter(r => r.split === split);
    if (subset.length === 0) continue;
    bySplit[split] = evaluateMatcherRows(subset);
    printMetrics(split, bySplit[split]);
  }

  // Diagnostic: relevant tweets the matcher missed
  const missed = rows.filter(r => r.is_relevant === 'yes' && r.matcher_status === 'rejected');
  const falsePos = rows.filter(r => r.is_relevant === 'no' && r.matcher_status === 'accepted');

  const report = {
    version,
    stage: 'matcher',
    evaluated_at: new Date().toISOString(),
    source: rerun ? 'rerun_match' : 'frozen_matcher_result',
    include_low_confidence: includeLowConfidence,
    overall,
    by_split: bySplit,
    false_negatives: missed.map(r => ({
      tweet_id: r.tweet_id,
      market_id: r.market_id,
      market_category: r.market_category,
    })),
    false_positives: falsePos.map(r => ({
      tweet_id: r.tweet_id,
      market_id: r.market_id,
      assigned_market_id: r.assigned_market_id,
      assigned_category: r.assigned_category,
    })),
  };

  const outDir = path.join(dir, 'eval');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'matcher_stage1.json');
  await fs.writeFile(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\nWrote ${outPath}`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
