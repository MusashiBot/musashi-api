// Synthetic Training Data Generator
//
// Generates realistic training examples based on the rule-based signal system.
// Useful for bootstrapping ML training before real resolution data exists.
//
// Usage: node --import tsx src/ml/generate-synthetic-data.ts
//
// This script:
// 1. Generates synthetic market scenarios
// 2. Runs them through the signal generator
// 3. Simulates outcomes based on signal quality
// 4. Saves to signal_outcomes table with resolution data

import { createSupabaseBrowserClient } from '../api/supabase-client';
import { Market, MarketMatch, ArbitrageOpportunity } from '../types/market';
import { generateSignal, TradingSignal } from '../analysis/signal-generator';
import { SignalOutcome } from '../db/signal-outcomes';

// ─── Synthetic Market Generation ──────────────────────────────────────────────

const MARKET_CATEGORIES = [
  'politics',
  'sports',
  'crypto',
  'business',
  'technology',
  'entertainment',
];

const SAMPLE_MARKET_TITLES = [
  'Will the S&P 500 close above 5000 by end of month?',
  'Will Bitcoin reach $100k in 2026?',
  'Will OpenAI release GPT-5 this quarter?',
  'Will Team A win the championship?',
  'Will Company X acquire Company Y?',
  'Will inflation drop below 2% this year?',
];

/**
 * Generate a synthetic market with realistic parameters.
 */
function generateSyntheticMarket(overrides?: Partial<Market>): Market {
  const category = MARKET_CATEGORIES[Math.floor(Math.random() * MARKET_CATEGORIES.length)];
  const title = SAMPLE_MARKET_TITLES[Math.floor(Math.random() * SAMPLE_MARKET_TITLES.length)];

  // Generate realistic price (with some bias toward 0.4-0.6 range)
  const yesPrice = Math.random() < 0.6 
    ? 0.3 + Math.random() * 0.4 // 60% chance of prices in 0.3-0.7 range
    : Math.random(); // 40% chance of any price

  // Volume follows log-normal distribution
  const logVolume = 10 + Math.random() * 4; // log(volume) ~ 10-14
  const volume24h = Math.exp(logVolume);

  // 5% chance of anomalous price movement
  const is_anomalous = Math.random() < 0.05;

  // 20% chance of near resolution
  const daysUntilEnd = Math.random() < 0.2 ? Math.random() * 7 : 7 + Math.random() * 30;
  const endDate = new Date(Date.now() + daysUntilEnd * 86_400_000).toISOString();

  return {
    id: `synthetic_${Math.random().toString(36).substring(7)}`,
    platform: Math.random() < 0.5 ? 'polymarket' : 'kalshi',
    title,
    description: title,
    keywords: title.toLowerCase().split(' ').filter(w => w.length > 3),
    yesPrice,
    noPrice: 1 - yesPrice,
    volume24h,
    url: 'https://example.com/market',
    category,
    lastUpdated: new Date().toISOString(),
    oneDayPriceChange: (Math.random() - 0.5) * 0.2, // -10% to +10%
    endDate,
    is_anomalous,
    ...overrides,
  };
}

// ─── Synthetic Tweet Generation ───────────────────────────────────────────────

const BULLISH_TEMPLATES = [
  'Breaking: Strong momentum for {topic}',
  'Just confirmed: {topic} looking very likely',
  'Huge news for {topic} - this is happening!',
  'Reports suggest {topic} is almost certain',
  'Official: {topic} confirmed by sources',
];

const BEARISH_TEMPLATES = [
  'Developing: {topic} looking unlikely now',
  'Sources say {topic} probably won\'t happen',
  'Bad news for {topic} - major setback reported',
  'Reports indicate {topic} is off the table',
  'Alert: {topic} facing significant obstacles',
];

const NEUTRAL_TEMPLATES = [
  'Discussion continues on {topic}',
  'Latest update on {topic} situation',
  'More information needed on {topic}',
  'Analysts divided on {topic} outcome',
];

/**
 * Generate a synthetic tweet based on market and desired sentiment.
 */
function generateSyntheticTweet(
  market: Market,
  sentiment: 'bullish' | 'bearish' | 'neutral'
): string {
  const topic = market.title.split('?')[0].replace('Will ', '');

  let templates: string[];
  if (sentiment === 'bullish') templates = BULLISH_TEMPLATES;
  else if (sentiment === 'bearish') templates = BEARISH_TEMPLATES;
  else templates = NEUTRAL_TEMPLATES;

  const template = templates[Math.floor(Math.random() * templates.length)];
  return template.replace('{topic}', topic);
}

// ─── Outcome Simulation ───────────────────────────────────────────────────────

/**
 * Simulate whether a signal would have been correct based on its quality.
 * Higher edge and confidence → higher probability of being correct.
 */
function simulateOutcome(signal: TradingSignal): {
  outcome: 'YES' | 'NO';
  was_correct: boolean;
  pnl: number;
} {
  if (!signal.suggested_action || signal.suggested_action.direction === 'HOLD') {
    // HOLD signals - random outcome
    const outcome = Math.random() < 0.5 ? 'YES' : 'NO';
    return { outcome, was_correct: false, pnl: 0 };
  }

  const edge = signal.suggested_action.edge;
  const confidence = signal.suggested_action.confidence;
  const direction = signal.suggested_action.direction;

  // Base probability of being correct increases with edge and confidence
  let correctProb = 0.5 + edge * 0.5 + confidence * 0.2;

  // High urgency signals have better accuracy
  if (signal.urgency === 'critical') correctProb += 0.1;
  else if (signal.urgency === 'high') correctProb += 0.05;

  // Arbitrage signals are very reliable
  if (signal.signal_type === 'arbitrage') correctProb += 0.15;

  // News events are noisier
  if (signal.signal_type === 'news_event') correctProb -= 0.1;

  // Add some noise
  correctProb += (Math.random() - 0.5) * 0.1;
  correctProb = Math.max(0.1, Math.min(0.9, correctProb));

  // Determine if prediction was correct
  const was_correct = Math.random() < correctProb;

  // Determine actual outcome based on direction and correctness
  let outcome: 'YES' | 'NO';
  if (direction === 'YES') {
    outcome = was_correct ? 'YES' : 'NO';
  } else {
    outcome = was_correct ? 'NO' : 'YES';
  }

  // Calculate PnL based on Kelly sizing and outcome
  const kellyFraction = signal.suggested_action.position_size.fraction;
  const basePnl = was_correct ? edge : -edge;
  const pnl = basePnl * kellyFraction * 100; // Scale to reasonable dollar amounts

  return { outcome, was_correct, pnl };
}

// ─── Data Insertion ───────────────────────────────────────────────────────────

/**
 * Insert a synthetic signal outcome into the database.
 */
async function insertSyntheticOutcome(
  signal: TradingSignal,
  outcome: 'YES' | 'NO',
  was_correct: boolean,
  pnl: number
): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[generateSyntheticData] Missing Supabase credentials');
    return false;
  }

  const client = createSupabaseBrowserClient(supabaseUrl, supabaseKey);

  if (!signal.suggested_action || signal.matches.length === 0) {
    return false;
  }

  const topMatch = signal.matches[0];
  const topMarket = topMatch.market;

  // Calculate implied probability
  const sentimentConf = signal.sentiment?.confidence || 0;
  let predicted_prob = 0.5;
  if (signal.sentiment?.sentiment === 'bullish') {
    predicted_prob = 0.5 + sentimentConf * 0.4;
  } else if (signal.sentiment?.sentiment === 'bearish') {
    predicted_prob = 0.5 - sentimentConf * 0.4;
  }

  // Extract features (same as logSignal in signal-outcomes.ts)
  const features = {
    sentiment: signal.sentiment?.sentiment,
    sentiment_confidence: signal.sentiment?.confidence,
    yes_price: topMarket.yesPrice,
    no_price: topMarket.noPrice,
    volume_24h: topMarket.volume24h,
    category: topMarket.category,
    one_day_price_change: topMarket.oneDayPriceChange,
    is_anomalous: topMarket.is_anomalous,
    match_confidence: topMatch.confidence,
    matched_keywords: topMatch.matchedKeywords,
    num_matches: signal.matches.length,
    valid_until_seconds: signal.valid_until_seconds,
    is_near_resolution: signal.is_near_resolution,
    processing_time_ms: signal.metadata.processing_time_ms,
    tweet_text: signal.metadata.tweet_text,
    has_arbitrage: !!signal.arbitrage,
    arbitrage_spread: signal.arbitrage?.spread,
    arbitrage_net_spread: signal.arbitrage?.net_spread,
    arbitrage_profit_potential: signal.arbitrage?.profitPotential,
    kelly_fraction: signal.suggested_action.position_size.fraction,
    kelly_full: signal.suggested_action.position_size.kelly_full,
    risk_level: signal.suggested_action.position_size.risk_level,
    vol_regime: signal.suggested_action.position_size.vol_regime,
    synthetic: true, // Mark as synthetic
  };

  // Set resolution date to past (signal is already resolved)
  const resolution_date = new Date(Date.now() - Math.random() * 30 * 86_400_000).toISOString();

  const { error } = await (client
    .from('signal_outcomes') as any)
    .insert({
      event_id: signal.event_id,
      market_id: topMarket.id,
      platform: topMarket.platform,
      predicted_direction: signal.suggested_action.direction,
      predicted_prob,
      confidence: signal.suggested_action.confidence,
      edge: signal.suggested_action.edge,
      signal_type: signal.signal_type,
      urgency: signal.urgency,
      features,
      resolution_date,
      outcome,
      was_correct,
      pnl,
      is_synthetic: true,
    });

  if (error) {
    console.error('[insertSyntheticOutcome] Failed to insert:', error);
    return false;
  }

  return true;
}

// ─── Main Generation Loop ─────────────────────────────────────────────────────

/**
 * Generate N synthetic training examples and save to database.
 */
export async function generateSyntheticData(count: number = 1000): Promise<void> {
  console.log(`🧪 Generating ${count} synthetic training examples...\n`);

  let inserted = 0;
  let failed = 0;

  for (let i = 0; i < count; i++) {
    try {
      // Generate a market
      const market = generateSyntheticMarket();

      // Choose a sentiment (70% directional, 30% neutral)
      let sentiment: 'bullish' | 'bearish' | 'neutral';
      const rand = Math.random();
      if (rand < 0.35) sentiment = 'bullish';
      else if (rand < 0.70) sentiment = 'bearish';
      else sentiment = 'neutral';

      // Generate tweet
      const tweet = generateSyntheticTweet(market, sentiment);

      // Create market match
      const match: MarketMatch = {
        market,
        confidence: 0.7 + Math.random() * 0.3, // 0.7-1.0
        matchedKeywords: market.keywords.slice(0, 3),
      };

      // Optionally create arbitrage opportunity (10% of signals)
      let arbitrage: ArbitrageOpportunity | undefined;
      if (Math.random() < 0.10) {
        const otherPlatform = market.platform === 'polymarket' ? 'kalshi' : 'polymarket';
        const spread = 0.02 + Math.random() * 0.08; // 2-10%
        const otherMarket = generateSyntheticMarket({
          platform: otherPlatform,
          yesPrice: market.yesPrice + spread,
        });

        arbitrage = {
          polymarket: market.platform === 'polymarket' ? market : otherMarket,
          kalshi: market.platform === 'kalshi' ? market : otherMarket,
          spread,
          net_spread: spread * 0.8, // Account for liquidity penalty
          liquidity_penalty: spread * 0.2,
          profitPotential: spread * 0.8,
          direction: market.platform === 'polymarket' ? 'buy_poly_sell_kalshi' : 'buy_kalshi_sell_poly',
          confidence: 0.85,
          matchReason: 'Synthetic arbitrage opportunity',
        };
      }

      // Generate signal
      const signal = generateSignal(tweet, [match], arbitrage);

      // Simulate outcome
      const { outcome, was_correct, pnl } = simulateOutcome(signal);

      // Insert into database
      const success = await insertSyntheticOutcome(signal, outcome, was_correct, pnl);

      if (success) {
        inserted++;
        if ((i + 1) % 100 === 0) {
          console.log(`  ✓ Generated ${i + 1}/${count} examples...`);
        }
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      if (failed <= 5) {
        console.error(`  ✗ Failed to generate example ${i + 1}:`, err);
      }
    }
  }

  console.log(`\n─── Generation Complete ───`);
  console.log(`✓ Successfully inserted: ${inserted}`);
  console.log(`✗ Failed: ${failed}`);
  console.log(`📊 Success rate: ${((inserted / count) * 100).toFixed(1)}%`);
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const count = process.argv[2] ? parseInt(process.argv[2]) : 1000;

  generateSyntheticData(count)
    .then(() => {
      console.log('\n✨ Synthetic data generation complete!');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ Generation failed:', err.message);
      process.exit(1);
    });
}
