import React from 'react';
import { Market } from '../api';

interface MarketsCardProps {
  data: Market[] | null;
  loading: boolean;
  error: string | null;
}

export const MarketsCard: React.FC<MarketsCardProps> = ({ data, loading, error }) => {
  if (error) {
    return (
      <div className="card p-4 border-red-300 dark:border-red-800">
        <h3 className="font-semibold mb-2">Active Markets</h3>
        <div className="text-red-600 dark:text-red-400 text-sm">{error}</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="card p-4">
        <h3 className="font-semibold mb-4">Active Markets</h3>
        <div className="space-y-2 animate-pulse">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-12 bg-gray-200 dark:bg-gray-700 rounded"></div>
          ))}
        </div>
      </div>
    );
  }

  const topMarkets = data?.slice(0, 5) || [];
  const polymarketCount = data?.filter(m => m.platform === 'polymarket').length || 0;
  const kalshiCount = data?.filter(m => m.platform === 'kalshi').length || 0;

  return (
    <div className="card p-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold text-gray-900 dark:text-gray-50">Active Markets</h3>
        <div className="flex gap-2 text-xs">
          <div className="px-2 py-1 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded">
            Polymarket: {polymarketCount}
          </div>
          <div className="px-2 py-1 bg-gray-300 dark:bg-gray-600 text-gray-800 dark:text-gray-200 rounded">
            Kalshi: {kalshiCount}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {topMarkets.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-sm">No markets loaded</p>
        ) : (
          topMarkets.map((market) => (
            <div key={market.id} className="p-2 rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800">
              <div className="flex justify-between items-start mb-1">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2">
                  {market.title}
                </p>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
                  market.platform === 'polymarket'
                    ? 'bg-gray-300 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                    : 'bg-gray-400 dark:bg-gray-600 text-gray-800 dark:text-gray-200'
                }`}>
                  {market.platform}
                </span>
              </div>

              <div className="flex justify-between items-center">
                <div className="flex gap-3 text-xs">
                  <div>
                    <span className="text-gray-600 dark:text-gray-400">YES:</span>
                    <span className="ml-1 font-semibold text-gray-900 dark:text-gray-100">{(market.yesPrice * 100).toFixed(0)}¢</span>
                  </div>
                  <div>
                    <span className="text-gray-600 dark:text-gray-400">24h Vol:</span>
                    <span className="ml-1 font-semibold text-gray-900 dark:text-gray-100">${(market.volume24h / 1000).toFixed(0)}k</span>
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {topMarkets.length > 0 && (
        <div className="mt-3 pt-3 border-t border-gray-300 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Total: {data?.length || 0} markets • Last updated: {data?.[0]?.lastUpdated && new Date(data[0].lastUpdated).toLocaleTimeString()}
          </p>
        </div>
      )}
    </div>
  );
};
