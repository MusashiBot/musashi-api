import React from 'react';
import { Market } from '../api';

interface MarketsCardProps {
  data: Market[] | null;
  loading: boolean;
  error: string | null;
}

const formatVolume = (volume: number) => {
  if (volume >= 1_000_000) {
    return `$${(volume / 1_000_000).toFixed(1)}M`;
  }

  if (volume >= 1_000) {
    return `$${(volume / 1_000).toFixed(0)}K`;
  }

  return `$${volume.toFixed(0)}`;
};

export const MarketsCard: React.FC<MarketsCardProps> = ({ data, loading, error }) => {
  if (error) {
    return (
      <section id="terminal-markets" className="card terminal-anchor p-4 border-red-900/60">
        <h3 className="mb-2">Market Feed</h3>
        <div className="text-sm text-[var(--accent-red)]">{error}</div>
      </section>
    );
  }

  const topMarkets = data?.slice(0, 8) || [];
  const polymarketCount = data?.filter(market => market.platform === 'polymarket').length || 0;
  const kalshiCount = data?.filter(market => market.platform === 'kalshi').length || 0;

  return (
    <section id="terminal-markets" className="card terminal-anchor">
      <div className="flex flex-col gap-3 border-b border-[var(--border-primary)] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3>Market Feed</h3>
          <p className="mt-1 text-[10px] uppercase text-[var(--text-tertiary)]">matched from live social and market scans</p>
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] uppercase">
          <span className="badge badge-info">POLY {polymarketCount}</span>
          <span className="badge badge-info">KALSHI {kalshiCount}</span>
          {loading && <span className="badge badge-warning">SYNCING</span>}
        </div>
      </div>

      {loading && topMarkets.length === 0 ? (
        <div className="space-y-2 p-4">
          {[...Array(5)].map((_, index) => (
            <div key={index} className="h-8 animate-pulse bg-[var(--bg-tertiary)]"></div>
          ))}
        </div>
      ) : topMarkets.length === 0 ? (
        <p className="p-4 text-sm text-[var(--text-tertiary)]">No markets loaded</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="terminal-table">
            <thead>
              <tr>
                <th className="w-[52%]">Market</th>
                <th>Yes</th>
                <th>Volume</th>
                <th>Source</th>
                <th>Sync</th>
              </tr>
            </thead>
            <tbody>
              {topMarkets.map(market => (
                <tr key={market.id} className="terminal-row">
                  <td>
                    <a
                      className="line-clamp-2 text-[var(--text-primary)] transition hover:text-[var(--accent-blue)]"
                      href={market.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {market.title}
                    </a>
                    <div className="mt-1 text-[10px] uppercase text-[var(--text-tertiary)]">{market.category || 'general'}</div>
                  </td>
                  <td className={market.yesPrice >= 0.5 ? 'terminal-positive' : 'terminal-warning'}>
                    {(market.yesPrice * 100).toFixed(1)}¢
                  </td>
                  <td>{formatVolume(market.volume24h)}</td>
                  <td>
                    <span className="badge badge-info">{market.platform}</span>
                  </td>
                  <td className="text-[var(--text-tertiary)]">
                    {market.lastUpdated ? new Date(market.lastUpdated).toLocaleTimeString() : '--:--:--'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
