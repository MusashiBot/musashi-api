import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createSupabaseBrowserClient } from '../../src/api/supabase-client';

interface ResolveMarketRequest {
  market_id: string;
  platform: 'polymarket' | 'kalshi';
  outcome: 'YES' | 'NO';
  resolution_date?: string;
  bankroll?: number; // Optional bankroll for P&L calculation
}

interface ResolveMarketResponse {
  success: boolean;
  signals_updated: number;
  total_pl?: number;
  error?: string;
}

// Simple API key auth - in production, use more robust auth
function isAuthorized(req: VercelRequest): boolean {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  const expectedKey = process.env.INTERNAL_API_KEY;

  // Fail closed: internal API key must be explicitly configured.
  if (!expectedKey) {
    return false;
  }
  
  return apiKey === expectedKey;
}

function calculatePnL(
  edge: number,
  predictedProb: number,
  wasCorrect: boolean,
  bankroll: number = 1000 // Default bankroll
): number {
  // NOTE: This formula assumes entry at the predicted probability (fair odds),
  // NOT the actual market price at time of trade. If the market price diverges
  // significantly from predictedProb, P&L will be misstated. For accurate
  // accounting, the fill price must be recorded at signal generation time.
  // Kelly Criterion: f* = (bp - q) / b
  // where b = decimal odds - 1, p = win probability, q = 1 - p
  // Simplified: bet size = edge * bankroll (fraction Kelly)
  
  const kellyFraction = Math.abs(edge) * 0.25; // Quarter Kelly for safety
  const betSize = kellyFraction * bankroll;
  
  if (wasCorrect) {
    // Return at fair odds based on predicted probability
    // Profit = betSize / predictedProb - betSize
    return betSize * (1 / predictedProb - 1);
  } else {
    // Loss: we lose the entire bet
    return -betSize;
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({
      success: false,
      error: 'Method not allowed. Use POST.',
    });
    return;
  }

  // Auth check
  if (!isAuthorized(req)) {
    res.status(401).json({
      success: false,
      error: 'Unauthorized. Provide valid X-API-Key header.',
    });
    return;
  }

  try {
    const body = req.body as ResolveMarketRequest;

    // Validation
    if (!body.market_id || !body.platform || !body.outcome) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: market_id, platform, outcome',
      });
      return;
    }

    if (!['YES', 'NO'].includes(body.outcome)) {
      res.status(400).json({
        success: false,
        error: 'outcome must be either "YES" or "NO"',
      });
      return;
    }

    if (!['polymarket', 'kalshi'].includes(body.platform)) {
      res.status(400).json({
        success: false,
        error: 'platform must be either "polymarket" or "kalshi"',
      });
      return;
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      res.status(500).json({
        success: false,
        error: 'Supabase configuration missing',
      });
      return;
    }

    const supabase = createSupabaseBrowserClient(supabaseUrl, supabaseKey);

    // Fetch all signals for this market
    const { data: signals, error: fetchError } = await supabase
      .from('signal_outcomes')
      .select('*')
      .eq('market_id', body.market_id)
      .eq('platform', body.platform)
      .is('outcome', null); // Only unresolved signals

    if (fetchError) {
      throw new Error(`Failed to fetch signals: ${fetchError.message}`);
    }

    // Type assertion for signal rows
    type SignalRow = {
      signal_id: string;
      predicted_direction: 'YES' | 'NO' | 'HOLD';
      edge: number;
      predicted_prob: number;
    };

    const typedSignals = (signals as unknown as SignalRow[]) || [];

    if (typedSignals.length === 0) {
      res.status(200).json({
        success: true,
        signals_updated: 0,
        total_pl: 0,
      });
      return;
    }

    // Calculate outcomes for each signal
    const resolutionDate = body.resolution_date || new Date().toISOString();
    const bankroll = body.bankroll ?? 1000; // Allow explicit bankroll=0 for dry-run style accounting
    if (!Number.isFinite(bankroll) || bankroll < 0) {
      res.status(400).json({
        success: false,
        error: 'bankroll must be a non-negative number',
      });
      return;
    }
    let totalPnL = 0;

    const updates = typedSignals.map(signal => {
      const predictedDirection = signal.predicted_direction;
      const wasCorrect = predictedDirection !== 'HOLD' && predictedDirection === body.outcome;
      
      // Calculate P&L based on Kelly bet sizing with edge
      const pnl = calculatePnL(signal.edge, signal.predicted_prob, wasCorrect, bankroll);
      totalPnL += pnl;

      return {
        signal_id: signal.signal_id,
        outcome: body.outcome,
        was_correct: wasCorrect,
        resolution_date: resolutionDate,
        pnl: pnl,
      };
    });

    // Perform a single batch upsert keyed by signal_id to avoid N round-trips.
    const { data: upsertedRows, error: upsertError } = await (supabase
      .from('signal_outcomes') as any)
      .upsert(updates, { onConflict: 'signal_id' })
      .select('signal_id');

    if (upsertError) {
      throw new Error(`Failed to update resolved signals: ${upsertError.message}`);
    }

    const successCount = Array.isArray(upsertedRows) ? upsertedRows.length : 0;

    const response: ResolveMarketResponse = {
      success: true,
      signals_updated: successCount,
      total_pl: totalPnL,
    };

    res.status(200).json(response);

  } catch (error) {
    console.error('[API] Error in resolve-market:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
      signals_updated: 0,
    });
  }
}
