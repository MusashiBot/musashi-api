import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchPolymarkets } from '../src/api/polymarket-client';
import { fetchKalshiMarkets } from '../src/api/kalshi-client';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only accept GET
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({
      success: false,
      error: 'Method not allowed. Use GET.',
    });
    return;
  }

  const startTime = Date.now();

  try {
    // Test API connections
    const [polyResult, kalshiResult] = await Promise.allSettled([
      fetchPolymarkets(10, 1), // Just fetch 10 markets as a health check
      fetchKalshiMarkets(10, 1),
    ]);

    const polymarketStatus = polyResult.status === 'fulfilled'
      ? { status: 'healthy', markets: polyResult.value.length }
      : { status: 'degraded', error: String(polyResult.reason) };

    const kalshiStatus = kalshiResult.status === 'fulfilled'
      ? { status: 'healthy', markets: kalshiResult.value.length }
      : { status: 'degraded', error: String(kalshiResult.reason) };

    // Determine overall status
    const overallStatus =
      polymarketStatus.status === 'healthy' && kalshiStatus.status === 'healthy'
        ? 'healthy'
        : polymarketStatus.status === 'degraded' && kalshiStatus.status === 'degraded'
        ? 'down'
        : 'degraded';

    const healthData = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime_ms: process.uptime() * 1000,
      response_time_ms: Date.now() - startTime,
      version: '2.1.0',
      services: {
        polymarket: polymarketStatus,
        kalshi: kalshiStatus,
      },
      endpoints: {
        '/api/analyze-text': {
          method: 'POST',
          description: 'Analyze text and return matching markets with trading signals (EV + Kelly)',
          status: 'healthy',
        },
        '/api/ground-probability': {
          method: 'POST',
          description: 'Compare an LLM probability estimate to the market consensus',
          status: 'healthy',
        },
        '/api/position-sizing': {
          method: 'POST',
          description: 'Kelly-optimal stake given true_prob, yes_price, bankroll, and liquidity',
          status: 'healthy',
        },
        '/api/risk-assessment': {
          method: 'POST',
          description: 'Evaluate a proposed trade: EV, variance, Sharpe, and recommendation',
          status: 'healthy',
        },
        '/api/markets/arbitrage': {
          method: 'GET',
          description: 'Cross-platform arbitrage opportunities (fee-adjusted, with synthetic arb)',
          status: 'healthy',
        },
        '/api/markets/movers': {
          method: 'GET',
          description: 'Markets with significant price changes',
          status: 'healthy',
        },
        '/api/markets/smart-money': {
          method: 'GET',
          description: 'Markets ranked by smart-wallet flow',
          status: 'healthy',
        },
        '/api/health': {
          method: 'GET',
          description: 'API health check',
          status: 'healthy',
        },
      },
      limits: {
        max_markets_per_request: 5,
        cache_ttl_seconds: 300,
        rate_limit: 'none (currently)',
      },
    };

    const response = {
      success: true,
      data: healthData,
    };

    const statusCode = overallStatus === 'healthy' ? 200 : overallStatus === 'degraded' ? 503 : 503;
    res.status(statusCode).json(response);

  } catch (error) {
    console.error('[Health API] Error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
