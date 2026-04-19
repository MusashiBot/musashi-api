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
      maxDataAgeMs,
      minNetEdgeBps,
      minSpread,
      limit = '20',
    } = req.query;

    let effectiveMinBps = minNetEdgeBps ? Number(minNetEdgeBps) : Math.round(parseFloat(minSpread as string) * 10000);
    if (minNetEdgeBps) {
      effectiveMinBps = Number(minNetEdgeBps);
    } else {
      effectiveMinBps = Math.round(parseFloat(minSpread as string) * 10000);
    }

    const minConfidenceNum = parseFloat(minConfidence as string);
    const limitNum = Math.min(parseInt(limit as string, 10), 100);

    const opportunities = await getArbitrage(effectiveMinBps);

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
// Item 1: Max Data Age Enforcement
  if (maxDataAgeMs && freshness.data_age_seconds * 1000 > Number(maxDataAgeMs)) {
    return res.status(200).json({ success: true, data: { opportunities: [], count: 0 }, metadata: { degraded: true }});
  }

  // Item 2: Mode Payload Stripping
  let finalOpps = opportunities.slice(0, Number(limit));
  if (mode === 'fast') {
    finalOpps = finalOpps.map(o => ({
      pair: `${o.polymarket.id}:${o.kalshi.id}`,
      netEdgeBps: o.netEdgeBps,
      buy: o.buyVenue,
      sell: o.sellVenue,
      confidence: o.matchConfidence.score
    }));
  }

  // Item 16: Log JSON for Observability
  console.log(JSON.stringify({ event: 'arb_req', duration: Date.now() - startTime, count: finalOpps.length }));

  return res.status(200).json({ success: true, metadata: { ...freshness, mode }, data: finalOpps });
}
}
