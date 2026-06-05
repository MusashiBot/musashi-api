// Deterministic, fixture-only arbitrage matching eval.
//
// Loads evals/data/arbitrage/dev.jsonl, rebuilds Market objects (regenerating
// keywords via the REAL keyword-generator so every matcher sees identical,
// production-faithful inputs), runs each registered matcher over every pair,
// and reports precision / recall / F1 per matcher. `uncertain`-labeled pairs
// are excluded from scoring and reported separately.
//
// Matchers are pluggable: the keyword-overlap arm wraps the existing exported
// `areMarketsSimilar`; the BM25 arm is a net-new comparison implementation
// under evals/. Nothing in src/ is modified.
//
// Run from the repo root:
//   node --import tsx evals/runners/arbitrage.ts
//   node --import tsx evals/runners/arbitrage.ts --min-confidence=0.5 --data=evals/data/arbitrage/holdout/holdout.jsonl
//   node --import tsx evals/runners/arbitrage.ts --update-baselines   # refresh committed baselines
//   node --import tsx evals/runners/arbitrage.ts --check-baselines    # CI gate: exit 1 on regression
//
// Output: writes a timestamped JSON report (plus arbitrage-latest.json) to
// evals/results/ (gitignored) and prints a summary table to stdout. With
// --update-baselines / --check-baselines it also writes / compares per-matcher
// baseline snapshots in evals/baselines/ (committed, diff-friendly).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Market } from '../../src/types/market';
import { generateKeywords } from '../../src/api/keyword-generator';
import { areMarketsSimilar } from '../../src/api/arbitrage-detector';
import { makeBM25Matcher, Matcher, SimResult } from './bm25-matcher';

const EVALS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATA = path.join(EVALS_DIR, 'data/arbitrage/dev.jsonl');
const RESULTS_DIR = path.join(EVALS_DIR, 'results');
const BASELINES_DIR = path.join(EVALS_DIR, 'baselines');

// Metrics are rounded to this many decimals before being written to / compared
// against baselines, so committed snapshots have stable, diff-friendly values
// and the regression check is free of floating-point noise.
const METRIC_PRECISION = 6;
const round = (n: number) => Number(n.toFixed(METRIC_PRECISION));

type Label = 'match' | 'non_match' | 'uncertain';

interface MarketSide {
  platform: 'polymarket' | 'kalshi';
  market_id?: string;
  title: string;
  category: string;
  description: string | null;
  resolution_criteria: string;
  resolution_date: string;
  url: string;
}

interface Fixture {
  pair_id: string;
  polymarket: MarketSide;
  kalshi: MarketSide;
  label: Label;
  adjudication: unknown;
  tags?: string[];
  source?: unknown;
}

// ── Fixture loading ──────────────────────────────────────────────────────────

const REQUIRED_SIDE_FIELDS: (keyof MarketSide)[] = [
  'platform', 'title', 'category', 'description', 'resolution_criteria', 'resolution_date', 'url',
];

/** Parse JSONL with lightweight structural validation (schema.json covers the rest in CI). */
function loadFixtures(file: string): Fixture[] {
  const raw = fs.readFileSync(file, 'utf8');
  const fixtures: Fixture[] = [];

  raw.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let obj: Fixture;
    try {
      obj = JSON.parse(trimmed) as Fixture;
    } catch (e) {
      throw new Error(`${path.basename(file)} line ${i + 1}: invalid JSON — ${(e as Error).message}`);
    }

    if (!obj.pair_id) throw new Error(`${path.basename(file)} line ${i + 1}: missing pair_id`);
    if (!['match', 'non_match', 'uncertain'].includes(obj.label)) {
      throw new Error(`${obj.pair_id}: invalid label "${obj.label}"`);
    }
    for (const [side, expected] of [['polymarket', 'polymarket'], ['kalshi', 'kalshi']] as const) {
      const s = obj[side];
      if (!s) throw new Error(`${obj.pair_id}: missing ${side}`);
      if (s.platform !== expected) throw new Error(`${obj.pair_id}: ${side}.platform must be "${expected}"`);
      for (const f of REQUIRED_SIDE_FIELDS) {
        if (!(f in s)) throw new Error(`${obj.pair_id}: ${side} missing "${f}"`);
      }
    }
    fixtures.push(obj);
  });

  return fixtures;
}

/** Rebuild a runtime Market from a fixture side. Prices/volume are irrelevant
 *  to matching, so they are placeholders; keywords come from the real generator. */
function toMarket(side: MarketSide, pairId: string): Market {
  return {
    id: side.market_id ?? `${side.platform}-${pairId}`,
    platform: side.platform,
    title: side.title,
    description: side.description ?? '',
    keywords: generateKeywords(side.title, side.description ?? undefined),
    yesPrice: 0.5,
    noPrice: 0.5,
    volume24h: 0,
    url: side.url,
    category: side.category,
    lastUpdated: new Date().toISOString(),
    endDate: side.resolution_date,
  };
}

// ── Metrics ──────────────────────────────────────────────────────────────────

interface Counts { tp: number; fp: number; fn: number; tn: number; }

interface Prediction {
  pair_id: string;
  label: Label;
  predicted_match: boolean;
  confidence: number;
  reason: string;
  correct: boolean | null; // null for uncertain (not scored)
}

interface MatcherReport {
  counts: Counts;
  precision: number;
  recall: number;
  f1: number;
  uncertain_predicted_match: number;
  predictions: Prediction[];
}

function score(counts: Counts) {
  const { tp, fp, fn } = counts;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

function evaluate(
  matcher: Matcher,
  pairs: { fixture: Fixture; poly: Market; kalshi: Market }[],
  minConfidence: number
): MatcherReport {
  const counts: Counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
  let uncertainPredictedMatch = 0;
  const predictions: Prediction[] = [];

  for (const { fixture, poly, kalshi } of pairs) {
    const result: SimResult = matcher(poly, kalshi);
    const predictedMatch = result.isSimilar && result.confidence >= minConfidence;

    let correct: boolean | null;
    if (fixture.label === 'uncertain') {
      correct = null;
      if (predictedMatch) uncertainPredictedMatch++;
    } else {
      const actualMatch = fixture.label === 'match';
      if (actualMatch && predictedMatch) counts.tp++;
      else if (!actualMatch && predictedMatch) counts.fp++;
      else if (actualMatch && !predictedMatch) counts.fn++;
      else counts.tn++;
      correct = actualMatch === predictedMatch;
    }

    predictions.push({
      pair_id: fixture.pair_id,
      label: fixture.label,
      predicted_match: predictedMatch,
      confidence: Number(result.confidence.toFixed(4)),
      reason: result.reason,
      correct,
    });
  }

  return { counts, ...score(counts), uncertain_predicted_match: uncertainPredictedMatch, predictions };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  let data = DEFAULT_DATA;
  // Default 0: use each matcher's own isSimilar verdict. Raise to sweep the
  // confidence threshold (e.g. getTopArbitrage's 0.5 floor).
  let minConfidence = Number(process.env.EVAL_MIN_CONFIDENCE ?? 0);
  let updateBaselines = false;
  let checkBaselines = false;

  for (const arg of argv) {
    if (arg.startsWith('--data=')) data = path.resolve(arg.slice('--data='.length));
    else if (arg.startsWith('--min-confidence=')) minConfidence = Number(arg.slice('--min-confidence='.length));
    else if (arg === '--update-baselines') updateBaselines = true;
    else if (arg === '--check-baselines') checkBaselines = true;
  }
  if (!Number.isFinite(minConfidence)) throw new Error('min-confidence must be a number');
  if (updateBaselines && checkBaselines) throw new Error('--update-baselines and --check-baselines are mutually exclusive');
  return { data, minConfidence, updateBaselines, checkBaselines };
}

// ── Reporting ──────────────────────────────────────────────────────────────────

function pct(n: number): string {
  return (n * 100).toFixed(1).padStart(5) + '%';
}

function printSummary(reports: Record<string, MatcherReport>, scored: number, uncertain: number, minConfidence: number) {
  console.log(`\nArbitrage matching eval — ${scored} scored pair(s), ${uncertain} uncertain (excluded), minConfidence=${minConfidence}\n`);
  const header = 'matcher'.padEnd(18) + 'precision  recall      F1   TP  FP  FN  TN  unc→match';
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const [name, r] of Object.entries(reports)) {
    const c = r.counts;
    console.log(
      name.padEnd(18) +
      pct(r.precision) + '  ' + pct(r.recall) + '  ' + pct(r.f1) + '  ' +
      String(c.tp).padStart(2) + '  ' + String(c.fp).padStart(2) + '  ' +
      String(c.fn).padStart(2) + '  ' + String(c.tn).padStart(2) + '  ' +
      String(r.uncertain_predicted_match).padStart(9)
    );
  }
  console.log('');
}

// ── Baselines ────────────────────────────────────────────────────────────────

interface Baseline {
  matcher: string;
  dataset: string;
  split: string;
  min_confidence: number;
  metrics: { precision: number; recall: number; f1: number };
  counts: Counts;
}

/** Split token derived from the dataset filename, e.g. dev.jsonl -> "dev". */
function splitName(dataPath: string): string {
  return path.basename(dataPath).replace(/\.jsonl$/, '');
}

function baselinePath(split: string, matcher: string): string {
  return path.join(BASELINES_DIR, `arbitrage.${split}.${matcher}.json`);
}

function toBaseline(matcher: string, split: string, minConfidence: number, r: MatcherReport): Baseline {
  return {
    matcher,
    dataset: `evals/data/arbitrage/${split}.jsonl`,
    split,
    min_confidence: minConfidence,
    metrics: { precision: round(r.precision), recall: round(r.recall), f1: round(r.f1) },
    counts: r.counts,
  };
}

function writeBaselines(reports: Record<string, MatcherReport>, split: string, minConfidence: number) {
  fs.mkdirSync(BASELINES_DIR, { recursive: true });
  for (const [name, r] of Object.entries(reports)) {
    const file = baselinePath(split, name);
    fs.writeFileSync(file, JSON.stringify(toBaseline(name, split, minConfidence, r), null, 2) + '\n');
    console.log(`Wrote baseline: ${path.relative(process.cwd(), file)}`);
  }
}

/**
 * Compare current metrics against committed baselines. Returns true if all
 * matchers held or improved; false (with details printed) on any regression or
 * missing baseline. A metric regresses if its rounded value drops below the
 * rounded baseline value.
 */
function checkBaselines(reports: Record<string, MatcherReport>, split: string): boolean {
  let ok = true;
  let improved = false;

  for (const [name, r] of Object.entries(reports)) {
    const file = baselinePath(split, name);
    if (!fs.existsSync(file)) {
      console.error(`✗ ${name}: no baseline at ${path.relative(process.cwd(), file)} — run with --update-baselines`);
      ok = false;
      continue;
    }
    const base = JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline;
    const current = { precision: round(r.precision), recall: round(r.recall), f1: round(r.f1) };

    for (const metric of ['precision', 'recall', 'f1'] as const) {
      const cur = current[metric];
      const expected = round(base.metrics[metric]);
      if (cur < expected) {
        console.error(`✗ ${name}: ${metric} regressed ${expected} -> ${cur}`);
        ok = false;
      } else if (cur > expected) {
        console.log(`↑ ${name}: ${metric} improved ${expected} -> ${cur}`);
        improved = true;
      }
    }
  }

  if (ok && improved) {
    console.log('\nMetrics improved above baseline. Refresh with --update-baselines to lock in the gains.');
  }
  return ok;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const { data, minConfidence, updateBaselines, checkBaselines: checkMode } = parseArgs(process.argv.slice(2));

  const fixtures = loadFixtures(data);
  const pairs = fixtures.map(fixture => ({
    fixture,
    poly: toMarket(fixture.polymarket, fixture.pair_id),
    kalshi: toMarket(fixture.kalshi, fixture.pair_id),
  }));

  // BM25 needs corpus-level IDF; build it over every market in the dataset.
  const corpus: Market[] = pairs.flatMap(p => [p.poly, p.kalshi]);

  const matchers: Record<string, Matcher> = {
    'keyword-overlap': areMarketsSimilar,
    'bm25': makeBM25Matcher(corpus),
  };

  const reports: Record<string, MatcherReport> = {};
  for (const [name, fn] of Object.entries(matchers)) {
    reports[name] = evaluate(fn, pairs, minConfidence);
  }

  const scored = fixtures.filter(f => f.label !== 'uncertain').length;
  const uncertain = fixtures.length - scored;

  const report = {
    generated_at: new Date().toISOString(),
    dataset: path.relative(process.cwd(), data),
    fixture_count: fixtures.length,
    scored_count: scored,
    uncertain_count: uncertain,
    min_confidence: minConfidence,
    matchers: reports,
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = report.generated_at.replace(/[:.]/g, '-');
  const outFile = path.join(RESULTS_DIR, `arbitrage-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(RESULTS_DIR, 'arbitrage-latest.json'), JSON.stringify(report, null, 2));

  printSummary(reports, scored, uncertain, minConfidence);
  console.log(`Full report: ${path.relative(process.cwd(), outFile)}\n`);

  const split = splitName(data);
  if (updateBaselines) {
    writeBaselines(reports, split, minConfidence);
    return;
  }
  if (checkMode) {
    if (!checkBaselines(reports, split)) {
      console.error(`\nFAIL: ${split} matchers regressed against committed baselines.`);
      process.exit(1);
    }
    console.log(`\nPASS: ${split} matchers held against committed baselines.`);
  }
}

main();
