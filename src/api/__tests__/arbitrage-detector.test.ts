import { areMarketsSimilar } from '../arbitrage-detector';
import { normalizeMinConfidence } from '../../../api/markets/arbitrage';
import { computePriceChange } from '../../../api/lib/price-snapshots';
import { Market } from '../../types/market';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// Test cases for areMarketsSimilar function
// Run with: node --import tsx src/api/__tests__/arbitrage-detector.test.ts

function runTests() {
  console.log('Running areMarketsSimilar tests...\n');

  // Test case 1: False positive that should now be rejected
  // Previously matched due to low keyword threshold + stop words
  const market1: Market = {
    id: '1',
    platform: 'polymarket',
    title: 'Will the market go up?',
    category: 'finance',
    yesPrice: 0.5,
    url: '',
    keywords: ['market', 'will', 'go', 'up', 'price'], // Common stop words
    volume24h: 0,
    createdAt: new Date().toISOString(),
  };

  const market2: Market = {
    id: '2',
    platform: 'kalshi',
    title: 'Will the stock market rise?',
    category: 'finance',
    yesPrice: 0.6,
    url: '',
    keywords: ['market', 'will', 'stock', 'rise', 'price'], // Common stop words
    volume24h: 0,
    createdAt: new Date().toISOString(),
  };

  const result1 = areMarketsSimilar(market1, market2);
  console.log('Test 1 - False positive (should be rejected):');
  console.log(`  Market1: "${market1.title}"`);
  console.log(`  Market2: "${market2.title}"`);
  console.log(`  Keywords1: [${market1.keywords.join(', ')}]`);
  console.log(`  Keywords2: [${market2.keywords.join(', ')}]`);
  console.log(`  Result: ${result1.isSimilar ? 'MATCH' : 'NO MATCH'} - ${result1.reason}`);
  console.log(`  Expected: NO MATCH (filtered stop words, low overlap)\n`);

  // Test case 2: True match that should still pass
  // High title similarity
  const market3: Market = {
    id: '3',
    platform: 'polymarket',
    title: 'Will Apple stock hit $200 by end of 2026?',
    category: 'finance',
    yesPrice: 0.5,
    url: '',
    keywords: ['apple', 'stock', 'hit', '200', 'end', '2026'],
    volume24h: 0,
    createdAt: new Date().toISOString(),
  };

  const market4: Market = {
    id: '4',
    platform: 'kalshi',
    title: 'Will Apple stock reach $200 by end of 2026?',
    category: 'finance',
    yesPrice: 0.55,
    url: '',
    keywords: ['apple', 'stock', 'reach', '200', 'end', '2026'],
    volume24h: 0,
    createdAt: new Date().toISOString(),
  };

  const result2 = areMarketsSimilar(market3, market4);
  console.log('Test 2 - True match (should pass):');
  console.log(`  Market3: "${market3.title}"`);
  console.log(`  Market4: "${market4.title}"`);
  console.log(`  Keywords3: [${market3.keywords.join(', ')}]`);
  console.log(`  Keywords4: [${market4.keywords.join(', ')}]`);
  console.log(`  Result: ${result2.isSimilar ? 'MATCH' : 'NO MATCH'} - ${result2.reason}`);
  console.log(`  Expected: MATCH (high title similarity)\n`);

  // Test case 3: Different categories (should be rejected)
  const market5: Market = {
    id: '5',
    platform: 'polymarket',
    title: 'Will Tesla stock go up?',
    category: 'finance',
    yesPrice: 0.5,
    url: '',
    keywords: ['tesla', 'stock', 'go', 'up'],
    volume24h: 0,
    createdAt: new Date().toISOString(),
  };

  const market6: Market = {
    id: '6',
    platform: 'kalshi',
    title: 'Will Tesla win the race?',
    category: 'sports',
    yesPrice: 0.5,
    url: '',
    keywords: ['tesla', 'win', 'race'],
    volume24h: 0,
    createdAt: new Date().toISOString(),
  };

  const result3 = areMarketsSimilar(market5, market6);
  console.log('Test 3 - Different categories (should be rejected):');
  console.log(`  Market5: "${market5.title}" (category: ${market5.category})`);
  console.log(`  Market6: "${market6.title}" (category: ${market6.category})`);
  console.log(`  Result: ${result3.isSimilar ? 'MATCH' : 'NO MATCH'} - ${result3.reason}`);
  console.log(`  Expected: NO MATCH (different categories)\n`);

  // Test case 4: minConfidence clamp behavior should keep the floor at 0.5
  const minConfidenceClampResult = 0.1;
  const effectiveClamp = normalizeMinConfidence(minConfidenceClampResult);
  assertEqual(effectiveClamp, 0.5, 'minConfidence clamp should enforce a 0.5 floor');
  console.log('Test 4 - minConfidence clamp behavior confirmed.');
  console.log(`  Requested minConfidence: ${minConfidenceClampResult}`);
  console.log(`  Effective minConfidence: ${effectiveClamp}`);
  console.log(`  Expected: 0.5 floor enforced\n`);

  // Test case 5: Strong keyword overlap (should pass with new threshold)
  const market7: Market = {
    id: '7',
    platform: 'polymarket',
    title: 'Federal Reserve interest rate decision',
    category: 'economics',
    yesPrice: 0.5,
    url: '',
    keywords: ['federal', 'reserve', 'interest', 'rate', 'decision', 'economy', 'policy'],
    volume24h: 0,
    createdAt: new Date().toISOString(),
  };

  const market8: Market = {
    id: '8',
    platform: 'kalshi',
    title: 'Fed rate hike announcement',
    category: 'economics',
    yesPrice: 0.5,
    url: '',
    keywords: ['fed', 'rate', 'announcement', 'federal', 'reserve', 'interest', 'policy'],
    volume24h: 0,
    createdAt: new Date().toISOString(),
  };

  const result4 = areMarketsSimilar(market7, market8);
  console.log('Test 4 - Strong keyword overlap (should pass):');
  console.log(`  Market7: "${market7.title}"`);
  console.log(`  Market8: "${market8.title}"`);
  console.log(`  Keywords7: [${market7.keywords.join(', ')}]`);
  console.log(`  Keywords8: [${market8.keywords.join(', ')}]`);
  console.log(`  Result: ${result4.isSimilar ? 'MATCH' : 'NO MATCH'} - ${result4.reason}`);
  console.log(`  Expected: MATCH (5+ shared keywords after filtering)\n`);

  // Test case 6: Price change normalization
  const now = Date.now();
  const snapshots = [
    { marketId: 'test', yesPrice: 0.4, timestamp: now - 90 * 60 * 1000 }, // 90 min ago
    { marketId: 'test', yesPrice: 0.5, timestamp: now }, // current
  ];
  const priceChangeResult = computePriceChange(snapshots, 1);
  const expectedNormalizedChange = (0.5 - 0.4) * (1 / 1.5); // raw change 0.1 over 1.5h, normalized to 1h
  assertEqual(priceChangeResult?.change, expectedNormalizedChange, 'Price change should be normalized by actual elapsed time');
  console.log('Test 6 - Price change normalization confirmed.');
  console.log(`  Snapshots: 0.4 at 90min ago, 0.5 now`);
  console.log(`  Raw change: 0.1 over 1.5h`);
  console.log(`  Normalized change: ${priceChangeResult?.change} (expected: ${expectedNormalizedChange})`);
  console.log(`  Expected: Normalized to 1h equivalent\n`);

  // Test case 7: minChange validation (would return 400 for < 0.02)
  const invalidMinChange = 0.01;
  console.log('Test 7 - minChange validation (API would return 400):');
  console.log(`  Requested minChange: ${invalidMinChange}`);
  console.log(`  Expected: 400 error "minChange must be at least 0.02"`);
  console.log(`  (This is validated in the API handler, not in unit tests)\n`);

  console.log('Tests completed.');
}

// Run tests if this file is executed directly
if (require.main === module) {
  runTests();
}