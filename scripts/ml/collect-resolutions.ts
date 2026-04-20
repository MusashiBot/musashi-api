#!/usr/bin/env node
/**
 * Batch job to collect resolved markets from Polymarket and Kalshi APIs
 * and automatically update signal_outcomes table.
 * 
 * Usage:
 *   node --import tsx scripts/ml/collect-resolutions.ts
 * 
 * Can be run as a cron job or manually.
 */

import { createSupabaseBrowserClient } from '../../src/api/supabase-client';
import { isMainModule } from '../lib/is-main-module';

interface PolymarketMarket {
  id: string;
  question: string;
  closed: boolean;
  outcomes: string[];
  outcome?: string; // The resolved outcome index
  end_date_iso: string;
}

interface KalshiMarket {
  ticker: string;
  title: string;
  status: string;
  result?: 'yes' | 'no';
  close_date: string;
}

// Fetch resolved markets from Polymarket
async function fetchPolymarketResolutions(since: Date): Promise<PolymarketMarket[]> {
  try {
    // Polymarket CLOB API endpoint for resolved markets
    const url = 'https://clob.polymarket.com/markets';
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Polymarket API error: ${response.status}`);
    }

    const markets: PolymarketMarket[] = await response.json();
    
    // Filter for recently resolved markets
    return markets.filter(m => {
      if (!m.closed || !m.outcome) return false;
      const endDate = new Date(m.end_date_iso);
      return endDate >= since;
    });
  } catch (error) {
    console.error('[collect-resolutions] Error fetching Polymarket:', error);
    return [];
  }
}

// Fetch resolved markets from Kalshi
async function fetchKalshiResolutions(since: Date): Promise<KalshiMarket[]> {
  try {
    const sinceStr = since.toISOString().split('T')[0]; // YYYY-MM-DD
    const url = `https://api.elections.kalshi.com/trade-api/v2/markets?status=closed&limit=200`;
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Kalshi API error: ${response.status}`);
    }

    const data = await response.json();
    const markets: KalshiMarket[] = data.markets || [];

    // Filter for markets with results
    return markets.filter(m => {
      if (!m.result) return false;
      const closeDate = new Date(m.close_date);
      return closeDate >= since;
    });
  } catch (error) {
    console.error('[collect-resolutions] Error fetching Kalshi:', error);
    return [];
  }
}

// Main execution
async function main() {
  console.log('[collect-resolutions] Starting batch job...');
  
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      'Missing Supabase configuration. Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_KEY'
    );
  }

  const supabase = createSupabaseBrowserClient(supabaseUrl, supabaseKey);

  // Look for markets resolved in the last 7 days
  const since = new Date();
  since.setDate(since.getDate() - 7);

  console.log(`[collect-resolutions] Fetching markets resolved since ${since.toISOString()}`);

  // Fetch from both platforms in parallel
  const [polymarketResults, kalshiResults] = await Promise.all([
    fetchPolymarketResolutions(since),
    fetchKalshiResolutions(since),
  ]);

  console.log(`[collect-resolutions] Found ${polymarketResults.length} Polymarket resolutions`);
  console.log(`[collect-resolutions] Found ${kalshiResults.length} Kalshi resolutions`);

  let totalUpdated = 0;
  let totalErrors = 0;

  // Process Polymarket resolutions
  for (const market of polymarketResults) {
    try {
      // Map outcome index to YES/NO
      let outcome: 'YES' | 'NO' = 'YES';
      if (market.outcome === '1') {
        outcome = 'NO';
      } else if (market.outcome === '0') {
        outcome = 'YES';
      } else {
        console.warn(`[collect-resolutions] Unknown Polymarket outcome: ${market.outcome} for ${market.id}`);
        continue;
      }

      // Find unresolved signals for this market
      const { data: signals, error: fetchError } = await supabase
        .from('signal_outcomes')
        .select('*')
        .eq('market_id', market.id)
        .eq('platform', 'polymarket')
        .is('outcome', null);

      if (fetchError) {
        console.error(`[collect-resolutions] Error fetching signals for ${market.id}:`, fetchError);
        totalErrors++;
        continue;
      }

      if (!signals || signals.length === 0) {
        continue; // No signals to update
      }

      // Type cast the results since Supabase returns proper types
      type SignalRow = {
        signal_id: string;
        predicted_direction: 'YES' | 'NO' | 'HOLD';
        predicted_prob: number;
        edge: number;
      };

      // Update each signal
      for (const signal of signals as unknown as SignalRow[]) {
        const wasCorrect = signal.predicted_direction === outcome || 
                          (signal.predicted_direction === 'HOLD' && false);
        
        // Calculate P&L using Kelly criterion with edge
        const bankroll = 1000; // Default bankroll
        const kellyFraction = Math.abs(signal.edge) * 0.25; // Quarter Kelly
        const betSize = kellyFraction * bankroll;
        const pnl = wasCorrect ? betSize * (1 / signal.predicted_prob - 1) : -betSize;

        const { error: updateError } = await (supabase
          .from('signal_outcomes') as any)
          .update({
            outcome,
            was_correct: wasCorrect,
            resolution_date: market.end_date_iso,
            pnl,
          })
          .eq('signal_id', signal.signal_id);

        if (updateError) {
          console.error(`[collect-resolutions] Error updating signal ${signal.signal_id}:`, updateError);
          totalErrors++;
        } else {
          totalUpdated++;
          console.log(`[collect-resolutions] ✓ Updated signal ${signal.signal_id} for ${market.question}`);
        }
      }
    } catch (error) {
      console.error(`[collect-resolutions] Error processing Polymarket ${market.id}:`, error);
      totalErrors++;
    }
  }

  // Process Kalshi resolutions
  for (const market of kalshiResults) {
    try {
      const outcome: 'YES' | 'NO' = market.result === 'yes' ? 'YES' : 'NO';

      // Find unresolved signals for this market
      const { data: signals, error: fetchError } = await supabase
        .from('signal_outcomes')
        .select('*')
        .eq('market_id', market.ticker)
        .eq('platform', 'kalshi')
        .is('outcome', null);

      if (fetchError) {
        console.error(`[collect-resolutions] Error fetching signals for ${market.ticker}:`, fetchError);
        totalErrors++;
        continue;
      }

      if (!signals || signals.length === 0) {
        continue; // No signals to update
      }

      // Type cast the results since Supabase returns proper types
      type SignalRow = {
        signal_id: string;
        predicted_direction: 'YES' | 'NO' | 'HOLD';
        predicted_prob: number;
        edge: number;
      };

      // Update each signal
      for (const signal of signals as unknown as SignalRow[]) {
        const wasCorrect = signal.predicted_direction === outcome || 
                          (signal.predicted_direction === 'HOLD' && false);
        
        // Calculate P&L using Kelly criterion with edge
        const bankroll = 1000; // Default bankroll
        const kellyFraction = Math.abs(signal.edge) * 0.25; // Quarter Kelly
        const betSize = kellyFraction * bankroll;
        const pnl = wasCorrect ? betSize * (1 / signal.predicted_prob - 1) : -betSize;

        const { error: updateError } = await (supabase
          .from('signal_outcomes') as any)
          .update({
            outcome,
            was_correct: wasCorrect,
            resolution_date: market.close_date,
            pnl,
          })
          .eq('signal_id', signal.signal_id);

        if (updateError) {
          console.error(`[collect-resolutions] Error updating signal ${signal.signal_id}:`, updateError);
          totalErrors++;
        } else {
          totalUpdated++;
          console.log(`[collect-resolutions] ✓ Updated signal ${signal.signal_id} for ${market.title}`);
        }
      }
    } catch (error) {
      console.error(`[collect-resolutions] Error processing Kalshi ${market.ticker}:`, error);
      totalErrors++;
    }
  }

  console.log('\n[collect-resolutions] Batch job complete!');
  console.log(`  Signals updated: ${totalUpdated}`);
  console.log(`  Errors: ${totalErrors}`);

  const failOnError = process.env.COLLECT_RESOLUTIONS_FAIL_ON_ERROR === '1';
  process.exit(failOnError && totalErrors > 0 ? 1 : 0);
}

if (isMainModule()) {
  main().catch(error => {
    console.error('[collect-resolutions] Fatal error:', error);
    process.exit(1);
  });
}

export { main as collectResolutions };
