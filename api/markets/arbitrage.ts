import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getArbitrage, getMarketMetadata } from '../lib/market-cache';

export const config = {
  maxDuration: 30,
};
const ARB_V15_ENABLED = process.env.ARB_V15_ENABLED !== '0';

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
    const {
      mode = 'fast',
      maxDataAgeMs,
      minNetEdgeBps,
      minSpread = '0.03',
      minConfidence = '0.5',
      limit = '20',
      category,
    } = req.query;

    const parsedMinSpread = parseFloat(minSpread as string);
    const parsedMinConfidence = parseFloat(minConfidence as string);
    const parsedLimit = parseInt(limit as string, 10);
    const parsedMaxDataAgeMs = maxDataAgeMs !== undefined ? Number(maxDataAgeMs) : undefined;

    if (Number.isNaN(parsedMinSpread) || parsedMinSpread < 0 || parsedMinSpread > 1) {
      res.status(400).json({ success: false, error: 'Invalid minSpread. Must be between 0 and 1.' });
      return;
    }
    if (Number.isNaN(parsedMinConfidence) || parsedMinConfidence < 0 || parsedMinConfidence > 1) {
      res.status(400).json({ success: false, error: 'Invalid minConfidence. Must be between 0 and 1.' });
      return;
    }
    if (Number.isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      res.status(400).json({ success: false, error: 'Invalid limit. Must be between 1 and 100.' });
      return;
    }
    if (!['fast', 'full'].includes(mode as string)) {
      res.status(400).json({ success: false, error: 'Invalid mode. Must be fast or full.' });
      return;
    }
    if (parsedMaxDataAgeMs !== undefined && (!Number.isFinite(parsedMaxDataAgeMs) || parsedMaxDataAgeMs < 0)) {
      res.status(400).json({ success: false, error: 'Invalid maxDataAgeMs. Must be greater than or equal to 0.' });
      return;
    }

    let effectiveMinBps = Math.round(parsedMinSpread * 10000);
    if (minNetEdgeBps !== undefined) {
      effectiveMinBps = Number(minNetEdgeBps);
      if (!Number.isFinite(effectiveMinBps) || effectiveMinBps < 0) {
        res.status(400).json({ success: false, error: 'Invalid minNetEdgeBps. Must be greater than or equal to 0.' });
        return;
      }
    }

    const opportunities = await getArbitrage(effectiveMinBps);
    const freshness = getMarketMetadata();

    if (parsedMaxDataAgeMs !== undefined && freshness.data_age_seconds * 1000 > parsedMaxDataAgeMs) {
      res.status(200).json({
        success: true,
        data: {
          opportunities: [],
          count: 0,
          timestamp: new Date().toISOString(),
          filters: {
            mode,
            minSpread: parsedMinSpread,
            minNetEdgeBps: effectiveMinBps,
            minConfidence: parsedMinConfidence,
            limit: parsedLimit,
            category: category || null,
            maxDataAgeMs: parsedMaxDataAgeMs,
          },
        },
        metadata: {
          processing_time_ms: Date.now() - startTime,
          data_age_seconds: freshness.data_age_seconds,
          fetched_at: freshness.fetched_at,
          mode,
          degraded: true,
          stale_reason: 'data_age_exceeded',
          sources: freshness.sources,
        },
      });
      return;
    }

    let filtered = opportunities;
    if (category || parsedMinConfidence > 0) {
      filtered = filtered.filter(arb => {
        const matchesCat = !category ||
          arb.polymarket.category === category ||
          arb.kalshi.category === category;
        const matchesConf = arb.confidence >= parsedMinConfidence;
        return matchesCat && matchesConf;
      });
    }

    filtered = filtered.sort((a, b) => {
      if (b.netEdgeBps !== a.netEdgeBps) return b.netEdgeBps - a.netEdgeBps;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      const aKey = `${a.polymarket.id}|${a.kalshi.id}`;
      const bKey = `${b.polymarket.id}|${b.kalshi.id}`;
      return aKey.localeCompare(bKey);
    });

    const result = filtered.slice(0, parsedLimit);

    const payloadOpportunities = (ARB_V15_ENABLED && mode === 'fast'
      ? result.map((o) => ({
          buyVenue: o.buyVenue,
          sellVenue: o.sellVenue,
          buyPrice: o.buyPrice,
          sellPrice: o.sellPrice,
          netEdgeBps: o.netEdgeBps,
          estimatedFeesBps: o.estimatedFeesBps,
          slippageBps: o.slippageBps,
          latencyRiskBps: o.latencyRiskBps,
          matchConfidence: o.matchConfidence.score,
          expiryDeltaMinutes: o.expiryDeltaMinutes,
          liquidityScore: o.liquidityScore,
          sourceTimestamps: o.sourceTimestamps,
          asOfTs: o.asOfTs,
        }))
      : result);

    console.log(JSON.stringify({
      event: 'arb_req',
      duration_ms: Date.now() - startTime,
      mode,
      count: payloadOpportunities.length,
      data_age_seconds: freshness.data_age_seconds,
    }));

    res.status(200).json({
      success: true,
      data: {
        opportunities: payloadOpportunities,
        count: payloadOpportunities.length,
        timestamp: new Date().toISOString(),
        filters: {
          mode,
          v15_enabled: ARB_V15_ENABLED,
          minSpread: parsedMinSpread,
          minNetEdgeBps: effectiveMinBps,
          minConfidence: parsedMinConfidence,
          limit: parsedLimit,
          category: category || null,
          maxDataAgeMs: parsedMaxDataAgeMs ?? null,
        },
      },
      metadata: {
        processing_time_ms: Date.now() - startTime,
        data_age_seconds: freshness.data_age_seconds,
        fetched_at: freshness.fetched_at,
        mode,
        sources: freshness.sources,
      },
    });
  } catch (error) {
    console.error('[Arbitrage API] Error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
