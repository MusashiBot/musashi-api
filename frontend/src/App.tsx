import { useEffect, useMemo, useState } from 'react';
import { useDarkMode, useFetch } from './hooks';
import {
  getHealth,
  getArbitrage,
  getFeed,
  getMovers,
  getFeedStats,
  getFeedAccounts,
  API_BASE_URL,
  Market,
  ArbitrageOpportunity,
  MarketMover,
  HealthStatus,
  ArbitrageResponse,
  FeedData,
  MoversResponse,
  FeedStatsResponse,
  FeedAccountsResponse,
} from './api';
import {
  Header,
  HealthCard,
  MarketsCard,
  ArbitrageCard,
  TextAnalyzer,
  MoversCard,
  FeedStatsCard,
  AccountsCard,
  WalletPanel,
} from './components';

const formatTime = (value?: string) => {
  if (!value) {
    return '--:--:--';
  }

  return new Date(value).toLocaleTimeString();
};

function App() {
  const { isDark, toggle: toggleDark } = useDarkMode();

  const healthData = useFetch<HealthStatus>(
    () => getHealth(),
    10000
  );

  const arbitrageData = useFetch<ArbitrageResponse>(
    () => getArbitrage(0.03),
    30000
  );

  const feedData = useFetch<FeedData>(
    () => getFeed(20),
    30000
  );

  const moversData = useFetch<MoversResponse>(
    () => getMovers(0.05, 5),
    60000
  );

  const feedStatsData = useFetch<FeedStatsResponse>(
    () => getFeedStats(),
    60000
  );

  const feedAccountsData = useFetch<FeedAccountsResponse>(
    () => getFeedAccounts(),
    300000
  );
  const [stickyArbitrage, setStickyArbitrage] = useState<ArbitrageOpportunity[] | null>(null);
  const [stickyMovers, setStickyMovers] = useState<MarketMover[] | null>(null);

  useEffect(() => {
    const nextArbitrage = arbitrageData.data?.opportunities || [];
    if (nextArbitrage.length > 0) {
      setStickyArbitrage(nextArbitrage);
    }
  }, [arbitrageData.data?.opportunities]);

  useEffect(() => {
    const nextMovers = moversData.data?.movers || [];
    if (nextMovers.length > 0) {
      setStickyMovers(nextMovers);
    }
  }, [moversData.data?.movers]);

  const activeMarkets = useMemo(() => {
    const marketsById = new Map<string, Market>();

    feedData.data?.tweets.forEach(tweet => {
      tweet.matches.forEach(match => {
        marketsById.set(match.market.id, match.market);
      });
    });

    return Array.from(marketsById.values());
  }, [feedData.data]);

  const totalMarkets = (healthData.data?.services?.polymarket?.markets || 0)
    + (healthData.data?.services?.kalshi?.markets || 0);
  const latestSignals = feedData.data?.tweets.slice(0, 4) || [];
  const arbitrageCount = arbitrageData.data?.count || 0;
  const feedCount = feedData.data?.count || 0;
  const apiStatus = healthData.data?.status || 'down';
  const responseTime = healthData.data?.response_time_ms;
  const displayedArbitrage = arbitrageData.data?.opportunities?.length
    ? arbitrageData.data.opportunities
    : stickyArbitrage;
  const displayedMovers = moversData.data?.movers?.length
    ? moversData.data.movers
    : stickyMovers;

  return (
    <div className={`${isDark ? 'dark ' : ''}terminal-shell`}>
      <Header
        isDark={isDark}
        onToggleDark={toggleDark}
        apiStatus={healthData.data?.status}
        apiLoading={healthData.loading && !healthData.data}
      />

      <main className="terminal-main">
        <section className="terminal-hero" aria-labelledby="terminal-title">
          <div>
            <p className="terminal-prompt">
              <strong>musashi@markets</strong>:~$ scan --platform polymarket,kalshi --execution full
            </p>
            <h1 id="terminal-title" className="ascii-logo">MUSASHI</h1>
            <p className="terminal-copy">
              One terminal for prediction-market intelligence: live market matching, arbitrage scans,
              wallet reads, feed monitoring, and API calls from a single command surface.
            </p>
            <div className="terminal-actions">
              <a className="terminal-button" href="#terminal-api">[ENTER] GET API KEY</a>
              <a className="terminal-button terminal-button-secondary" href="#terminal-docs">[D] DOCUMENTATION</a>
              <a className="terminal-button terminal-button-secondary" href="#terminal-feed">[F] LIVE FEED</a>
            </div>
          </div>
        </section>

        <section className="terminal-band terminal-band-grid" aria-label="Terminal metrics">
          <div className="terminal-stat">
            <span className="terminal-stat-label">API Status</span>
            <strong className={apiStatus === 'healthy' ? 'terminal-stat-value terminal-positive' : 'terminal-stat-value terminal-warning'}>
              {apiStatus.toUpperCase()}
            </strong>
            <span className="terminal-stat-sub">{responseTime ? `${responseTime}ms` : 'waiting for health check'}</span>
          </div>
          <div className="terminal-stat">
            <span className="terminal-stat-label">Markets Indexed</span>
            <strong className="terminal-stat-value">{totalMarkets.toLocaleString()}</strong>
            <span className="terminal-stat-sub">poly + kalshi sources</span>
          </div>
          <div className="terminal-stat">
            <span className="terminal-stat-label">Arbitrage Routes</span>
            <strong className="terminal-stat-value terminal-positive">{arbitrageCount}</strong>
            <span className="terminal-stat-sub">min spread 3%</span>
          </div>
          <div className="terminal-stat">
            <span className="terminal-stat-label">Signals Loaded</span>
            <strong className="terminal-stat-value">{feedCount}</strong>
            <span className="terminal-stat-sub">last sync {formatTime(feedData.data?.timestamp)}</span>
          </div>
        </section>

        <section className="terminal-grid" id="terminal-feed">
          <div className="terminal-stack">
            <MarketsCard
              data={activeMarkets}
              loading={feedData.loading}
              error={feedData.error}
            />

            <div className="grid grid-cols-1 xl:grid-cols-2">
              <section className="terminal-panel terminal-anchor" id="terminal-api">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h2 className="terminal-panel-title">What You Get</h2>
                  <span className="terminal-panel-kicker">fast</span>
                </div>
                <div className="space-y-4 text-[12px] leading-6 text-[var(--text-secondary)]">
                  <div>
                    <p className="text-[var(--accent-blue)]">$ GET /v1/markets</p>
                    <p className="terminal-muted">Search, sort, and filter markets across platforms by category, volume, liquidity, and price.</p>
                  </div>
                  <div>
                    <p className="text-[var(--accent-blue)]">$ POST /v1/text/analyze</p>
                    <p className="terminal-muted">Paste news, tweets, or claims and return matched markets with urgency and confidence.</p>
                  </div>
                  <div>
                    <p className="text-[var(--accent-blue)]">$ GET /v1/markets/arbitrage</p>
                    <p className="terminal-muted">Detect same-event price dislocations between Polymarket and Kalshi.</p>
                  </div>
                </div>
              </section>

              <section className="terminal-panel">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h2 className="terminal-panel-title">Live Signal Flow</h2>
                  <span className="terminal-panel-kicker">watch</span>
                </div>
                {latestSignals.length === 0 ? (
                  <p className="text-[12px] text-[var(--text-tertiary)]">Waiting for feed signals...</p>
                ) : (
                  <div className="divide-y divide-[var(--border-primary)]">
                    {latestSignals.map(signal => (
                      <div key={signal.tweet.id} className="py-3">
                        <div className="mb-1 flex items-center justify-between gap-3 text-[10px] uppercase text-[var(--text-tertiary)]">
                          <span>@{signal.tweet.author}</span>
                          <span className={signal.urgency === 'high' || signal.urgency === 'critical' ? 'terminal-warning' : 'terminal-positive'}>
                            {signal.urgency}
                          </span>
                        </div>
                        <p className="line-clamp-2 text-[12px] leading-5 text-[var(--text-primary)]">{signal.tweet.text}</p>
                        <p className="mt-1 text-[10px] uppercase text-[var(--text-tertiary)]">{signal.matches.length} market matches</p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <ArbitrageCard
              data={displayedArbitrage}
              loading={arbitrageData.loading}
              error={arbitrageData.error}
            />

            <MoversCard
              data={displayedMovers}
              loading={moversData.loading}
              error={moversData.error}
            />
          </div>

          <aside className="terminal-stack" aria-label="Terminal side rail">
            <HealthCard
              data={healthData.data}
              loading={healthData.loading}
              error={healthData.error}
            />

            <TextAnalyzer />

            <FeedStatsCard
              data={feedStatsData.data}
              loading={feedStatsData.loading}
              error={feedStatsData.error}
            />

            <AccountsCard
              data={feedAccountsData.data}
              loading={feedAccountsData.loading}
              error={feedAccountsData.error}
            />
          </aside>
        </section>

        <WalletPanel />

        <section className="terminal-panel mt-8" id="terminal-docs">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="terminal-panel-title">API Quickstart</h2>
            <span className="terminal-panel-kicker">test</span>
          </div>
          <code className="terminal-code">{`# Sign your app and query the live market plane
$ curl '${API_BASE_URL}/health'

# Ask Musashi to map plain text to tradeable markets
$ curl -X POST '${API_BASE_URL}/analyze-text' \\
  -H 'Content-Type: application/json' \\
  -d '{"text":"Fed cuts rates by 25bps in July","minConfidence":0.3}'

# Pull cross-platform price dislocations
$ curl '${API_BASE_URL}/markets/arbitrage?minSpread=0.03'`}</code>
        </section>

        <footer className="mt-10 flex flex-col gap-2 border-t border-[var(--border-primary)] py-5 text-[10px] uppercase text-[var(--text-tertiary)] sm:flex-row sm:items-center sm:justify-between">
          <span>Musashi API / Prediction Market Intelligence</span>
          <span>{API_BASE_URL} / React + TypeScript</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
