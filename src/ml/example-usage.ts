// Example Usage of ML Signal Scoring System
//
// This demonstrates the complete workflow from data generation to model training
// to inference in production signal generation.

import { generateSyntheticData } from './generate-synthetic-data';
import { trainModel } from './train-signal-scorer';
import { predictSignalQuality, isModelAvailable, getModelInfo } from './signal-scorer-model';
import { generateSignal } from '../analysis/signal-generator';
import { Market, MarketMatch } from '../types/market';

// ─── Step 1: Generate Synthetic Training Data ────────────────────────────────

async function step1_generateData() {
  console.log('═══ Step 1: Generate Synthetic Training Data ═══\n');
  
  // Generate 1000 synthetic signals with simulated outcomes
  // This is only needed once to bootstrap the system
  await generateSyntheticData(1000);
  
  console.log('\n✓ Synthetic data generated\n');
}

// ─── Step 2: Train the ML Model ──────────────────────────────────────────────

async function step2_trainModel() {
  console.log('═══ Step 2: Train the ML Model ═══\n');
  
  // Train logistic regression model on resolved signals
  const model = await trainModel();
  
  console.log('\n✓ Model trained successfully');
  console.log(`  Version: ${model.version}`);
  console.log(`  Accuracy: ${(model.metrics.accuracy * 100).toFixed(2)}%`);
  console.log(`  Brier Score: ${model.metrics.brier_score.toFixed(4)}\n`);
}

// ─── Step 3: Check Model Status ──────────────────────────────────────────────

function step3_checkModel() {
  console.log('═══ Step 3: Check Model Status ═══\n');
  
  if (isModelAvailable()) {
    const info = getModelInfo();
    console.log('✓ ML Model is available');
    console.log(`  Version: ${info.version}`);
    console.log(`  Trained: ${info.trained_at}`);
    console.log(`  Accuracy: ${((info.metrics?.accuracy ?? 0) * 100).toFixed(2)}%`);
  } else {
    console.log('✗ ML Model not found');
    console.log('  Will use heuristic fallback for predictions');
  }
  
  console.log();
}

// ─── Step 4: Generate Signals Without ML ─────────────────────────────────────

function step4_generateSignalWithoutML() {
  console.log('═══ Step 4: Generate Signal (Rule-Based) ═══\n');
  
  // Create a sample market
  const market: Market = {
    id: 'example-market-1',
    platform: 'polymarket',
    title: 'Will Bitcoin reach $100k in 2026?',
    description: 'Resolves YES if BTC hits $100k before Dec 31, 2026',
    keywords: ['bitcoin', 'btc', 'crypto', 'price'],
    yesPrice: 0.65,
    noPrice: 0.35,
    volume24h: 450000,
    url: 'https://polymarket.com/event/btc-100k',
    category: 'crypto',
    lastUpdated: new Date().toISOString(),
    oneDayPriceChange: 0.05,
    endDate: '2026-12-31T23:59:59Z',
  };
  
  const match: MarketMatch = {
    market,
    confidence: 0.85,
    matchedKeywords: ['bitcoin', 'btc'],
  };
  
  const tweetText = 'Breaking: Major institutional adoption signals bullish momentum for Bitcoin. Analysts predict $100k target by year-end.';
  
  // Generate signal WITHOUT ML (default behavior)
  const signal = generateSignal(tweetText, [match]);
  
  console.log('Signal generated (rule-based):');
  console.log(`  Direction: ${signal.suggested_action?.direction}`);
  console.log(`  Confidence: ${((signal.suggested_action?.confidence ?? 0) * 100).toFixed(1)}%`);
  console.log(`  Edge: ${((signal.suggested_action?.edge ?? 0) * 100).toFixed(1)}%`);
  console.log(`  Urgency: ${signal.urgency}`);
  console.log(`  ML Score: ${signal.ml_score ? 'present' : 'not used'}\n`);
}

// ─── Step 5: Generate Signals With ML ────────────────────────────────────────

function step5_generateSignalWithML() {
  console.log('═══ Step 5: Generate Signal (ML-Enhanced) ═══\n');
  
  // Create a sample market
  const market: Market = {
    id: 'example-market-2',
    platform: 'polymarket',
    title: 'Will Bitcoin reach $100k in 2026?',
    description: 'Resolves YES if BTC hits $100k before Dec 31, 2026',
    keywords: ['bitcoin', 'btc', 'crypto', 'price'],
    yesPrice: 0.65,
    noPrice: 0.35,
    volume24h: 450000,
    url: 'https://polymarket.com/event/btc-100k',
    category: 'crypto',
    lastUpdated: new Date().toISOString(),
    oneDayPriceChange: 0.05,
    endDate: '2026-12-31T23:59:59Z',
  };
  
  const match: MarketMatch = {
    market,
    confidence: 0.85,
    matchedKeywords: ['bitcoin', 'btc'],
  };
  
  const tweetText = 'Breaking: Major institutional adoption signals bullish momentum for Bitcoin. Analysts predict $100k target by year-end.';
  
  // Generate signal WITH ML scoring enabled
  const signal = generateSignal(
    tweetText,
    [match],
    undefined,
    'normal',
    { use_ml_scorer: true } // Enable ML
  );
  
  console.log('Signal generated (ML-enhanced):');
  console.log(`  Direction: ${signal.suggested_action?.direction}`);
  console.log(`  Confidence: ${((signal.suggested_action?.confidence ?? 0) * 100).toFixed(1)}%`);
  console.log(`  Edge: ${((signal.suggested_action?.edge ?? 0) * 100).toFixed(1)}%`);
  console.log(`  Urgency: ${signal.urgency}`);
  
  if (signal.ml_score) {
    console.log(`  ML Score:`);
    console.log(`    Probability: ${(signal.ml_score.probability * 100).toFixed(1)}%`);
    console.log(`    Confidence: ${(signal.ml_score.confidence * 100).toFixed(1)}%`);
    console.log(`    Source: ${signal.ml_score.source}`);
    if (signal.ml_score.model_version) {
      console.log(`    Model: ${signal.ml_score.model_version}`);
    }
  }
  
  console.log();
}

// ─── Step 6: Direct ML Prediction ────────────────────────────────────────────

function step6_directPrediction() {
  console.log('═══ Step 6: Direct ML Prediction ═══\n');
  
  // You can also use the ML model directly without going through signal generation
  const prediction = predictSignalQuality({
    sentiment_confidence: 0.8,
    yes_price: 0.65,
    volume_24h: 450000,
    match_confidence: 0.85,
    num_matches: 1,
    edge: 0.12,
    one_day_price_change: 0.05,
    is_anomalous: false,
    is_near_resolution: false,
    has_arbitrage: false,
    arbitrage_spread: 0,
    kelly_fraction: 0.08,
    processing_time_ms: 45,
    sentiment: 'bullish',
    signal_type: 'sentiment_shift',
    urgency: 'high',
  });
  
  console.log('Direct ML prediction:');
  console.log(`  Probability: ${(prediction.probability * 100).toFixed(1)}%`);
  console.log(`  Confidence: ${(prediction.confidence * 100).toFixed(1)}%`);
  console.log(`  Source: ${prediction.source}`);
  console.log();
}

// ─── Main Workflow ────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║   ML Signal Scoring System - Complete Workflow       ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');
  
  try {
    // Uncomment to generate synthetic data and train model
    // (Only needed once for initial setup)
    
    // await step1_generateData();
    // await step2_trainModel();
    
    // Check model status
    step3_checkModel();
    
    // Compare rule-based vs ML-enhanced signal generation
    step4_generateSignalWithoutML();
    step5_generateSignalWithML();
    
    // Direct prediction example
    step6_directPrediction();
    
    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║   Complete! See README.md for more information       ║');
    console.log('╚═══════════════════════════════════════════════════════╝\n');
    
  } catch (err) {
    console.error('\n❌ Error:', err);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}
