/**
 * api/cron/record-arbitrage.ts
 *
 * Scheduled job: scan for arbitrage opportunities and persist them to Supabase.
 *
 * Runs every 5 minutes via Vercel Cron (see vercel.json).
 * Uses a deliberately low detection threshold (1%) so the history table captures
 * everything — callers can filter to wider spreads when querying.
 *
 * Flow:
 *   1. Auth check (CRON_SECRET header)
 *   2. Fetch fresh markets from both platforms (via the shared cache)
 *   3. Run the arbitrage detector at MIN_SPREAD_THRESHOLD
 *   4. Hand results to the recorder (upsert pairs + insert snapshots)
 *   5. Return a summary JSON so the Vercel dashboard shows what happened
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getMarkets } from '../lib/market-cache';
import { detectArbitrage } from '../../src/api/arbitrage-detector';
import { recordArbitrageOpportunities, buildSupabaseClient } from '../../src/api/arbitrage-recorder';

// Threshold for this job is intentionally lower than the API default (3%).
// We want the history to capture near-arbitrage too, so analysts can study
// how spreads develop before/after crossing the actionable threshold.
const MIN_SPREAD_THRESHOLD = 0.01; // 1%

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  // Cron secret protects this endpoint from being called by anyone but Vercel.
  const cronSecret = req.headers.authorization?.replace('Bearer ', '');
  if (cronSecret !== process.env.CRON_SECRET) {
    console.error('[Cron record-arbitrage] Unauthorized: invalid CRON_SECRET');
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const startedAt = Date.now();
  const timings: Record<string, number> = {};

  try {
    // ── 1. Fetch markets ──────────────────────────────────────────────────────
    const t0 = Date.now();
    const markets = await getMarkets();
    timings.getMarkets_ms = Date.now() - t0;

    if (markets.length === 0) {
      console.warn('[Cron record-arbitrage] No markets available — skipping');
      res.status(200).json({ success: true, skipped: 'no markets', timings });
      return;
    }

    // ── 2. Detect arbitrage ───────────────────────────────────────────────────
    const t1 = Date.now();
    const opportunities = detectArbitrage(markets, MIN_SPREAD_THRESHOLD);
    timings.detectArbitrage_ms = Date.now() - t1;

    console.log(
      `[Cron record-arbitrage] ${opportunities.length} opportunities detected ` +
      `(threshold: ${MIN_SPREAD_THRESHOLD}, markets: ${markets.length})`
    );

    // ── 3. Record to Supabase ─────────────────────────────────────────────────
    const t2 = Date.now();
    const supabase = buildSupabaseClient();
    const recordResult = await recordArbitrageOpportunities(opportunities, supabase);
    timings.record_ms = Date.now() - t2;

    timings.total_ms = Date.now() - startedAt;

    if (recordResult.errors.length > 0) {
      console.warn(
        '[Cron record-arbitrage] Completed with errors:',
        recordResult.errors.join(' | ')
      );
    }

    console.log(
      `[Cron record-arbitrage] done in ${timings.total_ms}ms — ` +
      `upserted=${recordResult.upserted} snapshots=${recordResult.snapshots} ` +
      `closed=${recordResult.closed} errors=${recordResult.errors.length}`
    );

    res.status(200).json({
      success: true,
      opportunities_detected: opportunities.length,
      upserted: recordResult.upserted,
      snapshots: recordResult.snapshots,
      closed: recordResult.closed,
      errors: recordResult.errors,
      timings,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Cron record-arbitrage] Fatal error:', message);
    res.status(500).json({
      success: false,
      error: message,
      timings: { ...timings, total_ms: Date.now() - startedAt },
    });
  }
}
