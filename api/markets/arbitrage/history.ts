/**
 * api/markets/arbitrage/history.ts
 * Route: GET /api/markets/arbitrage/history
 *
 * Query the historical record of arbitrage opportunities.
 *
 * Each row in the response represents a unique (Polymarket, Kalshi) pair that
 * showed a spread above the recorded threshold.  The row includes:
 *   - When the opportunity was first/last seen
 *   - The widest spread ever observed for this pair
 *   - How many times our scanner caught it
 *   - Whether it is still active or has been closed
 *   - The most recent snapshot (latest prices + direction)
 *
 * Query parameters
 * ────────────────
 *   from          ISO timestamp — only return opportunities first seen after this time
 *   to            ISO timestamp — only return opportunities first seen before this time
 *   status        'active' | 'closed' | 'all' (default: 'all')
 *   minSpread     number 0–1 — filter by max_spread (default: 0)
 *   category      string — filter by market category
 *   limit         1–100 (default: 20)
 *   offset        integer ≥ 0 for pagination (default: 0)
 *
 * Response
 * ────────
 *   {
 *     success: true,
 *     data: {
 *       opportunities: ArbitrageHistoryRow[],
 *       total: number,       // total matching rows (for pagination)
 *       limit: number,
 *       offset: number,
 *       filters: { ... }
 *     }
 *   }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import type { AppDatabase } from '../../../src/api/supabase-client';
import { TABLES } from '../../../src/api/supabase-client';

export interface ArbitrageHistoryRow {
  id: string;
  polymarket_id: string;
  kalshi_id: string;
  polymarket_title: string;
  kalshi_title: string;
  category: string | null;
  match_reason: string | null;
  max_spread: number;
  observation_count: number;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
  status: 'active' | 'closed';
  // Duration in seconds (null if still active)
  duration_seconds: number | null;
  // Most recent snapshot (null if snapshots were not recorded)
  latest_snapshot: {
    polymarket_yes_price: number;
    kalshi_yes_price: number;
    spread: number;
    direction: 'buy_poly_sell_kalshi' | 'buy_kalshi_sell_poly';
    confidence: number;
    observed_at: string;
  } | null;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({ success: false, error: 'Method not allowed. Use GET.' });
    return;
  }

  const startTime = Date.now();

  // ── Parse + validate query params ──────────────────────────────────────────

  const {
    from,
    to,
    status = 'all',
    minSpread = '0',
    category,
    limit = '20',
    offset = '0',
  } = req.query;

  const limitNum = parseInt(limit as string, 10);
  const offsetNum = parseInt(offset as string, 10);
  const minSpreadNum = parseFloat(minSpread as string);

  if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
    res.status(400).json({ success: false, error: 'limit must be between 1 and 100' });
    return;
  }
  if (isNaN(offsetNum) || offsetNum < 0) {
    res.status(400).json({ success: false, error: 'offset must be >= 0' });
    return;
  }
  if (isNaN(minSpreadNum) || minSpreadNum < 0 || minSpreadNum > 1) {
    res.status(400).json({ success: false, error: 'minSpread must be between 0 and 1' });
    return;
  }
  if (!['active', 'closed', 'all'].includes(status as string)) {
    res.status(400).json({ success: false, error: "status must be 'active', 'closed', or 'all'" });
    return;
  }
  if (from && isNaN(Date.parse(from as string))) {
    res.status(400).json({ success: false, error: 'from must be a valid ISO timestamp' });
    return;
  }
  if (to && isNaN(Date.parse(to as string))) {
    res.status(400).json({ success: false, error: 'to must be a valid ISO timestamp' });
    return;
  }

  // ── Build Supabase client ───────────────────────────────────────────────────

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    res.status(503).json({ success: false, error: 'Database not configured.' });
    return;
  }

  const supabase = createClient<AppDatabase>(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Query opportunities ─────────────────────────────────────────────────────

  let query = supabase
    .from(TABLES.arbitrageOpportunities)
    .select('*', { count: 'exact' })
    .order('last_seen_at', { ascending: false })
    .range(offsetNum, offsetNum + limitNum - 1);

  if (status !== 'all') {
    query = query.eq('status', status as string);
  }
  if (minSpreadNum > 0) {
    query = query.gte('max_spread', minSpreadNum);
  }
  if (category) {
    query = query.eq('category', category as string);
  }
  if (from) {
    query = query.gte('first_seen_at', from as string);
  }
  if (to) {
    query = query.lte('first_seen_at', to as string);
  }

  const { data: oppRows, count, error: oppError } = await query;

  if (oppError) {
    console.error('[Arbitrage History] DB error:', oppError.message);
    res.status(500).json({ success: false, error: 'Database query failed.' });
    return;
  }

  const rows = oppRows ?? [];

  // ── Fetch latest snapshot for each opportunity ─────────────────────────────
  //
  // We want to show the most recent prices for each pair in the response.
  // Fetch in one query using `in()` rather than N queries.

  const oppIds = rows.map((r) => r.id);
  const latestSnapshotMap = new Map<
    string,
    AppDatabase['public']['Tables']['arbitrage_snapshots']['Row']
  >();

  if (oppIds.length > 0) {
    // Supabase doesn't have a "latest per group" primitive, so we fetch the last
    // `rows.length` snapshots ordered by time and deduplicate in JS.
    // This works because each opportunity typically has one snapshot per cron run,
    // so `rows.length * 2` gives a very safe upper bound.
    const { data: snapRows } = await supabase
      .from(TABLES.arbitrageSnapshots)
      .select('*')
      .in('opportunity_id', oppIds)
      .order('observed_at', { ascending: false })
      .limit(rows.length * 2);

    for (const snap of snapRows ?? []) {
      if (!latestSnapshotMap.has(snap.opportunity_id)) {
        latestSnapshotMap.set(snap.opportunity_id, snap);
      }
    }
  }

  // ── Shape the response ─────────────────────────────────────────────────────

  const opportunities: ArbitrageHistoryRow[] = rows.map((row) => {
    const snap = latestSnapshotMap.get(row.id) ?? null;
    const durationMs =
      row.closed_at
        ? new Date(row.closed_at).getTime() - new Date(row.first_seen_at).getTime()
        : null;

    return {
      id: row.id,
      polymarket_id: row.polymarket_id,
      kalshi_id: row.kalshi_id,
      polymarket_title: row.polymarket_title,
      kalshi_title: row.kalshi_title,
      category: row.category,
      match_reason: row.match_reason,
      max_spread: row.max_spread,
      observation_count: row.observation_count,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      closed_at: row.closed_at,
      status: row.status,
      duration_seconds: durationMs !== null ? Math.round(durationMs / 1000) : null,
      latest_snapshot: snap
        ? {
            polymarket_yes_price: snap.polymarket_yes_price,
            kalshi_yes_price: snap.kalshi_yes_price,
            spread: snap.spread,
            direction: snap.direction,
            confidence: snap.confidence,
            observed_at: snap.observed_at,
          }
        : null,
    };
  });

  res.status(200).json({
    success: true,
    data: {
      opportunities,
      total: count ?? opportunities.length,
      limit: limitNum,
      offset: offsetNum,
      filters: {
        from: from ?? null,
        to: to ?? null,
        status,
        minSpread: minSpreadNum,
        category: category ?? null,
      },
      metadata: {
        processing_time_ms: Date.now() - startTime,
      },
    },
  });
}
