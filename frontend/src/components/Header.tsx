import React from 'react';

interface HeaderProps {
  isDark: boolean;
  onToggleDark: () => void;
  apiStatus?: 'healthy' | 'degraded' | 'down';
  apiLoading?: boolean;
}

export const Header: React.FC<HeaderProps> = ({ isDark, onToggleDark, apiStatus, apiLoading = false }) => {
  const statusLabel = apiLoading ? 'SYNC' : apiStatus === 'healthy' ? 'LIVE' : apiStatus === 'degraded' ? 'DEGRADED' : 'OFFLINE';
  const statusClass = apiLoading
    ? 'terminal-status-dot terminal-status-warn'
    : apiStatus === 'healthy'
      ? 'terminal-status-dot terminal-status-online'
      : apiStatus === 'degraded'
        ? 'terminal-status-dot terminal-status-warn'
        : 'terminal-status-dot terminal-status-offline';

  return (
    <header className="terminal-topbar">
      <div className="terminal-topbar-inner">
        <div className="flex min-w-0 items-center gap-5">
          <div className="terminal-brand">MUSASHI</div>
          <div className="flex items-center gap-2 text-[10px] uppercase text-[var(--text-secondary)]">
            <span className={statusClass}></span>
            <span>{statusLabel}</span>
          </div>
          <div className="hidden text-[10px] uppercase text-[var(--text-tertiary)] sm:block">
            prediction market intelligence
          </div>
        </div>

        <nav className="terminal-nav" aria-label="Terminal navigation">
          <a href="#terminal-markets">MARKETS</a>
          <a href="#terminal-arbitrage">ARBITRAGE</a>
          <a href="#terminal-wallet">WALLETS</a>
          <a href="#terminal-api">API</a>
          <span>{new Date().toLocaleTimeString()}</span>
          <button
            onClick={onToggleDark}
            className="border border-[var(--border-lighter)] px-2 py-1 text-[10px] uppercase text-[var(--text-secondary)] transition hover:border-[var(--text-primary)] hover:text-[var(--text-primary)]"
            aria-label={isDark ? 'Switch to dusk display mode' : 'Switch to dark display mode'}
          >
            {isDark ? 'DUSK' : 'DARK'}
          </button>
        </nav>
      </div>
    </header>
  );
};
