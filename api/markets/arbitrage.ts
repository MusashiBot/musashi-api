import type { VercelRequest, VercelResponse } from '@vercel/node';

//To ensure function doesnt time out
export const config = {
  maxDuration: 30,
};

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
      mode = 'fast',
      minSpread = '0.03',
      minNetEdgeBps,
      minConfidence = '0.5',
      limit = '20',
      category,
    } = req.query;

    let effectiveMinBps = 50;
    if (minNetEdgeBps) {
      effectiveMinBps = Number(minNetEdgeBps);
    } else {
      effectiveMinBps = Math.round(parseFloat(minSpread as string) * 10000);
    }

    const minConfidenceNum = parseFloat(minConfidence as string);
    const limitNum = Math.min(parseInt(limit as string, 10), 100);

    let opportunities = await getArbitrage(effectiveMinBps);

    if (category || minConfidenceNum > 0) {
      opportunities = opportunities.filter(arb => {
        const matchesCat = !category ||
          arb.polymarket.category === category ||
          arb.kalshi.category === category;
        const matchesConf = arb.confidence >= minConfidenceNum;
        return matchesCat && matchesConf;
      });
    }

    const result = opportunities.slice(0, limitNum);
    const freshness = getMarketMetadata();

    res.status(200).json({
      success: true,
      metadata: {
        processing_time_ms: Date.now() - startTime,
        data_age_seconds: freshness.data_age_seconds,
        fetched_at: freshness.fetched_at,
        mode,
        thresholds: {
          applied_net_edge_bps: effectiveMinBps,
          min_confidence: minConfidenceNum
        },
        markets_analyzed: freshness.sources.polymarket.market_count + freshness.sources.kalshi.market_count,
        sources: freshness.sources
      },
      data: {
        count: result.length,
        opportunities: result
      }
    });

  } catch (error) {
    console.error('[Arbitrage API] Error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
