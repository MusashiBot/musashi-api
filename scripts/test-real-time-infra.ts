/**
 * Test script for real-time data infrastructure
 * Demonstrates WebSocket client, order book fetching, and market cache integration
 */

import {
  getWebSocketPrices,
  isWebSocketConnected,
  getWebSocketOrderBook,
  getAllWebSocketOrderBooks,
  disconnectWebSocket,
} from '../src/api/polymarket-websocket-client';

import {
  fetchOrderBookDepth,
  fetchPolymarketPrice,
} from '../src/api/polymarket-price-poller';

import {
  getMarkets,
  getOrderBookForMarket,
} from '../api/lib/market-cache';

/**
 * Test 1: Basic WebSocket Connection
 */
async function testWebSocketConnection() {
  console.log('\n=== Test 1: WebSocket Connection ===');
  
  // Give WebSocket time to connect
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const isConnected = isWebSocketConnected();
  console.log(`WebSocket connected: ${isConnected}`);
  
  if (!isConnected) {
    console.warn('⚠️  WebSocket not connected - tests may be limited');
  }
}

/**
 * Test 2: Fetch Order Book via REST API
 */
async function testRestOrderBook() {
  console.log('\n=== Test 2: REST API Order Book ===');
  
  // Use a known Polymarket token ID (example - you may need to replace with actual ID)
  const tokenId = '21742633143463906290569050155826241533067272736897614950488156847949938836455';
  
  console.log(`Fetching order book for token: ${tokenId}`);
  const orderBook = await fetchOrderBookDepth(tokenId);
  
  if (orderBook) {
    console.log('✓ Order book fetched successfully:');
    console.log(`  Bid: ${orderBook.bid.toFixed(4)}`);
    console.log(`  Ask: ${orderBook.ask.toFixed(4)}`);
    console.log(`  Mid: ${orderBook.midPrice.toFixed(4)}`);
    console.log(`  Spread: ${orderBook.spread.toFixed(4)} (${orderBook.spreadBps.toFixed(0)} bps)`);
    console.log(`  Bid Size: ${orderBook.bidSize}`);
    console.log(`  Ask Size: ${orderBook.askSize}`);
  } else {
    console.log('✗ Failed to fetch order book');
  }
}

/**
 * Test 3: Fetch Simple Price via REST API
 */
async function testRestPrice() {
  console.log('\n=== Test 3: REST API Simple Price ===');
  
  const tokenId = '21742633143463906290569050155826241533067272736897614950488156847949938836455';
  
  console.log(`Fetching price for token: ${tokenId}`);
  const price = await fetchPolymarketPrice(tokenId);
  
  if (price !== null) {
    console.log(`✓ Price: ${price.toFixed(4)} (${(price * 100).toFixed(2)}%)`);
  } else {
    console.log('✗ Failed to fetch price');
  }
}

/**
 * Test 4: WebSocket Price Subscription
 */
async function testWebSocketPrices() {
  console.log('\n=== Test 4: WebSocket Price Subscription ===');
  
  if (!isWebSocketConnected()) {
    console.log('⚠️  Skipping - WebSocket not connected');
    return;
  }
  
  // Subscribe to some token IDs
  const tokenIds = [
    '21742633143463906290569050155826241533067272736897614950488156847949938836455',
    '71321045679252212594626385532706912750332728571942532289631379312455583992563',
  ];
  
  console.log(`Subscribing to ${tokenIds.length} tokens...`);
  const prices = getWebSocketPrices(tokenIds);
  
  console.log(`Received ${prices.size} prices from WebSocket:`);
  prices.forEach((price, tokenId) => {
    console.log(`  ${tokenId.substring(0, 12)}...: ${price.toFixed(4)}`);
  });
  
  if (prices.size === 0) {
    console.log('⚠️  No prices available yet - data may arrive after subscription');
  }
}

/**
 * Test 5: WebSocket Order Book Snapshot
 */
async function testWebSocketOrderBook() {
  console.log('\n=== Test 5: WebSocket Order Book Snapshot ===');
  
  if (!isWebSocketConnected()) {
    console.log('⚠️  Skipping - WebSocket not connected');
    return;
  }
  
  const tokenId = '21742633143463906290569050155826241533067272736897614950488156847949938836455';
  
  console.log(`Fetching WebSocket orderbook for token: ${tokenId.substring(0, 12)}...`);
  const orderBook = getWebSocketOrderBook(tokenId, 10000); // 10s max age
  
  if (orderBook) {
    console.log('✓ WebSocket order book:');
    console.log(`  Bid: ${orderBook.bid.toFixed(4)}`);
    console.log(`  Ask: ${orderBook.ask.toFixed(4)}`);
    console.log(`  Mid: ${orderBook.price.toFixed(4)}`);
    console.log(`  Spread: ${orderBook.spread.toFixed(4)}`);
    console.log(`  Age: ${Date.now() - orderBook.lastUpdated.getTime()}ms`);
  } else {
    console.log('⚠️  No WebSocket order book available (may not have received data yet)');
  }
}

/**
 * Test 6: Market Cache Integration
 */
async function testMarketCacheIntegration() {
  console.log('\n=== Test 6: Market Cache Integration ===');
  
  console.log('Fetching markets from cache...');
  const markets = await getMarkets();
  
  console.log(`✓ Fetched ${markets.length} markets`);
  
  const polymarkets = markets.filter(m => m.platform === 'polymarket' && m.numericId);
  console.log(`  ${polymarkets.length} Polymarket markets with numeric IDs`);
  
  if (polymarkets.length > 0) {
    const sampleMarket = polymarkets[0];
    console.log(`\nSample market: ${sampleMarket.title.substring(0, 50)}...`);
    console.log(`  ID: ${sampleMarket.id}`);
    console.log(`  Token ID: ${sampleMarket.numericId}`);
    console.log(`  Price: ${sampleMarket.yesPrice}`);
    console.log(`  Last updated: ${sampleMarket.lastUpdated}`);
  }
}

/**
 * Test 7: Hybrid Order Book (Cache → WS → REST)
 */
async function testHybridOrderBook() {
  console.log('\n=== Test 7: Hybrid Order Book (Cache → WS → REST) ===');
  
  // First fetch markets to populate cache
  const markets = await getMarkets();
  const polymarkets = markets.filter(m => m.platform === 'polymarket' && m.numericId);
  
  if (polymarkets.length === 0) {
    console.log('✗ No Polymarket markets available');
    return;
  }
  
  const sampleMarket = polymarkets[0];
  console.log(`Fetching order book for: ${sampleMarket.title.substring(0, 50)}...`);
  console.log(`Market ID: ${sampleMarket.id}`);
  
  const orderBook = await getOrderBookForMarket(sampleMarket.id);
  
  if (orderBook) {
    console.log('✓ Order book fetched:');
    console.log(`  Bid: ${orderBook.bid.toFixed(4)}`);
    console.log(`  Ask: ${orderBook.ask.toFixed(4)}`);
    console.log(`  Mid: ${orderBook.midPrice.toFixed(4)}`);
    console.log(`  Spread: ${orderBook.spreadBps.toFixed(0)} bps`);
    console.log(`  Source: ${isWebSocketConnected() ? 'WebSocket (preferred)' : 'REST API (fallback)'}`);
  } else {
    console.log('✗ Failed to fetch order book');
  }
}

/**
 * Test 8: All Cached WebSocket Order Books
 */
async function testAllWebSocketOrderBooks() {
  console.log('\n=== Test 8: All Cached WebSocket Order Books ===');
  
  if (!isWebSocketConnected()) {
    console.log('⚠️  Skipping - WebSocket not connected');
    return;
  }
  
  const allOrderBooks = getAllWebSocketOrderBooks();
  console.log(`Cached WebSocket order books: ${allOrderBooks.size}`);
  
  if (allOrderBooks.size > 0) {
    console.log('\nSample orderbooks:');
    let count = 0;
    for (const [tokenId, orderBook] of allOrderBooks) {
      if (count >= 3) break; // Show first 3
      console.log(`\n  Token: ${tokenId.substring(0, 12)}...`);
      console.log(`  Bid: ${orderBook.bid.toFixed(4)}, Ask: ${orderBook.ask.toFixed(4)}`);
      console.log(`  Age: ${Date.now() - orderBook.lastUpdated.getTime()}ms`);
      count++;
    }
  }
}

/**
 * Main test runner
 */
async function main() {
  console.log('🚀 Real-Time Data Infrastructure Tests\n');
  console.log('This will test:');
  console.log('  - WebSocket connection and subscriptions');
  console.log('  - REST API order book fetching');
  console.log('  - Market cache integration');
  console.log('  - Hybrid data source selection');
  
  try {
    await testWebSocketConnection();
    await testRestOrderBook();
    await testRestPrice();
    
    // Wait a bit for WebSocket to potentially receive data
    console.log('\n⏳ Waiting 3s for WebSocket data...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    await testWebSocketPrices();
    await testWebSocketOrderBook();
    await testMarketCacheIntegration();
    await testHybridOrderBook();
    await testAllWebSocketOrderBooks();
    
    console.log('\n✅ All tests completed!');
    
    // Cleanup
    console.log('\n🧹 Disconnecting WebSocket...');
    disconnectWebSocket();
    console.log('✓ Cleanup complete');
    
  } catch (error) {
    console.error('\n❌ Test error:', error);
    disconnectWebSocket();
    process.exit(1);
  }
}

// Run tests
main();
