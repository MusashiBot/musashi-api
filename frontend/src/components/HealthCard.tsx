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
      <section className="card p-4 border-red-900/60">
        <div className="text-[var(--accent-red)]">
          <p className="font-semibold uppercase">Health Check Failed</p>
          <p className="mt-1 text-sm">{error}</p>
        </div>
      </section>
    );
  }

  if (loading && !data) {
    return (
      <section className="card p-4">
        <div className="animate-pulse space-y-3">
          <div className="h-4 w-1/3 bg-[var(--bg-tertiary)]"></div>
          <div className="h-3 w-1/2 bg-[var(--bg-tertiary)]"></div>
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="card p-4">
        <p className="text-sm text-[var(--text-tertiary)]">No health data loaded</p>
      </section>
    );
  }

  const statusClass = data.status === 'healthy'
    ? 'terminal-positive'
    : data.status === 'degraded'
      ? 'terminal-warning'
      : 'terminal-negative';

  return (
    <section className="card p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3>System Status</h3>
        <span className={`text-sm font-bold uppercase ${statusClass}`}>{data.status}</span>
      </div>

      <div className="space-y-3 text-sm">
        <div className="flex justify-between gap-4">
          <span className="terminal-muted">Polymarket</span>
          <span className="badge badge-success">{data.services.polymarket.markets || 0} markets</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="terminal-muted">Kalshi</span>
          <span className="badge badge-success">{data.services.kalshi.markets || 0} markets</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="terminal-muted">API Response</span>
          <span className="text-[var(--text-primary)]">{data.response_time_ms}ms</span>
        </div>
      </div>

      <div className="mt-4 border-t border-[var(--border-primary)] pt-3">
        <p className="text-xs text-[var(--text-tertiary)]">
          Updated {new Date(data.timestamp).toLocaleTimeString()}
        </p>
      </div>
    </section>
  );
};
