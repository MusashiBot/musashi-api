import { detectArbitrage } from '../../src/api/arbitrage-detector';
import { fetchKalshiMarkets } from '../../src/api/kalshi-client';
import { fetchPolymarkets } from '../../src/api/polymarket-client';
import { Market, ArbitrageOpportunity } from '../../src/types/market';

const POSITION_USD = 10;
const COST_BUFFER = 0.02;

function market(input: Partial<Market> & Pick<Market, 'id' | 'platform' | 'title' | 'category' | 'yesPrice' | 'noPrice'>): Market {
  return {
    description: '',
    keywords: input.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
    volume24h: 100000,
    url: `https://example.com/${input.id}`,
    lastUpdated: new Date().toISOString(),
    ...input,
  };
}

function legacyNormalize(title: string): string {
  return title
    .toLowerCase()
    .replace(/\?/g, '')
    .replace(/\b(will|before|after|by|in|on|at|the|a|an)\b/g, '')
    .replace(/\b(2024|2025|2026|2027|2028)\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function legacyEntities(title: string): Set<string> {
  const stopWords = new Set(['will', 'hit', 'reach', 'win', 'lose', 'pass', 'than', 'over', 'under']);
  return new Set(
    legacyNormalize(title)
      .split(' ')
      .filter(word => word.length >= 3 && !stopWords.has(word)),
  );
}

function legacySimilarity(a: string, b: string): number {
  const aTerms = legacyEntities(a);
  const bTerms = legacyEntities(b);
  let shared = 0;
  for (const term of aTerms) {
    if (bTerms.has(term)) shared++;
  }
  const union = aTerms.size + bTerms.size - shared;
  return union > 0 ? shared / union : 0;
}

function legacyDetect(markets: Market[]): ArbitrageOpportunity[] {
  const polys = markets.filter(m => m.platform === 'polymarket');
  const kalshis = markets.filter(m => m.platform === 'kalshi');
  const opportunities: ArbitrageOpportunity[] = [];

  for (const poly of polys) {
    for (const kalshi of kalshis) {
      const categoryMatch =
        poly.category === kalshi.category ||
        poly.category === 'other' ||
        kalshi.category === 'other';
      if (!categoryMatch) continue;

      const confidence = legacySimilarity(poly.title, kalshi.title);
      if (confidence <= 0.5) continue;

      const spread = Math.abs(poly.yesPrice - kalshi.yesPrice);
      if (spread < 0.03) continue;

      opportunities.push({
        polymarket: poly,
        kalshi,
        spread,
        rawPriceGap: spread,
        profitPotential: spread,
        direction: poly.yesPrice < kalshi.yesPrice ? 'buy_poly_sell_kalshi' : 'buy_kalshi_sell_poly',
        confidence,
        matchReason: `Legacy title similarity (${(confidence * 100).toFixed(0)}%)`,
      });
    }
  }

  return opportunities.sort((a, b) => b.spread - a.spread);
}

function legacyExpectedPnl(op: ArbitrageOpportunity): number {
  const buyPrice = op.direction === 'buy_poly_sell_kalshi'
    ? op.polymarket.yesPrice
    : op.kalshi.yesPrice;
  return op.spread * (POSITION_USD / buyPrice);
}

function coveredRealizedPnl(op: ArbitrageOpportunity): number {
  const yesPrice = op.direction === 'buy_poly_sell_kalshi'
    ? op.polymarket.yesAsk ?? op.polymarket.yesPrice
    : op.kalshi.yesAsk ?? op.kalshi.yesPrice;
  const noPrice = op.direction === 'buy_poly_sell_kalshi'
    ? op.kalshi.noAsk ?? op.kalshi.noPrice
    : op.polymarket.noAsk ?? op.polymarket.noPrice;
  const cost = yesPrice + noPrice + COST_BUFFER;
  const bundles = POSITION_USD / cost;
  return (1 - cost) * bundles;
}

function fixedPnl(op: ArbitrageOpportunity): number {
  const cost = op.costPerBundle ?? 1;
  return op.profitPotential * (POSITION_USD / cost);
}

function printTrade(label: string, op: ArbitrageOpportunity, expected: number, realized: number): void {
  console.log(`${label}`);
  console.log(`  pair: ${op.polymarket.title}  <->  ${op.kalshi.title}`);
  console.log(`  reason: ${op.matchReason}`);
  console.log(`  raw YES gap: ${(op.rawPriceGap ?? op.spread * 100).toFixed(3)}`);
  console.log(`  expected pnl: $${expected.toFixed(2)}`);
  console.log(`  covered-bundle pnl: $${realized.toFixed(2)}`);
}

async function liveSnapshot(): Promise<void> {
  try {
    const [poly, kalshi] = await Promise.all([
      fetchPolymarkets(200, 3),
      fetchKalshiMarkets(400, 3),
    ]);
    const arbs = detectArbitrage([...poly, ...kalshi], 0.03);
    console.log('\nLIVE DATA SNAPSHOT');
    console.log(`  polymarket markets: ${poly.length}`);
    console.log(`  kalshi markets: ${kalshi.length}`);
    console.log(`  valid covered arbs >= 3% edge: ${arbs.length}`);
  } catch (error) {
    console.log('\nLIVE DATA SNAPSHOT');
    console.log(`  unavailable: ${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  const fixtures = [
    market({
      id: 'poly-btc-2025',
      platform: 'polymarket',
      title: 'Will BTC hit $100k in 2025?',
      category: 'crypto',
      yesPrice: 0.55,
      noPrice: 0.45,
      yesAsk: 0.57,
      noAsk: 0.47,
      endDate: '2025-12-31T00:00:00Z',
    }),
    market({
      id: 'kalshi-btc-2026',
      platform: 'kalshi',
      title: 'Will BTC hit $100k in 2026?',
      category: 'crypto',
      yesPrice: 0.65,
      noPrice: 0.35,
      yesAsk: 0.67,
      noAsk: 0.43,
      endDate: '2026-12-31T00:00:00Z',
    }),
    market({
      id: 'poly-fed-june',
      platform: 'polymarket',
      title: 'Will the Fed cut rates in June 2026?',
      category: 'economics',
      yesPrice: 0.42,
      noPrice: 0.58,
      yesAsk: 0.4,
      noAsk: 0.6,
      endDate: '2026-06-30T00:00:00Z',
    }),
    market({
      id: 'kalshi-fed-june',
      platform: 'kalshi',
      title: 'Will the Fed cut rates in June 2026?',
      category: 'economics',
      yesPrice: 0.6,
      noPrice: 0.4,
      yesAsk: 0.62,
      noAsk: 0.5,
      endDate: '2026-06-30T00:00:00Z',
    }),
  ];

  const before = legacyDetect(fixtures);
  const after = detectArbitrage(fixtures, 0.03, COST_BUFFER);

  console.log('MUSASHI CASE STUDY SIMULATION');
  console.log(`position size: $${POSITION_USD}`);
  console.log(`cost buffer: ${(COST_BUFFER * 100).toFixed(1)} cents per bundle`);
  console.log('\nBEFORE: legacy detector');

  let beforeExpected = 0;
  let beforeCovered = 0;
  for (const op of before) {
    const expected = legacyExpectedPnl(op);
    const realized = coveredRealizedPnl(op);
    beforeExpected += expected;
    beforeCovered += realized;
    printTrade('  trade', op, expected, realized);
  }

  console.log(`  trades: ${before.length}`);
  console.log(`  reported pnl: $${beforeExpected.toFixed(2)}`);
  console.log(`  covered-bundle pnl: $${beforeCovered.toFixed(2)}`);

  console.log('\nAFTER: fixed detector');
  let afterPnl = 0;
  for (const op of after) {
    const pnl = fixedPnl(op);
    afterPnl += pnl;
    printTrade('  trade', op, pnl, pnl);
  }
  console.log(`  trades: ${after.length}`);
  console.log(`  modeled pnl: $${afterPnl.toFixed(2)}`);
  console.log(`  improvement vs covered legacy: $${(afterPnl - beforeCovered).toFixed(2)}`);

  if (process.argv.includes('--live')) {
    await liveSnapshot();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
