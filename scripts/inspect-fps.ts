/**
 * Quick debugging script — prints every dataset entry that has false positives,
 * along with which markets the matcher matched.
 *
 * Usage:
 *   pnpm tsx scripts/inspect-fps.ts [category]
 *
 * Example:
 *   pnpm tsx scripts/inspect-fps.ts synthetic_entity
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { KeywordMatcher } from '../src/analysis/keyword-matcher';
import type { Market } from '../src/types/market';

const FIXTURES_DIR = resolve(process.cwd(), 'scripts', 'eval-fixtures');

function findLatest(prefix: string, ext: string): string {
  const f = readdirSync(FIXTURES_DIR)
    .filter((x) => x.startsWith(prefix) && x.endsWith(ext))
    .sort()
    .reverse()[0];
  return resolve(FIXTURES_DIR, f);
}

interface Entry {
  id: string;
  tweet: string;
  expected_market_ids: string[];
  category: string;
}

const snap = JSON.parse(readFileSync(findLatest('markets-snapshot-', '.json'), 'utf-8')) as {
  markets: Market[];
};
const ds = readFileSync(findLatest('dataset-', '.jsonl'), 'utf-8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Entry);

const categoryFilter = process.argv[2];
const entries = categoryFilter ? ds.filter((d) => d.category === categoryFilter) : ds;

const m = new KeywordMatcher(snap.markets, 0.22, 5);

console.log(`Inspecting ${entries.length} entries${categoryFilter ? ` in category "${categoryFilter}"` : ''}\n`);

for (const e of entries) {
  const matches = m.match(e.tweet);
  const expected = new Set(e.expected_market_ids);
  const fps = matches.filter((x) => !expected.has(x.market.id));
  if (fps.length > 0) {
    console.log(`${e.id} (${e.category}) — ${fps.length} FP${fps.length > 1 ? 's' : ''}:`);
    console.log(`  Tweet: ${e.tweet.slice(0, 100)}${e.tweet.length > 100 ? '...' : ''}`);
    for (const x of fps) {
      console.log(`    ${x.confidence.toFixed(3)}  ${x.market.title.slice(0, 70)}`);
      console.log(`           matched keywords: ${x.matchedKeywords.slice(0, 6).join(', ')}`);
    }
    console.log('');
  }
}
