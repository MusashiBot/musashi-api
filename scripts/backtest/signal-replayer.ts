/**
 * Signal Replayer
 * 
 * Replays historical trading signals against actual price movements.
 * Simulates entry/exit based on signal parameters and calculates outcomes.
 */

import { SignalOutcome } from '../../src/db/signal-outcomes';
import { PriceSnapshot, getHistoricalPrices, getPriceAtTime } from './historical-data-fetcher';
import { calculatePnL, calculateResolutionPnL, PnLResult, TradeParams, TradeDirection } from './pnl-calculator';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TradeOutcome {
  signalId: string;
  marketId: string;
  platform: 'polymarket' | 'kalshi';
  signalType: string;
  urgency: string;
  
  // Entry details
  entryTime: Date;
  entryPrice: number;
  direction: TradeDirection;
  positionSize: number;
  confidence: number;
  edge: number;
  
  // Exit details
  exitTime: Date;
  exitPrice: number;
  exitReason: 'expired' | 'resolved' | 'stop_loss' | 'take_profit';
  
  // Outcome
  pnl: PnLResult;
  wasCorrect: boolean;
  actualOutcome?: 'YES' | 'NO';
  
  // Metadata
  holdingPeriodHours: number;
  priceChangePercent: number;
}

export interface ReplayConfig {
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  useKellySizing: boolean;
  stopLossPercent?: number;     // Optional stop-loss (e.g., 0.20 = 20% loss)
  takeProfitPercent?: number;   // Optional take-profit (e.g., 0.50 = 50% gain)
}

export interface ReplayResult {
  trades: TradeOutcome[];
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  missedSignals: number;        // Signals we couldn't replay due to missing data
}

// ─── Main Functions ───────────────────────────────────────────────────────────

/**
 * Replay a single signal against historical price data
 * 
 * @param signal Signal to replay
 * @param config Replay configuration
 * @returns Trade outcome, or null if signal can't be replayed
 */
export async function replaySignal(
  signal: SignalOutcome,
  config: ReplayConfig
): Promise<TradeOutcome | null> {
  try {
    // Extract entry details from signal
    const entryTime = new Date(signal.created_at);
    
    // Filter out HOLD signals (we only trade YES or NO)
    if (signal.predicted_direction === 'HOLD') {
      console.warn(`[Replayer] Skipping HOLD signal ${signal.signal_id}`);
      return null;
    }
    
    const direction = signal.predicted_direction as TradeDirection;
    const positionSize = config.useKellySizing 
      ? (signal.features as any).kelly_fraction || 0.05
      : 0.05; // Default to 5% if not using Kelly

    // Get entry price (price at signal creation time)
    const entrySnapshot = await getPriceAtTime(
      signal.market_id,
      entryTime.getTime(),
      10 * 60 * 1000 // 10 minute tolerance
    );

    if (!entrySnapshot) {
      console.warn(`[Replayer] No entry price found for signal ${signal.signal_id}`);
      return null;
    }

    const entryPrice = direction === 'YES' 
      ? entrySnapshot.yesPrice 
      : (1 - entrySnapshot.yesPrice);

    // Calculate exit time based on valid_until_seconds
    const validUntilSeconds = (signal.features as any).valid_until_seconds || 3600;
    const exitTime = new Date(entryTime.getTime() + (validUntilSeconds * 1000));

    // Get exit price
    let exitSnapshot: PriceSnapshot | null = null;
    let exitReason: TradeOutcome['exitReason'] = 'expired';

    // If signal has resolution data, use that for exit
    if (signal.resolution_date && signal.outcome) {
      const resolutionTime = new Date(signal.resolution_date);
      
      // Use resolution time if it's before the expiry
      if (resolutionTime < exitTime) {
        exitSnapshot = await getPriceAtTime(
          signal.market_id,
          resolutionTime.getTime(),
          60 * 60 * 1000 // 1 hour tolerance
        );
        exitReason = 'resolved';
      }
    }

    // If no resolution exit, find exit at expiry time
    if (!exitSnapshot) {
      exitSnapshot = await getPriceAtTime(
        signal.market_id,
        exitTime.getTime(),
        60 * 60 * 1000 // 1 hour tolerance
      );
    }

    if (!exitSnapshot) {
      console.warn(`[Replayer] No exit price found for signal ${signal.signal_id}`);
      return null;
    }

    const exitPrice = direction === 'YES' 
      ? exitSnapshot.yesPrice 
      : (1 - exitSnapshot.yesPrice);

    // Check for stop-loss / take-profit (if configured)
    if (config.stopLossPercent || config.takeProfitPercent) {
      const { newExitPrice, newExitTime, newExitReason } = await checkStopLossTakeProfit(
        signal.market_id,
        direction,
        entryPrice,
        entryTime,
        exitTime,
        config.stopLossPercent,
        config.takeProfitPercent
      );

      if (newExitPrice !== null) {
        exitSnapshot = { 
          marketId: signal.market_id, 
          yesPrice: newExitPrice, 
          timestamp: newExitTime.getTime() 
        };
        exitReason = newExitReason;
      }
    }

    // Calculate P&L
    const tradeParams: TradeParams = {
      entryPrice,
      exitPrice,
      positionSize,
      direction,
      platform: signal.platform,
      capital: config.initialCapital,
    };

    const pnl = calculatePnL(tradeParams);

    // Determine if prediction was correct
    const priceChange = exitPrice - entryPrice;
    const wasCorrect = (direction === 'YES' && priceChange > 0) || 
                      (direction === 'NO' && priceChange < 0) ||
                      (signal.was_correct !== undefined ? signal.was_correct : false);

    const holdingPeriodMs = exitSnapshot.timestamp - entryTime.getTime();
    const holdingPeriodHours = holdingPeriodMs / (1000 * 60 * 60);
    const priceChangePercent = ((exitPrice - entryPrice) / entryPrice) * 100;

    return {
      signalId: signal.signal_id,
      marketId: signal.market_id,
      platform: signal.platform,
      signalType: signal.signal_type,
      urgency: signal.urgency,
      entryTime,
      entryPrice,
      direction,
      positionSize,
      confidence: signal.confidence,
      edge: signal.edge,
      exitTime: new Date(exitSnapshot.timestamp),
      exitPrice,
      exitReason,
      pnl,
      wasCorrect,
      actualOutcome: signal.outcome,
      holdingPeriodHours: parseFloat(holdingPeriodHours.toFixed(2)),
      priceChangePercent: parseFloat(priceChangePercent.toFixed(2)),
    };
  } catch (error) {
    console.error(`[Replayer] Failed to replay signal ${signal.signal_id}:`, error);
    return null;
  }
}

/**
 * Replay multiple signals in batch
 * 
 * @param signals Array of signals to replay
 * @param config Replay configuration
 * @returns Aggregated replay results
 */
export async function replaySignals(
  signals: SignalOutcome[],
  config: ReplayConfig
): Promise<ReplayResult> {
  console.log(`[Replayer] Starting replay of ${signals.length} signals...`);

  const trades: TradeOutcome[] = [];
  let missedSignals = 0;

  // Process signals with progress updates
  const batchSize = 50;
  for (let i = 0; i < signals.length; i += batchSize) {
    const batch = signals.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(signal => replaySignal(signal, config))
    );

    for (const result of batchResults) {
      if (result) {
        trades.push(result);
      } else {
        missedSignals++;
      }
    }

    const progress = ((i + batch.length) / signals.length * 100).toFixed(1);
    console.log(`[Replayer] Progress: ${progress}% (${trades.length} trades, ${missedSignals} missed)`);
  }

  const successfulTrades = trades.filter(t => t.pnl.netPnL > 0).length;
  const failedTrades = trades.filter(t => t.pnl.netPnL <= 0).length;

  console.log(`[Replayer] Replay complete:`);
  console.log(`  - Total trades: ${trades.length}`);
  console.log(`  - Successful: ${successfulTrades}`);
  console.log(`  - Failed: ${failedTrades}`);
  console.log(`  - Missed: ${missedSignals}`);

  return {
    trades,
    totalTrades: trades.length,
    successfulTrades,
    failedTrades,
    missedSignals,
  };
}

/**
 * Check if stop-loss or take-profit was triggered during the holding period
 * 
 * @param marketId Market ID
 * @param direction Trade direction
 * @param entryPrice Entry price
 * @param entryTime Entry timestamp
 * @param maxExitTime Maximum exit time (expiry)
 * @param stopLossPercent Stop loss threshold (optional)
 * @param takeProfitPercent Take profit threshold (optional)
 * @returns New exit details if triggered, null otherwise
 */
async function checkStopLossTakeProfit(
  marketId: string,
  direction: TradeDirection,
  entryPrice: number,
  entryTime: Date,
  maxExitTime: Date,
  stopLossPercent?: number,
  takeProfitPercent?: number
): Promise<{
  newExitPrice: number | null;
  newExitTime: Date;
  newExitReason: 'stop_loss' | 'take_profit';
}> {
  // Get all price snapshots during holding period
  const snapshots = await getHistoricalPrices(
    marketId,
    entryTime,
    maxExitTime
  );

  if (snapshots.length === 0) {
    return { newExitPrice: null, newExitTime: maxExitTime, newExitReason: 'stop_loss' };
  }

  // Calculate thresholds
  const stopLossPrice = stopLossPercent 
    ? entryPrice * (1 - stopLossPercent) 
    : -Infinity;
  const takeProfitPrice = takeProfitPercent 
    ? entryPrice * (1 + takeProfitPercent) 
    : Infinity;

  // Check each snapshot for trigger
  for (const snapshot of snapshots) {
    const price = direction === 'YES' ? snapshot.yesPrice : (1 - snapshot.yesPrice);

    // Check stop-loss
    if (stopLossPercent && price <= stopLossPrice) {
      return {
        newExitPrice: price,
        newExitTime: new Date(snapshot.timestamp),
        newExitReason: 'stop_loss',
      };
    }

    // Check take-profit
    if (takeProfitPercent && price >= takeProfitPrice) {
      return {
        newExitPrice: price,
        newExitTime: new Date(snapshot.timestamp),
        newExitReason: 'take_profit',
      };
    }
  }

  return { newExitPrice: null, newExitTime: maxExitTime, newExitReason: 'stop_loss' };
}

/**
 * Filter signals by date range for replay
 * 
 * @param signals All signals
 * @param config Replay configuration with date range
 * @returns Filtered signals within date range
 */
export function filterSignalsByDateRange(
  signals: SignalOutcome[],
  config: ReplayConfig
): SignalOutcome[] {
  return signals.filter(signal => {
    const signalDate = new Date(signal.created_at);
    return signalDate >= config.startDate && signalDate <= config.endDate;
  });
}
