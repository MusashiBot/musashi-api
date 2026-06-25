/**
 * Fetch real tweet candidates from the hosted Musashi feed for labeling.
 *
 * Pulls ~200 analyzed tweets from https://musashi-api.vercel.app/api/feed,
 * filters for usable candidates, then samples 50 with category diversity
 * (~8-10 per non-crypto account category, rest crypto).
 *
 * Output is a SCRATCH file — NOT the final dataset. Each entry contains the
 * raw tweet plus the hosted matcher's current matches as "hints" to inform
 * (but not dictate) labeling. The final dataset.jsonl entries are written
 * separately after manual review.
 *
 * Usage:
 *   pnpm tsx scripts/fetch-real-tweets.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const HOSTED_API = 'https://musashi-api.vercel.app';
const FETCH_LIMIT = 200;
const TARGET_TOTAL = 50;
const PER_CATEGORY_TARGET = 9;
const FETCH_TIMEOUT_MS = 15_000;

// 'crypto' filled last to balance the rest. Order also dictates sample priority.
const NON_CRYPTO_CATEGORIES = [
  'politics',
  'finance',
  'geopolitics',
  'tech',
  'sports',
  'climate',
  'breaking_news',
] as const;

// ─── Types ────────────────────────────────────────────────────────────────

interface RawTweet {
  id: string;
  text: string;
  author: string;
  created_at: string;
  metrics?: { likes: number; retweets: number; replies: number; quotes: number };
  url?: string;
}

interface MarketMatch {
  market: { id: string; title: string; category: string };
  confidence: number;
  matchedKeywords: string[];
}

interface AnalyzedTweet {
  tweet: RawTweet;
  matches: MarketMatch[];
  category: string;
  urgency: string;
  confidence: number;
  analyzed_at: string;
  collected_at: string;
}

interface FeedApiResponse {
  success: boolean;
  data?: {
    tweets: AnalyzedTweet[];
    count: number;
  };
  error?: string;
}

interface Candidate {
  candidate_id: string;
  tweet_id: string;
  tweet: string;
  author: string;
  created_at: string;
  account_category: string;
  hosted_matcher_hints: Array<{ market_id: string; market_title: string; confidence: number }>;
}

// ─── Fetch ────────────────────────────────────────────────────────────────

async function fetchFeed(limit: number): Promise<AnalyzedTweet[]> {
  const url = `${HOSTED_API}/api/feed?limit=${limit}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      console.error(`[fetch-tweets] HTTP ${resp.status}`);
      return [];
    }

    const json = (await resp.json()) as FeedApiResponse;
    if (!json.success || !json.data) {
      console.error(`[fetch-tweets] ${json.error ?? 'unknown error'}`);
      return [];
    }

    return json.data.tweets;
  } catch (err) {
    clearTimeout(timer);
    console.error(`[fetch-tweets] ${(err as Error).message}`);
    return [];
  }
}

// ─── Filter ───────────────────────────────────────────────────────────────

function isUsable(at: AnalyzedTweet): boolean {
  const text = at.tweet?.text ?? '';
  if (text.trim().length < 20) return false;

  // Strip URLs, mentions, hashtags — what's left should still have substance.
  const stripped = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/#\w+/g, '')
    .trim();
  if (stripped.length < 15) return false;

  return true;
}

function dedupeByText(tweets: AnalyzedTweet[]): AnalyzedTweet[] {
  const seen = new Set<string>();
  const out: AnalyzedTweet[] = [];
  for (const t of tweets) {
    // Normalize to catch near-duplicates (whitespace, casing).
    const key = (t.tweet?.text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!seen.has(key) && key.length > 0) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

// ─── Sample with category balance ─────────────────────────────────────────

function sampleBalanced(
  tweets: AnalyzedTweet[],
  perCategory: number,
  total: number,
): AnalyzedTweet[] {
  const byCategory = new Map<string, AnalyzedTweet[]>();
  for (const t of tweets) {
    const cat = (t.category ?? 'unknown').toLowerCase();
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(t);
  }

  const picked: AnalyzedTweet[] = [];

  // First pass: take up to perCategory from each non-crypto category in order.
  for (const cat of NON_CRYPTO_CATEGORIES) {
    const bucket = byCategory.get(cat) ?? [];
    const take = bucket.slice(0, perCategory);
    picked.push(...take);
  }

  // Second pass: fill remaining slots with crypto.
  const remaining = Math.max(0, total - picked.length);
  const cryptoBucket = byCategory.get('crypto') ?? [];
  picked.push(...cryptoBucket.slice(0, remaining));

  // Third pass: if still under target (some categories underdelivered), top up
  // with anything we haven't picked yet.
  if (picked.length < total) {
    const pickedIds = new Set(picked.map((t) => t.tweet?.id).filter(Boolean));
    for (const t of tweets) {
      if (picked.length >= total) break;
      if (!pickedIds.has(t.tweet?.id)) {
        picked.push(t);
      }
    }
  }

  return picked.slice(0, total);
}

// ─── Map to candidate shape ───────────────────────────────────────────────

function toCandidate(at: AnalyzedTweet, index: number): Candidate {
  return {
    candidate_id: `real-${String(index + 1).padStart(3, '0')}`,
    tweet_id: at.tweet?.id ?? '(no-id)',
    tweet: at.tweet?.text ?? '',
    author: at.tweet?.author ?? '',
    created_at: at.tweet?.created_at ?? '',
    account_category: (at.category ?? 'unknown').toLowerCase(),
    hosted_matcher_hints: (at.matches ?? []).slice(0, 5).map((m) => ({
      market_id: m.market.id,
      market_title: m.market.title,
      confidence: m.confidence,
    })),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[fetch-tweets] Source: ${HOSTED_API}/api/feed`);
  console.log(`[fetch-tweets] Fetching up to ${FETCH_LIMIT} tweets...`);
  console.log('');

  const raw = await fetchFeed(FETCH_LIMIT);
  console.log(`[fetch-tweets] Received: ${raw.length} tweets`);

  const usable = raw.filter(isUsable);
  console.log(`[fetch-tweets] Passed filters: ${usable.length}`);

  const deduped = dedupeByText(usable);
  console.log(`[fetch-tweets] After dedup: ${deduped.length}`);

  // Breakdown by account category
  const counts = new Map<string, number>();
  for (const t of deduped) {
    const c = (t.category ?? 'unknown').toLowerCase();
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  console.log(`[fetch-tweets] By account category: ${JSON.stringify(Object.fromEntries(counts))}`);

  const sampled = sampleBalanced(deduped, PER_CATEGORY_TARGET, TARGET_TOTAL);
  console.log(`[fetch-tweets] Sampled: ${sampled.length} candidates`);

  // Show category distribution of the sample
  const sampleCounts = new Map<string, number>();
  for (const t of sampled) {
    const c = (t.category ?? 'unknown').toLowerCase();
    sampleCounts.set(c, (sampleCounts.get(c) ?? 0) + 1);
  }
  console.log(`[fetch-tweets] Sample by category: ${JSON.stringify(Object.fromEntries(sampleCounts))}`);

  const candidates = sampled.map(toCandidate);

  const today = new Date().toISOString().slice(0, 10);
  const outDir = resolve(process.cwd(), 'scripts', 'eval-fixtures');
  const outPath = resolve(outDir, `real-tweet-candidates-${today}.jsonl`);

  mkdirSync(outDir, { recursive: true });

  // JSONL = one JSON object per line
  const lines = candidates.map((c) => JSON.stringify(c)).join('\n') + '\n';
  writeFileSync(outPath, lines);

  console.log('');
  console.log(`[fetch-tweets] Written ${candidates.length} candidates to:`);
  console.log(`  ${outPath}`);
  console.log('');
  console.log('[fetch-tweets] Next: review candidates and label expected_market_ids for each.');
}

main().catch((err) => {
  console.error('[fetch-tweets] Fatal:', err);
  process.exit(1);
});
