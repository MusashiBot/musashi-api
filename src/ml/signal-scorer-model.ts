// Signal Scorer Model — ML-powered signal quality prediction
//
// Loads trained model weights and provides inference for signal scoring.
// Falls back to heuristic scoring if model is not available.
//
// Usage:
//   import { predictSignalQuality } from './ml/signal-scorer-model';
//   const probability = predictSignalQuality(features);

import * as fs from 'fs';
import * as path from 'path';
import { ModelWeights } from './train-signal-scorer';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Feature vector for signal quality prediction.
 * Must contain all features used during training.
 */
export interface SignalFeatures {
  sentiment_confidence: number;
  yes_price: number;
  volume_24h: number;
  match_confidence: number;
  num_matches: number;
  edge: number;
  one_day_price_change: number;
  is_anomalous: boolean;
  is_near_resolution: boolean;
  has_arbitrage: boolean;
  arbitrage_spread: number;
  kelly_fraction: number;
  processing_time_ms: number;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  signal_type: string;
  urgency: string;
}

/**
 * Prediction result from the ML model.
 */
export interface SignalQualityPrediction {
  probability: number; // 0-1, probability that signal will be correct
  confidence: number; // 0-1, model confidence in this prediction
  source: 'ml_model' | 'heuristic'; // Where the prediction came from
  model_version?: string;
}

// ─── Model Loading ────────────────────────────────────────────────────────────

let cachedModel: ModelWeights | null = null;
let modelLoadError: string | null = null;

/**
 * Load model weights from disk (cached after first load).
 */
function loadModel(): ModelWeights | null {
  if (cachedModel) {
    return cachedModel;
  }

  if (modelLoadError) {
    // Don't retry if we already failed
    return null;
  }

  try {
    const modelPath = path.join(__dirname, 'models', 'signal-scorer-v1.json');

    if (!fs.existsSync(modelPath)) {
      modelLoadError = 'Model file not found';
      console.warn('[signal-scorer-model] Model file not found, using heuristic fallback');
      return null;
    }

    const modelJson = fs.readFileSync(modelPath, 'utf-8');
    cachedModel = JSON.parse(modelJson) as ModelWeights;

    console.log(
      `[signal-scorer-model] Loaded model ${cachedModel.version} (trained ${cachedModel.trained_at})`
    );
    console.log(
      `  Accuracy: ${(cachedModel.metrics.accuracy * 100).toFixed(1)}%, Brier: ${cachedModel.metrics.brier_score.toFixed(3)}`
    );

    return cachedModel;
  } catch (err) {
    modelLoadError = err instanceof Error ? err.message : 'Unknown error';
    console.error('[signal-scorer-model] Failed to load model:', modelLoadError);
    return null;
  }
}

// ─── Feature Extraction ───────────────────────────────────────────────────────

/**
 * Extract numeric feature vector from SignalFeatures object.
 * IMPORTANT: Order must match FEATURE_NAMES in train-signal-scorer.ts
 */
function extractFeatureVector(features: SignalFeatures): number[] {
  return [
    features.sentiment_confidence,
    features.yes_price,
    Math.log(features.volume_24h + 1),
    features.match_confidence,
    features.num_matches,
    features.edge,
    features.one_day_price_change,
    features.is_anomalous ? 1 : 0,
    features.is_near_resolution ? 1 : 0,
    features.has_arbitrage ? 1 : 0,
    features.arbitrage_spread,
    features.kelly_fraction,
    Math.log(features.processing_time_ms + 1),
    features.sentiment === 'bullish' ? 1 : 0,
    features.sentiment === 'bearish' ? 1 : 0,
    features.signal_type === 'news_event' ? 1 : 0,
    features.signal_type === 'arbitrage' ? 1 : 0,
    features.urgency === 'high' ? 1 : 0,
    features.urgency === 'critical' ? 1 : 0,
  ];
}

// ─── Model Inference ──────────────────────────────────────────────────────────

/**
 * Sigmoid activation function.
 */
function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Normalize features using z-score normalization.
 */
function normalizeFeatures(
  features: number[],
  means: number[],
  stds: number[]
): number[] {
  return features.map((f, i) => (f - means[i]) / stds[i]);
}

/**
 * Run inference using the loaded model.
 */
function predictWithModel(features: SignalFeatures, model: ModelWeights): number {
  // Extract and normalize features
  const rawFeatures = extractFeatureVector(features);
  const normalizedFeatures = normalizeFeatures(
    rawFeatures,
    model.feature_stats.means,
    model.feature_stats.stds
  );

  // Compute logistic regression: z = w·x + b
  let z = model.bias;
  for (let i = 0; i < normalizedFeatures.length; i++) {
    z += normalizedFeatures[i] * model.weights[i];
  }

  // Apply sigmoid to get probability
  return sigmoid(z);
}

// ─── Heuristic Fallback ───────────────────────────────────────────────────────

/**
 * Heuristic-based signal quality estimation.
 * Used when ML model is not available.
 *
 * This is a simplified rule-based approach that considers:
 * - Edge magnitude
 * - Sentiment confidence
 * - Market volume
 * - Match confidence
 * - Urgency and signal type
 */
function predictWithHeuristic(features: SignalFeatures): number {
  let score = 0.5; // Start at 50%

  // Edge is the most important factor
  score += features.edge * 1.5; // +15% per 0.1 edge

  // Sentiment confidence boosts score
  if (features.sentiment !== 'neutral') {
    score += features.sentiment_confidence * 0.2;
  }

  // High match confidence is good
  score += features.match_confidence * 0.1;

  // High volume markets are more reliable
  if (features.volume_24h > 100_000) {
    score += 0.05;
  }
  if (features.volume_24h > 500_000) {
    score += 0.05;
  }

  // Arbitrage signals are high quality
  if (features.has_arbitrage && features.arbitrage_spread > 0.03) {
    score += 0.15;
  }

  // Critical urgency signals have proven edge
  if (features.urgency === 'critical') {
    score += 0.1;
  } else if (features.urgency === 'high') {
    score += 0.05;
  }

  // News events can be noisy
  if (features.signal_type === 'news_event') {
    score -= 0.05;
  }

  // Anomalous price movement needs extra caution
  if (features.is_anomalous) {
    score -= 0.05;
  }

  // Near-resolution markets can be manipulated
  if (features.is_near_resolution) {
    score -= 0.03;
  }

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, score));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Predict the probability that a signal will be correct.
 *
 * @param features Signal features extracted during generation
 * @returns Calibrated probability (0-1) that the signal will be correct
 */
export function predictSignalQuality(
  features: SignalFeatures
): SignalQualityPrediction {
  const model = loadModel();

  if (model) {
    const probability = predictWithModel(features, model);

    // Model confidence based on how far from 0.5 the prediction is
    const confidence = Math.abs(probability - 0.5) * 2;

    return {
      probability,
      confidence,
      source: 'ml_model',
      model_version: model.version,
    };
  }

  // Fallback to heuristic
  const probability = predictWithHeuristic(features);
  const confidence = 0.6; // Lower confidence for heuristic

  return {
    probability,
    confidence,
    source: 'heuristic',
  };
}

/**
 * Get the enforced minimum number of real (non-synthetic) resolved signals
 * required before the ML model can be used for live scoring.
 * Clamped to a hard floor of 50 regardless of env var.
 */
export function getMinRealSignals(): number {
  const raw = parseInt(process.env.ML_MIN_REAL_SIGNALS ?? '200', 10);
  const clamped = Math.max(50, Number.isFinite(raw) ? raw : 200);
  if (raw < 50 && Number.isFinite(raw)) {
    console.warn('[ML] ML_MIN_REAL_SIGNALS clamped to 50 — never set below 50 in production');
  }
  return clamped;
}

/**
 * Check if ML model is available.
 * Useful for conditional logic in signal generation.
 */
export function isModelAvailable(): boolean {
  return loadModel() !== null;
}

/**
 * Get model info (version, metrics, training date).
 */
export function getModelInfo(): {
  available: boolean;
  version?: string;
  trained_at?: string;
  metrics?: ModelWeights['metrics'];
} {
  const model = loadModel();

  if (!model) {
    return { available: false };
  }

  return {
    available: true,
    version: model.version,
    trained_at: model.trained_at,
    metrics: model.metrics,
  };
}

/**
 * Reload model from disk (useful after retraining).
 */
export function reloadModel(): boolean {
  cachedModel = null;
  modelLoadError = null;
  return loadModel() !== null;
}
