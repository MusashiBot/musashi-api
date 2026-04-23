import React from 'react';
import { FeedStatsResponse } from '../api';

interface FeedStatsCardProps {
  data: FeedStatsResponse | null;
  loading: boolean;
  error: string | null;
}

export const FeedStatsCard: React.FC<FeedStatsCardProps> = ({ data, loading, error }) => {
  if (error) {
    return (
      <div className="card p-4 border-red-300 dark:border-red-800">
        <h3 className="font-semibold mb-2">Feed Activity</h3>
        <div className="text-red-600 dark:text-red-400 text-sm">{error}</div>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="card p-4">
        <h3 className="font-semibold mb-4">Feed Activity</h3>
        <div className="space-y-3 animate-pulse">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded"></div>
          <div className="h-16 bg-gray-200 dark:bg-gray-700 rounded"></div>
        </div>
      </div>
    );
  }

  const categories = Object.entries(data.by_category)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4);

  return (
    <div className="card p-4">
      <h3 className="font-semibold mb-4 text-gray-900 dark:text-gray-50">Feed Activity</h3>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <div>
          <p className="text-xs text-gray-600 dark:text-gray-400">1h</p>
          <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{data.tweets.last_1h}</p>
        </div>
        <div>
          <p className="text-xs text-gray-600 dark:text-gray-400">6h</p>
          <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{data.tweets.last_6h}</p>
        </div>
        <div>
          <p className="text-xs text-gray-600 dark:text-gray-400">24h</p>
          <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{data.tweets.last_24h}</p>
        </div>
      </div>

      <div className="space-y-2">
        {categories.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-sm">No category activity yet</p>
        ) : (
          categories.map(([category, count]) => (
            <div key={category} className="flex justify-between text-sm">
              <span className="text-gray-600 dark:text-gray-400">{category}</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{count}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
