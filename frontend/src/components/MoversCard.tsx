import React, { useMemo } from 'react';
import { MarketMover } from '../api';

interface MoversCardProps {
  data: MarketMover[] | null;
  loading: boolean;
  error: string | null;
}

export const MoversCard: React.FC<MoversCardProps> = ({ data, loading, error }) => {
  const movers = useMemo(() => {
    const unique = new Map<string, MarketMover>();

    (data || []).forEach(mover => {
      const key = [
        mover.market.platform,
        mover.market.title.trim().toLowerCase().replace(/\s+/g, ' '),
      ].join('|');
      const existing = unique.get(key);

      if (!existing || Math.abs(mover.priceChange1h) > Math.abs(existing.priceChange1h)) {
        unique.set(key, mover);
      }
    });

    return Array.from(unique.values())
      .sort((left, right) => Math.abs(right.priceChange1h) - Math.abs(left.priceChange1h));
  }, [data]);

  if (error) {
    return (
      <section className="card p-4 border-red-900/60">
        <h3 className="mb-2">Market Movers</h3>
        <div className="text-sm text-[var(--accent-red)]">{error}</div>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="flex flex-col gap-3 border-b border-[var(--border-primary)] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3>Market Movers</h3>
          <p className="mt-1 text-[10px] uppercase text-[var(--text-tertiary)]">1h price velocity</p>
        </div>
        {loading && <span className="badge badge-warning">REFRESHING</span>}
      </div>

      {loading && movers.length === 0 ? (
        <div className="space-y-2 p-4">
          {[...Array(3)].map((_, index) => (
            <div key={index} className="h-8 animate-pulse bg-[var(--bg-tertiary)]"></div>
          ))}
        </div>
      ) : movers.length === 0 ? (
        <p className="p-4 text-sm text-[var(--text-tertiary)]">No significant 1h movers found</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="terminal-table">
            <thead>
              <tr>
                <th className="w-[50%]">Market</th>
                <th>Move</th>
                <th>Now</th>
                <th>Platform</th>
              </tr>
            </thead>
            <tbody>
              {movers.map(mover => {
                const isUp = mover.direction === 'up';
                const marketUrl = mover.market.url && mover.market.url.trim().length > 0
                  ? mover.market.url
                  : null;

                return (
                  <tr key={mover.market.id} className="terminal-row">
                    <td>
                      {marketUrl ? (
                        <a
                          href={marketUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="terminal-link line-clamp-2"
                        >
                          {mover.market.title}
                        </a>
                      ) : (
                        <p className="line-clamp-2 text-[var(--text-primary)]">{mover.market.title}</p>
                      )}
                      <p className="mt-1 text-[10px] uppercase text-[var(--text-tertiary)]">{mover.market.category}</p>
                    </td>
                    <td className={isUp ? 'terminal-positive' : 'terminal-negative'}>
                      {isUp ? '+' : ''}{(mover.priceChange1h * 100).toFixed(1)}%
                    </td>
                    <td>{(mover.currentPrice * 100).toFixed(0)}¢</td>
                    <td>
                      {marketUrl ? (
                        <a href={marketUrl} target="_blank" rel="noreferrer" className="badge badge-info terminal-badge-link">
                          {mover.market.platform}
                        </a>
                      ) : (
                        <span className="badge badge-info">{mover.market.platform}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
