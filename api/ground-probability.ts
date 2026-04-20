import type { VercelRequest, VercelResponse } from '@vercel/node';
import { KeywordMatcher } from '../src/analysis/keyword-matcher';
import { getMarkets, getMarketMetadata } from './lib/market-cache';
import { Market, MarketMatch } from '../src/types/market';
import { enforceRateLimit } from './lib/rate-limit';

/**
 * Ground Probability Endpoint
 *
 * THE KEY PRIMITIVE that makes Musashi different.
 * Takes a natural language probability claim + optional LLM estimate
 * → finds relevant markets → returns what markets actually price it at
 *
 * Example:
 *   Input: "There's a 70% chance the Fed cuts in May", llm_estimate: 0.70
 *   Output: market_price: 0.43, divergence: +0.27
 */

interface GroundProbabilityRequest {
  claim: string;
  llm_estimate?: number;
  min_confidence?: number;
  max_markets?: number;
}

interface DivergenceAnalysis {
  type: 'higher' | 'lower' | 'aligned' | 'no_data';
  magnitude: number; // Absolute difference
  magnitude_percent: number; // Percentage points
  insight: string;
}

interface GroundProbabilityResponse {
  success: boolean;
  claim: string;
  llm_estimate: number | null;
  market_consensus: {
    price: number | null;
    confidence: number; // How confident we are this is the right market
    market_count: number;
    markets: Array<{
      title: string;
      platform: string;
      yes_price: number;
      volume_24h: number;
      url: string;
      match_confidence: number;
    }>;
  };
  divergence: DivergenceAnalysis | null;
  timestamp: string;
  metadata: {
    processing_time_ms: number;
    data_age_seconds: number;
    fetched_at: string;
  };
}

/**
 * Calculate weighted consensus price from market matches
 * Weights by (confidence × volume)
 */
function calculateConsensusPrice(matches: MarketMatch[]): number | null {
  if (matches.length === 0) return null;

  let totalWeight = 0;
  let weightedSum = 0;

  for (const match of matches) {
    // Weight = match confidence × log(volume + 1)
    // Log scaling prevents single high-volume market from dominating
    const volumeWeight = Math.log10(match.market.volume24h + 1);
    const weight = match.confidence * volumeWeight;

    weightedSum += match.market.yesPrice * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : null;
}

/**
 * Generate divergence analysis with plain-English insight
 */
function analyzeDivergence(
  llm_estimate: number | null,
  market_price: number | null,
  claim: string
): DivergenceAnalysis | null {
  if (llm_estimate === null || market_price === null) {
    return null;
  }

  const diff = llm_estimate - market_price;
  const absDiff = Math.abs(diff);
  const percentDiff = absDiff * 100;

  // Threshold: ±5% is "aligned"
  if (absDiff < 0.05) {
    return {
      type: 'aligned',
      magnitude: absDiff,
      magnitude_percent: percentDiff,
      insight: `Your estimate (${(llm_estimate * 100).toFixed(0)}%) is aligned with market consensus (${(market_price * 100).toFixed(0)}%). Markets agree with your assessment.`,
    };
  }

  if (diff > 0) {
    // LLM more bullish than markets
    let insight = '';
    if (absDiff > 0.20) {
      insight = `You are significantly more bullish than markets. ${percentDiff.toFixed(0)}-point gap suggests either you have edge or the market does. Check for new information markets haven't priced in yet.`;
    } else if (absDiff > 0.10) {
      insight = `You are moderately more bullish than markets. ${percentDiff.toFixed(0)}-point gap is notable—markets may be underpricing this outcome.`;
    } else {
      insight = `You are slightly more bullish than markets. ${percentDiff.toFixed(0)}-point gap is within normal variance.`;
    }

    return {
      type: 'higher',
      magnitude: absDiff,
      magnitude_percent: percentDiff,
      insight,
    };
  } else {
    // LLM more bearish than markets
    let insight = '';
    if (absDiff > 0.20) {
      insight = `You are significantly more bearish than markets. ${percentDiff.toFixed(0)}-point gap suggests markets are pricing in factors you may be missing.`;
    } else if (absDiff > 0.10) {
      insight = `You are moderately more bearish than markets. ${percentDiff.toFixed(0)}-point gap indicates markets see higher probability than you do.`;
    } else {
      insight = `You are slightly more bearish than markets. ${percentDiff.toFixed(0)}-point gap is within normal variance.`;
    }

    return {
      type: 'lower',
      magnitude: absDiff,
      magnitude_percent: percentDiff,
      insight,
    };
  }
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
      success: false,
      error: 'Method not allowed. Use POST.',
    });
    return;
  }

  if (await enforceRateLimit(req, res, { bucket: 'ground-probability', maxRequests: 60, windowSeconds: 60 })) {
    return;
  }

  const startTime = Date.now();

  try {
    const body = req.body as GroundProbabilityRequest | null;

    // Validate request body
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({
        success: false,
        error: 'Request body must be a JSON object.',
      });
      return;
    }

    // Validate claim
    if (!body.claim || typeof body.claim !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Missing or invalid "claim" field. Must be a string.',
      });
      return;
    }

    if (body.claim.length > 1000) {
      res.status(400).json({
        success: false,
        error: 'Claim exceeds 1,000 character limit.',
      });
      return;
    }

    // Validate llm_estimate if provided
    if (body.llm_estimate !== undefined) {
      if (
        typeof body.llm_estimate !== 'number' ||
        !Number.isFinite(body.llm_estimate) ||
        body.llm_estimate < 0 ||
        body.llm_estimate > 1
      ) {
        res.status(400).json({
          success: false,
          error: 'llm_estimate must be a number between 0 and 1.',
        });
        return;
      }
    }

    const {
      claim,
      llm_estimate = null,
      min_confidence = 0.3,
      max_markets = 5,
    } = body;

    // Validate numeric parameters
    if (
      typeof min_confidence !== 'number' ||
      !Number.isFinite(min_confidence) ||
      min_confidence < 0 ||
      min_confidence > 1
    ) {
      res.status(400).json({
        success: false,
        error: 'min_confidence must be between 0 and 1.',
      });
      return;
    }

    if (
      typeof max_markets !== 'number' ||
      !Number.isFinite(max_markets) ||
      max_markets < 1 ||
      max_markets > 20
    ) {
      res.status(400).json({
        success: false,
        error: 'max_markets must be between 1 and 20.',
      });
      return;
    }

    // Get markets
    const markets = await getMarkets();

    if (markets.length === 0) {
      res.status(503).json({
        success: false,
        error: 'No markets available. Service temporarily unavailable.',
      });
      return;
    }

    // Match markets using KeywordMatcher
    const matcher = new KeywordMatcher(markets, min_confidence, max_markets);
    const matches = matcher.match(claim);

    // Calculate consensus price
    const consensusPrice = calculateConsensusPrice(matches);
    const avgConfidence = matches.length > 0
      ? matches.reduce((sum, m) => sum + m.confidence, 0) / matches.length
      : 0;

    // Analyze divergence if LLM estimate provided
    const divergence = llm_estimate !== null
      ? analyzeDivergence(llm_estimate, consensusPrice, claim)
      : null;

    // Get freshness metadata
    const freshnessMetadata = getMarketMetadata();

    // Build response
    const response: GroundProbabilityResponse = {
      success: true,
      claim,
      llm_estimate,
      market_consensus: {
        price: consensusPrice,
        confidence: avgConfidence,
        market_count: matches.length,
        markets: matches.map(m => ({
          title: m.market.title,
          platform: m.market.platform,
          yes_price: m.market.yesPrice,
          volume_24h: m.market.volume24h,
          url: m.market.url,
          match_confidence: m.confidence,
        })),
      },
      divergence,
      timestamp: new Date().toISOString(),
      metadata: {
        processing_time_ms: Date.now() - startTime,
        data_age_seconds: freshnessMetadata.data_age_seconds,
        fetched_at: freshnessMetadata.fetched_at,
      },
    };

    res.status(200).json(response);
  } catch (error) {
    console.error('[API] Error in ground-probability:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
