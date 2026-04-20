import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getMarkets, getArbitrage, getGroupArbitrage, getMarketMetadata } from '../lib/market-cache';

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
    } = req.query;

    const minSpreadNum = parseFloat(minSpread as string);
    const minConfidenceNum = parseFloat(minConfidence as string);
    const limitNum = parseInt(limit as string, 10);

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

    // Get markets
    const markets = await getMarkets();

    if (markets.length === 0) {
      res.status(503).json({
        success: false,
        error: 'No markets available. Service temporarily unavailable.',
      });
      return;
    }

    // Fetch both cross-platform and intra-event arbitrage in parallel
    const [crossPlatformOpportunities, groupOpportunitiesRaw] = await Promise.all([
      getArbitrage(minSpreadNum),
      getGroupArbitrage(minSpreadNum),
    ]);

    // Apply additional filters to cross-platform opportunities
    let opportunities = crossPlatformOpportunities
      .filter(arb => arb.confidence >= minConfidenceNum)
      .filter(arb => !category || arb.polymarket.category === category || arb.kalshi.category === category)
      .slice(0, limitNum);

    // Apply category filter to intra-event opportunities.
    // All legs of a group share the same platform and category, so checking the
    // first leg is sufficient (avoids iterating all legs on every filter call).
    const groupOpportunities = groupOpportunitiesRaw
      .filter(op => !category || op.legs[0]?.market.category === category)
      .slice(0, limitNum);

    // Stage 0: Get freshness metadata
    const freshnessMetadata = getMarketMetadata();

    // Build response
    const response = {
      success: true,
      data: {
        // Cross-platform arbitrage (Polymarket vs Kalshi, covered YES/NO bundle)
        opportunities,
        count: opportunities.length,
        // Intra-event arbitrage (same platform, range sums / match outcomes)
        group_opportunities: groupOpportunities,
        group_count: groupOpportunities.length,
        timestamp: new Date().toISOString(),
        filters: {
          minSpread: minSpreadNum,
          minConfidence: minConfidenceNum,
          limit: limitNum,
          category: category || null,
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
