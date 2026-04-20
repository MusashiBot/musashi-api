import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getMarkets, getArbitrage, getMarketMetadata } from '../lib/market-cache';

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
    // Parse query parameters
    const {
      minSpread = '0.03',
      minConfidence = '0.5',
      limit = '20',
      category,
      minExpectedProfit,
      minAnnualisedReturn,
      minMaxStake,
    } = req.query;

    const minSpreadNum = parseFloat(minSpread as string);
    const minConfidenceNum = parseFloat(minConfidence as string);
    const limitNum = parseInt(limit as string, 10);
    const minExpectedProfitNum =
      minExpectedProfit === undefined ? 0 : parseFloat(minExpectedProfit as string);
    const minAnnualisedReturnNum =
      minAnnualisedReturn === undefined ? 0 : parseFloat(minAnnualisedReturn as string);
    const minMaxStakeNum =
      minMaxStake === undefined ? 0 : parseFloat(minMaxStake as string);

    // Validate parameters
    if (isNaN(minSpreadNum) || minSpreadNum < 0 || minSpreadNum > 1) {
      res.status(400).json({
        success: false,
        error: 'Invalid minSpread. Must be between 0 and 1.',
      });
      return;
    }

    if (isNaN(minConfidenceNum) || minConfidenceNum < 0 || minConfidenceNum > 1) {
      res.status(400).json({
        success: false,
        error: 'Invalid minConfidence. Must be between 0 and 1.',
      });
      return;
    }

    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      res.status(400).json({
        success: false,
        error: 'Invalid limit. Must be between 1 and 100.',
      });
      return;
    }

    if (!Number.isFinite(minExpectedProfitNum) || minExpectedProfitNum < 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid minExpectedProfit. Must be a non-negative number (dollars).',
      });
      return;
    }

    if (!Number.isFinite(minAnnualisedReturnNum) || minAnnualisedReturnNum < 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid minAnnualisedReturn. Must be a non-negative number (e.g. 0.25 for 25%).',
      });
      return;
    }

    if (!Number.isFinite(minMaxStakeNum) || minMaxStakeNum < 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid minMaxStake. Must be a non-negative number (dollars).',
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

    // Get cached arbitrage opportunities (already filtered by minSpread upstream).
    // Opportunities are sorted by profitPotential descending from detectArbitrage().
    let opportunities = await getArbitrage(minSpreadNum);

    opportunities = opportunities
      .filter(arb => arb.confidence >= minConfidenceNum)
      .filter(arb => !category || arb.polymarket.category === category || arb.kalshi.category === category)
      .filter(arb => (arb.expectedDollarProfit ?? 0) >= minExpectedProfitNum)
      .filter(arb => (arb.annualisedReturn ?? 0) >= minAnnualisedReturnNum)
      .filter(arb => (arb.maxStake ?? 0) >= minMaxStakeNum)
      .slice(0, limitNum);

    // Stage 0: Get freshness metadata
    const freshnessMetadata = getMarketMetadata();

    // Build response
    const response = {
      success: true,
      data: {
        opportunities,
        count: opportunities.length,
        timestamp: new Date().toISOString(),
        filters: {
          minSpread: minSpreadNum,
          minConfidence: minConfidenceNum,
          limit: limitNum,
          category: category || null,
          minExpectedProfit: minExpectedProfitNum,
          minAnnualisedReturn: minAnnualisedReturnNum,
          minMaxStake: minMaxStakeNum,
        },
        metadata: {
          processing_time_ms: Date.now() - startTime,
          markets_analyzed: markets.length,
          polymarket_count: markets.filter(m => m.platform === 'polymarket').length,
          kalshi_count: markets.filter(m => m.platform === 'kalshi').length,
          // Stage 0: Freshness metadata
          data_age_seconds: freshnessMetadata.data_age_seconds,
          fetched_at: freshnessMetadata.fetched_at,
          sources: freshnessMetadata.sources,
        },
      },
    };

    res.status(200).json(response);
  } catch (error) {
    console.error('[Arbitrage API] Error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
