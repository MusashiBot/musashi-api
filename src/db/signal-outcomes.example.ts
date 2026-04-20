/**
 * Example usage of the Signal Outcome Tracking System
 * 
 * This demonstrates how to:
 * - Log signals (happens automatically in signal-generator)
 * - Update resolutions when markets resolve
 * - Query performance metrics
 * - Monitor unresolved signals
 */

import { 
  logSignal, 
  updateResolution, 
  getUnresolvedSignals, 
  getRecentPerformance 
} from './signal-outcomes';
import { generateSignal } from '../analysis/signal-generator';
import { Market, MarketMatch } from '../types/market';

// ─── Example 1: Generate and Log a Signal ────────────────────────────────────

async function exampleGenerateAndLogSignal() {
  // Example market data
  const market: Market = {
    id: 'poly-btc-100k-2026',
    platform: 'polymarket',
    title: 'Will Bitcoin reach $100k by end of 2026?',
    description: 'Resolves YES if BTC trades at $100k or higher on any major exchange by Dec 31, 2026',
    keywords: ['bitcoin', 'btc', 'cryptocurrency', '100k'],
    yesPrice: 0.65,
    noPrice: 0.35,
    volume24h: 1_250_000,
    url: 'https://polymarket.com/event/btc-100k-2026',
    category: 'Crypto',
    lastUpdated: new Date().toISOString(),
    numericId: '12345',
    oneDayPriceChange: 0.05,
    endDate: '2026-12-31T23:59:59Z',
    is_anomalous: false,
  };

  const match: MarketMatch = {
    market,
    confidence: 0.92,
    matchedKeywords: ['bitcoin', 'btc', '100k'],
  };

  const tweetText = 'BREAKING: Major institutional investor announces massive Bitcoin purchase. BTC to $100k incoming! 🚀';

  // Generate signal (automatically logs in background)
  const signal = generateSignal(tweetText, [match]);

  console.log('Generated signal:', {
    event_id: signal.event_id,
    signal_type: signal.signal_type,
    urgency: signal.urgency,
    direction: signal.suggested_action?.direction,
    confidence: signal.suggested_action?.confidence,
    edge: signal.suggested_action?.edge,
  });

  // Note: Signal is already logged via generateSignal!
  // But if you need to log manually with additional features:
  const signalId = await logSignal(signal, {
    custom_feature_1: 'example',
    analyst_note: 'High conviction bullish signal',
  });

  console.log('Signal logged with ID:', signalId);

  return signalId;
}

// ─── Example 2: Monitor and Resolve Signals ──────────────────────────────────

async function exampleMonitorAndResolve() {
  // Get all signals waiting for resolution
  const unresolved = await getUnresolvedSignals();

  console.log(`Found ${unresolved.length} unresolved signals`);

  // Example: resolve the oldest signal
  if (unresolved.length > 0) {
    const oldestSignal = unresolved[0];

    console.log('Resolving signal:', {
      signal_id: oldestSignal.signal_id,
      event_id: oldestSignal.event_id,
      market_id: oldestSignal.market_id,
      predicted_direction: oldestSignal.predicted_direction,
      age_days: (Date.now() - new Date(oldestSignal.created_at).getTime()) / 86_400_000,
    });

    // In a real system, you would fetch the actual market resolution
    // For this example, let's simulate a correct prediction
    const actualOutcome: 'YES' | 'NO' = 'YES';
    const wasCorrect = oldestSignal.predicted_direction === actualOutcome;
    
    // Calculate PnL (example: simple Kelly position sizing)
    const positionSize = 0.05; // 5% of capital
    const profit = wasCorrect ? positionSize * oldestSignal.edge : -positionSize;

    const success = await updateResolution(
      oldestSignal.signal_id,
      actualOutcome,
      wasCorrect,
      profit
    );

    console.log(`Resolution update ${success ? 'succeeded' : 'failed'}`);
  }
}

// ─── Example 3: Analyze Performance ──────────────────────────────────────────

async function exampleAnalyzePerformance() {
  // Get performance metrics for the last 30 days
  const metrics = await getRecentPerformance(30);

  if (!metrics) {
    console.log('No performance data available');
    return;
  }

  console.log('\n=== Performance Report (Last 30 Days) ===\n');

  console.log('Overall Statistics:');
  console.log(`  Total Signals: ${metrics.total_signals}`);
  console.log(`  Resolved: ${metrics.resolved_signals}`);
  console.log(`  Unresolved: ${metrics.unresolved_signals}`);
  console.log(`  Win Rate: ${(metrics.win_rate * 100).toFixed(1)}%`);
  console.log(`  Avg Confidence: ${(metrics.avg_confidence * 100).toFixed(1)}%`);
  console.log(`  Avg Edge: ${(metrics.avg_edge * 100).toFixed(1)}%`);
  console.log(`  Brier Score: ${metrics.brier_score.toFixed(3)} (lower is better)`);
  console.log(`  Total PnL: $${metrics.total_pnl.toFixed(2)}`);
  console.log(`  Avg PnL per Signal: $${metrics.avg_pnl.toFixed(2)}`);

  console.log('\nPerformance by Signal Type:');
  for (const [type, stats] of Object.entries(metrics.by_signal_type)) {
    console.log(`  ${type}:`);
    console.log(`    Count: ${stats.count}`);
    console.log(`    Win Rate: ${(stats.win_rate * 100).toFixed(1)}%`);
    console.log(`    Avg PnL: $${stats.avg_pnl.toFixed(2)}`);
  }

  console.log('\nPerformance by Platform:');
  for (const [platform, stats] of Object.entries(metrics.by_platform)) {
    console.log(`  ${platform}:`);
    console.log(`    Count: ${stats.count}`);
    console.log(`    Win Rate: ${(stats.win_rate * 100).toFixed(1)}%`);
    console.log(`    Avg PnL: $${stats.avg_pnl.toFixed(2)}`);
  }
}

// ─── Example 4: Build a Resolution Monitor ───────────────────────────────────

async function exampleResolutionMonitor() {
  console.log('Running resolution monitor...\n');

  const unresolved = await getUnresolvedSignals();

  for (const signal of unresolved) {
    const ageHours = (Date.now() - new Date(signal.created_at).getTime()) / 3_600_000;
    
    console.log(`Signal ${signal.signal_id}:`);
    console.log(`  Market: ${signal.market_id}`);
    console.log(`  Platform: ${signal.platform}`);
    console.log(`  Age: ${ageHours.toFixed(1)}h`);
    console.log(`  Predicted: ${signal.predicted_direction} (${(signal.confidence * 100).toFixed(0)}% conf)`);

    // In production, you would check if the market has resolved:
    // const resolution = await checkMarketResolution(signal.market_id, signal.platform);
    // if (resolution) { await updateResolution(...); }
  }

  console.log(`\nTotal unresolved signals: ${unresolved.length}`);
}

// ─── Run Examples ─────────────────────────────────────────────────────────────

async function main() {
  try {
    console.log('=== Signal Outcome Tracking Examples ===\n');

    // Example 1: Generate and log a signal
    console.log('\n--- Example 1: Generate and Log Signal ---');
    const signalId = await exampleGenerateAndLogSignal();

    // Example 2: Monitor and resolve signals
    console.log('\n--- Example 2: Monitor and Resolve ---');
    await exampleMonitorAndResolve();

    // Example 3: Analyze performance
    console.log('\n--- Example 3: Performance Analysis ---');
    await exampleAnalyzePerformance();

    // Example 4: Resolution monitor
    console.log('\n--- Example 4: Resolution Monitor ---');
    await exampleResolutionMonitor();

  } catch (error) {
    console.error('Error running examples:', error);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export {
  exampleGenerateAndLogSignal,
  exampleMonitorAndResolve,
  exampleAnalyzePerformance,
  exampleResolutionMonitor,
};
