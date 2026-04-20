// ML Model Training Script for Signal Quality Scoring
//
// This script trains a simple logistic regression model to predict whether
// a trading signal will be correct based on features extracted from the
// signal generation process.
//
// Usage: node --import tsx src/ml/train-signal-scorer.ts
//
// Requirements: At least 500 resolved signals in the database

import { createSupabaseBrowserClient } from '../api/supabase-client';
import { SignalOutcome } from '../db/signal-outcomes';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ModelWeights {
  version: string;
  trained_at: string;
  feature_names: string[];
  weights: number[];
  bias: number;
  metrics: {
    accuracy: number;
    precision: number;
    recall: number;
    brier_score: number;
    f1_score: number;
    n_samples: number;
    n_train: number;
    n_test: number;
  };
  feature_stats: {
    means: number[];
    stds: number[];
  };
}

interface TrainingExample {
  features: number[];
  label: number; // 1 = correct, 0 = incorrect
}

// ─── Feature Extraction ───────────────────────────────────────────────────────

/**
 * Feature names in the order they are extracted.
 * IMPORTANT: This order must match the feature extraction in extractFeatures()
 */
const FEATURE_NAMES = [
  'sentiment_confidence',
  'yes_price',
  'volume_24h_log',
  'match_confidence',
  'num_matches',
  'edge',
  'one_day_price_change',
  'is_anomalous',
  'is_near_resolution',
  'has_arbitrage',
  'arbitrage_spread',
  'kelly_fraction',
  'processing_time_ms_log',
  'is_bullish',
  'is_bearish',
  'is_news_event',
  'is_arbitrage',
  'is_high_urgency',
  'is_critical_urgency',
];

/**
 * Extract numeric features from a signal's features JSON.
 * Returns a fixed-length array of numbers suitable for model training.
 */
function extractFeatures(outcome: SignalOutcome): number[] {
  const f = outcome.features as any;

  // Handle missing or null features gracefully
  const sentimentConf = f.sentiment_confidence ?? 0;
  const yesPrice = f.yes_price ?? 0.5;
  const volume24h = f.volume_24h ?? 0;
  const matchConf = f.match_confidence ?? 0;
  const numMatches = f.num_matches ?? 1;
  const edge = outcome.edge ?? 0;
  const oneDayChange = f.one_day_price_change ?? 0;
  const isAnomalous = f.is_anomalous ? 1 : 0;
  const isNearRes = f.is_near_resolution ? 1 : 0;
  const hasArb = f.has_arbitrage ? 1 : 0;
  const arbSpread = f.arbitrage_spread ?? 0;
  const kellyFrac = f.kelly_fraction ?? 0;
  const procTime = f.processing_time_ms ?? 1;

  // Derived features
  const isBullish = f.sentiment === 'bullish' ? 1 : 0;
  const isBearish = f.sentiment === 'bearish' ? 1 : 0;
  const isNewsEvent = outcome.signal_type === 'news_event' ? 1 : 0;
  const isArbitrage = outcome.signal_type === 'arbitrage' ? 1 : 0;
  const isHighUrgency = outcome.urgency === 'high' ? 1 : 0;
  const isCriticalUrgency = outcome.urgency === 'critical' ? 1 : 0;

  return [
    sentimentConf,
    yesPrice,
    Math.log(volume24h + 1), // Log transform for volume
    matchConf,
    numMatches,
    edge,
    oneDayChange,
    isAnomalous,
    isNearRes,
    hasArb,
    arbSpread,
    kellyFrac,
    Math.log(procTime + 1), // Log transform for time
    isBullish,
    isBearish,
    isNewsEvent,
    isArbitrage,
    isHighUrgency,
    isCriticalUrgency,
  ];
}

// ─── Data Loading ─────────────────────────────────────────────────────────────

/**
 * Load all resolved signals from the database.
 * Only signals with resolution_date and was_correct are included.
 */
async function loadTrainingData(): Promise<SignalOutcome[]> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_ANON_KEY.');
  }

  const client = createSupabaseBrowserClient(supabaseUrl, supabaseKey);

  const { data, error } = await client
    .from('signal_outcomes')
    .select('*')
    .not('resolution_date', 'is', null)
    .not('was_correct', 'is', null)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to load training data: ${error.message}`);
  }

  return (data as SignalOutcome[]) || [];
}

// ─── Feature Normalization ────────────────────────────────────────────────────

/**
 * Calculate mean and standard deviation for each feature.
 * Used for z-score normalization.
 */
function calculateFeatureStats(examples: TrainingExample[]): {
  means: number[];
  stds: number[];
} {
  const n = examples.length;
  const featureCount = examples[0].features.length;

  // Calculate means
  const means = new Array(featureCount).fill(0);
  for (const ex of examples) {
    for (let i = 0; i < featureCount; i++) {
      means[i] += ex.features[i];
    }
  }
  for (let i = 0; i < featureCount; i++) {
    means[i] /= n;
  }

  // Calculate standard deviations
  const stds = new Array(featureCount).fill(0);
  for (const ex of examples) {
    for (let i = 0; i < featureCount; i++) {
      stds[i] += Math.pow(ex.features[i] - means[i], 2);
    }
  }
  for (let i = 0; i < featureCount; i++) {
    stds[i] = Math.sqrt(stds[i] / n);
    // Avoid division by zero
    if (stds[i] === 0) stds[i] = 1;
  }

  return { means, stds };
}

/**
 * Normalize features using z-score normalization.
 */
function normalizeFeatures(
  examples: TrainingExample[],
  means: number[],
  stds: number[]
): TrainingExample[] {
  return examples.map((ex) => ({
    features: ex.features.map((f, i) => (f - means[i]) / stds[i]),
    label: ex.label,
  }));
}

// ─── Logistic Regression Training ────────────────────────────────────────────

/**
 * Sigmoid activation function.
 */
function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Predict probability using logistic regression.
 */
function predict(features: number[], weights: number[], bias: number): number {
  let z = bias;
  for (let i = 0; i < features.length; i++) {
    z += features[i] * weights[i];
  }
  return sigmoid(z);
}

/**
 * Train logistic regression using gradient descent.
 * Returns trained weights and bias.
 */
function trainLogisticRegression(
  examples: TrainingExample[],
  learningRate: number = 0.01,
  iterations: number = 1000,
  l2Lambda: number = 0.01
): { weights: number[]; bias: number } {
  const n = examples.length;
  const featureCount = examples[0].features.length;

  // Initialize weights and bias
  let weights = new Array(featureCount).fill(0);
  let bias = 0;

  // Gradient descent
  for (let iter = 0; iter < iterations; iter++) {
    // Calculate gradients
    const gradWeights = new Array(featureCount).fill(0);
    let gradBias = 0;

    for (const ex of examples) {
      const pred = predict(ex.features, weights, bias);
      const error = pred - ex.label;

      gradBias += error;
      for (let i = 0; i < featureCount; i++) {
        gradWeights[i] += error * ex.features[i];
      }
    }

    // Update weights with L2 regularization
    for (let i = 0; i < featureCount; i++) {
      const regularization = l2Lambda * weights[i];
      weights[i] -= learningRate * (gradWeights[i] / n + regularization);
    }
    bias -= learningRate * (gradBias / n);

    // Log progress every 100 iterations
    if (iter % 100 === 0 && iter > 0) {
      const loss = calculateLogLoss(examples, weights, bias);
      console.log(`Iteration ${iter}: Log loss = ${loss.toFixed(4)}`);
    }
  }

  return { weights, bias };
}

/**
 * Calculate log loss (binary cross-entropy).
 */
function calculateLogLoss(
  examples: TrainingExample[],
  weights: number[],
  bias: number
): number {
  let loss = 0;
  for (const ex of examples) {
    const pred = predict(ex.features, weights, bias);
    // Clip predictions to avoid log(0)
    const clippedPred = Math.max(1e-7, Math.min(1 - 1e-7, pred));
    loss += -ex.label * Math.log(clippedPred) - (1 - ex.label) * Math.log(1 - clippedPred);
  }
  return loss / examples.length;
}

// ─── Evaluation Metrics ───────────────────────────────────────────────────────

interface Metrics {
  accuracy: number;
  precision: number;
  recall: number;
  brier_score: number;
  f1_score: number;
}

/**
 * Evaluate model performance on a test set.
 */
function evaluateModel(
  examples: TrainingExample[],
  weights: number[],
  bias: number
): Metrics {
  let truePos = 0;
  let falsePos = 0;
  let trueNeg = 0;
  let falseNeg = 0;
  let brierSum = 0;

  for (const ex of examples) {
    const prob = predict(ex.features, weights, bias);
    const predicted = prob >= 0.5 ? 1 : 0;
    const actual = ex.label;

    if (predicted === 1 && actual === 1) truePos++;
    else if (predicted === 1 && actual === 0) falsePos++;
    else if (predicted === 0 && actual === 0) trueNeg++;
    else if (predicted === 0 && actual === 1) falseNeg++;

    // Brier score
    brierSum += Math.pow(prob - actual, 2);
  }

  const accuracy = (truePos + trueNeg) / examples.length;
  const precision = truePos + falsePos > 0 ? truePos / (truePos + falsePos) : 0;
  const recall = truePos + falseNeg > 0 ? truePos / (truePos + falseNeg) : 0;
  const brier_score = brierSum / examples.length;
  const f1_score = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { accuracy, precision, recall, brier_score, f1_score };
}

// ─── Main Training Pipeline ───────────────────────────────────────────────────

/**
 * Train the signal scorer model and save weights to disk.
 */
export async function trainModel(): Promise<ModelWeights> {
  console.log('🔬 Loading training data...');
  const outcomes = await loadTrainingData();

  if (outcomes.length < 500) {
    throw new Error(
      `Insufficient training data: ${outcomes.length} signals (minimum 500 required)`
    );
  }

  console.log(`✓ Loaded ${outcomes.length} resolved signals`);

  // Convert to training examples
  const examples: TrainingExample[] = outcomes.map((outcome) => ({
    features: extractFeatures(outcome),
    label: outcome.was_correct ? 1 : 0,
  }));

  // Shuffle examples
  for (let i = examples.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [examples[i], examples[j]] = [examples[j], examples[i]];
  }

  // Split into train/test (80/20)
  const splitIndex = Math.floor(examples.length * 0.8);
  const trainExamples = examples.slice(0, splitIndex);
  const testExamples = examples.slice(splitIndex);

  console.log(`📊 Training set: ${trainExamples.length} examples`);
  console.log(`📊 Test set: ${testExamples.length} examples`);

  // Calculate feature statistics for normalization
  const { means, stds } = calculateFeatureStats(trainExamples);

  // Normalize features
  const normalizedTrain = normalizeFeatures(trainExamples, means, stds);
  const normalizedTest = normalizeFeatures(testExamples, means, stds);

  // Train model
  console.log('\n🧠 Training logistic regression model...');
  const { weights, bias } = trainLogisticRegression(normalizedTrain, 0.01, 1000, 0.01);
  console.log('✓ Training complete');

  // Evaluate on test set
  console.log('\n📈 Evaluating model...');
  const metrics = evaluateModel(normalizedTest, weights, bias);

  console.log(`\n─── Test Set Performance ───`);
  console.log(`Accuracy:      ${(metrics.accuracy * 100).toFixed(2)}%`);
  console.log(`Precision:     ${(metrics.precision * 100).toFixed(2)}%`);
  console.log(`Recall:        ${(metrics.recall * 100).toFixed(2)}%`);
  console.log(`F1 Score:      ${(metrics.f1_score * 100).toFixed(2)}%`);
  console.log(`Brier Score:   ${metrics.brier_score.toFixed(4)} (lower is better)`);

  // Feature importance (absolute weight values)
  console.log(`\n─── Feature Importance ───`);
  const importances = weights.map((w, i) => ({
    name: FEATURE_NAMES[i],
    weight: w,
    absWeight: Math.abs(w),
  }));
  importances.sort((a, b) => b.absWeight - a.absWeight);
  for (let i = 0; i < Math.min(10, importances.length); i++) {
    const imp = importances[i];
    console.log(
      `${(i + 1).toString().padStart(2)}. ${imp.name.padEnd(30)} ${imp.weight > 0 ? '+' : ''}${imp.weight.toFixed(4)}`
    );
  }

  // Build model weights object
  const modelWeights: ModelWeights = {
    version: 'v1',
    trained_at: new Date().toISOString(),
    feature_names: FEATURE_NAMES,
    weights,
    bias,
    metrics: {
      accuracy: metrics.accuracy,
      precision: metrics.precision,
      recall: metrics.recall,
      brier_score: metrics.brier_score,
      f1_score: metrics.f1_score,
      n_samples: examples.length,
      n_train: trainExamples.length,
      n_test: testExamples.length,
    },
    feature_stats: { means, stds },
  };

  // Save to disk
  const modelPath = path.join(__dirname, 'models', 'signal-scorer-v1.json');
  fs.writeFileSync(modelPath, JSON.stringify(modelWeights, null, 2));
  console.log(`\n✓ Model saved to ${modelPath}`);

  return modelWeights;
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

if (require.main === module) {
  trainModel()
    .then(() => {
      console.log('\n✨ Training complete!');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ Training failed:', err.message);
      process.exit(1);
    });
}
