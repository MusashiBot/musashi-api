/**
 * Example Usage - Backtest Framework
 * 
 * This file demonstrates how to use the backtest framework programmatically.
 * You can customize the configuration and run specific scenarios.
 */

import { createSupabaseBrowserClient } from '../../src/api/supabase-client';
import { SignalOutcome } from '../../src/db/signal-outcomes';
import { replaySignals, filterSignalsByDateRange, ReplayConfig } from './signal-replayer';
import { generateReport } from './metrics-reporter';

// ─── Example 1: Basic Backtest ───────────────────────────────────────────────

async function runBasicBacktest() {
  console.log('Running basic backtest...');

  const config: ReplayConfig = {
    startDate: new Date('2026-04-01'),
    endDate: new Date('2026-04-15'),
    initialCapital: 10000,
    useKellySizing: true,
  };

  // Fetch signals from database
  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_ANON_KEY!;
  const client = createSupabaseBrowserClient(supabaseUrl, supabaseKey);

  const { data: allSignals } = await client
    .from('signal_outcomes')
    .select('*')
    .order('created_at', { ascending: true });

  if (!allSignals) {
    console.log('No signals found');
    return;
  }

  // Filter and replay
  const signals = filterSignalsByDateRange(allSignals as SignalOutcome[], config);
  const result = await replaySignals(signals, config);

  // Generate report
  await generateReport(result.trades, config.initialCapital);
  
  console.log(`Backtest complete: ${result.totalTrades} trades replayed`);
}

// ─── Example 2: Compare Strategies ───────────────────────────────────────────

async function compareStrategies() {
  console.log('Comparing strategies...');

  const baseConfig: ReplayConfig = {
    startDate: new Date('2026-04-01'),
    endDate: new Date('2026-04-15'),
    initialCapital: 10000,
    useKellySizing: true, // Default, strategies can override
  };

  // Strategy 1: Kelly sizing, no risk management
  const strategy1: ReplayConfig = {
    ...baseConfig,
    useKellySizing: true,
  };

  // Strategy 2: Kelly sizing with stop-loss
  const strategy2: ReplayConfig = {
    ...baseConfig,
    useKellySizing: true,
    stopLossPercent: 0.20, // 20% stop-loss
  };

  // Strategy 3: Fixed sizing
  const strategy3: ReplayConfig = {
    ...baseConfig,
    useKellySizing: false,
  };

  // Fetch signals
  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_ANON_KEY!;
  const client = createSupabaseBrowserClient(supabaseUrl, supabaseKey);

  const { data: allSignals } = await client
    .from('signal_outcomes')
    .select('*')
    .order('created_at', { ascending: true });

  if (!allSignals) {
    console.log('No signals found');
    return;
  }

  const signals = filterSignalsByDateRange(allSignals as SignalOutcome[], baseConfig);

  // Run all strategies
  console.log('\nStrategy 1: Kelly sizing, no risk management');
  const result1 = await replaySignals(signals, strategy1);
  await generateReport(result1.trades, baseConfig.initialCapital, 'BACKTEST_STRATEGY1.md');

  console.log('\nStrategy 2: Kelly sizing with 20% stop-loss');
  const result2 = await replaySignals(signals, strategy2);
  await generateReport(result2.trades, baseConfig.initialCapital, 'BACKTEST_STRATEGY2.md');

  console.log('\nStrategy 3: Fixed 5% sizing');
  const result3 = await replaySignals(signals, strategy3);
  await generateReport(result3.trades, baseConfig.initialCapital, 'BACKTEST_STRATEGY3.md');

  // Compare results
  console.log('\n=== Strategy Comparison ===');
  console.log(`Strategy 1 - Total P&L: $${result1.trades.reduce((sum, t) => sum + t.pnl.netPnL, 0).toFixed(2)}`);
  console.log(`Strategy 2 - Total P&L: $${result2.trades.reduce((sum, t) => sum + t.pnl.netPnL, 0).toFixed(2)}`);
  console.log(`Strategy 3 - Total P&L: $${result3.trades.reduce((sum, t) => sum + t.pnl.netPnL, 0).toFixed(2)}`);
}

// ─── Example 3: Filter by Signal Type ────────────────────────────────────────

async function analyzeBySignalType() {
  console.log('Analyzing performance by signal type...');

  const config: ReplayConfig = {
    startDate: new Date('2026-04-01'),
    endDate: new Date('2026-04-15'),
    initialCapital: 10000,
    useKellySizing: true,
  };

  // Fetch signals
  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_ANON_KEY!;
  const client = createSupabaseBrowserClient(supabaseUrl, supabaseKey);

  const { data: allSignals } = await client
    .from('signal_outcomes')
    .select('*')
    .order('created_at', { ascending: true });

  if (!allSignals) {
    console.log('No signals found');
    return;
  }

  const signals = filterSignalsByDateRange(allSignals as SignalOutcome[], config);

  // Group by signal type
  const signalsByType = signals.reduce((acc, signal) => {
    const type = signal.signal_type;
    if (!acc[type]) acc[type] = [];
    acc[type].push(signal);
    return acc;
  }, {} as Record<string, SignalOutcome[]>);

  // Run backtest for each type
  for (const [type, typeSignals] of Object.entries(signalsByType)) {
    console.log(`\n=== ${type} (${typeSignals.length} signals) ===`);
    const result = await replaySignals(typeSignals, config);
    
    const totalPnL = result.trades.reduce((sum, t) => sum + t.pnl.netPnL, 0);
    const winRate = result.successfulTrades / result.totalTrades;
    
    console.log(`  Trades: ${result.totalTrades}`);
    console.log(`  Win Rate: ${(winRate * 100).toFixed(1)}%`);
    console.log(`  Total P&L: $${totalPnL.toFixed(2)}`);
  }
}

// ─── Example 4: Rolling Window Analysis ──────────────────────────────────────

async function rollingWindowAnalysis() {
  console.log('Running rolling window analysis...');

  const windowSizeDays = 7;
  const startDate = new Date('2026-03-01');
  const endDate = new Date('2026-04-15');

  // Fetch all signals
  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_ANON_KEY!;
  const client = createSupabaseBrowserClient(supabaseUrl, supabaseKey);

  const { data: allSignals } = await client
    .from('signal_outcomes')
    .select('*')
    .order('created_at', { ascending: true });

  if (!allSignals) {
    console.log('No signals found');
    return;
  }

  // Slide window across date range
  const results: { period: string; pnl: number; trades: number }[] = [];
  
  let currentStart = new Date(startDate);
  while (currentStart < endDate) {
    const currentEnd = new Date(currentStart.getTime() + windowSizeDays * 24 * 60 * 60 * 1000);
    
    const config: ReplayConfig = {
      startDate: currentStart,
      endDate: currentEnd,
      initialCapital: 10000,
      useKellySizing: true,
    };

    const signals = filterSignalsByDateRange(allSignals as SignalOutcome[], config);
    
    if (signals.length > 0) {
      const result = await replaySignals(signals, config);
      const totalPnL = result.trades.reduce((sum, t) => sum + t.pnl.netPnL, 0);
      
      results.push({
        period: `${currentStart.toISOString().split('T')[0]} to ${currentEnd.toISOString().split('T')[0]}`,
        pnl: totalPnL,
        trades: result.totalTrades,
      });
    }

    // Move window forward by 1 day
    currentStart = new Date(currentStart.getTime() + 24 * 60 * 60 * 1000);
  }

  // Display results
  console.log('\n=== Rolling 7-Day Performance ===');
  for (const result of results) {
    console.log(`${result.period}: $${result.pnl.toFixed(2)} (${result.trades} trades)`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const example = process.argv[2] || '1';

  switch (example) {
    case '1':
      await runBasicBacktest();
      break;
    case '2':
      await compareStrategies();
      break;
    case '3':
      await analyzeBySignalType();
      break;
    case '4':
      await rollingWindowAnalysis();
      break;
    default:
      console.log('Usage: node --import tsx example-usage.ts [1|2|3|4]');
      console.log('  1 - Basic backtest');
      console.log('  2 - Compare strategies');
      console.log('  3 - Analyze by signal type');
      console.log('  4 - Rolling window analysis');
  }
}

if (require.main === module) {
  main().catch(console.error);
}
