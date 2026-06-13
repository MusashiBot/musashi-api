/**
 * Eval harness for the matcher.
 *
 * Runs a matcher against the frozen markets snapshot + labeled tweet dataset,
 * computes precision / recall / F1 (overall + per category), prints a table.
 *
 * Usage:
 *   pnpm tsx scripts/eval-matcher.ts
 *     → default run: KeywordMatcher at class-default threshold, top-5
 *
 *   pnpm tsx scripts/eval-matcher.ts --matcher=embedding
 *     → run the Gemini-based EmbeddingMatcher (needs GEMINI_API_KEY)
 *
 *   pnpm tsx scripts/eval-matcher.ts --matcher=compare
 *     → run both matchers and print a side-by-side table
 *
 *   pnpm tsx scripts/eval-matcher.ts --sweep-threshold
 *     → sweep threshold values for the active matcher
 *
 *   pnpm tsx scripts/eval-matcher.ts --category=synthetic_promo
 *     → only evaluates entries in that category
 *
 *   pnpm tsx scripts/eval-matcher.ts --json
 *     → outputs JSON (for diffing across runs)
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { KeywordMatcher, DEFAULT_MIN_CONFIDENCE } from '../src/analysis/keyword-matcher';
import { EmbeddingMatcher, DEFAULT_MIN_SIMILARITY as EMBEDDING_DEFAULT } from '../src/analysis/embedding-matcher';
import type { Market, MarketMatch } from '../src/types/market';

// ─── Env loader ────────────────────────────────────────────────────────────

function loadEnvFile(fileName: string): void {
  const filePath = resolve(process.cwd(), fileName);
  if (!existsSync(filePath)) return;
  const contents = readFileSync(filePath, 'utf8');
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf('=');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile('.env.local');
loadEnvFile('.env');

// ─── Types ─────────────────────────────────────────────────────────────────

interface DatasetEntry {
  id: string;
  tweet: string;
  expected_market_ids: string[];
  category: string;
  notes?: string;
}

interface SnapshotFile {
  generated_at: string;
  count: number;
  markets: Market[];
}

interface EvalResult {
  entryId: string;
  category: string;
  expected: string[];
  predicted: string[];
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  firstCorrectRank: number | null; // for MRR; null if no correct match found
}

interface AggregatedMetrics {
  count: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  mrr: number;
}

type MatcherKind = 'keyword' | 'embedding';

interface RunOptions {
  matcher: MatcherKind | 'compare';
  threshold: number; // keyword min confidence
  minSimilarity: number; // embedding min cosine similarity
  topK: number;
  categoryFilter?: string;
  jsonOutput: boolean;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const FIXTURES_DIR = resolve(process.cwd(), 'scripts', 'eval-fixtures');
// Fix C: eval mirrors the production class default so the table reflects
// real-world behavior. Override via --threshold=N.
const DEFAULT_THRESHOLD = DEFAULT_MIN_CONFIDENCE;
const DEFAULT_MIN_SIMILARITY = EMBEDDING_DEFAULT;
const DEFAULT_TOP_K = 5;
const KEYWORD_THRESHOLD_SWEEP = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
const EMBEDDING_SIMILARITY_SWEEP = [0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];

// ─── Fixture loading ───────────────────────────────────────────────────────

function findLatestFile(prefix: string, ext: string): string {
  const candidates = readdirSync(FIXTURES_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
    .sort()
    .reverse();
  if (candidates.length === 0) {
    throw new Error(`No file matching ${prefix}*${ext} in ${FIXTURES_DIR}`);
  }
  return resolve(FIXTURES_DIR, candidates[0]);
}

function loadSnapshot(): Market[] {
  const path = findLatestFile('markets-snapshot-', '.json');
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as SnapshotFile;
  if (!Array.isArray(parsed.markets)) {
    throw new Error(`Snapshot at ${path} has no 'markets' array`);
  }
  console.log(`[eval] Loaded snapshot: ${parsed.markets.length} markets from ${path}`);
  return parsed.markets;
}

function loadDataset(): DatasetEntry[] {
  const path = findLatestFile('dataset-', '.jsonl');
  const raw = readFileSync(path, 'utf-8').trim();
  const entries: DatasetEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as DatasetEntry;
    entries.push(o);
  }
  console.log(`[eval] Loaded dataset: ${entries.length} entries from ${path}`);
  return entries;
}

// ─── Per-entry evaluation ──────────────────────────────────────────────────

function evaluateEntry(entry: DatasetEntry, matches: MarketMatch[]): EvalResult {
  const expected = new Set(entry.expected_market_ids);
  const predicted = matches.map((m) => m.market.id);
  const predictedSet = new Set(predicted);

  let truePositives = 0;
  for (const id of expected) {
    if (predictedSet.has(id)) truePositives++;
  }
  const falsePositives = predicted.filter((id) => !expected.has(id)).length;
  const falseNegatives = entry.expected_market_ids.filter((id) => !predictedSet.has(id)).length;

  // First correct rank for MRR (1-indexed). Only meaningful when expected is non-empty.
  let firstCorrectRank: number | null = null;
  if (expected.size > 0) {
    for (let i = 0; i < predicted.length; i++) {
      if (expected.has(predicted[i])) {
        firstCorrectRank = i + 1;
        break;
      }
    }
  }

  return {
    entryId: entry.id,
    category: entry.category,
    expected: entry.expected_market_ids,
    predicted,
    truePositives,
    falsePositives,
    falseNegatives,
    firstCorrectRank,
  };
}

// ─── Aggregation ───────────────────────────────────────────────────────────

function aggregate(results: EvalResult[]): AggregatedMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let mrrSum = 0;
  let mrrCount = 0;

  for (const r of results) {
    tp += r.truePositives;
    fp += r.falsePositives;
    fn += r.falseNegatives;
    if (r.expected.length > 0) {
      mrrCount++;
      if (r.firstCorrectRank !== null) {
        mrrSum += 1 / r.firstCorrectRank;
      }
    }
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const mrr = mrrCount > 0 ? mrrSum / mrrCount : 0;

  return {
    count: results.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision,
    recall,
    f1,
    mrr,
  };
}

function aggregateByCategory(results: EvalResult[]): Map<string, AggregatedMetrics> {
  const byCategory = new Map<string, EvalResult[]>();
  for (const r of results) {
    const arr = byCategory.get(r.category) ?? [];
    arr.push(r);
    byCategory.set(r.category, arr);
  }
  const metricsByCategory = new Map<string, AggregatedMetrics>();
  for (const [cat, arr] of byCategory) {
    metricsByCategory.set(cat, aggregate(arr));
  }
  return metricsByCategory;
}

// ─── Printing ──────────────────────────────────────────────────────────────

function fmt(n: number, digits = 3): string {
  return n.toFixed(digits);
}

function padCol(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (s.length >= width) return s;
  const pad = ' '.repeat(width - s.length);
  return align === 'left' ? s + pad : pad + s;
}

function printMetricsTable(
  label: string,
  overall: AggregatedMetrics,
  perCategory: Map<string, AggregatedMetrics>,
): void {
  console.log('');
  console.log('═'.repeat(86));
  console.log(`  ${label}`);
  console.log('═'.repeat(86));
  console.log(
    `  ${padCol('Category', 22)}  ${padCol('N', 4, 'right')}  ${padCol('Prec', 6, 'right')}  ${padCol('Recall', 6, 'right')}  ${padCol('F1', 6, 'right')}  ${padCol('MRR', 6, 'right')}  ${padCol('TP/FP/FN', 12, 'right')}`,
  );
  console.log('  ' + '─'.repeat(82));

  // Sort categories: synthetic first (target test categories), then real
  const cats = Array.from(perCategory.keys()).sort((a, b) => {
    const aSyn = a.startsWith('synthetic_');
    const bSyn = b.startsWith('synthetic_');
    if (aSyn && !bSyn) return -1;
    if (!aSyn && bSyn) return 1;
    return a.localeCompare(b);
  });

  for (const cat of cats) {
    const m = perCategory.get(cat)!;
    console.log(
      `  ${padCol(cat, 22)}  ${padCol(String(m.count), 4, 'right')}  ${padCol(fmt(m.precision, 3), 6, 'right')}  ${padCol(fmt(m.recall, 3), 6, 'right')}  ${padCol(fmt(m.f1, 3), 6, 'right')}  ${padCol(fmt(m.mrr, 3), 6, 'right')}  ${padCol(`${m.truePositives}/${m.falsePositives}/${m.falseNegatives}`, 12, 'right')}`,
    );
  }

  console.log('  ' + '─'.repeat(82));
  console.log(
    `  ${padCol('OVERALL', 22)}  ${padCol(String(overall.count), 4, 'right')}  ${padCol(fmt(overall.precision, 3), 6, 'right')}  ${padCol(fmt(overall.recall, 3), 6, 'right')}  ${padCol(fmt(overall.f1, 3), 6, 'right')}  ${padCol(fmt(overall.mrr, 3), 6, 'right')}  ${padCol(`${overall.truePositives}/${overall.falsePositives}/${overall.falseNegatives}`, 12, 'right')}`,
  );
  console.log('═'.repeat(86));
}

// ─── Matcher factory ───────────────────────────────────────────────────────

function buildEmbeddingMatcher(
  markets: Market[],
  minSimilarity: number,
  topK: number,
): EmbeddingMatcher {
  const cachePath = resolve(FIXTURES_DIR, findLatestFileName('markets-embeddings-', '.json'));

  // Reuse the most recent tweet cache so re-runs across days don't burn API
  // quota. Falls back to today's date if no cache file exists yet.
  let tweetCachePath: string;
  try {
    tweetCachePath = resolve(FIXTURES_DIR, findLatestFileName('tweets-embeddings-', '.json'));
  } catch {
    const today = new Date().toISOString().slice(0, 10);
    tweetCachePath = resolve(FIXTURES_DIR, `tweets-embeddings-${today}.json`);
  }

  return new EmbeddingMatcher({
    markets,
    marketEmbeddingsCachePath: cachePath,
    tweetCachePath,
    minSimilarity,
    maxResults: topK,
  });
}

function findLatestFileName(prefix: string, ext: string): string {
  const candidates = readdirSync(FIXTURES_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
    .sort()
    .reverse();
  if (candidates.length === 0) {
    throw new Error(`No file matching ${prefix}*${ext} in ${FIXTURES_DIR}`);
  }
  return candidates[0];
}

// Unified async match — works for either matcher.
type MatchFn = (tweet: string) => Promise<MarketMatch[]>;

async function evalAllEntries(
  filtered: DatasetEntry[],
  matchFn: MatchFn,
  progressLabel?: string,
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i];
    const matches = await matchFn(entry.tweet);
    results.push(evaluateEntry(entry, matches));
    if (progressLabel && (i + 1) % 25 === 0) {
      console.log(`[eval] ${progressLabel}: ${i + 1}/${filtered.length}`);
    }
  }
  return results;
}

// ─── Run modes ─────────────────────────────────────────────────────────────

async function runOnce(
  markets: Market[],
  dataset: DatasetEntry[],
  opts: RunOptions,
): Promise<void> {
  const filtered = opts.categoryFilter
    ? dataset.filter((d) => d.category === opts.categoryFilter)
    : dataset;

  if (filtered.length === 0) {
    console.error(`[eval] No dataset entries match filter category=${opts.categoryFilter}`);
    process.exit(1);
  }

  const kind: MatcherKind = opts.matcher === 'compare' ? 'keyword' : opts.matcher;

  let label: string;
  let results: EvalResult[];

  if (kind === 'embedding') {
    const matcher = buildEmbeddingMatcher(markets, opts.minSimilarity, opts.topK);
    label = `EmbeddingMatcher (Gemini)  |  minSimilarity=${opts.minSimilarity}  |  topK=${opts.topK}  |  N=${filtered.length}`;
    results = await evalAllEntries(filtered, (t) => matcher.match(t), 'embedding');
    matcher.flushCache();
    const s = matcher.stats();
    console.log(`[eval] Tweet cache now holds ${s.cachedTweets} entries (${s.modelName}, ${s.dimensions}-dim).`);
  } else {
    const matcher = new KeywordMatcher(markets, opts.threshold, opts.topK);
    label = `KeywordMatcher  |  threshold=${opts.threshold}  |  topK=${opts.topK}  |  N=${filtered.length}`;
    results = await evalAllEntries(filtered, async (t) => matcher.match(t));
  }

  const overall = aggregate(results);
  const perCategory = aggregateByCategory(results);

  if (opts.jsonOutput) {
    console.log(
      JSON.stringify(
        {
          matcher: kind,
          threshold: kind === 'keyword' ? opts.threshold : opts.minSimilarity,
          topK: opts.topK,
          overall,
          perCategory: Object.fromEntries(perCategory),
        },
        null,
        2,
      ),
    );
  } else {
    printMetricsTable(label, overall, perCategory);
  }
}

async function runSweep(
  markets: Market[],
  dataset: DatasetEntry[],
  opts: RunOptions,
): Promise<void> {
  const filtered = opts.categoryFilter
    ? dataset.filter((d) => d.category === opts.categoryFilter)
    : dataset;

  const kind: MatcherKind = opts.matcher === 'compare' ? 'keyword' : opts.matcher;
  const sweep = kind === 'embedding' ? EMBEDDING_SIMILARITY_SWEEP : KEYWORD_THRESHOLD_SWEEP;
  const colLabel = kind === 'embedding' ? 'MinSim' : 'Threshold';

  console.log('');
  console.log('═'.repeat(86));
  console.log(
    `  ${kind === 'embedding' ? 'EmbeddingMatcher' : 'KeywordMatcher'}  |  ` +
      `Threshold Sweep  |  topK=${opts.topK}  |  N=${filtered.length}`,
  );
  console.log('═'.repeat(86));
  console.log(
    `  ${padCol(colLabel, 10)}  ${padCol('Prec', 6, 'right')}  ${padCol('Recall', 6, 'right')}  ${padCol('F1', 6, 'right')}  ${padCol('MRR', 6, 'right')}  ${padCol('TP/FP/FN', 14, 'right')}`,
  );
  console.log('  ' + '─'.repeat(82));

  // For embedding sweep we reuse one EmbeddingMatcher instance and just vary
  // its similarity threshold — but the class threshold is set at construction,
  // so for sweep we score everything at the lowest threshold then post-filter.
  if (kind === 'embedding') {
    const lowest = Math.min(...sweep);
    const matcher = buildEmbeddingMatcher(markets, lowest, /* topK */ 100);

    // Run once at the lowest threshold; collect all scored matches.
    const rawMatches: { entry: DatasetEntry; matches: MarketMatch[] }[] = [];
    for (let i = 0; i < filtered.length; i++) {
      const entry = filtered[i];
      const matches = await matcher.match(entry.tweet);
      rawMatches.push({ entry, matches });
      if ((i + 1) % 25 === 0) {
        console.log(`[eval] embedding sweep: ${i + 1}/${filtered.length}`);
      }
    }
    matcher.flushCache();

    for (const t of sweep) {
      const results: EvalResult[] = rawMatches.map(({ entry, matches }) => {
        const filteredMatches = matches.filter((m) => m.confidence >= t).slice(0, opts.topK);
        return evaluateEntry(entry, filteredMatches);
      });
      const m = aggregate(results);
      console.log(
        `  ${padCol(fmt(t, 2), 10)}  ${padCol(fmt(m.precision, 3), 6, 'right')}  ${padCol(fmt(m.recall, 3), 6, 'right')}  ${padCol(fmt(m.f1, 3), 6, 'right')}  ${padCol(fmt(m.mrr, 3), 6, 'right')}  ${padCol(`${m.truePositives}/${m.falsePositives}/${m.falseNegatives}`, 14, 'right')}`,
      );
    }
  } else {
    for (const t of sweep) {
      const matcher = new KeywordMatcher(markets, t, opts.topK);
      const results: EvalResult[] = [];
      for (const entry of filtered) {
        const matches = matcher.match(entry.tweet);
        results.push(evaluateEntry(entry, matches));
      }
      const m = aggregate(results);
      console.log(
        `  ${padCol(fmt(t, 2), 10)}  ${padCol(fmt(m.precision, 3), 6, 'right')}  ${padCol(fmt(m.recall, 3), 6, 'right')}  ${padCol(fmt(m.f1, 3), 6, 'right')}  ${padCol(fmt(m.mrr, 3), 6, 'right')}  ${padCol(`${m.truePositives}/${m.falsePositives}/${m.falseNegatives}`, 14, 'right')}`,
      );
    }
  }

  console.log('═'.repeat(86));
}

async function runCompare(
  markets: Market[],
  dataset: DatasetEntry[],
  opts: RunOptions,
): Promise<void> {
  const filtered = opts.categoryFilter
    ? dataset.filter((d) => d.category === opts.categoryFilter)
    : dataset;

  // Keyword pass
  console.log('[eval] Running KeywordMatcher pass...');
  const kw = new KeywordMatcher(markets, opts.threshold, opts.topK);
  const kwResults = await evalAllEntries(filtered, async (t) => kw.match(t));
  const kwOverall = aggregate(kwResults);
  const kwByCat = aggregateByCategory(kwResults);

  // Embedding pass
  console.log('[eval] Running EmbeddingMatcher pass (may take a few minutes)...');
  const em = buildEmbeddingMatcher(markets, opts.minSimilarity, opts.topK);
  const emResults = await evalAllEntries(filtered, (t) => em.match(t), 'embedding');
  em.flushCache();
  const emOverall = aggregate(emResults);
  const emByCat = aggregateByCategory(emResults);

  // Print individually
  printMetricsTable(
    `KeywordMatcher  |  threshold=${opts.threshold}  |  topK=${opts.topK}  |  N=${filtered.length}`,
    kwOverall,
    kwByCat,
  );
  printMetricsTable(
    `EmbeddingMatcher (Gemini)  |  minSimilarity=${opts.minSimilarity}  |  topK=${opts.topK}  |  N=${filtered.length}`,
    emOverall,
    emByCat,
  );

  // Side-by-side overall comparison
  console.log('');
  console.log('═'.repeat(86));
  console.log('  Comparison (overall)');
  console.log('═'.repeat(86));
  console.log(
    `  ${padCol('Matcher', 24)}  ${padCol('Prec', 6, 'right')}  ${padCol('Recall', 6, 'right')}  ${padCol('F1', 6, 'right')}  ${padCol('MRR', 6, 'right')}  ${padCol('TP/FP/FN', 14, 'right')}`,
  );
  console.log('  ' + '─'.repeat(82));
  console.log(
    `  ${padCol('Keyword', 24)}  ${padCol(fmt(kwOverall.precision, 3), 6, 'right')}  ${padCol(fmt(kwOverall.recall, 3), 6, 'right')}  ${padCol(fmt(kwOverall.f1, 3), 6, 'right')}  ${padCol(fmt(kwOverall.mrr, 3), 6, 'right')}  ${padCol(`${kwOverall.truePositives}/${kwOverall.falsePositives}/${kwOverall.falseNegatives}`, 14, 'right')}`,
  );
  console.log(
    `  ${padCol('Embedding (Gemini)', 24)}  ${padCol(fmt(emOverall.precision, 3), 6, 'right')}  ${padCol(fmt(emOverall.recall, 3), 6, 'right')}  ${padCol(fmt(emOverall.f1, 3), 6, 'right')}  ${padCol(fmt(emOverall.mrr, 3), 6, 'right')}  ${padCol(`${emOverall.truePositives}/${emOverall.falsePositives}/${emOverall.falseNegatives}`, 14, 'right')}`,
  );
  const dF1 = emOverall.f1 - kwOverall.f1;
  console.log('  ' + '─'.repeat(82));
  console.log(
    `  Δ F1 (embedding - keyword) = ${dF1 >= 0 ? '+' : ''}${fmt(dF1, 3)}`,
  );
  console.log('═'.repeat(86));
}

// ─── Args ──────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  sweep: boolean;
  opts: RunOptions;
} {
  const opts: RunOptions = {
    matcher: 'keyword',
    threshold: DEFAULT_THRESHOLD,
    minSimilarity: DEFAULT_MIN_SIMILARITY,
    topK: DEFAULT_TOP_K,
    jsonOutput: false,
  };
  let sweep = false;

  for (const arg of argv) {
    if (arg === '--sweep-threshold') {
      sweep = true;
    } else if (arg === '--json') {
      opts.jsonOutput = true;
    } else if (arg.startsWith('--threshold=')) {
      opts.threshold = parseFloat(arg.split('=')[1]);
    } else if (arg.startsWith('--min-similarity=')) {
      opts.minSimilarity = parseFloat(arg.split('=')[1]);
    } else if (arg.startsWith('--top-k=')) {
      opts.topK = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--category=')) {
      opts.categoryFilter = arg.split('=')[1];
    } else if (arg.startsWith('--matcher=')) {
      const v = arg.split('=')[1];
      if (v !== 'keyword' && v !== 'embedding' && v !== 'compare') {
        console.error(`[eval] Invalid --matcher=${v}. Use keyword|embedding|compare.`);
        process.exit(1);
      }
      opts.matcher = v;
    }
  }

  return { sweep, opts };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { sweep, opts } = parseArgs(process.argv.slice(2));

  const markets = loadSnapshot();
  const dataset = loadDataset();

  if (opts.matcher === 'compare') {
    if (sweep) {
      console.error('[eval] --sweep-threshold not supported with --matcher=compare. Use one matcher at a time.');
      process.exit(1);
    }
    await runCompare(markets, dataset, opts);
  } else if (sweep) {
    await runSweep(markets, dataset, opts);
  } else {
    await runOnce(markets, dataset, opts);
  }
}

main().catch((err) => {
  console.error('[eval] Fatal:', err);
  process.exit(1);
});
