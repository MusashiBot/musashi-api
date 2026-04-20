import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchPolymarkets } from '../src/api/polymarket-client';
import { fetchKalshiMarkets } from '../src/api/kalshi-client';

/** Env-derived flags for demos / ops — no secrets returned. */
function operationalReadiness(): Record<string, boolean> {
  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon =
    process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_KEY;

  return {
    supabase_project_configured: Boolean(supabaseUrl),
    signal_logging_ready: Boolean(supabaseUrl && anon),
    metrics_dashboard_ready: Boolean(supabaseUrl && (anon || service)),
    batch_resolution_job_ready: Boolean(supabaseUrl && service),
    kv_movers_history_ready: Boolean(
      process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
    ),
    internal_resolve_configured: Boolean(process.env.INTERNAL_API_KEY),
    polymarket_ws_enabled: process.env.MUSASHI_POLYMARKET_WS === '1',
    semantic_matching_disabled: process.env.MUSASHI_DISABLE_SEMANTIC_MATCHING === '1',
  };
}

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
      operational_readiness: operationalReadiness(),
      timestamp: new Date().toISOString(),
      uptime_ms: process.uptime() * 1000,
      response_time_ms: Date.now() - startTime,
      version: '3.0.0',
      services: {
        polymarket: polymarketStatus,
        kalshi: kalshiStatus,
      },
      endpoints: {
        '/api/analyze-text': {
          method: 'POST',
          description: 'Analyze text; returns matching markets, trading signal with Kelly position sizing, valid_until, and weighted sentiment',
          status: 'healthy',
          new_fields: ['suggested_action.position_size', 'valid_until_seconds', 'is_near_resolution', 'vol_regime'],
        },
        '/api/markets/arbitrage': {
          method: 'GET',
          description: 'Cross-platform arbitrage with liquidity-adjusted net spread and directional-opposition filtering',
          status: 'healthy',
          new_fields: ['net_spread', 'liquidity_penalty', 'is_directionally_opposed'],
          new_params: ['minNetSpread', 'excludeOpposed'],
        },
        '/api/markets/movers': {
          method: 'GET',
          description: 'Markets with significant price changes (7-day KV history)',
          status: 'healthy',
        },
        '/api/risk/session': {
          method: 'POST',
          description: 'Session-level risk circuit breaker — returns throttle_level (normal/caution/halt) and Kelly multiplier based on daily P&L',
          status: 'healthy',
        },
        '/api/metrics/performance': {
          method: 'GET',
          description: 'Historical signal performance metrics (requires Supabase signal_outcomes)',
          status: 'healthy',
        },
        '/api/internal/resolve-market': {
          method: 'POST',
          description: 'INTERNAL — resolve a market outcome for logged signals when INTERNAL_API_KEY is configured',
          status: 'conditional',
        },
        '/api/ground-probability': {
          method: 'GET',
          description: 'Calibration / grounding helpers for probabilities',
          status: 'healthy',
        },
        '/api/feed': {
          method: 'GET',
          description: 'Aggregated tracked Twitter accounts feed',
          status: 'healthy',
        },
        '/api/feed/stats': {
          method: 'GET',
          description: 'Feed ingestion statistics',
          status: 'healthy',
        },
        '/api/feed/accounts': {
          method: 'GET',
          description: 'Tracked feed account list',
          status: 'healthy',
        },
        '/api/markets/smart-money': {
          method: 'GET',
          description: 'Large-wallet / cluster flow summaries for Polymarket',
          status: 'healthy',
        },
        '/api/markets/wallet-flow': {
          method: 'GET',
          description: 'Trade flow aggregates for tracked wallets',
          status: 'healthy',
        },
        '/api/wallet/activity': {
          method: 'GET',
          description: 'Recent activity for a tracked wallet address',
          status: 'healthy',
        },
        '/api/wallet/positions': {
          method: 'GET',
          description: 'Open positions for a wallet address',
          status: 'healthy',
        },
        '/api/cron/collect-tweets': {
          method: 'GET',
          description: 'Scheduled ingestion (Vercel cron); protected in production — do not expose publicly without auth',
          status: 'conditional',
        },
        '/api/health': {
          method: 'GET',
          description: 'API health check',
          status: 'healthy',
        },
      },
      improvements_v3: {
        liquidity_adjusted_spread: 'Arbitrage spreads net of estimated bid/ask friction by volume tier',
        directional_opposition_guard: 'Automatically filters out opposite-directional false-positive arb pairs',
        synonym_expansion: 'Market titles normalised across FOMC/Fed, rate-cut/reduction, BTC/Bitcoin, etc.',
        kelly_position_sizing: 'Every suggested_action includes Quarter-Kelly fraction with vol-regime scaling',
        weighted_sentiment: 'aggregateWeightedSentiment() applies recency decay + author influence weighting',
        signal_validity: 'valid_until_seconds tells bots exactly when to discard a signal',
        risk_circuit_breaker: 'POST /api/risk/session enforces -5%/caution, -10%/halt daily loss limits',
      },
      limits: {
        max_markets_per_request: 5,
        cache_ttl_seconds: 20,
        arbitrage_cache_ttl_seconds: 15,
        analyze_text_post_rate_limit_per_ip_per_minute:
          parseInt(process.env.MUSASHI_ANALYZE_TEXT_RATE_LIMIT_PER_MIN ?? '120', 10),
        arbitrage_get_rate_limit_per_ip_per_minute:
          parseInt(process.env.MUSASHI_ARBITRAGE_RATE_LIMIT_PER_MIN ?? '90', 10),
        polymarket_ws: process.env.MUSASHI_POLYMARKET_WS === '1' ? 'enabled' : 'disabled',
        semantic_matching_disabled: process.env.MUSASHI_DISABLE_SEMANTIC_MATCHING === '1',
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
