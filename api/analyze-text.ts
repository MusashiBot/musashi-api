import type { VercelRequest, VercelResponse } from '@vercel/node';
import { KeywordMatcher } from '../src/analysis/keyword-matcher';
import { generateSignal, TradingSignal } from '../src/analysis/signal-generator';
import { getMarkets, getArbitrage, getMarketMetadata } from './lib/market-cache';
import { VolatilityRegime } from '../src/analysis/kelly-sizing';
import {
  getClientIp,
  isRateLimited,
  parsePositiveIntEnv,
} from './lib/rate-limit';

function isMalformedJsonError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof SyntaxError) return true;
  const msg = error.message.toLowerCase();
  return msg.includes('json') || msg.includes('unexpected token') || msg.includes('request body');
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({
      event_id: 'evt_error',
      signal_type: 'user_interest',
      urgency: 'low',
      success: false,
      error: 'Method not allowed. Use POST.',
    });
    return;
  }

  const analyzeLimit = parsePositiveIntEnv('MUSASHI_ANALYZE_TEXT_RATE_LIMIT_PER_MIN', 120);
  if (isRateLimited(`analyze:${getClientIp(req)}`, analyzeLimit)) {
    res.status(429).json({
      event_id: 'evt_error',
      signal_type: 'user_interest',
      urgency: 'low',
      success: false,
      error: 'Too many requests. Retry later.',
    });
    return;
  }

  const startTime = Date.now();

  try {
    const body = req.body as {
      text: string;
      minConfidence?: number;
      maxResults?: number;
      vol_regime?: VolatilityRegime;
      use_ml_scorer?: boolean;
    } | null;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({
        event_id: 'evt_error',
        signal_type: 'user_interest',
        urgency: 'low',
        success: false,
        error: 'Request body must be a JSON object.',
      });
      return;
    }

    if (!body.text || typeof body.text !== 'string') {
      res.status(400).json({
        event_id: 'evt_error',
        signal_type: 'user_interest',
        urgency: 'low',
        success: false,
        error: 'Missing or invalid "text" field in request body.',
      });
      return;
    }

    if (body.text.length > 10_000) {
      res.status(400).json({
        event_id: 'evt_error',
        signal_type: 'user_interest',
        urgency: 'low',
        success: false,
        error: 'Text exceeds 10,000 character limit.',
      });
      return;
    }

    const { text, minConfidence = 0.3, maxResults = 5 } = body;
    const useMlScorer = body.use_ml_scorer === true;

    // Optional volatility regime hint from caller (e.g. from their own regime detector)
    const volRegime: VolatilityRegime =
      body.vol_regime === 'low' || body.vol_regime === 'high' ? body.vol_regime : 'normal';

    if (
      typeof minConfidence !== 'number' ||
      !Number.isFinite(minConfidence) ||
      minConfidence < 0 ||
      minConfidence > 1
    ) {
      res.status(400).json({
        event_id: 'evt_error',
        signal_type: 'user_interest',
        urgency: 'low',
        success: false,
        error: 'minConfidence must be between 0 and 1.',
      });
      return;
    }

    if (
      typeof maxResults !== 'number' ||
      !Number.isFinite(maxResults) ||
      maxResults < 1 ||
      maxResults > 100
    ) {
      res.status(400).json({
        event_id: 'evt_error',
        signal_type: 'user_interest',
        urgency: 'low',
        success: false,
        error: 'maxResults must be between 1 and 100.',
      });
      return;
    }

    if (body.use_ml_scorer !== undefined && typeof body.use_ml_scorer !== 'boolean') {
      res.status(400).json({
        event_id: 'evt_error',
        signal_type: 'user_interest',
        urgency: 'low',
        success: false,
        error: 'use_ml_scorer must be a boolean when provided.',
      });
      return;
    }

    const markets = await getMarkets();

    if (markets.length === 0) {
      res.status(503).json({
        event_id: 'evt_error',
        signal_type: 'user_interest',
        urgency: 'low',
        success: false,
        error: 'No markets available. Service temporarily unavailable.',
      });
      return;
    }

    const matcher = new KeywordMatcher(markets, minConfidence, maxResults);
    const matches = matcher.match(text);

    // Filter out anomalous markets from arbitrage consideration
    const arbitrageOpportunities = await getArbitrage(0.03);
    let arbitrageForSignal = undefined;

    if (matches.length > 0 && arbitrageOpportunities.length > 0) {
      const topMatchId = matches[0].market.id;
      arbitrageForSignal = arbitrageOpportunities.find(
        arb =>
          (arb.polymarket.id === topMatchId || arb.kalshi.id === topMatchId) &&
          !arb.is_directionally_opposed // Skip false positives
      );
    }

    const signal: TradingSignal = generateSignal(text, matches, arbitrageForSignal, volRegime, {
      use_ml_scorer: useMlScorer,
    });

    const freshnessMetadata = getMarketMetadata();

    const response = {
      event_id: signal.event_id,
      signal_type: signal.signal_type,
      urgency: signal.urgency,
      success: true,
      data: {
        markets: signal.matches,
        matchCount: signal.matches.length,
        timestamp: new Date().toISOString(),
        suggested_action: signal.suggested_action,
        sentiment: signal.sentiment,
        arbitrage: signal.arbitrage,
        // ── New fields ──────────────────────────────────────────────────
        valid_until_seconds: signal.valid_until_seconds,
        is_near_resolution: signal.is_near_resolution,
        vol_regime: volRegime,
        use_ml_scorer: useMlScorer,
        ml_score: signal.ml_score,
        ml_score_shadow: signal.ml_score_shadow,
        metadata: {
          processing_time_ms: Date.now() - startTime,
          sources_checked: 2,
          markets_analyzed: markets.length,
          model_version: 'v3.0.0',
          data_age_seconds: freshnessMetadata.data_age_seconds,
          fetched_at: freshnessMetadata.fetched_at,
          sources: freshnessMetadata.sources,
        },
      },
    };

    res.status(200).json(response);
  } catch (error) {
    if (isMalformedJsonError(error)) {
      res.status(400).json({
        event_id: 'evt_error',
        signal_type: 'user_interest',
        urgency: 'low',
        success: false,
        error: 'Malformed JSON request body.',
      });
      return;
    }

    console.error('[API] Error in analyze-text:', error);
    res.status(500).json({
      event_id: 'evt_error',
      signal_type: 'user_interest',
      urgency: 'low',
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
