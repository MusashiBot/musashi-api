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
  
  if (!expectedKey) {
    // If no key is configured, check if request is from internal network
    const allowedIps = (process.env.INTERNAL_IPS || '').split(',');
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
    return allowedIps.some(ip => clientIp.toString().includes(ip));
  }
  
  return apiKey === expectedKey;
}

function calculatePnL(
  edge: number,
  predictedProb: number,
  wasCorrect: boolean,
  bankroll: number = 1000 // Default bankroll
): number {
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
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
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
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

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
    const bankroll = body.bankroll || 1000; // Default $1000 bankroll
    let totalPnL = 0;

    const updates = typedSignals.map(signal => {
      const predictedDirection = signal.predicted_direction;
      const wasCorrect = predictedDirection === body.outcome || 
                        (predictedDirection === 'HOLD' && false); // HOLD is always wrong in binary outcome
      
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

    // Update all signals in batch
    const updatePromises = updates.map(update => 
      (supabase
        .from('signal_outcomes') as any)
        .update({
          outcome: update.outcome,
          was_correct: update.was_correct,
          resolution_date: update.resolution_date,
          pnl: update.pnl,
        })
        .eq('signal_id', update.signal_id)
    );

    const results = await Promise.all(updatePromises);

    // Check for errors
    const errors = results.filter(r => r.error);
    if (errors.length > 0) {
      console.error('[resolve-market] Some updates failed:', errors);
    }

    const successCount = results.filter(r => !r.error).length;

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
