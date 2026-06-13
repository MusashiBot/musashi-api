/**
 * Embed all markets in the curated snapshot using Google Gemini.
 *
 * One-time script. Sends each market's "{title}. {description}" to Gemini's
 * gemini-embedding-001 model and saves the resulting vectors to disk. The eval
 * harness and the EmbeddingMatcher class read this cached file instead of
 * re-embedding on every run.
 *
 * Usage:
 *   pnpm tsx scripts/embed-markets.ts
 *
 * Requires:
 *   GEMINI_API_KEY in .env.local (or shell env)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { GoogleGenerativeAI } from '@google/generative-ai';

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
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile('.env.local');
loadEnvFile('.env');

// ─── Constants ─────────────────────────────────────────────────────────────

// Google retired text-embedding-004; gemini-embedding-001 is the current stable model.
// Its default dimensionality is 3072 (configurable down to 768, 1536, or 256, but
// we use the default so we don't have to thread an extra config through the SDK).
const MODEL_NAME = 'gemini-embedding-001';
// Dimension is determined by the model's first response (no hardcoded assumption).
let detectedDimensions: number | null = null;
const FIXTURES_DIR = resolve(process.cwd(), 'scripts', 'eval-fixtures');
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000]; // exponential backoff on 429s

// ─── Types ─────────────────────────────────────────────────────────────────

interface Market {
  id: string;
  title: string;
  description?: string;
  [k: string]: unknown;
}

interface SnapshotFile {
  generated_at: string;
  markets: Market[];
}

interface EmbeddingCache {
  model: string;
  dimensions: number;
  created_at: string;
  snapshot_file: string;
  count: number;
  embeddings: Record<string, number[]>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function findLatestFile(prefix: string, ext: string): string {
  const candidates = readdirSync(FIXTURES_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
    .sort()
    .reverse();
  if (candidates.length === 0) {
    throw new Error(`No file matching ${prefix}*${ext} in ${FIXTURES_DIR}`);
  }
  return candidates[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function buildMarketText(m: Market): string {
  const title = (m.title ?? '').trim();
  const desc = (m.description ?? '').trim();
  // Truncate to ~500 chars so we don't waste tokens on very long descriptions.
  const combined = desc ? `${title}. ${desc}` : title;
  return combined.slice(0, 500);
}

async function embedWithRetry(
  model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>,
  text: string,
): Promise<number[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      const result = await model.embedContent(text);
      const values = result.embedding?.values;
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error('Gemini returned empty embedding');
      }
      return values;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // 429s and 5xxs are retriable; 400s usually aren't.
      const retriable = /429|rate|quota|503|504|timeout/i.test(msg);
      if (!retriable || attempt >= RETRY_DELAYS_MS.length) break;
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(`[embed] ${msg} — retrying in ${delay}ms (attempt ${attempt + 1})`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[embed] GEMINI_API_KEY not set. Add it to .env.local or your shell env.');
    process.exit(1);
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: MODEL_NAME });

  // ── Sanity check (1 call) ──────────────────────────────────────────────
  console.log('[embed] Sanity check: embedding a 3-word test string...');
  const sanity = await embedWithRetry(model, 'sanity check ping');
  if (!Array.isArray(sanity) || sanity.length === 0) {
    console.error('[embed] Sanity returned empty embedding');
    process.exit(1);
  }
  detectedDimensions = sanity.length;
  console.log(
    `[embed] ✓ Sanity OK — model=${MODEL_NAME}, dimensions=${detectedDimensions}, ` +
      `first 5 values: [${sanity.slice(0, 5).map((v) => v.toFixed(4)).join(', ')}]`,
  );
  console.log('');

  // ── Load snapshot ──────────────────────────────────────────────────────
  const snapshotFile = findLatestFile('markets-snapshot-', '.json');
  const snapshotPath = resolve(FIXTURES_DIR, snapshotFile);
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as SnapshotFile;
  console.log(`[embed] Loaded ${snapshot.markets.length} markets from ${snapshotFile}`);
  console.log('');

  // ── Embed each market ──────────────────────────────────────────────────
  const embeddings: Record<string, number[]> = {};
  let okCount = 0;
  const startTime = Date.now();

  for (const [i, m] of snapshot.markets.entries()) {
    const text = buildMarketText(m);
    try {
      const vec = await embedWithRetry(model, text);
      embeddings[m.id] = vec;
      okCount++;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `[embed] ${String(i + 1).padStart(3, ' ')}/${snapshot.markets.length} ✓ (${elapsed}s) ${m.id.slice(0, 30)}... — ${m.title.slice(0, 50)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[embed] ${i + 1}/${snapshot.markets.length} ✗ ${m.id}: ${msg}`);
    }
  }

  console.log('');
  console.log(`[embed] Embedded ${okCount}/${snapshot.markets.length} markets`);

  if (okCount < snapshot.markets.length) {
    console.warn(`[embed] WARNING: ${snapshot.markets.length - okCount} markets failed. Cache is incomplete.`);
  }

  // ── Save cache ─────────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const outFile = `markets-embeddings-${today}.json`;
  const outPath = resolve(FIXTURES_DIR, outFile);

  mkdirSync(FIXTURES_DIR, { recursive: true });

  const cache: EmbeddingCache = {
    model: MODEL_NAME,
    dimensions: detectedDimensions ?? 0,
    created_at: new Date().toISOString(),
    snapshot_file: snapshotFile,
    count: okCount,
    embeddings,
  };

  writeFileSync(outPath, JSON.stringify(cache, null, 2));
  console.log(`[embed] Cache written to: ${outPath}`);
  console.log(`[embed] File size: ${(JSON.stringify(cache).length / 1024).toFixed(1)} KB`);
}

main().catch((err) => {
  console.error('[embed] Fatal:', err);
  process.exit(1);
});
