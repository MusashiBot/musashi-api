/**
 * Smoke test: critical modules must import without throwing.
 * Catches issues like optional native deps (sharp) loading at module scope.
 *
 * Run: pnpm test:smoke
 */

import test from 'node:test';
import assert from 'node:assert/strict';

test('market-cache imports without side effects', async () => {
  const mod = await import('../api/lib/market-cache');
  assert.equal(typeof mod.getMarkets, 'function');
  assert.equal(typeof mod.getArbitrage, 'function');
});

test('arbitrage-detector imports (semantic matcher lazy-loads transformers)', async () => {
  const mod = await import('../src/api/arbitrage-detector');
  assert.equal(typeof mod.detectArbitrage, 'function');
});

test('signal-generator imports', async () => {
  const mod = await import('../src/analysis/signal-generator');
  assert.equal(typeof mod.generateSignal, 'function');
});

test('polymarket websocket client does not connect without MUSASHI_POLYMARKET_WS=1', async () => {
  delete process.env.MUSASHI_POLYMARKET_WS;
  const mod = await import('../src/api/polymarket-websocket-client');
  assert.equal(mod.isWebSocketConnected(), false);
  const prices = mod.getWebSocketPrices(['123']);
  assert.equal(prices.size, 0);
});
