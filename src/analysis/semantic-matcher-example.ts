/**
 * Example usage of semantic market matching
 * 
 * This demonstrates how to:
 * 1. Pre-compute embeddings for markets
 * 2. Find semantically similar markets
 * 3. Compute pairwise market similarity
 */

import { Market } from '../types/market';
import {
  embedMarkets,
  findSemanticMatches,
  computeMarketSimilarity,
  getCacheStats,
  clearEmbeddingCache,
} from './semantic-matcher';

// Example markets
const exampleMarkets: Market[] = [
  {
    id: 'poly-1',
    platform: 'polymarket',
    title: 'Will the Fed cut interest rates in March 2026?',
    description: 'Resolves YES if the Federal Reserve cuts rates by at least 25bps',
    keywords: ['fed', 'interest rates', 'march'],
    yesPrice: 0.65,
    noPrice: 0.35,
    volume24h: 50000,
    url: 'https://polymarket.com/example-1',
    category: 'economics',
    lastUpdated: '2026-04-18T00:00:00Z',
  },
  {
    id: 'kalshi-1',
    platform: 'kalshi',
    title: 'Will FOMC reduce rates before April 2026?',
    description: 'This market resolves YES if the Federal Open Market Committee cuts the federal funds rate',
    keywords: ['fomc', 'rates', 'march'],
    yesPrice: 0.62,
    noPrice: 0.38,
    volume24h: 30000,
    url: 'https://kalshi.com/example-1',
    category: 'economics',
    lastUpdated: '2026-04-18T00:00:00Z',
  },
  {
    id: 'poly-2',
    platform: 'polymarket',
    title: 'Will Bitcoin hit $100k by June 2026?',
    description: 'Resolves YES if BTC reaches $100,000',
    keywords: ['bitcoin', 'crypto', 'price'],
    yesPrice: 0.45,
    noPrice: 0.55,
    volume24h: 100000,
    url: 'https://polymarket.com/example-2',
    category: 'crypto',
    lastUpdated: '2026-04-18T00:00:00Z',
  },
];

/**
 * Example 1: Pre-compute embeddings for all markets
 * This should be done once when markets are loaded
 */
async function example1_PreComputeEmbeddings() {
  console.log('\n=== Example 1: Pre-compute Embeddings ===\n');
  
  const results = await embedMarkets(exampleMarkets);
  
  console.log(`Embedded ${results.length} markets`);
  console.log('Sample embedding (first 5 dimensions):');
  console.log(results[0].embedding.slice(0, 5));
  
  const stats = getCacheStats();
  console.log(`\nCache stats: ${stats.size} markets cached`);
}

/**
 * Example 2: Find similar markets using semantic search
 */
async function example2_FindSimilarMarkets() {
  console.log('\n=== Example 2: Find Similar Markets ===\n');
  
  // Pre-compute embeddings first
  await embedMarkets(exampleMarkets);
  
  // Search for markets similar to a query
  const query = 'Federal Reserve interest rate decision';
  console.log(`Query: "${query}"\n`);
  
  const matches = await findSemanticMatches(query, exampleMarkets, 3);
  
  console.log('Top matches:');
  matches.forEach((match, idx) => {
    console.log(`\n${idx + 1}. ${match.market.title}`);
    console.log(`   Similarity: ${(match.similarity * 100).toFixed(1)}%`);
    console.log(`   Platform: ${match.market.platform}`);
  });
}

/**
 * Example 3: Compute pairwise similarity between two markets
 * This is useful for arbitrage detection
 */
async function example3_PairwiseSimilarity() {
  console.log('\n=== Example 3: Pairwise Similarity ===\n');
  
  // Pre-compute embeddings
  await embedMarkets(exampleMarkets);
  
  const market1 = exampleMarkets[0]; // Poly Fed market
  const market2 = exampleMarkets[1]; // Kalshi FOMC market
  
  console.log(`Market 1: ${market1.title}`);
  console.log(`Market 2: ${market2.title}\n`);
  
  const similarity = await computeMarketSimilarity(market1, market2);
  
  console.log(`Semantic similarity: ${(similarity * 100).toFixed(1)}%`);
  
  if (similarity >= 0.75) {
    console.log('✓ High confidence match - likely the same event');
  } else if (similarity >= 0.65) {
    console.log('⚠ Moderate match - may be related events');
  } else {
    console.log('✗ Low similarity - different events');
  }
  
  // Compare with an unrelated market
  const market3 = exampleMarkets[2]; // Bitcoin market
  console.log(`\nMarket 3: ${market3.title}`);
  
  const similarity2 = await computeMarketSimilarity(market1, market3);
  console.log(`Similarity to Market 1: ${(similarity2 * 100).toFixed(1)}%`);
}

/**
 * Example 4: Integration with arbitrage detection workflow
 */
async function example4_ArbitrageWorkflow() {
  console.log('\n=== Example 4: Arbitrage Detection Workflow ===\n');
  
  // Step 1: Pre-compute embeddings for all markets
  console.log('Step 1: Pre-computing embeddings...');
  await embedMarkets(exampleMarkets);
  
  const polymarkets = exampleMarkets.filter(m => m.platform === 'polymarket');
  const kalshiMarkets = exampleMarkets.filter(m => m.platform === 'kalshi');
  
  console.log(`Found ${polymarkets.length} Polymarket × ${kalshiMarkets.length} Kalshi markets\n`);
  
  // Step 2: Find potential arbitrage pairs
  console.log('Step 2: Finding arbitrage pairs...\n');
  
  for (const poly of polymarkets) {
    for (const kalshi of kalshiMarkets) {
      const similarity = await computeMarketSimilarity(poly, kalshi);
      
      if (similarity >= 0.65) {
        const spread = Math.abs(poly.yesPrice - kalshi.yesPrice);
        
        console.log(`Potential arbitrage:`);
        console.log(`  ${poly.title} (${poly.platform})`);
        console.log(`  ${kalshi.title} (${kalshi.platform})`);
        console.log(`  Similarity: ${(similarity * 100).toFixed(1)}%`);
        console.log(`  Spread: ${(spread * 100).toFixed(1)}%`);
        console.log(`  Poly YES: ${(poly.yesPrice * 100).toFixed(1)}%`);
        console.log(`  Kalshi YES: ${(kalshi.yesPrice * 100).toFixed(1)}%\n`);
      }
    }
  }
  
  // Step 3: Show cache efficiency
  const stats = getCacheStats();
  console.log(`Cache contains ${stats.size} embeddings (no recomputation needed)`);
}

/**
 * Run all examples
 */
async function runAllExamples() {
  try {
    await example1_PreComputeEmbeddings();
    
    // Clear cache between examples to demonstrate fresh computation
    clearEmbeddingCache();
    
    await example2_FindSimilarMarkets();
    await example3_PairwiseSimilarity();
    await example4_ArbitrageWorkflow();
    
    console.log('\n=== All examples completed successfully ===\n');
  } catch (error) {
    console.error('Error running examples:', error);
    process.exit(1);
  }
}

// Run examples if this file is executed directly
if (require.main === module) {
  runAllExamples();
}

export {
  example1_PreComputeEmbeddings,
  example2_FindSimilarMarkets,
  example3_PairwiseSimilarity,
  example4_ArbitrageWorkflow,
};
