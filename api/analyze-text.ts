import type { VercelRequest, VercelResponse } from '@vercel/node';
import { KeywordMatcher } from '../src/analysis/keyword-matcher';
import { generateSignal, TradingSignal } from '../src/analysis/signal-generator';
import { getMarkets, getArbitrage, getMarketMetadata } from './lib/market-cache';

function isMalformedJsonError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error instanceof SyntaxError) {
    return true;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('json') ||
    message.includes('unexpected token') ||
    message.includes('request body')
  );
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only accept POST
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

  const startTime = Date.now();

  try {
    const body = req.body as {
      text: string;
      minConfidence?: number;
      maxResults?: number;
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

    // Validate request
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

    // Validate text length (prevent abuse)
    if (body.text.length > 10000) {
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

    // Validate numeric parameters
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

    // Get markets
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

    // Match markets
    const matcher = new KeywordMatcher(markets, minConfidence, maxResults);
    const matches = matcher.match(text);

    // Get cached arbitrage opportunities
    const arbitrageOpportunities = await getArbitrage(0.03);
    let arbitrageForSignal = undefined;

    if (matches.length > 0 && arbitrageOpportunities.length > 0) {
      const topMatchId = matches[0].market.id;
      arbitrageForSignal = arbitrageOpportunities.find(
        arb => arb.polymarket.id === topMatchId || arb.kalshi.id === topMatchId
      );
    }

    // Generate trading signal
    const signal: TradingSignal = generateSignal(text, matches, arbitrageForSignal);

    // Stage 0: Get freshness metadata
    const freshnessMetadata = getMarketMetadata();

    // Build response
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
        metadata: {
          processing_time_ms: Date.now() - startTime,
          sources_checked: 2, // Polymarket + Kalshi
          markets_analyzed: markets.length,
          model_version: 'v2.1.0',
          implied_true_prob: signal.metadata.implied_true_prob ?? null,
          // Stage 0: Freshness metadata
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
