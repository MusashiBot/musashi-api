import React, { useMemo } from 'react';
import { ArbitrageOpportunity } from '../api';

interface ArbitrageCardProps {
  data: ArbitrageOpportunity[] | null;
  loading: boolean;
  error: string | null;
}

const directionLabel: Record<ArbitrageOpportunity['direction'], string> = {
  buy_poly_sell_kalshi: 'BUY POLY / SELL KALSHI',
  buy_kalshi_sell_poly: 'BUY KALSHI / SELL POLY',
};

const normalizeMarketTitle = (title: string) => title.trim().toLowerCase().replace(/\s+/g, ' ');

const buildArbitrageKey = (arb: ArbitrageOpportunity) => [
  normalizeMarketTitle(arb.polymarket.title),
  normalizeMarketTitle(arb.kalshi.title),
  arb.direction,
].join('|');

const getMarketUrl = (url?: string) => url && url.trim().length > 0 ? url : null;

export const ArbitrageCard: React.FC<ArbitrageCardProps> = ({ data, loading, error }) => {
  const arbitrageList = useMemo(() => {
    const unique = new Map<string, ArbitrageOpportunity>();

    (data || []).forEach(arb => {
      const key = buildArbitrageKey(arb);
      const existing = unique.get(key);

      if (
        !existing ||
        arb.profitPotential > existing.profitPotential ||
        (arb.profitPotential === existing.profitPotential && arb.confidence > existing.confidence)
      ) {
        unique.set(key, arb);
      }
    });

    return Array.from(unique.values())
      .sort((left, right) => right.profitPotential - left.profitPotential);
  }, [data]);

  if (error && !data) {
    return (
      <section id="terminal-arbitrage" className="card terminal-anchor p-4 border-red-900/60">
        <h3 className="mb-2">Arbitrage</h3>
        <div className="text-sm text-[var(--accent-red)]">{error}</div>
      </section>
    );
  }

  return (
    <section id="terminal-arbitrage" className="card terminal-anchor">
      <div className="flex flex-col gap-3 border-b border-[var(--border-primary)] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3>Arbitrage</h3>
          <p className="mt-1 text-[10px] uppercase text-[var(--text-tertiary)]">same-event price dislocations</p>
        </div>
        <div className="flex gap-2 text-[10px] uppercase">
          <span className={arbitrageList.length > 0 ? 'badge badge-success' : 'badge badge-info'}>
            {arbitrageList.length} routes
          </span>
          {loading && <span className="badge badge-warning">SCANNING</span>}
        </div>
      </div>

      {loading && arbitrageList.length === 0 ? (
        <p className="p-4 text-sm text-[var(--text-tertiary)]">Loading arbitrage routes...</p>
      ) : arbitrageList.length === 0 ? (
        <p className="p-4 text-sm text-[var(--text-tertiary)]">No arbitrage opportunities found</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="terminal-table">
            <thead>
              <tr>
                <th className="w-[46%]">Market Pair</th>
                <th>Spread</th>
                <th>Profit</th>
                <th>Direction</th>
              </tr>
            </thead>
            <tbody>
              {arbitrageList.slice(0, 8).map(arb => {
                const polymarketUrl = getMarketUrl(arb.polymarket.url);
                const kalshiUrl = getMarketUrl(arb.kalshi.url);

                return (
                <tr key={`${arb.polymarket.id}-${arb.kalshi.id}-${arb.direction}`} className="terminal-row">
                  <td>
                    {polymarketUrl ? (
                      <a
                        href={polymarketUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="terminal-link line-clamp-2"
                      >
                        {arb.polymarket.title}
                      </a>
                    ) : (
                      <p className="line-clamp-2 text-[var(--text-primary)]">{arb.polymarket.title}</p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2 text-[10px] uppercase">
                      <span className="text-[var(--text-tertiary)]">confidence {(arb.confidence * 100).toFixed(0)}%</span>
                      {polymarketUrl && (
                        <a href={polymarketUrl} target="_blank" rel="noreferrer" className="badge badge-info terminal-badge-link">
                          Poly
                        </a>
                      )}
                      {kalshiUrl && (
                        <a href={kalshiUrl} target="_blank" rel="noreferrer" className="badge badge-info terminal-badge-link">
                          Kalshi
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="terminal-positive">{(arb.spread * 100).toFixed(2)}%</td>
                  <td className="terminal-positive">{(arb.profitPotential * 100).toFixed(1)}%</td>
                  <td className="text-[10px] uppercase text-[var(--accent-blue)]">{directionLabel[arb.direction]}</td>
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
