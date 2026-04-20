# Musashi Backtest Framework

A comprehensive backtesting framework for prediction market trading signals. Replays historical signals against actual price movements to evaluate trading strategy performance.

## Overview

The backtesting framework consists of five main modules:

1. **`run-backtest.ts`** - Main orchestrator that coordinates the entire backtest
2. **`historical-data-fetcher.ts`** - Fetches price snapshots from KV storage
3. **`signal-replayer.ts`** - Replays signals against historical prices and simulates trades
4. **`pnl-calculator.ts`** - Calculates profit/loss with platform-specific fees
5. **`metrics-reporter.ts`** - Generates comprehensive performance reports

## Quick Start

### Prerequisites

Ensure you have the following environment variables set:

```bash
# Required
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_key

# Optional (for historical price data)
KV_REST_API_URL=your_kv_url
KV_REST_API_TOKEN=your_kv_token
```

### Run a Backtest

```bash
# Run with default settings (last 7 days, $10k capital)
node --import tsx scripts/backtest/run-backtest.ts

# Custom date range
BACKTEST_START_DATE=2026-04-01 \
BACKTEST_END_DATE=2026-04-15 \
node --import tsx scripts/backtest/run-backtest.ts

# Custom capital
BACKTEST_INITIAL_CAPITAL=50000 \
node --import tsx scripts/backtest/run-backtest.ts
```

### View Results

After running, view the generated report:

```bash
cat BACKTEST_REPORT.md
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BACKTEST_START_DATE` | Start date (ISO format) | 7 days ago |
| `BACKTEST_END_DATE` | End date (ISO format) | Now |
| `BACKTEST_INITIAL_CAPITAL` | Starting capital in dollars | 10000 |

### Code Configuration

Edit `run-backtest.ts` to customize:

```typescript
const config = {
  startDate: new Date('2026-04-01'),
  endDate: new Date('2026-04-15'),
  initialCapital: 10000,
  useKellySizing: true,            // Use Kelly fraction from signals
  stopLossPercent: 0.20,           // Optional: 20% stop-loss
  takeProfitPercent: 0.50,         // Optional: 50% take-profit
};
```

## Features

### Performance Metrics

The backtest calculates and reports:

- **Win rate** - Percentage of profitable trades
- **Total P&L** - Net profit/loss after fees
- **Sharpe ratio** - Risk-adjusted returns
- **Max drawdown** - Largest peak-to-trough decline
- **Average confidence** - Mean signal confidence
- **Average edge** - Mean predicted edge
- **Calibration** - Predicted vs. actual win rates

### Breakdown Analysis

Performance is analyzed across multiple dimensions:

- **By signal type** - Compare different signal generators
- **By urgency** - High vs. medium vs. low urgency
- **By platform** - Polymarket vs. Kalshi
- **By exit reason** - Expired vs. resolved vs. stop-loss

### Fee Modeling

Accurately models platform fees:

- **Polymarket**: 1% per side (2% round-trip)
- **Kalshi**: 3% per side (6% round-trip)

### Position Sizing

Supports two position sizing methods:

1. **Kelly sizing** (default) - Uses Kelly fractions from signals
2. **Fixed sizing** - Fixed 5% per trade

## Architecture

### Data Flow

```
┌─────────────────┐
│  Signal DB      │
│  (Supabase)     │
└────────┬────────┘
         │
         v
┌─────────────────┐
│ Filter Signals  │
│ by Date Range   │
└────────┬────────┘
         │
         v
┌─────────────────┐     ┌──────────────────┐
│ Historical      │────>│  Signal          │
│ Price Fetcher   │     │  Replayer        │
│ (KV Storage)    │     └────────┬─────────┘
└─────────────────┘              │
                                 v
                        ┌────────────────┐
                        │ P&L Calculator │
                        └────────┬───────┘
                                 │
                                 v
                        ┌────────────────┐
                        │ Metrics        │
                        │ Reporter       │
                        └────────┬───────┘
                                 │
                                 v
                        ┌────────────────┐
                        │ BACKTEST_      │
                        │ REPORT.md      │
                        └────────────────┘
```

### Module Descriptions

#### historical-data-fetcher.ts

Retrieves price snapshots from KV storage. Each market has up to 7 days of price history at ~1-minute intervals.

**Key functions:**
- `getHistoricalPrices(marketId, startDate, endDate)` - Get all prices for a market
- `getPriceAtTime(marketId, timestamp)` - Get closest price to a specific time
- `getAvailableMarkets()` - List all markets with price history

#### signal-replayer.ts

Simulates trades by matching signals to historical price movements.

**Key functions:**
- `replaySignal(signal, config)` - Replay a single signal
- `replaySignals(signals, config)` - Batch replay multiple signals
- `checkStopLossTakeProfit()` - Detect stop-loss/take-profit triggers

**Trade lifecycle:**
1. Extract entry price at signal creation time
2. Calculate exit time based on `valid_until_seconds`
3. Get exit price at expiry or resolution
4. Check for stop-loss/take-profit triggers
5. Calculate P&L with fees

#### pnl-calculator.ts

Handles all P&L calculations with accurate fee modeling.

**Key functions:**
- `calculatePnL(params)` - Main P&L calculation
- `calculateResolutionPnL(params, outcome)` - P&L for market resolution
- `calculateBreakEvenPrice()` - Break-even price after fees
- `calculateSharpe()` - Sharpe ratio from returns
- `calculateMaxDrawdown()` - Maximum drawdown calculation

#### metrics-reporter.ts

Generates comprehensive markdown reports with tables and charts.

**Key functions:**
- `generateReport(trades, capital, outputPath)` - Generate full report
- `calculatePerformanceSummary()` - Aggregate metrics
- `calculateBreakdownMetrics()` - Group by categories
- `calculateCalibration()` - Calibration buckets

## Example Output

```
# Backtest Report

**Generated:** 2026-04-18T10:30:00.000Z
**Initial Capital:** $10,000
**Total Trades:** 42

## Overall Performance

| Metric | Value |
|--------|-------|
| **Total Trades** | 42 |
| **Win Rate** | 61.90% |
| **Total P&L** | $342.50 |
| **Avg P&L per Trade** | $8.15 |
| **Sharpe Ratio** | 1.847 |
| **Max Drawdown** | $125.00 (1.25%) |

## Performance by Category

### By Signal Type

| Category | Win Rate | Avg P&L | Total P&L | Count | Sharpe |
|----------|----------|---------|-----------|-------|--------|
| semantic_match | 65.0% | $12.50 | $150.00 | 12 | 2.14 |
| arbitrage | 58.3% | $8.20 | $82.00 | 10 | 1.92 |
| sentiment_surge | 60.0% | $5.50 | $110.50 | 20 | 1.56 |
```

## Troubleshooting

### No Historical Data

**Problem**: "No price history found for market"

**Solution**: 
- Run the `/api/markets/movers` endpoint regularly to build up price history
- Historical data is retained for 7 days in KV storage
- Consider running backtests on recent signals only

### Missing Signals

**Problem**: "No signals found in database"

**Solution**:
- Run the signal generator first: see `src/analysis/signal-generator.ts`
- Ensure signals are being logged to Supabase
- Check `signal_outcomes` table has data

### Low Coverage

**Problem**: "Can replay 10/50 unique markets (20%)"

**Solution**:
- Wait for more price history to accumulate
- Focus backtest on markets with known price history
- Run movers endpoint more frequently

## Advanced Usage

### Custom Date Ranges

For month-over-month comparisons:

```bash
# April 2026
BACKTEST_START_DATE=2026-04-01 \
BACKTEST_END_DATE=2026-04-30 \
node --import tsx scripts/backtest/run-backtest.ts

# March 2026
BACKTEST_START_DATE=2026-03-01 \
BACKTEST_END_DATE=2026-03-31 \
node --import tsx scripts/backtest/run-backtest.ts
```

### A/B Testing Strategies

Compare Kelly sizing vs. fixed sizing:

```typescript
// Test 1: Kelly sizing
const config1 = { ...baseConfig, useKellySizing: true };

// Test 2: Fixed sizing
const config2 = { ...baseConfig, useKellySizing: false };
```

### Stop-Loss / Take-Profit Analysis

Test different risk management parameters:

```typescript
const configs = [
  { stopLossPercent: 0.10, takeProfitPercent: 0.30 },
  { stopLossPercent: 0.20, takeProfitPercent: 0.50 },
  { stopLossPercent: undefined, takeProfitPercent: undefined },
];
```

## Next Steps

1. **Improve signal quality** - Use calibration analysis to identify weak signal types
2. **Optimize position sizing** - Compare Kelly vs. fixed sizing performance
3. **Test risk management** - Experiment with stop-loss and take-profit levels
4. **Build ML models** - Use backtest data as training labels
5. **Forward test** - Paper trade with recent signals before going live

## Support

For issues or questions:
- Check the code comments in each module
- Review the signal_outcomes table schema
- Verify environment variables are set correctly
- Ensure historical price data is available in KV

---

*Built with Musashi API Framework*
