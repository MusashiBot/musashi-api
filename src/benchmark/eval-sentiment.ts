/**
 * Benchmark Stage 2: Sentiment classification evaluation.
 *
 * Evaluates analyzeSentiment() on tweets the matcher accepted (real pipeline),
 * using human sentiment_label as ground truth.
 *
 * Metrics (from proposal):
 * - accuracy_score: signed confidence vs human label (neutral pred → 0;
 *   correct directional → +conf; wrong directional → -conf). Averaged.
 * - Macro-F1 across bullish / bearish / neutral
 * - Calibration: reliability bins + expected calibration error (ECE)
 *
 * Also writes model outputs to outputs/<model_version>.jsonl
 *
 * Usage:
 *   pnpm run eval:sentiment
 *   pnpm run eval:sentiment -- --include-low-confidence
 *   pnpm run eval:sentiment -- --model-version v1.0.0
 */

import fs from 'fs/promises';
import path from 'path';
import { analyzeSentiment, Sentiment } from '../analysis/sentiment-analyzer';
import {
  BenchmarkSplits,
  BenchmarkTweet,
  SentimentLabel,
  benchmarkDir,
  isLabeled,
  readJsonl,
  writeJsonl,
} from './schema';

const LABELS: SentimentLabel[] = ['bullish', 'bearish', 'neutral'];

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export interface SentimentOutputRow {
  tweet_id: string;
  model_version: string;
  predicted_label: Sentiment;
  confidence: number;
  run_at: string;
}

export interface SentimentEvalExample {
  tweet_id: string;
  market_id: string;
  human_label: SentimentLabel;
  predicted_label: Sentiment;
  confidence: number;
  accuracy_score: number;
  correct: boolean;
  is_relevant: 'yes' | 'no';
  label_confidence: string;
  split: 'train' | 'validation' | 'test' | 'unassigned';
}

export interface ClassScores {
  precision: number | null;
  recall: number | null;
  f1: number | null;
  support: number;
}

export interface ReliabilityBin {
  bin_start: number;
  bin_end: number;
  count: number;
  mean_confidence: number | null;
  empirical_accuracy: number | null;
}

export interface SentimentEvalMetrics {
  n: number;
  accuracy_score: number | null;
  hard_accuracy: number | null;
  macro_f1: number | null;
  per_class: Record<SentimentLabel, ClassScores>;
  expected_calibration_error: number | null;
  reliability_diagram: ReliabilityBin[];
}

/**
 * Proposal accuracy_score:
 * - model neutral → 0
 * - model matches human (directional) → +confidence
 * - model mismatches human (directional) → -confidence
 */
export function accuracyScore(
  human: SentimentLabel,
  predicted: Sentiment,
  confidence: number
): number {
  if (predicted === 'neutral') return 0;
  if (predicted === human) return confidence;
  return -confidence;
}

function ratio(num: number, den: number): number | null {
  if (den === 0) return null;
  return num / den;
}

export function computePerClassF1(
  examples: Array<{ human: SentimentLabel; predicted: Sentiment }>
): Record<SentimentLabel, ClassScores> {
  const result = {} as Record<SentimentLabel, ClassScores>;

  for (const label of LABELS) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let support = 0;

    for (const ex of examples) {
      if (ex.human === label) support++;
      if (ex.predicted === label && ex.human === label) tp++;
      if (ex.predicted === label && ex.human !== label) fp++;
      if (ex.human === label && ex.predicted !== label) fn++;
    }

    const precision = ratio(tp, tp + fp);
    const recall = ratio(tp, tp + fn);
    const f1 =
      precision == null || recall == null || precision + recall === 0
        ? null
        : (2 * precision * recall) / (precision + recall);

    result[label] = { precision, recall, f1, support };
  }

  return result;
}

export function macroF1(perClass: Record<SentimentLabel, ClassScores>): number | null {
  const f1s = LABELS.map(l => perClass[l].f1).filter((v): v is number => v != null);
  if (f1s.length === 0) return null;
  return f1s.reduce((a, b) => a + b, 0) / LABELS.length;
}

/** Equal-width confidence bins for a reliability diagram + ECE. */
export function computeCalibration(
  examples: Array<{ confidence: number; correct: boolean }>,
  numBins = 10
): { ece: number | null; bins: ReliabilityBin[] } {
  if (examples.length === 0) {
    return { ece: null, bins: [] };
  }

  const bins: ReliabilityBin[] = [];
  for (let i = 0; i < numBins; i++) {
    const binStart = i / numBins;
    const binEnd = (i + 1) / numBins;
    const inBin = examples.filter(e =>
      i === numBins - 1
        ? e.confidence >= binStart && e.confidence <= binEnd
        : e.confidence >= binStart && e.confidence < binEnd
    );

    if (inBin.length === 0) {
      bins.push({
        bin_start: binStart,
        bin_end: binEnd,
        count: 0,
        mean_confidence: null,
        empirical_accuracy: null,
      });
      continue;
    }

    const meanConf = inBin.reduce((s, e) => s + e.confidence, 0) / inBin.length;
    const empAcc = inBin.filter(e => e.correct).length / inBin.length;
    bins.push({
      bin_start: binStart,
      bin_end: binEnd,
      count: inBin.length,
      mean_confidence: meanConf,
      empirical_accuracy: empAcc,
    });
  }

  let ece = 0;
  for (const bin of bins) {
    if (bin.count === 0 || bin.mean_confidence == null || bin.empirical_accuracy == null) continue;
    ece += (bin.count / examples.length) * Math.abs(bin.empirical_accuracy - bin.mean_confidence);
  }

  return { ece, bins };
}

export function evaluateSentiment(examples: SentimentEvalExample[]): SentimentEvalMetrics {
  if (examples.length === 0) {
    return {
      n: 0,
      accuracy_score: null,
      hard_accuracy: null,
      macro_f1: null,
      per_class: computePerClassF1([]),
      expected_calibration_error: null,
      reliability_diagram: [],
    };
  }

  const accuracySum = examples.reduce((s, e) => s + e.accuracy_score, 0);
  const hardCorrect = examples.filter(e => e.correct).length;
  const perClass = computePerClassF1(
    examples.map(e => ({ human: e.human_label, predicted: e.predicted_label }))
  );
  const { ece, bins } = computeCalibration(
    examples.map(e => ({ confidence: e.confidence, correct: e.correct }))
  );

  return {
    n: examples.length,
    accuracy_score: accuracySum / examples.length,
    hard_accuracy: hardCorrect / examples.length,
    macro_f1: macroF1(perClass),
    per_class: perClass,
    expected_calibration_error: ece,
    reliability_diagram: bins,
  };
}

function splitForMarket(
  marketId: string,
  splits: BenchmarkSplits | null
): SentimentEvalExample['split'] {
  if (!splits) return 'unassigned';
  if (splits.train.includes(marketId)) return 'train';
  if (splits.validation.includes(marketId)) return 'validation';
  if (splits.test.includes(marketId)) return 'test';
  return 'unassigned';
}

function formatNum(v: number | null, digits = 3): string {
  if (v == null) return 'n/a';
  return v.toFixed(digits);
}

function formatPct(v: number | null): string {
  if (v == null) return 'n/a';
  return `${(v * 100).toFixed(1)}%`;
}

function printMetrics(label: string, metrics: SentimentEvalMetrics): void {
  console.log(`\n[${label}] n=${metrics.n}`);
  console.log(`  accuracy_score=${formatNum(metrics.accuracy_score)}`);
  console.log(`  hard_accuracy=${formatPct(metrics.hard_accuracy)}`);
  console.log(`  macro_f1=${formatNum(metrics.macro_f1)}`);
  console.log(`  ECE=${formatNum(metrics.expected_calibration_error)}`);
  for (const cls of LABELS) {
    const c = metrics.per_class[cls];
    console.log(
      `  ${cls}: f1=${formatNum(c.f1)}  P=${formatNum(c.precision)}  R=${formatNum(c.recall)}  support=${c.support}`
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const version = argValue(args, '--version') ?? process.env.BENCHMARK_VERSION ?? 'v1';
  const modelVersion =
    argValue(args, '--model-version') ?? process.env.BENCHMARK_MODEL_VERSION ?? 'v1.0.0';
  const includeLowConfidence = hasFlag(args, '--include-low-confidence');
  /** Optional: only evaluate human-relevant tweets (stricter than pipeline). */
  const relevantOnly = hasFlag(args, '--relevant-only');

  const dir = benchmarkDir(version);
  const tweets = await readJsonl<BenchmarkTweet>(path.join(dir, 'tweets.jsonl'));

  let splits: BenchmarkSplits | null = null;
  try {
    splits = JSON.parse(await fs.readFile(path.join(dir, 'splits.json'), 'utf8')) as BenchmarkSplits;
  } catch {
    console.warn('No splits.json found; reporting overall metrics only.');
  }

  const runAt = new Date().toISOString();
  const examples: SentimentEvalExample[] = [];
  const outputs: SentimentOutputRow[] = [];

  for (const tweet of tweets) {
    if (!isLabeled(tweet) || tweet.sentiment_label == null) continue;
    if (!includeLowConfidence && tweet.label_confidence === 'low') continue;
    // Stage 2 evaluates the real pipeline path: matcher-accepted tweets only
    if (tweet.matcher_result.status !== 'accepted') continue;
    if (relevantOnly && tweet.is_relevant !== 'yes') continue;

    const result = analyzeSentiment(tweet.text);
    const score = accuracyScore(tweet.sentiment_label, result.sentiment, result.confidence);
    const correct = result.sentiment === tweet.sentiment_label;

    examples.push({
      tweet_id: tweet.tweet_id,
      market_id: tweet.market_id,
      human_label: tweet.sentiment_label,
      predicted_label: result.sentiment,
      confidence: result.confidence,
      accuracy_score: score,
      correct,
      is_relevant: tweet.is_relevant ?? 'no',
      label_confidence: tweet.label_confidence ?? 'unknown',
      split: splitForMarket(tweet.market_id, splits),
    });

    outputs.push({
      tweet_id: tweet.tweet_id,
      model_version: modelVersion,
      predicted_label: result.sentiment,
      confidence: result.confidence,
      run_at: runAt,
    });
  }

  if (examples.length === 0) {
    throw new Error(
      'No matcher-accepted labeled tweets available for sentiment evaluation.'
    );
  }

  console.log(
    `Evaluating analyzeSentiment on ${examples.length} matcher-accepted tweet(s)` +
      ` (model_version=${modelVersion}` +
      `${relevantOnly ? ', relevant-only' : ''}` +
      `${includeLowConfidence ? ', include-low-confidence' : ''})`
  );

  const overall = evaluateSentiment(examples);
  printMetrics('overall', overall);

  const bySplit: Record<string, SentimentEvalMetrics> = {};
  for (const split of ['train', 'validation', 'test', 'unassigned'] as const) {
    const subset = examples.filter(e => e.split === split);
    if (subset.length === 0) continue;
    bySplit[split] = evaluateSentiment(subset);
    printMetrics(split, bySplit[split]);
  }

  const outputsDir = path.join(dir, 'outputs');
  await fs.mkdir(outputsDir, { recursive: true });
  const outputsPath = path.join(outputsDir, `${modelVersion}.jsonl`);
  await writeJsonl(outputsPath, outputs);

  const evalDir = path.join(dir, 'eval');
  await fs.mkdir(evalDir, { recursive: true });
  const reportPath = path.join(evalDir, 'sentiment_stage2.json');
  const report = {
    version,
    stage: 'sentiment',
    model_version: modelVersion,
    evaluated_at: runAt,
    pipeline_filter: 'matcher_accepted',
    include_low_confidence: includeLowConfidence,
    relevant_only: relevantOnly,
    overall,
    by_split: bySplit,
    examples,
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log(`\nWrote ${reportPath}`);
  console.log(`Wrote ${outputsPath} (${outputs.length} predictions)`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
