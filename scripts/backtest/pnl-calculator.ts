/**
 * P&L Calculator
 * 
 * Calculates profit/loss for prediction market trades.
 * Handles fees for Polymarket (1% per side) and Kalshi (3% per side).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type TradeDirection = 'YES' | 'NO';

export interface TradeParams {
  entryPrice: number;         // 0-1 (e.g., 0.65 = 65¢)
  exitPrice: number;          // 0-1
  positionSize: number;       // Kelly fraction (e.g., 0.05 = 5% of capital)
  direction: TradeDirection;  // 'YES' or 'NO'
  platform: 'polymarket' | 'kalshi';
  capital: number;            // Total capital in dollars
}

export interface PnLResult {
  grossPnL: number;           // P&L before fees
  netPnL: number;             // P&L after fees
  fees: number;               // Total fees paid
  returnPercent: number;      // Return as % of invested capital
  positionValue: number;      // Dollar value of position
  entryFee: number;
  exitFee: number;
}

// ─── Fee Structure ────────────────────────────────────────────────────────────

const FEES = {
  polymarket: 0.01,  // 1% per side
  kalshi: 0.03,      // 3% per side
} as const;

// ─── Main Function ────────────────────────────────────────────────────────────

/**
 * Calculate P&L for a prediction market trade
 * 
 * @param params Trade parameters
 * @returns P&L breakdown with fees
 */
export function calculatePnL(params: TradeParams): PnLResult {
  const {
    entryPrice,
    exitPrice,
    positionSize,
    direction,
    platform,
    capital,
  } = params;

  // Validate inputs
  if (entryPrice < 0 || entryPrice > 1) {
    throw new Error(`Invalid entry price: ${entryPrice}. Must be between 0 and 1.`);
  }
  if (exitPrice < 0 || exitPrice > 1) {
    throw new Error(`Invalid exit price: ${exitPrice}. Must be between 0 and 1.`);
  }
  if (positionSize < 0 || positionSize > 1) {
    throw new Error(`Invalid position size: ${positionSize}. Must be between 0 and 1.`);
  }
  if (capital <= 0) {
    throw new Error(`Invalid capital: ${capital}. Must be positive.`);
  }

  const feeRate = FEES[platform];
  const positionValue = capital * positionSize;

  // Calculate shares purchased
  // For YES: shares = positionValue / entryPrice
  // For NO: shares = positionValue / (1 - entryPrice)
  const sharesPrice = direction === 'YES' ? entryPrice : (1 - entryPrice);
  const shares = positionValue / sharesPrice;

  // Entry fee (paid on the position value)
  const entryFee = positionValue * feeRate;

  // Calculate gross proceeds from exit
  // For YES: proceeds = shares * exitPrice
  // For NO: proceeds = shares * (1 - exitPrice)
  const exitSharePrice = direction === 'YES' ? exitPrice : (1 - exitPrice);
  const grossProceeds = shares * exitSharePrice;

  // Exit fee (paid on the proceeds)
  const exitFee = grossProceeds * feeRate;

  // Net proceeds after exit fee
  const netProceeds = grossProceeds - exitFee;

  // P&L calculations
  const grossPnL = grossProceeds - positionValue;
  const netPnL = netProceeds - positionValue - entryFee;
  const totalFees = entryFee + exitFee;
  const returnPercent = (netPnL / positionValue) * 100;

  return {
    grossPnL: parseFloat(grossPnL.toFixed(4)),
    netPnL: parseFloat(netPnL.toFixed(4)),
    fees: parseFloat(totalFees.toFixed(4)),
    returnPercent: parseFloat(returnPercent.toFixed(2)),
    positionValue: parseFloat(positionValue.toFixed(2)),
    entryFee: parseFloat(entryFee.toFixed(4)),
    exitFee: parseFloat(exitFee.toFixed(4)),
  };
}

/**
 * Calculate P&L for a market resolution (binary outcome)
 * 
 * Used when a market resolves YES or NO, and we want to know the final P&L.
 * 
 * @param params Trade parameters
 * @param resolvedTo Market resolution ('YES' or 'NO')
 * @returns P&L result
 */
export function calculateResolutionPnL(
  params: Omit<TradeParams, 'exitPrice'>,
  resolvedTo: 'YES' | 'NO'
): PnLResult {
  // If market resolves to our direction: shares worth $1 each
  // If market resolves against us: shares worth $0
  const exitPrice = resolvedTo === params.direction ? 1.0 : 0.0;

  return calculatePnL({
    ...params,
    exitPrice,
  });
}

/**
 * Calculate break-even price for a trade
 * 
 * Returns the exit price needed to break even after fees.
 * 
 * @param entryPrice Entry price (0-1)
 * @param direction Trade direction
 * @param platform Trading platform
 * @returns Break-even exit price
 */
export function calculateBreakEvenPrice(
  entryPrice: number,
  direction: TradeDirection,
  platform: 'polymarket' | 'kalshi'
): number {
  const feeRate = FEES[platform];
  
  // For YES positions:
  // Break-even when: (shares * exitPrice * (1 - feeRate)) = positionValue * (1 + feeRate)
  // exitPrice = entryPrice * (1 + feeRate) / (1 - feeRate)
  
  // For NO positions:
  // Break-even when: (shares * (1 - exitPrice) * (1 - feeRate)) = positionValue * (1 + feeRate)
  // This gets more complex, but follows similar logic
  
  if (direction === 'YES') {
    const breakEven = entryPrice * (1 + feeRate) / (1 - feeRate);
    return Math.min(1.0, breakEven); // Cap at 1.0
  } else {
    // For NO: need price to move down
    const breakEven = 1 - ((1 - entryPrice) * (1 + feeRate) / (1 - feeRate));
    return Math.max(0.0, breakEven); // Floor at 0.0
  }
}

/**
 * Calculate expected value of a trade given win probability
 * 
 * @param entryPrice Entry price
 * @param winProbability Estimated probability of winning (0-1)
 * @param direction Trade direction
 * @param platform Trading platform
 * @param positionSize Position size as fraction of capital
 * @param capital Total capital
 * @returns Expected P&L
 */
export function calculateExpectedValue(
  entryPrice: number,
  winProbability: number,
  direction: TradeDirection,
  platform: 'polymarket' | 'kalshi',
  positionSize: number,
  capital: number
): number {
  // Calculate P&L for win scenario (market resolves to our direction)
  const winPnL = calculateResolutionPnL(
    { entryPrice, positionSize, direction, platform, capital },
    direction
  );

  // Calculate P&L for loss scenario (market resolves against us)
  const lossPnL = calculateResolutionPnL(
    { entryPrice, positionSize, direction, platform, capital },
    direction === 'YES' ? 'NO' : 'YES'
  );

  // Expected value = (winProb * winPnL) + ((1 - winProb) * lossPnL)
  const expectedValue = (winProbability * winPnL.netPnL) + 
                       ((1 - winProbability) * lossPnL.netPnL);

  return parseFloat(expectedValue.toFixed(4));
}

/**
 * Calculate Sharpe ratio from a series of returns
 * 
 * @param returns Array of trade returns (as decimals, e.g., 0.05 = 5%)
 * @param riskFreeRate Annual risk-free rate (default: 0.02 = 2%)
 * @returns Sharpe ratio
 */
export function calculateSharpe(
  returns: number[],
  riskFreeRate: number = 0.02
): number {
  if (returns.length === 0) return 0;

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  
  if (returns.length < 2) {
    return mean > 0 ? Infinity : -Infinity;
  }

  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) {
    return mean > 0 ? Infinity : -Infinity;
  }

  // Annualize assuming ~252 trading days
  const excessReturn = mean - (riskFreeRate / 252);
  const sharpe = excessReturn / stdDev * Math.sqrt(252);

  return parseFloat(sharpe.toFixed(3));
}

/**
 * Calculate maximum drawdown from a P&L series
 * 
 * @param cumulativePnL Array of cumulative P&L values over time
 * @returns Maximum drawdown as a positive number (0.15 = 15% drawdown)
 */
export function calculateMaxDrawdown(cumulativePnL: number[]): number {
  if (cumulativePnL.length === 0) return 0;

  let maxDrawdown = 0;
  let peak = cumulativePnL[0];

  for (const value of cumulativePnL) {
    if (value > peak) {
      peak = value;
    }

    const drawdown = (peak - value) / Math.abs(peak || 1);
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  return parseFloat(maxDrawdown.toFixed(4));
}
