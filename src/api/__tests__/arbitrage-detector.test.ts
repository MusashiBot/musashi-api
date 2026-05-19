import { areMarketsSimilar, buildBM25Stats } from '../arbitrage-detector';
import { normalizeMinConfidence } from '../../../api/markets/arbitrage';
import { computePriceChange } from '../../../api/lib/price-snapshots';
import { Market } from '../../types/market';

function makeMarket(overrides: Partial<Market> & { id: string; keywords: string[] }): Market {
  return {
    platform: 'polymarket',
    title: '',
    description: '',
    category: 'finance',
    yesPrice: 0.5,
    noPrice: 0.5,
    volume24h: 0,
    url: '',
    lastUpdated: new Date().toISOString(),
    ...overrides,
  };
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

// Test cases for areMarketsSimilar function
// Run with: node --import tsx src/api/__tests__/arbitrage-detector.test.ts

function runTests() {
  console.log('Running areMarketsSimilar tests...\n');

  // Test 1: stop-word-heavy false positive (should be rejected)
  const market1 = makeMarket({
    id: '1',
    platform: 'polymarket',
    title: 'Will the market go up?',
    keywords: ['market', 'will', 'go', 'up', 'price'],
  });
  const market2 = makeMarket({
    id: '2',
    platform: 'kalshi',
    title: 'Will the stock market rise?',
    keywords: ['market', 'will', 'stock', 'rise', 'price'],
  });

  // Test 2: paraphrased title (should still match via title-similarity path)
  const market3 = makeMarket({
    id: '3',
    platform: 'polymarket',
    title: 'Will Apple stock hit $200 by end of 2026?',
    keywords: ['apple', 'stock', 'hit', '200', 'end', '2026'],
  });
  const market4 = makeMarket({
    id: '4',
    platform: 'kalshi',
    title: 'Will Apple stock reach $200 by end of 2026?',
    keywords: ['apple', 'stock', 'reach', '200', 'end', '2026'],
  });

  // Test 3: different categories (category gate should reject)
  const market5 = makeMarket({
    id: '5',
    platform: 'polymarket',
    title: 'Will Tesla stock go up?',
    keywords: ['tesla', 'stock', 'go', 'up'],
  });
  const market6 = makeMarket({
    id: '6',
    platform: 'kalshi',
    title: 'Will Tesla win the race?',
    category: 'sports',
    keywords: ['tesla', 'win', 'race'],
  });

  // Test 4: strong keyword overlap (should match via BM25 path)
  const market7 = makeMarket({
    id: '7',
    platform: 'polymarket',
    title: 'Federal Reserve interest rate decision',
    category: 'economics',
    keywords: ['federal', 'reserve', 'interest', 'rate', 'decision', 'economy', 'policy'],
  });
  const market8 = makeMarket({
    id: '8',
    platform: 'kalshi',
    title: 'Fed rate hike announcement',
    category: 'economics',
    keywords: ['fed', 'rate', 'announcement', 'federal', 'reserve', 'interest', 'policy'],
  });

  // Test 5: rare-term coincidence (should be rejected).
  // Same category, one accidentally shared rare token ("mars"), nothing else
  // in common. Plain overlap-counting would flag this; BM25's self-score
  // normalization keeps the ratio low because each side's unique terms
  // dominate the bound.
  const rareA = makeMarket({
    id: 'rare-a',
    platform: 'polymarket',
    title: 'Will SpaceX launch Starship to Mars in Q3?',
    category: 'tech',
    keywords: ['spacex', 'starship', 'launch', 'q3', 'rocket', 'mars'],
  });
  const rareB = makeMarket({
    id: 'rare-b',
    platform: 'kalshi',
    title: 'Will Apple unveil a new headset?',
    category: 'tech',
    keywords: ['apple', 'headset', 'unveil', 'vision', 'pro', 'mars'],
  });

  // Test 6: high-volume shared-term pair (should still match).
  // The shared tokens ("trump", "2028", "election", "president") are common
  // across the padded corpus below — i.e. low IDF — but the pair still
  // overlaps on ~5/6 keywords, so BM25 normalized similarity stays high.
  const popA = makeMarket({
    id: 'pop-a',
    platform: 'polymarket',
    title: 'Will Trump win the 2028 election?',
    category: 'politics',
    keywords: ['trump', 'election', '2028', 'president', 'win', 'republican'],
  });
  const popB = makeMarket({
    id: 'pop-b',
    platform: 'kalshi',
    title: 'Trump elected president in 2028',
    category: 'politics',
    keywords: ['trump', 'election', '2028', 'president', 'elected', 'republican'],
  });

  // Padding so popular terms in Test 6 actually have low IDF.
  // Without this, df=2 for "trump" would still give it meaningful weight.
  const popPadding = [
    ['trump', 'election', '2028', 'rally', 'iowa'],
    ['trump', 'indictment', '2028', 'court', 'verdict'],
    ['trump', 'president', '2028', 'debate', 'cnn'],
    ['trump', 'election', '2028', 'biden', 'rematch'],
    ['trump', 'election', '2028', 'haley', 'primary'],
  ].map((kws, i) =>
    makeMarket({ id: `pad-${i}`, category: 'politics', keywords: kws })
  );

  // Generic finance-noise padding so common terms ("market", "will", "price",
  // "stock") get high df → low IDF, mirroring the production distribution.
  // Without this the test corpus is too small for IDF to suppress stopwords.
  const financeNoise = [
    ['market', 'will', 'price', 'bond', 'yield'],
    ['market', 'will', 'price', 'spy', 'index'],
    ['market', 'price', 'will', 'bitcoin', 'crypto'],
    ['stock', 'will', 'market', 'nasdaq', 'tech'],
    ['stock', 'market', 'price', 'banking', 'earnings'],
    ['will', 'market', 'stock', 'oil', 'brent'],
    ['market', 'price', 'gold', 'commodity', 'will'],
    ['stock', 'market', 'price', 'russell', 'cap'],
    ['will', 'stock', 'price', 'gain', 'session'],
    ['market', 'will', 'sector', 'price', 'momentum'],
  ].map((kws, i) =>
    makeMarket({ id: `noise-${i}`, category: 'finance', keywords: kws })
  );

  const corpus = [
    market1, market2, market3, market4, market5, market6, market7, market8,
    rareA, rareB, popA, popB, ...popPadding, ...financeNoise,
  ];
  const stats = buildBM25Stats(corpus);

  const result1 = areMarketsSimilar(market1, market2, stats);
  console.log('Test 1 - Stop-word-heavy false positive (should be rejected):');
  console.log(`  "${market1.title}" vs "${market2.title}"`);
  console.log(`  Result: ${result1.isSimilar ? 'MATCH' : 'NO MATCH'} - ${result1.reason}\n`);
  assert(!result1.isSimilar, 'Test 1: expected NO MATCH for stop-word-heavy pair');

  const result2 = areMarketsSimilar(market3, market4, stats);
  console.log('Test 2 - Paraphrased title (should match):');
  console.log(`  "${market3.title}" vs "${market4.title}"`);
  console.log(`  Result: ${result2.isSimilar ? 'MATCH' : 'NO MATCH'} - ${result2.reason}\n`);
  assert(result2.isSimilar, 'Test 2: expected MATCH for paraphrased titles');

  const result3 = areMarketsSimilar(market5, market6, stats);
  console.log('Test 3 - Different categories (should be rejected):');
  console.log(`  "${market5.title}" (${market5.category}) vs "${market6.title}" (${market6.category})`);
  console.log(`  Result: ${result3.isSimilar ? 'MATCH' : 'NO MATCH'} - ${result3.reason}\n`);
  assert(!result3.isSimilar, 'Test 3: expected NO MATCH across categories');

  const result4 = areMarketsSimilar(market7, market8, stats);
  console.log('Test 4 - Strong keyword overlap via BM25 (should match):');
  console.log(`  "${market7.title}" vs "${market8.title}"`);
  console.log(`  Result: ${result4.isSimilar ? 'MATCH' : 'NO MATCH'} - ${result4.reason}\n`);
  assert(result4.isSimilar, 'Test 4: expected MATCH for Fed/Federal Reserve overlap');

  const resultRare = areMarketsSimilar(rareA, rareB, stats);
  console.log('Test 5 - Rare-term coincidence (should be rejected):');
  console.log(`  "${rareA.title}" vs "${rareB.title}"`);
  console.log(`  Shared keyword: mars (single rare-term coincidence)`);
  console.log(`  Result: ${resultRare.isSimilar ? 'MATCH' : 'NO MATCH'} - ${resultRare.reason}\n`);
  assert(!resultRare.isSimilar, 'Test 5: expected NO MATCH for rare-term coincidence');

  const resultPop = areMarketsSimilar(popA, popB, stats);
  console.log('Test 6 - High-volume shared-term pair (should match):');
  console.log(`  "${popA.title}" vs "${popB.title}"`);
  console.log(`  Padded corpus inflates df for trump/2028/election/president`);
  console.log(`  Result: ${resultPop.isSimilar ? 'MATCH' : 'NO MATCH'} - ${resultPop.reason}\n`);
  assert(resultPop.isSimilar, 'Test 6: expected MATCH for high-volume shared-term pair');

  // Test 7: minConfidence clamp floor
  const minConfidenceClampResult = 0.1;
  const effectiveClamp = normalizeMinConfidence(minConfidenceClampResult);
  assertEqual(effectiveClamp, 0.5, 'minConfidence clamp should enforce a 0.5 floor');
  console.log('Test 7 - minConfidence clamp behavior confirmed.');
  console.log(`  Requested: ${minConfidenceClampResult} → Effective: ${effectiveClamp}\n`);

  // Test 8: Price change normalization
  const now = Date.now();
  const snapshots = [
    { marketId: 'test', yesPrice: 0.4, timestamp: now - 90 * 60 * 1000 },
    { marketId: 'test', yesPrice: 0.5, timestamp: now },
  ];
  const priceChangeResult = computePriceChange(snapshots, 1);
  const expectedNormalizedChange = (0.5 - 0.4) * (1 / 1.5);
  assertEqual(priceChangeResult?.change, expectedNormalizedChange, 'Price change should be normalized by actual elapsed time');
  console.log('Test 8 - Price change normalization confirmed.');
  console.log(`  Raw 0.1 over 1.5h → normalized ${priceChangeResult?.change}\n`);

  console.log('All tests passed.');
}

if (require.main === module) {
  runTests();
}
