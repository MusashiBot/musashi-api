/**
 * Freeze train / validation / test splits by market_id.
 *
 * Partition is stratified by market category and seeded for reproducibility.
 * Default ratios: 60% train / 20% validation / 20% test (proposal).
 *
 * Usage:
 *   pnpm run split
 *   pnpm run split -- --force --seed 42
 */

import fs from 'fs/promises';
import path from 'path';
import {
  BenchmarkMarket,
  BenchmarkSplits,
  benchmarkDir,
  readJsonl,
} from './schema';

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** Deterministic mulberry32 PRNG. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Assign markets to splits. With very small N, guarantee each non-empty pool
 * gets at least one market when possible (test preferred for final holdout).
 */
export function assignSplits(
  markets: BenchmarkMarket[],
  seed: number,
  ratios = { train: 0.6, validation: 0.2, test: 0.2 }
): Pick<BenchmarkSplits, 'train' | 'validation' | 'test'> {
  const rand = mulberry32(seed);
  const byCategory = new Map<string, BenchmarkMarket[]>();
  for (const m of markets) {
    const list = byCategory.get(m.category) ?? [];
    list.push(m);
    byCategory.set(m.category, list);
  }

  const train: string[] = [];
  const validation: string[] = [];
  const test: string[] = [];

  for (const [, group] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const shuffled = shuffle(group, rand);
    const n = shuffled.length;

    if (n === 1) {
      test.push(shuffled[0].market_id);
      continue;
    }
    if (n === 2) {
      train.push(shuffled[0].market_id);
      test.push(shuffled[1].market_id);
      continue;
    }
    if (n === 3) {
      train.push(shuffled[0].market_id);
      validation.push(shuffled[1].market_id);
      test.push(shuffled[2].market_id);
      continue;
    }

    let nTest = Math.round(n * ratios.test);
    let nVal = Math.round(n * ratios.validation);
    if (nTest < 1) nTest = 1;
    if (nVal < 1) nVal = 1;
    let nTrain = n - nTest - nVal;
    if (nTrain < 1) {
      nTrain = 1;
      nVal = Math.max(1, n - nTrain - nTest);
      nTest = n - nTrain - nVal;
    }

    const trainSlice = shuffled.slice(0, nTrain);
    const valSlice = shuffled.slice(nTrain, nTrain + nVal);
    const testSlice = shuffled.slice(nTrain + nVal);

    train.push(...trainSlice.map(m => m.market_id));
    validation.push(...valSlice.map(m => m.market_id));
    test.push(...testSlice.map(m => m.market_id));
  }

  return { train, validation, test };
}

export function validateSplits(
  markets: BenchmarkMarket[],
  splits: Pick<BenchmarkSplits, 'train' | 'validation' | 'test'>
): string[] {
  const errors: string[] = [];
  const allIds = new Set(markets.map(m => m.market_id));
  const assigned = [...splits.train, ...splits.validation, ...splits.test];
  const seen = new Set<string>();

  for (const id of assigned) {
    if (!allIds.has(id)) errors.push(`unknown market_id in splits: ${id}`);
    if (seen.has(id)) errors.push(`duplicate market_id in splits: ${id}`);
    seen.add(id);
  }

  for (const id of allIds) {
    if (!seen.has(id)) errors.push(`market_id missing from splits: ${id}`);
  }

  return errors;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const version = argValue(args, '--version') ?? process.env.BENCHMARK_VERSION ?? 'v1';
  const seed = Number(argValue(args, '--seed') ?? 42);
  const force = hasFlag(args, '--force');

  const dir = benchmarkDir(version);
  const marketsPath = path.join(dir, 'markets.jsonl');
  const splitsPath = path.join(dir, 'splits.json');

  const markets = await readJsonl<BenchmarkMarket>(marketsPath);
  if (markets.length === 0) {
    throw new Error(`No markets in ${marketsPath}`);
  }

  try {
    await fs.access(splitsPath);
    if (!force) {
      throw new Error(
        `splits.json already exists at ${splitsPath}. Re-run with --force to overwrite (proposal: freeze once).`
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) throw err;
    // file missing — proceed
  }

  const assignment = assignSplits(markets, seed);
  const errors = validateSplits(markets, assignment);
  if (errors.length) {
    throw new Error(`Invalid splits:\n${errors.join('\n')}`);
  }

  const payload: BenchmarkSplits = {
    version,
    created_at: new Date().toISOString(),
    seed,
    ratios: { train: 0.6, validation: 0.2, test: 0.2 },
    stratified_by: 'category',
    ...assignment,
  };

  await fs.writeFile(splitsPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(`Wrote ${splitsPath}`);
  console.log(
    `  train=${payload.train.length}  validation=${payload.validation.length}  test=${payload.test.length}`
  );
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
