import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createSupabaseBrowserClient } from '../../src/api/supabase-client';

interface PerformanceMetrics {
  win_rate_24h: { [signal_type: string]: number };
  win_rate_7d: { [signal_type: string]: number };
  win_rate_30d: { [signal_type: string]: number };
  brier_score_24h: number;
  brier_score_7d: number;
  brier_score_30d: number;
  top_categories: Array<{ category: string; win_rate: number; count: number }>;
  worst_false_positives: Array<{
    signal_id: string;
    market_id: string;
    platform: string;
    signal_type: string;
    confidence: number;
    predicted_direction: string;
    actual_outcome: string;
    loss_amount: number;
  }>;
  signal_stats: {
    total_generated: number;
    total_resolved: number;
    pending_resolution: number;
  };
  timestamp: string;
}

function calculateBrierScore(predictions: Array<{ confidence: number; was_correct: boolean }>): number {
  if (predictions.length === 0) return 0;
  
  const sum = predictions.reduce((acc, pred) => {
    const outcome = pred.was_correct ? 1 : 0;
    return acc + Math.pow(pred.confidence - outcome, 2);
  }, 0);
  
  return sum / predictions.length;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({
      success: false,
      error: 'Method not allowed. Use GET.',
    });
    return;
  }

  try {
    const supabaseUrl =
      process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      res.status(500).json({
        success: false,
        error: 'Supabase configuration missing',
      });
      return;
    }

    const supabase = createSupabaseBrowserClient(supabaseUrl, supabaseKey);

    const now = new Date();
    const day24Ago = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const day7Ago = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const day30Ago = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Fetch only last 30 days and only fields required by this endpoint.
    const { data: allSignals, error: allSignalsError } = await supabase
      .from('signal_outcomes')
      .select('signal_id,signal_type,confidence,was_correct,created_at,outcome,pnl,predicted_direction,platform,market_id')
      .gte('created_at', day30Ago);

    if (allSignalsError) {
      throw new Error(`Failed to fetch signals: ${allSignalsError.message}`);
    }

    // Type assertion for signal rows
    type SignalRow = {
      signal_id: string;
      signal_type: string;
      confidence: number;
      was_correct: boolean;
      created_at: string;
      outcome: 'YES' | 'NO' | null;
      pnl: number | null;
      predicted_direction: string;
      platform: string;
      market_id: string;
    };

    const typedSignals = (allSignals as unknown as SignalRow[]) || [];

    // Filter signals by time periods
    const signals24h = typedSignals.filter(s => s.created_at >= day24Ago && s.outcome !== null);
    const signals7d = typedSignals.filter(s => s.created_at >= day7Ago && s.outcome !== null);
    const signals30d = typedSignals.filter(s => s.created_at >= day30Ago && s.outcome !== null);

    // Calculate win rates by signal type
    const calculateWinRates = (signals: SignalRow[]) => {
      const byType: { [key: string]: { correct: number; total: number } } = {};
      
      signals.forEach(signal => {
        if (!byType[signal.signal_type]) {
          byType[signal.signal_type] = { correct: 0, total: 0 };
        }
        byType[signal.signal_type].total++;
        if (signal.was_correct) {
          byType[signal.signal_type].correct++;
        }
      });

      const rates: { [key: string]: number } = {};
      Object.keys(byType).forEach(type => {
        rates[type] = byType[type].total > 0 
          ? byType[type].correct / byType[type].total 
          : 0;
      });

      return rates;
    };

    // Calculate Brier scores
    const brier24h = calculateBrierScore(
      signals24h.map(s => ({ confidence: s.confidence, was_correct: s.was_correct }))
    );
    const brier7d = calculateBrierScore(
      signals7d.map(s => ({ confidence: s.confidence, was_correct: s.was_correct }))
    );
    const brier30d = calculateBrierScore(
      signals30d.map(s => ({ confidence: s.confidence, was_correct: s.was_correct }))
    );

    // Top performing by signal type (using 30d data)
    const signalTypeStats: { [key: string]: { correct: number; total: number } } = {};
    signals30d.forEach(signal => {
      const type = signal.signal_type || 'unknown';
      if (!signalTypeStats[type]) {
        signalTypeStats[type] = { correct: 0, total: 0 };
      }
      signalTypeStats[type].total++;
      if (signal.was_correct) {
        signalTypeStats[type].correct++;
      }
    });

    const topCategories = Object.entries(signalTypeStats)
      .map(([category, stats]) => ({
        category,
        win_rate: stats.total > 0 ? stats.correct / stats.total : 0,
        count: stats.total,
      }))
      .filter(c => c.count >= 5) // Only types with at least 5 signals
      .sort((a, b) => b.win_rate - a.win_rate)
      .slice(0, 10);

    // Worst false positives (high confidence but wrong)
    const falsePositives = signals30d
      .filter(s => !s.was_correct && s.confidence >= 0.7)
      .sort((a, b) => Math.abs(b.pnl || 0) - Math.abs(a.pnl || 0))
      .slice(0, 10)
      .map(s => ({
        signal_id: s.signal_id,
        market_id: s.market_id,
        platform: s.platform,
        signal_type: s.signal_type,
        confidence: s.confidence,
        predicted_direction: s.predicted_direction,
        actual_outcome: s.outcome || 'N/A',
        loss_amount: Math.abs(s.pnl || 0),
      }));

    // Signal stats
    const totalGenerated = typedSignals.length;
    const totalResolved = typedSignals.filter(s => s.outcome !== null).length;
    const pendingResolution = totalGenerated - totalResolved;

    const metrics: PerformanceMetrics = {
      win_rate_24h: calculateWinRates(signals24h),
      win_rate_7d: calculateWinRates(signals7d),
      win_rate_30d: calculateWinRates(signals30d),
      brier_score_24h: brier24h,
      brier_score_7d: brier7d,
      brier_score_30d: brier30d,
      top_categories: topCategories,
      worst_false_positives: falsePositives,
      signal_stats: {
        total_generated: totalGenerated,
        total_resolved: totalResolved,
        pending_resolution: pendingResolution,
      },
      timestamp: now.toISOString(),
    };

    res.status(200).json({
      success: true,
      data: metrics,
    });

  } catch (error) {
    console.error('[API] Error in performance metrics:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
