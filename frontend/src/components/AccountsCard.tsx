import React from 'react';
import { FeedAccountsResponse } from '../api';

interface AccountsCardProps {
  data: FeedAccountsResponse | null;
  loading: boolean;
  error: string | null;
}

export const AccountsCard: React.FC<AccountsCardProps> = ({ data, loading, error }) => {
  if (error) {
    return (
      <section className="card p-4 border-red-900/60">
        <h3 className="mb-2">Tracked Accounts</h3>
        <div className="text-sm text-[var(--accent-red)]">{error}</div>
      </section>
    );
  }

  if (loading || !data) {
    return (
      <section className="card p-4">
        <h3 className="mb-4">Tracked Accounts</h3>
        <div className="space-y-3 animate-pulse">
          <div className="h-8 bg-[var(--bg-tertiary)]"></div>
          <div className="h-16 bg-[var(--bg-tertiary)]"></div>
        </div>
      </section>
    );
  }

  const topCategories = Object.entries(data.by_category)
    .sort(([, left], [, right]) => right - left)
    .slice(0, 4);

  return (
    <section className="card p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3>Tracked Accounts</h3>
        <span className="terminal-panel-kicker">sources</span>
      </div>

      <div className="mb-4 grid grid-cols-3 border border-[var(--border-primary)]">
        <div className="border-r border-[var(--border-primary)] p-3">
          <p className="text-[10px] uppercase text-[var(--text-tertiary)]">Total</p>
          <p className="text-2xl font-bold text-[var(--accent-blue)]">{data.count}</p>
        </div>
        <div className="border-r border-[var(--border-primary)] p-3">
          <p className="text-[10px] uppercase text-[var(--text-tertiary)]">High</p>
          <p className="text-2xl font-bold text-[var(--accent-green)]">{data.by_priority.high}</p>
        </div>
        <div className="p-3">
          <p className="text-[10px] uppercase text-[var(--text-tertiary)]">Medium</p>
          <p className="text-2xl font-bold text-[var(--text-primary)]">{data.by_priority.medium}</p>
        </div>
      </div>

      <div className="space-y-2">
        {topCategories.map(([category, count]) => (
          <div key={category} className="flex justify-between gap-4 text-sm">
            <span className="terminal-muted">{category}</span>
              <span className="text-[var(--text-primary)]">{count}</span>
          </div>
        ))}
      </div>
    </section>
  );
};
