import React from 'react';
import { ArbitrageOpportunity } from '../api';

interface ArbitrageCardProps {
  data: ArbitrageOpportunity[] | null;
  loading: boolean;
  error: string | null;
}

export const ArbitrageCard: React.FC<ArbitrageCardProps> = ({ data, loading, error }) => {
  if (error && !data) {
    return (
      <div className="card p-4 border-red-300 dark:border-red-800">
        <h3 className="font-semibold mb-2">Arbitrage Opportunities</h3>
        <div className="text-red-600 dark:text-red-400 text-sm">{error}</div>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="card p-4">
        <h3 className="font-semibold mb-4">Arbitrage Opportunities</h3>
        <p className="text-gray-500 dark:text-gray-400 text-sm">Loading arbitrage opportunities...</p>
      </div>
    );
  }

  const arbitrageList = data || [];

  return (
    <div className="card p-4">
      <h3 className="font-semibold mb-4">Arbitrage Opportunities</h3>

      {!arbitrageList || arbitrageList.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 text-sm">No arbitrage opportunities found</p>
      ) : (
        <div className="space-y-3">
          {arbitrageList.map((arb) => (
            <div key={`${arb.polymarket.id}-${arb.kalshi.id}-${arb.direction}`} className="p-3 bg-gray-100 dark:bg-gray-800 rounded-lg border border-gray-300 dark:border-gray-700">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {arb.polymarket.title}
                  </p>
                  <p className="text-xs text-gray-600 dark:text-gray-400">
                    {arb.polymarket.platform} ↔ {arb.kalshi.platform}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-green-600 dark:text-green-500">
                    {(arb.spread * 100).toFixed(2)}%
                  </p>
                  <p className="text-xs text-gray-600 dark:text-gray-400">spread</p>
                </div>
              </div>

              <div className="flex justify-between text-xs">
                <div>
                  <span className="text-gray-600 dark:text-gray-400">YES:</span>
                  <span className="ml-1 font-medium text-gray-900 dark:text-gray-100">${arb.polymarket.yesPrice.toFixed(2)}</span>
                </div>
                <div>
                  <span className="text-gray-600 dark:text-gray-400">Profit:</span>
                  <span className="ml-1 font-medium text-green-600 dark:text-green-500">
                    {(arb.profitPotential * 100).toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
