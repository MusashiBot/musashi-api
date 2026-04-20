/**
 * Fetch markets from the Polymarket + Kalshi clients and persist them to
 * `fixtures/markets.snapshot.json` so the matcher eval is reproducible
 * without needing a live network call on every run.
 *
 *   npx tsx scripts/matcher-eval/snapshot-markets.ts
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchPolymarkets } from '../../src/api/polymarket-client';
import { fetchKalshiMarkets } from '../../src/api/kalshi-client';

async function main(): Promise<void> {
  console.log('[snapshot] fetching Polymarket + Kalshi markets...');
  const [poly, kalshi] = await Promise.all([
    fetchPolymarkets(1200, 10),
    fetchKalshiMarkets(1000, 10),
  ]);
  const all = [...poly, ...kalshi];
  const out = resolve('scripts/matcher-eval/fixtures/markets.snapshot.json');
  writeFileSync(out, JSON.stringify(all, null, 0));
  console.log(`[snapshot] wrote ${all.length} markets (${poly.length} Polymarket + ${kalshi.length} Kalshi) to ${out}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
