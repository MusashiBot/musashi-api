import { useDarkMode, useFetch } from './hooks';
import { getHealth, getArbitrage, Market, HealthStatus, ArbitrageResponse } from './api';
import { Header, HealthCard, MarketsCard, ArbitrageCard, TextAnalyzer } from './components';

const mockMarkets: Market[] = [
  {
    id: 'poly-1',
    platform: 'polymarket',
    title: 'Will Bitcoin exceed $100k by end of 2026?',
    description: 'Bitcoin price prediction',
    yesPrice: 0.72,
    noPrice: 0.28,
    volume24h: 125000,
    url: 'https://polymarket.com',
    category: 'crypto',
    lastUpdated: new Date().toISOString(),
  },
  {
    id: 'kalshi-1',
    platform: 'kalshi',
    title: 'Will the Fed cut rates in May 2026?',
    description: 'Federal Reserve interest rate prediction',
    yesPrice: 0.45,
    noPrice: 0.55,
    volume24h: 89000,
    url: 'https://kalshi.com',
    category: 'economics',
    lastUpdated: new Date().toISOString(),
  },
  {
    id: 'poly-2',
    platform: 'polymarket',
    title: 'Will Ethereum 2.0 implementation succeed?',
    description: 'Ethereum upgrade outcome',
    yesPrice: 0.88,
    noPrice: 0.12,
    volume24h: 67000,
    url: 'https://polymarket.com',
    category: 'crypto',
    lastUpdated: new Date().toISOString(),
  },
  {
    id: 'kalshi-2',
    platform: 'kalshi',
    title: 'Will Apple stock price reach $200 by Q3 2026?',
    description: 'Apple stock price prediction',
    yesPrice: 0.61,
    noPrice: 0.39,
    volume24h: 156000,
    url: 'https://kalshi.com',
    category: 'stocks',
    lastUpdated: new Date().toISOString(),
  },
  {
    id: 'poly-3',
    platform: 'polymarket',
    title: 'Will AI regulation bill pass Congress by 2026?',
    description: 'AI regulation legislation prediction',
    yesPrice: 0.34,
    noPrice: 0.66,
    volume24h: 45000,
    url: 'https://polymarket.com',
    category: 'technology',
    lastUpdated: new Date().toISOString(),
  },
];

function App() {
  const { isDark, toggle: toggleDark } = useDarkMode();

  const healthData = useFetch<HealthStatus>(
    () => getHealth(),
    10000 // Refresh every 10 seconds
  );

  const arbitrageData = useFetch<ArbitrageResponse>(
    () => getArbitrage(0.03),
    30000 // Refresh every 30 seconds
  );

  return (
    <div className={isDark ? 'dark' : ''}>
      <div className="min-h-screen bg-white dark:bg-black text-gray-900 dark:text-gray-50">
        <Header isDark={isDark} onToggleDark={toggleDark} />

        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Top Row: Status & Key Metrics */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {/* Health Status */}
            <div className="lg:col-span-2">
              <HealthCard
                data={healthData.data}
                loading={healthData.loading}
                error={healthData.error}
              />
            </div>

            {/* Quick Stats */}
            <div className="card p-4">
              <h3 className="font-semibold mb-4 text-gray-900 dark:text-gray-50">Quick Stats</h3>
              <div className="space-y-3 text-sm">
                <div>
                  <p className="text-gray-600 dark:text-gray-400">Total Markets</p>
                  <p className="text-2xl font-bold text-gray-700 dark:text-gray-300">
                    {healthData.data?.services?.polymarket?.markets || 0} + {healthData.data?.services?.kalshi?.markets || 0}
                  </p>
                </div>
                <div>
                  <p className="text-gray-600 dark:text-gray-400">Arbitrage</p>
                  <p className="text-2xl font-bold text-green-600 dark:text-green-500">
                    {arbitrageData.data?.count || 0}
                  </p>
                </div>
              </div>
            </div>

            {/* Last Updated */}
            <div className="card p-4">
              <h3 className="font-semibold mb-4 text-gray-900 dark:text-gray-50">Data Freshness</h3>
              <div className="space-y-2 text-sm">
                <div>
                  <p className="text-gray-600 dark:text-gray-400">Health Check</p>
                  <p className="text-xs font-mono text-green-600 dark:text-green-500">
                    {healthData.data?.timestamp ? new Date(healthData.data.timestamp).toLocaleTimeString() : '-'}
                  </p>
                </div>
                <div>
                  <p className="text-gray-600 dark:text-gray-400">Arbitrage Scan</p>
                  <p className="text-xs font-mono text-green-600 dark:text-green-500">
                    {new Date().toLocaleTimeString()}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Main Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
            {/* Left Column: Markets & Arbitrage */}
            <div className="lg:col-span-2 space-y-6">
              <MarketsCard
                data={mockMarkets}
                loading={false}
                error={null}
              />

              <ArbitrageCard
                data={arbitrageData.data?.opportunities || null}
                loading={arbitrageData.loading}
                error={arbitrageData.error}
              />
            </div>

            {/* Right Column: Text Analyzer */}
            <div>
              <TextAnalyzer />
            </div>
          </div>

          {/* Data Source Info */}
          <div className="card p-6 mb-8">
            <h3 className="font-semibold mb-4 text-gray-900 dark:text-gray-50">How Musashi Works</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded bg-gray-300 dark:bg-gray-700 flex items-center justify-center text-gray-700 dark:text-gray-300 font-bold">
                    1
                  </div>
                  <h4 className="font-medium text-gray-900 dark:text-gray-100">Polymarket Feed</h4>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Real-time market data from Polymarket's prediction markets API.
                </p>
              </div>

              <div>
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded bg-gray-400 dark:bg-gray-600 flex items-center justify-center text-gray-800 dark:text-gray-200 font-bold">
                    2
                  </div>
                  <h4 className="font-medium text-gray-900 dark:text-gray-100">Kalshi Integration</h4>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Financial markets from Kalshi combined for comprehensive coverage.
                </p>
              </div>

              <div>
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded bg-gray-500 dark:bg-gray-600 flex items-center justify-center text-white dark:text-gray-200 font-bold">
                    3
                  </div>
                  <h4 className="font-medium text-gray-900 dark:text-gray-100">Signal Analysis</h4>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Intelligent arbitrage detection and trading signal generation.
                </p>
              </div>
            </div>
          </div>

          {/* Footer */}
          <footer className="text-center text-sm text-gray-600 dark:text-gray-400 py-6 border-t border-gray-200 dark:border-gray-800">
            <p>Musashi API • Prediction Market Intelligence • {new Date().getFullYear()}</p>
            <p className="text-xs mt-2">Backend: Running at http://localhost:3000 • Frontend: React + TypeScript</p>
          </footer>
        </main>
      </div>
    </div>
  );
}

export default App;
