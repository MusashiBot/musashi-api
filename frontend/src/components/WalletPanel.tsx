import React, { useState } from 'react';
import {
  WalletActivity,
  WalletPosition,
  getWalletActivity,
  getWalletPositions,
} from '../api';

const WALLET_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

export const WalletPanel: React.FC = () => {
  const [wallet, setWallet] = useState('');
  const [positions, setPositions] = useState<WalletPosition[] | null>(null);
  const [activity, setActivity] = useState<WalletActivity[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQueried, setLastQueried] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const trimmedWallet = wallet.trim();
    if (!WALLET_ADDRESS_REGEX.test(trimmedWallet)) {
      setError('Enter a valid 0x wallet address');
      return;
    }

    setLoading(true);
    setError(null);

    const [positionsResult, activityResult] = await Promise.allSettled([
      getWalletPositions(trimmedWallet, 20, 0),
      getWalletActivity(trimmedWallet, 20),
    ]);

    if (positionsResult.status === 'fulfilled') {
      setPositions(positionsResult.value.positions);
    }

    if (activityResult.status === 'fulfilled') {
      setActivity(activityResult.value.activity);
    }

    const failures = [
      positionsResult.status === 'rejected' ? 'positions' : null,
      activityResult.status === 'rejected' ? 'activity' : null,
    ].filter(Boolean);

    setError(failures.length > 0 ? `Could not load wallet ${failures.join(' and ')}` : null);
    setLastQueried(trimmedWallet);
    setLoading(false);
  };

  const totalValue = positions?.reduce((sum, position) => sum + (position.currentValue || 0), 0) || 0;

  return (
    <section id="terminal-wallet" className="terminal-panel terminal-anchor mt-8">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="terminal-panel-title">Wallet Intelligence</h2>
          <p className="mt-1 text-[10px] uppercase text-[var(--text-tertiary)]">
            {lastQueried ? `${lastQueried.slice(0, 8)}...${lastQueried.slice(-6)}` : 'load polymarket positions and activity'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3 lg:w-[720px] sm:flex-row">
          <input
            value={wallet}
            onChange={(event) => setWallet(event.target.value)}
            placeholder="0x wallet address"
            className="terminal-input min-w-0 flex-1 text-sm"
          />
          <button
            type="submit"
            disabled={loading}
            className="terminal-button"
          >
            {loading ? '[RUNNING] LOAD' : '[ENTER] ANALYZE WALLET'}
          </button>
        </form>
      </div>

      {error && (
        <div className="terminal-error-message mb-4 p-3 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-px bg-[var(--border-primary)] lg:grid-cols-[260px_1fr_1fr]">
        <div className="bg-[var(--bg-primary)] p-4">
          <p className="text-[10px] uppercase text-[var(--text-tertiary)]">Positions</p>
          <p className="mt-2 text-4xl font-black text-[var(--accent-blue)]">{positions?.length || 0}</p>
          <p className="mt-5 text-[10px] uppercase text-[var(--text-tertiary)]">Current Value</p>
          <p className="mt-2 text-2xl font-bold text-[var(--accent-green)]">
            ${totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </p>
        </div>

        <div className="bg-[var(--bg-primary)] p-4">
          <h3 className="mb-3">Positions</h3>
          <div className="divide-y divide-[var(--border-primary)]">
            {!positions || positions.length === 0 ? (
              <p className="text-sm text-[var(--text-tertiary)]">No positions loaded</p>
            ) : (
              positions.slice(0, 5).map(position => (
                <div key={`${position.marketId || position.tokenId}-${position.outcome}`} className="py-3">
                  <p className="line-clamp-2 text-sm text-[var(--text-primary)]">{position.marketTitle}</p>
                  <div className="mt-2 flex justify-between gap-4 text-xs">
                    <span className="terminal-muted">{position.outcome}</span>
                    <span className="text-[var(--accent-green)]">
                      {position.currentValue ? `$${position.currentValue.toFixed(2)}` : `${position.quantity.toFixed(2)} shares`}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-[var(--bg-primary)] p-4">
          <h3 className="mb-3">Activity</h3>
          <div className="divide-y divide-[var(--border-primary)]">
            {!activity || activity.length === 0 ? (
              <p className="text-sm text-[var(--text-tertiary)]">No activity loaded</p>
            ) : (
              activity.slice(0, 5).map((item, index) => (
                <div key={`${item.marketId || item.tokenId || item.timestamp}-${index}`} className="py-3">
                  <div className="flex justify-between gap-3">
                    <p className="line-clamp-2 text-sm text-[var(--text-primary)]">{item.marketTitle || item.activityType}</p>
                    {item.side && (
                      <span className={item.side === 'buy' ? 'terminal-positive text-xs font-bold' : 'terminal-negative text-xs font-bold'}>
                        {item.side.toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex justify-between gap-4 text-xs">
                    <span className="terminal-muted">{item.outcome || item.activityType}</span>
                    <span className="terminal-muted">{new Date(item.timestamp).toLocaleDateString()}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
