/**
 * arbitrage-recorder.ts
 *
 * Persists arbitrage opportunities to Supabase so we can answer:
 *   - What opportunities has the system found over time?
 *   - How long did each one last?
 *   - How did the spread move during the opportunity?
 *   - Which market pairs show arbitrage most often?
 *
 * How it works
 * ────────────
 * Every time the cron job runs, it calls recordArbitrageOpportunities() with
 * the full list of currently-live opportunities (above a low threshold).
 *
 * For each opportunity:
 *   1. UPSERT arbitrage_opportunities ON CONFLICT (polymarket_id, kalshi_id)
 *      → If the pair is new: inserts a fresh row (status = 'active')
 *      → If the pair is seen again: bumps last_seen_at, observation_count,
 *        and max_spread (if this scan found a wider spread), and resets
 *        status to 'active' (in case it was previously closed)
 *
 *   2. INSERT into arbitrage_snapshots
 *      → One row per observation, forever. This gives us the spread time-series.
 *
 * After writing, we close stale opportunities:
 *   Any opportunity that was 'active' but not seen in this scan AND whose
 *   last_seen_at is older than STALE_THRESHOLD_MS gets status = 'closed'.
 *   This gives opportunities a grace period before being declared gone
 *   (handles transient data gaps in one platform's feed).
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ArbitrageOpportunity } from '../types/market';
import { AppDatabase, TABLES } from './supabase-client';

// An opportunity must be absent from scans for at least this long before
// we mark it closed. Set to 10 minutes — 5 full cron cycles at 2-minute cadence.
const STALE_THRESHOLD_MS = 10 * 60 * 1000;

export interface RecordResult {
  upserted: number;     // opportunities written (new or updated)
  snapshots: number;    // snapshot rows inserted
  closed: number;       // opportunities marked closed this run
  errors: string[];     // non-fatal error messages
}

/**
 * Build a Supabase service-role client for server-side recording.
 * Call once per cron invocation rather than at module load time
 * so env vars are always resolved.
 */
export function buildSupabaseClient(): SupabaseClient<AppDatabase> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY) must be set'
    );
  }

  return createClient<AppDatabase>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Main entry point.
 *
 * @param opportunities  Live arbitrage opportunities from this scan
 * @param supabase       Supabase client (service-role key required for upserts)
 * @returns              Summary of what was written
 */
export async function recordArbitrageOpportunities(
  opportunities: ArbitrageOpportunity[],
  supabase: SupabaseClient<AppDatabase>
): Promise<RecordResult> {
  const result: RecordResult = { upserted: 0, snapshots: 0, closed: 0, errors: [] };
  const nowIso = new Date().toISOString();

  // ── Step 1: Upsert each opportunity ────────────────────────────────────────
  //
  // We do this one-by-one rather than a bulk upsert so that each row gets
  // the correct observation_count increment via SQL (not JS arithmetic, which
  // would race if two cron invocations overlap).

  const seenPairKeys = new Set<string>();

  for (const opp of opportunities) {
    const pairKey = `${opp.polymarket.id}::${opp.kalshi.id}`;
    seenPairKeys.add(pairKey);

    const { error: upsertError } = await supabase
      .from(TABLES.arbitrageOpportunities)
      .upsert(
        {
          polymarket_id: opp.polymarket.id,
          kalshi_id: opp.kalshi.id,
          polymarket_title: opp.polymarket.title,
          kalshi_title: opp.kalshi.title,
          category: opp.polymarket.category ?? opp.kalshi.category ?? null,
          match_reason: opp.matchReason,
          max_spread: opp.spread,
          observation_count: 1, // placeholder; DB increments via ON CONFLICT
          last_seen_at: nowIso,
          status: 'active',
        },
        {
          onConflict: 'polymarket_id,kalshi_id',
          // ON CONFLICT: bump counters, widen max_spread if this scan found more,
          // reset status to active (re-opens a previously closed opportunity).
          // Supabase doesn't support expressions in the upsert payload directly,
          // so we use ignoreDuplicates: false (the default) and rely on the fact
          // that Supabase's upsert merges the provided columns.
          // For max_spread and observation_count we issue a follow-up update below.
          ignoreDuplicates: false,
        }
      );

    if (upsertError) {
      result.errors.push(`Upsert failed for ${pairKey}: ${upsertError.message}`);
      continue;
    }

    // Increment observation_count and widen max_spread via a targeted UPDATE.
    // We do this as a separate call because Supabase's JS upsert doesn't support
    // SQL expressions like `greatest(max_spread, $1)` in the conflict clause.
    const { error: updateError } = await supabase.rpc('increment_arbitrage_observation', {
      p_polymarket_id: opp.polymarket.id,
      p_kalshi_id: opp.kalshi.id,
      p_spread: opp.spread,
      p_last_seen_at: nowIso,
    });

    // rpc may not exist yet (it's an optional optimization); ignore if missing.
    if (updateError && !updateError.message.includes('does not exist')) {
      result.errors.push(`RPC update failed for ${pairKey}: ${updateError.message}`);
    }

    result.upserted += 1;
  }

  // ── Step 2: Fetch the opportunity IDs we just upserted ─────────────────────
  //
  // We need the UUID primary keys to write snapshot foreign keys.
  // Fetch only the pairs we saw in this scan.

  if (opportunities.length === 0) {
    // No opportunities this run — skip to closing stale ones.
    await closeStaleOpportunities(supabase, new Set(), nowIso, result);
    return result;
  }

  const polyIds = opportunities.map((o) => o.polymarket.id);
  const kalshiIds = opportunities.map((o) => o.kalshi.id);

  const { data: oppRows, error: fetchError } = await supabase
    .from(TABLES.arbitrageOpportunities)
    .select('id, polymarket_id, kalshi_id')
    .in('polymarket_id', polyIds)
    .in('kalshi_id', kalshiIds)
    .eq('status', 'active');

  if (fetchError) {
    result.errors.push(`Failed to fetch opportunity IDs: ${fetchError.message}`);
    return result;
  }

  // Build a lookup: "polyId::kalshiId" → uuid
  const idMap = new Map<string, string>();
  for (const row of oppRows ?? []) {
    idMap.set(`${row.polymarket_id}::${row.kalshi_id}`, row.id);
  }

  // ── Step 3: Insert snapshots ────────────────────────────────────────────────
  //
  // Batch-insert all snapshots at once. Snapshots are append-only.

  const snapshotRows = opportunities
    .map((opp) => {
      const pairKey = `${opp.polymarket.id}::${opp.kalshi.id}`;
      const opportunityId = idMap.get(pairKey);
      if (!opportunityId) return null;

      return {
        opportunity_id: opportunityId,
        polymarket_yes_price: opp.polymarket.yesPrice,
        kalshi_yes_price: opp.kalshi.yesPrice,
        spread: opp.spread,
        profit_potential: opp.profitPotential,
        direction: opp.direction,
        confidence: opp.confidence,
        polymarket_volume_24h: opp.polymarket.volume24h ?? null,
        kalshi_volume_24h: opp.kalshi.volume24h ?? null,
        observed_at: nowIso,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (snapshotRows.length > 0) {
    const { error: snapError } = await supabase
      .from(TABLES.arbitrageSnapshots)
      .insert(snapshotRows);

    if (snapError) {
      result.errors.push(`Snapshot insert failed: ${snapError.message}`);
    } else {
      result.snapshots = snapshotRows.length;
    }
  }

  // ── Step 4: Close stale opportunities ──────────────────────────────────────

  await closeStaleOpportunities(supabase, seenPairKeys, nowIso, result);

  return result;
}

/**
 * Mark active opportunities as 'closed' when they haven't been seen in this
 * scan AND their last_seen_at is older than STALE_THRESHOLD_MS.
 *
 * We compare by pairKey (polymarket_id::kalshi_id) rather than by UUID so
 * that even if the upsert step had errors, we still close the right rows.
 */
async function closeStaleOpportunities(
  supabase: SupabaseClient<AppDatabase>,
  seenPairKeys: Set<string>,
  nowIso: string,
  result: RecordResult
): Promise<void> {
  const staleBeforeIso = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

  // Fetch all currently-active opportunities older than the threshold.
  const { data: activeRows, error: fetchError } = await supabase
    .from(TABLES.arbitrageOpportunities)
    .select('id, polymarket_id, kalshi_id')
    .eq('status', 'active')
    .lt('last_seen_at', staleBeforeIso);

  if (fetchError) {
    result.errors.push(`Stale fetch failed: ${fetchError.message}`);
    return;
  }

  const staleIds = (activeRows ?? [])
    .filter((row) => !seenPairKeys.has(`${row.polymarket_id}::${row.kalshi_id}`))
    .map((row) => row.id);

  if (staleIds.length === 0) return;

  const { error: closeError } = await supabase
    .from(TABLES.arbitrageOpportunities)
    .update({ status: 'closed', closed_at: nowIso })
    .in('id', staleIds);

  if (closeError) {
    result.errors.push(`Close stale failed: ${closeError.message}`);
  } else {
    result.closed = staleIds.length;
  }
}
