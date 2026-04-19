import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchPolymarkets } from '../src/api/polymarket-client';
import { fetchKalshiMarkets } from '../src/api/kalshi-client';
import { getArbitrageCacheMetadata, getMarketMetadata } from './lib/market-cache';

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

    const freshness = getMarketMetadata();
    const arbCache = getArbitrageCacheMetadata();

    const healthData = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime_ms: process.uptime() * 1000,
      response_time_ms: Date.now() - startTime,
      version: '2.0.0',
      services: {
        polymarket: polymarketStatus,
        kalshi: kalshiStatus,
      },
      endpoints: {
        '/api/analyze-text': {
          method: 'POST',
          description: 'Analyze text and return matching markets with trading signals',
          status: 'healthy',
        },
        '/api/markets/arbitrage': {
          method: 'GET',
          description: 'Get cross-platform arbitrage opportunities',
          status: 'healthy',
        },
        '/api/markets/movers': {
          method: 'GET',
          description: 'Get markets with significant price changes',
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
      caches: {
        arbitrage: arbCache,
      },
      feature_flags: {
        ARB_V15_ENABLED: process.env.ARB_V15_ENABLED !== '0',
        ARB_NET_EDGE_ENABLED: process.env.ARB_NET_EDGE_ENABLED !== '0',
        ARB_STRICT_MATCH_ENABLED: process.env.ARB_STRICT_MATCH_ENABLED !== '0',
        ARB_SHARED_CACHE_ENABLED: process.env.ARB_SHARED_CACHE_ENABLED === '1',
      },
      freshness: {
        data_age_seconds: freshness.data_age_seconds,
        fetched_at: freshness.fetched_at,
        sources: freshness.sources,
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
