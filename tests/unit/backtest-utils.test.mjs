import test from 'node:test';
import assert from 'node:assert/strict';

const historicalModule = await import('../../scripts/backtest/historical-data-fetcher.ts');
const calculatePriceStats =
  historicalModule?.calculatePriceStats ?? historicalModule?.default?.calculatePriceStats;

test('calculatePriceStats handles large histories without min/max spread overflow', () => {
  const snapshots = [];
  const start = Date.now() - 1_000_000;

  for (let i = 0; i < 150_000; i++) {
    snapshots.push({
      marketId: 'mkt-large',
      yesPrice: 0.2 + ((i % 1000) / 2000),
      timestamp: start + i,
    });
  }

  const stats = calculatePriceStats(snapshots);

  assert.equal(stats.sampleSize, 150_000);
  assert.ok(stats.min >= 0.2);
  assert.ok(stats.max <= 0.7);
  assert.ok(stats.max >= stats.min);
  assert.ok(Number.isFinite(stats.mean));
  assert.ok(Number.isFinite(stats.volatility));
});
