/**
 * Metrics Reporter
 * 
 * Generates comprehensive backtest reports with performance metrics,
 * win rate analysis, calibration plots, and comparisons.
 */

import { TradeOutcome } from './signal-replayer';
import { calculateSharpe, calculateMaxDrawdown } from './pnl-calculator';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PerformanceSummary {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  
  totalPnL: number;
  avgPnL: number;
  medianPnL: number;
  
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  
  avgConfidence: number;
  avgEdge: number;
  avgHoldingPeriodHours: number;
  
  bestTrade: number;
  worstTrade: number;
}

export interface BreakdownMetrics {
  winRate: number;
  avgPnL: number;
  totalPnL: number;
  count: number;
  sharpe?: number;
}

export interface CalibrationBucket {
  confidenceRange: string;
  predictedProb: number;
  actualWinRate: number;
  count: number;
  calibrationError: number;
}

// ─── Main Functions ───────────────────────────────────────────────────────────

/**
 * Generate a comprehensive backtest report
 * 
 * @param trades Array of trade outcomes
 * @param initialCapital Starting capital
 * @param outputPath Path to write report (default: BACKTEST_REPORT.md)
 */
export async function generateReport(
  trades: TradeOutcome[],
  initialCapital: number,
  outputPath: string = path.join(process.cwd(), 'BACKTEST_REPORT.md')
): Promise<void> {
  console.log('[Reporter] Generating backtest report...');

  const report: string[] = [];

  const DISCLAIMER = [
    '> **BACKTEST DISCLAIMER**',
    '> ',
    '> P&L and Sharpe figures are computed at **FAIR ODDS** (predicted probability),',
    '> not actual market fill prices. Live fill prices will diverge. These numbers',
    '> represent an **UPPER BOUND** on achievable returns. Do not use for live capital sizing.',
    '',
    '---',
    '',
  ].join('\n');

  // Console disclaimer
  console.log('');
  console.log('⚠️  BACKTEST DISCLAIMER');
  console.log('P&L and Sharpe figures are computed at FAIR ODDS (predicted probability),');
  console.log('not actual market fill prices. Live fill prices will diverge. These numbers');
  console.log('represent an UPPER BOUND on achievable returns. Do not use for live capital sizing.');
  console.log('');

  // Header
  report.push('# Backtest Report');
  report.push('');
  report.push(`**Generated:** ${new Date().toISOString()}`);
  report.push(`**Initial Capital:** $${initialCapital.toLocaleString()}`);
  report.push(`**Total Trades:** ${trades.length}`);
  report.push('');
  report.push(DISCLAIMER);

  // Performance Summary
  const summary = calculatePerformanceSummary(trades, initialCapital);
  report.push('## Overall Performance');
  report.push('');
  report.push('| Metric | Value |');
  report.push('|--------|-------|');
  report.push(`| **Total Trades** | ${summary.totalTrades} |`);
  report.push(`| **Win Rate** | ${(summary.winRate * 100).toFixed(2)}% |`);
  report.push(`| **Total P&L** | $${summary.totalPnL.toFixed(2)} |`);
  report.push(`| **Avg P&L per Trade** | $${summary.avgPnL.toFixed(2)} |`);
  report.push(`| **Median P&L** | $${summary.medianPnL.toFixed(2)} |`);
  report.push(`| **Sharpe Ratio** | ${summary.sharpeRatio.toFixed(3)} |`);
  report.push(`| **Max Drawdown** | $${summary.maxDrawdown.toFixed(2)} (${(summary.maxDrawdownPercent * 100).toFixed(2)}%) |`);
  report.push(`| **Avg Confidence** | ${(summary.avgConfidence * 100).toFixed(1)}% |`);
  report.push(`| **Avg Edge** | ${(summary.avgEdge * 100).toFixed(2)}% |`);
  report.push(`| **Avg Holding Period** | ${summary.avgHoldingPeriodHours.toFixed(1)} hours |`);
  report.push('');

  // Cumulative P&L Chart (ASCII)
  report.push('## Cumulative P&L Over Time');
  report.push('');
  report.push('```');
  report.push(generateCumulativePnLChart(trades, initialCapital));
  report.push('```');
  report.push('');

  // Win Rate Breakdowns
  report.push('## Performance by Category');
  report.push('');
  
  // By Signal Type
  report.push('### By Signal Type');
  report.push('');
  const bySignalType = calculateBreakdownMetrics(trades, 'signalType');
  report.push(formatBreakdownTable(bySignalType));
  report.push('');

  // By Urgency
  report.push('### By Urgency Level');
  report.push('');
  const byUrgency = calculateBreakdownMetrics(trades, 'urgency');
  report.push(formatBreakdownTable(byUrgency));
  report.push('');

  // By Platform
  report.push('### By Platform');
  report.push('');
  const byPlatform = calculateBreakdownMetrics(trades, 'platform');
  report.push(formatBreakdownTable(byPlatform));
  report.push('');

  // Calibration Analysis
  report.push('## Calibration Analysis');
  report.push('');
  const calibration = calculateCalibration(trades);
  report.push('| Confidence Range | Predicted | Actual Win Rate | Count | Error |');
  report.push('|-----------------|-----------|-----------------|-------|-------|');
  for (const bucket of calibration) {
    report.push(
      `| ${bucket.confidenceRange} | ` +
      `${(bucket.predictedProb * 100).toFixed(1)}% | ` +
      `${(bucket.actualWinRate * 100).toFixed(1)}% | ` +
      `${bucket.count} | ` +
      `${(bucket.calibrationError * 100).toFixed(1)}% |`
    );
  }
  report.push('');
  report.push('_Note: A well-calibrated model should have Actual Win Rate ≈ Predicted for each bucket._');
  report.push('');

  // Best and Worst Trades
  report.push('## Notable Trades');
  report.push('');
  report.push('### Top 5 Winning Trades');
  report.push('');
  const topWinners = [...trades]
    .sort((a, b) => b.pnl.netPnL - a.pnl.netPnL)
    .slice(0, 5);
  report.push(formatTradeTable(topWinners));
  report.push('');

  report.push('### Top 5 Losing Trades');
  report.push('');
  const topLosers = [...trades]
    .sort((a, b) => a.pnl.netPnL - b.pnl.netPnL)
    .slice(0, 5);
  report.push(formatTradeTable(topLosers));
  report.push('');

  // Exit Reason Analysis
  report.push('## Exit Reason Analysis');
  report.push('');
  const byExitReason = calculateBreakdownMetrics(trades, 'exitReason');
  report.push(formatBreakdownTable(byExitReason));
  report.push('');

  // Footer
  report.push('---');
  report.push('');
  report.push('_Report generated by Musashi Backtest Framework_');

  // Write to file
  const reportContent = report.join('\n');
  fs.writeFileSync(outputPath, reportContent, 'utf-8');
  
  console.log(`[Reporter] Report written to: ${outputPath}`);
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Calculate overall performance summary
 */
function calculatePerformanceSummary(
  trades: TradeOutcome[],
  initialCapital: number
): PerformanceSummary {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalPnL: 0,
      avgPnL: 0,
      medianPnL: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      avgConfidence: 0,
      avgEdge: 0,
      avgHoldingPeriodHours: 0,
      bestTrade: 0,
      worstTrade: 0,
    };
  }

  const winningTrades = trades.filter(t => t.pnl.netPnL > 0).length;
  const losingTrades = trades.filter(t => t.pnl.netPnL <= 0).length;
  const totalPnL = trades.reduce((sum, t) => sum + t.pnl.netPnL, 0);
  const avgPnL = totalPnL / trades.length;

  const sortedPnL = [...trades].map(t => t.pnl.netPnL).sort((a, b) => a - b);
  const medianPnL = sortedPnL[Math.floor(sortedPnL.length / 2)];

  // Calculate cumulative P&L for drawdown
  const cumulativePnL = trades.reduce((acc, trade) => {
    const last = acc.length > 0 ? acc[acc.length - 1] : initialCapital;
    acc.push(last + trade.pnl.netPnL);
    return acc;
  }, [] as number[]);

  const maxDrawdown = calculateMaxDrawdown(cumulativePnL);
  const maxDrawdownDollar = maxDrawdown * (initialCapital + totalPnL);

  // Calculate Sharpe ratio from returns
  const returns = trades.map(t => t.pnl.returnPercent / 100);
  const sharpeRatio = calculateSharpe(returns);

  const avgConfidence = trades.reduce((sum, t) => sum + t.confidence, 0) / trades.length;
  const avgEdge = trades.reduce((sum, t) => sum + t.edge, 0) / trades.length;
  const avgHoldingPeriodHours = trades.reduce((sum, t) => sum + t.holdingPeriodHours, 0) / trades.length;

  const bestTrade = Math.max(...trades.map(t => t.pnl.netPnL));
  const worstTrade = Math.min(...trades.map(t => t.pnl.netPnL));

  return {
    totalTrades: trades.length,
    winningTrades,
    losingTrades,
    winRate: winningTrades / trades.length,
    totalPnL,
    avgPnL,
    medianPnL,
    sharpeRatio,
    maxDrawdown: maxDrawdownDollar,
    maxDrawdownPercent: maxDrawdown,
    avgConfidence,
    avgEdge,
    avgHoldingPeriodHours,
    bestTrade,
    worstTrade,
  };
}

/**
 * Calculate breakdown metrics by a specific field
 */
function calculateBreakdownMetrics(
  trades: TradeOutcome[],
  field: keyof TradeOutcome
): Record<string, BreakdownMetrics> {
  const grouped: Record<string, TradeOutcome[]> = {};

  for (const trade of trades) {
    const key = String(trade[field]);
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(trade);
  }

  const result: Record<string, BreakdownMetrics> = {};

  for (const [key, groupTrades] of Object.entries(grouped)) {
    const winningTrades = groupTrades.filter(t => t.pnl.netPnL > 0).length;
    const totalPnL = groupTrades.reduce((sum, t) => sum + t.pnl.netPnL, 0);
    const avgPnL = totalPnL / groupTrades.length;
    const returns = groupTrades.map(t => t.pnl.returnPercent / 100);
    const sharpe = calculateSharpe(returns);

    result[key] = {
      winRate: winningTrades / groupTrades.length,
      avgPnL,
      totalPnL,
      count: groupTrades.length,
      sharpe: isFinite(sharpe) ? sharpe : undefined,
    };
  }

  return result;
}

/**
 * Calculate calibration buckets
 */
function calculateCalibration(trades: TradeOutcome[]): CalibrationBucket[] {
  const buckets = [
    { min: 0.0, max: 0.5, label: '0-50%' },
    { min: 0.5, max: 0.6, label: '50-60%' },
    { min: 0.6, max: 0.7, label: '60-70%' },
    { min: 0.7, max: 0.8, label: '70-80%' },
    { min: 0.8, max: 0.9, label: '80-90%' },
    { min: 0.9, max: 1.0, label: '90-100%' },
  ];

  return buckets.map(bucket => {
    const bucketTrades = trades.filter(
      t => t.confidence >= bucket.min && t.confidence < bucket.max
    );

    if (bucketTrades.length === 0) {
      return {
        confidenceRange: bucket.label,
        predictedProb: (bucket.min + bucket.max) / 2,
        actualWinRate: 0,
        count: 0,
        calibrationError: 0,
      };
    }

    const avgConfidence = bucketTrades.reduce((sum, t) => sum + t.confidence, 0) / bucketTrades.length;
    const correctPredictions = bucketTrades.filter(t => t.wasCorrect).length;
    const actualWinRate = correctPredictions / bucketTrades.length;
    const calibrationError = Math.abs(avgConfidence - actualWinRate);

    return {
      confidenceRange: bucket.label,
      predictedProb: avgConfidence,
      actualWinRate,
      count: bucketTrades.length,
      calibrationError,
    };
  });
}

/**
 * Generate ASCII cumulative P&L chart
 */
function generateCumulativePnLChart(
  trades: TradeOutcome[],
  initialCapital: number,
  width: number = 60,
  height: number = 15
): string {
  if (trades.length === 0) {
    return 'No trades to chart';
  }

  // Calculate cumulative P&L
  const cumulativePnL: number[] = [initialCapital];
  for (const trade of trades) {
    cumulativePnL.push(cumulativePnL[cumulativePnL.length - 1] + trade.pnl.netPnL);
  }

  const min = Math.min(...cumulativePnL);
  const max = Math.max(...cumulativePnL);
  const range = max - min || 1;

  // Build chart
  const lines: string[] = [];
  
  // Y-axis labels
  for (let row = 0; row < height; row++) {
    const value = max - (row / (height - 1)) * range;
    const label = `$${value.toFixed(0).padStart(8)} |`;
    
    let line = label;
    for (let col = 0; col < width; col++) {
      const dataIndex = Math.floor((col / width) * (cumulativePnL.length - 1));
      const dataValue = cumulativePnL[dataIndex];
      const normalizedValue = (dataValue - min) / range;
      const rowValue = 1 - (row / (height - 1));
      
      if (Math.abs(normalizedValue - rowValue) < 0.5 / height) {
        line += '*';
      } else {
        line += ' ';
      }
    }
    lines.push(line);
  }

  // X-axis
  lines.push(' '.repeat(10) + '+' + '-'.repeat(width));
  lines.push(' '.repeat(10) + '0' + ' '.repeat(width - 10) + `${trades.length} trades`);

  return lines.join('\n');
}

/**
 * Format breakdown table
 */
function formatBreakdownTable(breakdown: Record<string, BreakdownMetrics>): string {
  const rows: string[] = [];
  rows.push('| Category | Win Rate | Avg P&L | Total P&L | Count | Sharpe |');
  rows.push('|----------|----------|---------|-----------|-------|--------|');

  // Sort by total P&L descending
  const sorted = Object.entries(breakdown).sort((a, b) => b[1].totalPnL - a[1].totalPnL);

  for (const [category, metrics] of sorted) {
    rows.push(
      `| ${category} | ` +
      `${(metrics.winRate * 100).toFixed(1)}% | ` +
      `$${metrics.avgPnL.toFixed(2)} | ` +
      `$${metrics.totalPnL.toFixed(2)} | ` +
      `${metrics.count} | ` +
      `${metrics.sharpe?.toFixed(2) || 'N/A'} |`
    );
  }

  return rows.join('\n');
}

/**
 * Format trade table
 */
function formatTradeTable(trades: TradeOutcome[]): string {
  const rows: string[] = [];
  rows.push('| Signal Type | Direction | Entry | Exit | P&L | Return % | Holding (hrs) |');
  rows.push('|-------------|-----------|-------|------|-----|----------|---------------|');

  for (const trade of trades) {
    rows.push(
      `| ${trade.signalType} | ` +
      `${trade.direction} | ` +
      `${trade.entryPrice.toFixed(3)} | ` +
      `${trade.exitPrice.toFixed(3)} | ` +
      `$${trade.pnl.netPnL.toFixed(2)} | ` +
      `${trade.pnl.returnPercent.toFixed(1)}% | ` +
      `${trade.holdingPeriodHours.toFixed(1)} |`
    );
  }

  return rows.join('\n');
}
