/**
 * Curate the markets snapshot:
 *   1. Recategorize "other" markets per title patterns (weather → climate,
 *      tennis → sports, SpaceX/Anthropic → technology, etc.)
 *   2. Drop 14 redundant markets:
 *      - 9 weather markets (keep 4 representative London/Munich/Madrid temps)
 *      - 2 sports duplicates (drop "French Open"; keep "Roland Garros" — same tournament)
 *      - 3 Elon Musk tweet-count markets (keep <40 and 140-159)
 *   3. Add 7 synthetic markets for testing:
 *      - BTC $150k / $200k 2026 (numeric discrimination trap)
 *      - Fed rate cut June 2026 (economics backstop)
 *      - CPI May 2026 above 3% (economics)
 *      - US Q2 2026 GDP positive (economics)
 *      - Trump approval >50% June 2026 (us_politics)
 *      - Mike Johnson Speaker through 2026 (us_politics)
 *
 * Synthetic keywords are generated via the existing generateKeywords() helper
 * so the keyword matcher gets no unfair advantage from hand-tuned entries.
 *
 * Overwrites the snapshot file in place. To start over, re-run
 * `pnpm tsx scripts/snapshot-markets.ts` to regenerate the raw file,
 * then re-run this script.
 *
 * Usage:
 *   pnpm tsx scripts/curate-snapshot.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateKeywords } from '../src/api/keyword-generator';

interface Market {
  id: string;
  platform: 'polymarket' | 'kalshi';
  title: string;
  description: string;
  keywords: string[];
  yesPrice: number;
  noPrice: number;
  volume24h: number;
  url: string;
  category: string;
  lastUpdated: string;
  endDate?: string;
  oneDayPriceChange?: number;
}

// ─── Configuration ─────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);
const SNAPSHOT_PATH = resolve(
  process.cwd(),
  'scripts',
  'eval-fixtures',
  `markets-snapshot-${today}.json`,
);

// Title patterns that move "other" markets into a specific category.
// Applied in order; first match wins.
const RECATEGORIZE_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\b(highest|lowest)\s+temperature\b/i, category: 'climate' },
  { pattern: /precipitation/i, category: 'climate' },
  { pattern: /(Roland Garros|French Open)/i, category: 'sports' },
  { pattern: /Clarity Act/i, category: 'us_politics' },
  { pattern: /SpaceX/i, category: 'technology' },
  { pattern: /Anthropic/i, category: 'technology' },
  { pattern: /Netanyahu/i, category: 'geopolitics' },
  { pattern: /Starmer/i, category: 'us_politics' },
  { pattern: /(S&P 500|SPY)/i, category: 'economics' },
];

// Explicit IDs to drop (14 markets).
const REMOVE_IDS = new Set<string>([
  // Weather duplicates (9) — keep London 19°C, London 22°C, Munich 25°C, Madrid 32°C
  'polymarket-0x3f580144d228c12d674fc09ab4eeff09b14d79084827ce12426ee52607a9b06f', // London 21°C
  'polymarket-0x1613544e91a8bc6f7df32b9a6b2b6588f597d03c3ba7a07607c4768f8c8428a6', // London 20°C
  'polymarket-0x00df54aa54dced1797e6b5fab6a7ca616196117af3f61cef773759b3ad36713e', // Hong Kong 28°C
  'polymarket-0x3ff3d49ab287815f7677ab20f0324381de22517bd07a80eb524dce53ff433130', // London precipitation
  'polymarket-0x8ecff97778cbf180ebf43c502540d029b25d76424b2bd218726768eab3e14e96', // Amsterdam 19°C
  'polymarket-0x24c32fc68ccfd6358516a42e9b375bc0e7c86256a70f3dd83e6b25b834713552', // Munich 27°C
  'polymarket-0xb5ceb5eaeb0fb2ab168d01b826ea859d14b1ceea5710f4e86f904a223ff1d417', // Milan 24°C+
  'polymarket-0xba45241d09d574473f1e71ea77c4194658606f7d93a4f21da3f7b393508e37bd', // Milan 23°C
  'polymarket-0xefe0b9b5418f9e503974826578dc52c24e64a7a0c5e4c193dc035937eb908c36', // Ankara 25°C

  // Sports duplicates (2) — drop "French Open" variants; keep "Roland Garros" entries
  'polymarket-0x739e756119534672538d8df821a5b3321e2c802d80afff0c5790126be9b41281', // Zverev French Open
  'polymarket-0x3e166e94d38707543b2e951c325eb9b917468b99e75294d11cd853587364d934', // Jodar French Open

  // Elon tweet-count redundant (3) — keep <40 and 140-159
  'polymarket-0x5ec638191dfc672211a03dda500672f53c867fbe8cc4f31c9be67b6d33ed8079', // 160-179
  'polymarket-0x36ae7cb439f44ccd452aadee56de2e0c3ed08abcc58a4d3f36b11707bb043514', // 65-89
  'polymarket-0xf53f1512e0b1cc672327a0c2a47d6f2f7fccc2547cf36ee583c120b6cade284c', // 40-64
]);

// Synthetic markets to inject. Keywords filled in at runtime by generateKeywords().
const SYNTHETIC_BASE: Omit<Market, 'keywords'>[] = [
  {
    id: 'synthetic-btc-150k-2026',
    platform: 'polymarket',
    title: 'Will Bitcoin cross $150,000 in 2026?',
    description:
      'Synthetic market for matcher eval. Resolves YES if Bitcoin (BTC/USD) closes above $150,000 at any point during the 2026 calendar year.',
    yesPrice: 0.3,
    noPrice: 0.7,
    volume24h: 100000,
    url: '',
    category: 'crypto',
    lastUpdated: new Date().toISOString(),
    endDate: '2026-12-31',
  },
  {
    id: 'synthetic-btc-200k-2026',
    platform: 'polymarket',
    title: 'Will Bitcoin cross $200,000 in 2026?',
    description:
      'Synthetic market for matcher eval. Resolves YES if Bitcoin (BTC/USD) closes above $200,000 at any point during the 2026 calendar year.',
    yesPrice: 0.1,
    noPrice: 0.9,
    volume24h: 100000,
    url: '',
    category: 'crypto',
    lastUpdated: new Date().toISOString(),
    endDate: '2026-12-31',
  },
  {
    id: 'synthetic-fed-rate-cut-jun-2026',
    platform: 'polymarket',
    title: 'Will the Federal Reserve lower its benchmark interest rate in June 2026?',
    description:
      'Synthetic market for matcher eval. Resolves YES if the FOMC announces a cut to the federal funds target range at the June 2026 meeting.',
    yesPrice: 0.4,
    noPrice: 0.6,
    volume24h: 100000,
    url: '',
    category: 'economics',
    lastUpdated: new Date().toISOString(),
    endDate: '2026-06-30',
  },
  {
    id: 'synthetic-cpi-may-2026',
    platform: 'polymarket',
    title: 'Will the May 2026 CPI release show inflation above 3%?',
    description:
      'Synthetic market for matcher eval. Resolves YES if the year-over-year CPI for May 2026, as reported by the BLS, exceeds 3.0%.',
    yesPrice: 0.45,
    noPrice: 0.55,
    volume24h: 100000,
    url: '',
    category: 'economics',
    lastUpdated: new Date().toISOString(),
    endDate: '2026-06-15',
  },
  {
    id: 'synthetic-gdp-q2-2026',
    platform: 'polymarket',
    title: 'Will US Q2 2026 GDP growth be positive?',
    description:
      'Synthetic market for matcher eval. Resolves YES if the BEA reports positive real GDP growth for Q2 2026 in its advance estimate.',
    yesPrice: 0.75,
    noPrice: 0.25,
    volume24h: 100000,
    url: '',
    category: 'economics',
    lastUpdated: new Date().toISOString(),
    endDate: '2026-07-30',
  },
  {
    id: 'synthetic-trump-approval-jun-2026',
    platform: 'polymarket',
    title: "Will Donald Trump's approval rating average above 50% in June 2026?",
    description:
      "Synthetic market for matcher eval. Resolves YES if the average of major poll aggregators shows Trump's approval rating above 50% for June 2026.",
    yesPrice: 0.35,
    noPrice: 0.65,
    volume24h: 100000,
    url: '',
    category: 'us_politics',
    lastUpdated: new Date().toISOString(),
    endDate: '2026-06-30',
  },
  {
    id: 'synthetic-johnson-speaker-2026',
    platform: 'polymarket',
    title: 'Will Mike Johnson remain Speaker of the House through end of 2026?',
    description:
      'Synthetic market for matcher eval. Resolves YES if Mike Johnson holds the office of Speaker of the US House of Representatives continuously through December 31, 2026.',
    yesPrice: 0.55,
    noPrice: 0.45,
    volume24h: 100000,
    url: '',
    category: 'us_politics',
    lastUpdated: new Date().toISOString(),
    endDate: '2026-12-31',
  },
];

// ─── Main ──────────────────────────────────────────────────────────────────

function main(): void {
  if (!existsSync(SNAPSHOT_PATH)) {
    console.error(`[curate] Snapshot not found at: ${SNAPSHOT_PATH}`);
    console.error('[curate] Run scripts/snapshot-markets.ts first.');
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));
  let markets: Market[] = data.markets;

  console.log(`[curate] Loaded ${markets.length} markets from ${SNAPSHOT_PATH}`);
  console.log('');

  // 1. Recategorize "other" markets
  let recategorized = 0;
  for (const m of markets) {
    if (m.category !== 'other') continue;
    for (const { pattern, category } of RECATEGORIZE_PATTERNS) {
      if (pattern.test(m.title)) {
        m.category = category;
        recategorized++;
        break;
      }
    }
  }
  console.log(`[curate] Recategorized: ${recategorized} markets`);

  // 2. Drop redundant markets
  const beforeRemove = markets.length;
  markets = markets.filter((m) => !REMOVE_IDS.has(m.id));
  const removed = beforeRemove - markets.length;
  console.log(`[curate] Dropped: ${removed} markets (expected: ${REMOVE_IDS.size})`);

  if (removed !== REMOVE_IDS.size) {
    console.warn(
      `[curate] WARNING: removed ${removed} but expected ${REMOVE_IDS.size}. ` +
        `Some IDs may have changed or already been absent. Check the snapshot.`,
    );
  }

  // 3. Add synthetic markets with generated keywords
  for (const base of SYNTHETIC_BASE) {
    markets.push({
      ...base,
      keywords: generateKeywords(base.title, base.description),
    });
  }
  console.log(`[curate] Added: ${SYNTHETIC_BASE.length} synthetic markets`);

  // 4. Recompute breakdown
  const byCategory: Record<string, number> = {};
  const byPlatform: Record<string, number> = {};
  for (const m of markets) {
    byCategory[m.category] = (byCategory[m.category] ?? 0) + 1;
    byPlatform[m.platform] = (byPlatform[m.platform] ?? 0) + 1;
  }

  // 5. Write
  const output = {
    generated_at: data.generated_at,
    curated_at: new Date().toISOString(),
    source: data.source,
    per_category_limit: data.per_category_limit,
    count: markets.length,
    breakdown: {
      by_category: byCategory,
      by_platform: byPlatform,
    },
    curation: {
      recategorized,
      removed,
      synthetic_added: SYNTHETIC_BASE.length,
    },
    markets,
  };

  writeFileSync(SNAPSHOT_PATH, JSON.stringify(output, null, 2));

  console.log('');
  console.log('[curate] === Final snapshot ===');
  console.log(`[curate] Total markets: ${markets.length}`);
  console.log(`[curate] By category: ${JSON.stringify(byCategory)}`);
  console.log(`[curate] By platform: ${JSON.stringify(byPlatform)}`);
  console.log(`[curate] Written to: ${SNAPSHOT_PATH}`);
}

main();
