#!/usr/bin/env node
/**
 * Backtest Runner
 * 
 * Main orchestrator for running backtests on historical signals.
 * 
 * Usage:
 *   node --import tsx scripts/backtest/run-backtest.ts
 * 
 * Environment variables:
 *   SUPABASE_URL              - Supabase project URL
 *   SUPABASE_ANON_KEY         - Supabase anonymous key
 *   KV_REST_API_URL           - Vercel KV REST API URL (optional, uses in-memory if not set)
 *   KV_REST_API_TOKEN         - Vercel KV REST API token (optional)
 *   BACKTEST_START_DATE       - Start date (ISO format, default: 7 days ago)
 *   BACKTEST_END_DATE         - End date (ISO format, default: now)
 *   BACKTEST_INITIAL_CAPITAL  - Starting capital (default: 10000)
 *   BACKTEST_REPORT_PATH      - Markdown report output path (default: ./BACKTEST_REPORT.md)
 */

import { createSupabaseBrowserClient } from '../../src/api/supabase-client';
import { isMainModule } from '../lib/is-main-module';
import { SignalOutcome } from '../../src/db/signal-outcomes';
import { replaySignals, filterSignalsByDateRange, ReplayConfig } from './signal-replayer';
import { generateReport } from './metrics-reporter';
import { getAvailableMarkets } from './historical-data-fetcher';

// ─── Configuration ────────────────────────────────────────────────────────────

interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  useKellySizing: boolean;
  stopLossPercent?: number;
  takeProfitPercent?: number;
  reportPath?: string;
}

function getConfig(): BacktestConfig {
  // Parse date range from environment or use defaults
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const startDate = process.env.BACKTEST_START_DATE 
    ? new Date(process.env.BACKTEST_START_DATE)
    : sevenDaysAgo;

  const endDate = process.env.BACKTEST_END_DATE 
    ? new Date(process.env.BACKTEST_END_DATE)
    : now;

  const initialCapital = process.env.BACKTEST_INITIAL_CAPITAL 
    ? parseFloat(process.env.BACKTEST_INITIAL_CAPITAL)
    : 10000;

  const reportPath = process.env.BACKTEST_REPORT_PATH?.trim() || undefined;

  return {
    startDate,
    endDate,
    initialCapital,
    useKellySizing: true,
    stopLossPercent: undefined,  // Optional: 0.20 for 20% stop-loss
    takeProfitPercent: undefined, // Optional: 0.50 for 50% take-profit
    reportPath,
  };
}

// ─── Main Execution ───────────────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║          MUSASHI BACKTEST FRAMEWORK                          ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log('');

  const startTime = Date.now();

  try {
    // Load configuration
    const config = getConfig();
    console.log('Configuration:');
    console.log(`  Start Date:       ${config.startDate.toISOString()}`);
    console.log(`  End Date:         ${config.endDate.toISOString()}`);
    console.log(`  Initial Capital:  $${config.initialCapital.toLocaleString()}`);
    console.log(`  Kelly Sizing:     ${config.useKellySizing ? 'Enabled' : 'Disabled'}`);
    console.log('');

    // Validate environment
    console.log('[1/5] Validating environment...');
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        'Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_ANON_KEY environment variables.'
      );
    }
    console.log('  ✓ Supabase credentials found');

    // Check KV availability (optional)
    const hasKv = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;
    if (hasKv) {
      console.log('  ✓ Vercel KV credentials found');
    } else {
      console.log('  ⚠ KV credentials not found - using in-memory storage (limited historical data)');
    }
    console.log('');

    // Fetch signals from database
    console.log('[2/5] Fetching signals from database...');
    const client = createSupabaseBrowserClient(supabaseUrl, supabaseKey);
    
    const { data: allSignals, error } = await client
      .from('signal_outcomes')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch signals: ${error.message}`);
    }

    if (!allSignals || allSignals.length === 0) {
      console.log('  ⚠ No signals found in database.');
      console.log('  Tip: Run the signal generator first to populate the database.');
      return;
    }

    console.log(`  ✓ Fetched ${allSignals.length} signals`);
    console.log('');

    // Filter signals by date range
    console.log('[3/5] Filtering signals by date range...');
    const signals = filterSignalsByDateRange(
      allSignals as SignalOutcome[],
      config as ReplayConfig
    );
    console.log(`  ✓ ${signals.length} signals within date range`);

    if (signals.length === 0) {
      console.log('  ⚠ No signals found in specified date range.');
      console.log(`  Try expanding the date range or checking signal timestamps.`);
      return;
    }
    console.log('');

    // Check available historical data
    console.log('[3.5/5] Checking available historical price data...');
    const availableMarkets = await getAvailableMarkets();
    console.log(`  ✓ ${availableMarkets.length} markets with price history`);
    
    // Calculate how many signals we can replay
    const signalMarkets = new Set(signals.map(s => s.market_id));
    const replayableMarkets = Array.from(signalMarkets).filter(m => availableMarkets.includes(m));
    const coveragePercent = (replayableMarkets.length / signalMarkets.size) * 100;
    
    console.log(`  ✓ Can replay ${replayableMarkets.length}/${signalMarkets.size} unique markets (${coveragePercent.toFixed(1)}%)`);
    
    if (coveragePercent < 50) {
      console.log('  ⚠ Warning: Low historical data coverage. Results may not be representative.');
      console.log('  Tip: Run the movers endpoint for several days to build up price history.');
    }
    console.log('');

    // Replay signals
    console.log('[4/5] Replaying signals against historical data...');
    const replayResult = await replaySignals(signals, config as ReplayConfig);
    console.log('');

    // Check if we got any trades
    if (replayResult.trades.length === 0) {
      console.log('  ⚠ No trades could be replayed (missing price data).');
      console.log('  Backtest incomplete - cannot generate report.');
      return;
    }

    // Generate performance report
    console.log('[5/5] Generating performance report...');
    await generateReport(replayResult.trades, config.initialCapital, config.reportPath);
    console.log('');

    // Summary
    const endTime = Date.now();
    const durationSeconds = ((endTime - startTime) / 1000).toFixed(1);
    
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║                    BACKTEST COMPLETE                         ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Summary:');
    console.log(`  Total Signals:      ${signals.length}`);
    console.log(`  Trades Replayed:    ${replayResult.totalTrades}`);
    console.log(`  Winning Trades:     ${replayResult.successfulTrades}`);
    console.log(`  Losing Trades:      ${replayResult.failedTrades}`);
    console.log(`  Missed (no data):   ${replayResult.missedSignals}`);
    
    const totalPnL = replayResult.trades.reduce((sum, t) => sum + t.pnl.netPnL, 0);
    const returnPercent = (totalPnL / config.initialCapital) * 100;
    
    console.log('');
    console.log('Performance:');
    console.log(`  Total P&L:          $${totalPnL.toFixed(2)}`);
    console.log(`  Return:             ${returnPercent.toFixed(2)}%`);
    console.log(`  Final Capital:      $${(config.initialCapital + totalPnL).toFixed(2)}`);
    console.log('');
    console.log(`  Duration:           ${durationSeconds}s`);
    console.log('');
    console.log(
      `📊 View full report: ${config.reportPath ?? `${process.cwd()}/BACKTEST_REPORT.md`}`
    );
    console.log('');

  } catch (error) {
    console.error('');
    console.error('❌ Backtest failed:');
    console.error('');
    if (error instanceof Error) {
      console.error(`  ${error.message}`);
      if (error.stack) {
        console.error('');
        console.error('Stack trace:');
        console.error(error.stack);
      }
    } else {
      console.error(`  ${String(error)}`);
    }
    console.error('');
    process.exit(1);
  }
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Format duration in human-readable format
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Validate date range
 */
function validateDateRange(start: Date, end: Date): void {
  if (start >= end) {
    throw new Error('Start date must be before end date');
  }

  const now = new Date();
  if (end > now) {
    throw new Error('End date cannot be in the future');
  }

  const maxRangeDays = 90;
  const rangeDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  if (rangeDays > maxRangeDays) {
    console.warn(
      `Warning: Date range is ${rangeDays.toFixed(0)} days. ` +
      `Large ranges may take longer to process. Consider using smaller ranges.`
    );
  }
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

if (isMainModule()) {
  main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

export { main, getConfig };
