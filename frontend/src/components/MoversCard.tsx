import React from 'react';
import { MarketMover } from '../api';

interface MoversCardProps {
  data: MarketMover[] | null;
  loading: boolean;
  error: string | null;
}

export const MoversCard: React.FC<MoversCardProps> = ({ data, loading, error }) => {
  if (error) {
    return (
      <div className="card p-4 border-red-300 dark:border-red-800">
        <h3 className="font-semibold mb-2">Market Movers</h3>
        <div className="text-red-600 dark:text-red-400 text-sm">{error}</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="card p-4">
        <h3 className="font-semibold mb-4">Market Movers</h3>
        <div className="space-y-3 animate-pulse">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-14 bg-gray-200 dark:bg-gray-700 rounded"></div>
          ))}
        </div>
      </div>
    );
  }

  const movers = data || [];

  return (
    <div className="card p-4">
      <h3 className="font-semibold mb-4 text-gray-900 dark:text-gray-50">Market Movers</h3>

      {movers.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 text-sm">No significant 1h movers found</p>
      ) : (
        <div className="space-y-3">
          {movers.map((mover) => {
            const isUp = mover.direction === 'up';
            const changeColor = isUp ? 'text-green-600 dark:text-green-500' : 'text-red-600 dark:text-red-500';

            return (
              <div key={mover.market.id} className="p-3 rounded-lg border border-gray-300 dark:border-gray-700">
                <div className="flex justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2">
                      {mover.market.title}
                    </p>
                    <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                      {mover.market.platform} • {mover.market.category}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-sm font-bold ${changeColor}`}>
                      {isUp ? '+' : ''}{(mover.priceChange1h * 100).toFixed(1)}%
                    </p>
                    <p className="text-xs text-gray-600 dark:text-gray-400">
                      {(mover.currentPrice * 100).toFixed(0)}¢
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
