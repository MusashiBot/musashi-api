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
    <section className="card p-6 mb-8">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 mb-6">
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-gray-50 text-lg">Wallet Intelligence</h3>
          {lastQueried && (
            <p className="text-xs font-mono text-gray-500 dark:text-gray-400 mt-1">
              {lastQueried.slice(0, 8)}...{lastQueried.slice(-6)}
            </p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3 lg:w-[680px]">
          <input
            value={wallet}
            onChange={(event) => setWallet(event.target.value)}
            placeholder="0x wallet address"
            className="min-w-0 flex-1 p-3 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-500 font-mono text-sm"
          />
          <button
            type="submit"
            disabled={loading}
            className="px-5 py-3 bg-gray-700 hover:bg-gray-800 disabled:bg-gray-400 dark:bg-gray-600 dark:hover:bg-gray-700 text-white rounded-lg font-medium transition"
          >
            {loading ? 'Loading...' : 'Analyze Wallet'}
          </button>
        </form>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-200 rounded-lg text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <div className="p-4 rounded-lg border border-gray-300 dark:border-gray-700 h-full">
            <p className="text-sm text-gray-600 dark:text-gray-400">Positions</p>
            <p className="text-3xl font-bold text-gray-900 dark:text-gray-100 mt-2">
              {positions?.length || 0}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-4">Current Value</p>
            <p className="text-2xl font-bold text-green-600 dark:text-green-500">
              ${totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </p>
          </div>
        </div>

        <div>
          <h4 className="font-medium text-gray-900 dark:text-gray-100 mb-3">Positions</h4>
          <div className="space-y-3">
            {!positions || positions.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400 text-sm">No positions loaded</p>
            ) : (
              positions.slice(0, 5).map((position) => (
                <div key={`${position.marketId || position.tokenId}-${position.outcome}`} className="p-3 rounded-lg border border-gray-300 dark:border-gray-700">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2">
                    {position.marketTitle}
                  </p>
                  <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400 mt-2">
                    <span>{position.outcome}</span>
                    <span>{position.currentValue ? `$${position.currentValue.toFixed(2)}` : `${position.quantity.toFixed(2)} shares`}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div>
          <h4 className="font-medium text-gray-900 dark:text-gray-100 mb-3">Activity</h4>
          <div className="space-y-3">
            {!activity || activity.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400 text-sm">No activity loaded</p>
            ) : (
              activity.slice(0, 5).map((item, index) => (
                <div key={`${item.marketId || item.tokenId || item.timestamp}-${index}`} className="p-3 rounded-lg border border-gray-300 dark:border-gray-700">
                  <div className="flex justify-between gap-3">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2">
                      {item.marketTitle || item.activityType}
                    </p>
                    {item.side && (
                      <span className={`text-xs font-semibold ${item.side === 'buy' ? 'text-green-600 dark:text-green-500' : 'text-red-600 dark:text-red-500'}`}>
                        {item.side.toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400 mt-2">
                    <span>{item.outcome || item.activityType}</span>
                    <span>{new Date(item.timestamp).toLocaleDateString()}</span>
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
