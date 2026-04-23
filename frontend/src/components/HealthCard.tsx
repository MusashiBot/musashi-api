import React from 'react';
import { HealthStatus } from '../api';

interface HealthCardProps {
  data: HealthStatus | null;
  loading: boolean;
  error: string | null;
}

export const HealthCard: React.FC<HealthCardProps> = ({ data, loading, error }) => {
  if (error && !data) {
    return (
      <div className="card p-4 border-red-300 dark:border-red-800">
        <div className="text-red-600 dark:text-red-400">
          <p className="font-semibold">Health Check Failed</p>
          <p className="text-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="card p-4">
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/3"></div>
          <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-1/2"></div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="card p-4">
        <p className="text-gray-500 dark:text-gray-400 text-sm">No health data loaded</p>
      </div>
    );
  }

  const statusColor = data.status === 'healthy' ? 'text-green-600 dark:text-green-500' :
                      data.status === 'degraded' ? 'text-yellow-600 dark:text-yellow-500' :
                      'text-red-600 dark:text-red-500';

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold flex items-center gap-2 text-gray-900 dark:text-gray-50">
          <div className={`w-3 h-3 rounded-full ${
            data.status === 'healthy' ? 'bg-green-500' :
            data.status === 'degraded' ? 'bg-yellow-500' :
            'bg-red-500'
          }`}></div>
          System Status
        </h3>
        <span className={`text-sm font-medium uppercase ${statusColor}`}>
          {data.status}
        </span>
      </div>

      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-600 dark:text-gray-400">Polymarket</span>
          <span className="badge badge-success">{data.services.polymarket.markets || 0} markets</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-600 dark:text-gray-400">Kalshi</span>
          <span className="badge badge-success">{data.services.kalshi.markets || 0} markets</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-600 dark:text-gray-400">API Response</span>
          <span className="text-gray-900 dark:text-gray-100">{data.response_time_ms}ms</span>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-800">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Updated: {new Date(data.timestamp).toLocaleTimeString()}
        </p>
      </div>
    </div>
  );
};
