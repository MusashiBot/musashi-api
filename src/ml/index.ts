// ML Signal Scoring — Public API
//
// This module provides machine learning-based signal quality prediction
// for the Musashi prediction market trading system.

// ─── Model Training ───────────────────────────────────────────────────────────
export { trainModel, ModelWeights } from './train-signal-scorer';

// ─── Model Inference ──────────────────────────────────────────────────────────
export {
  predictSignalQuality,
  isModelAvailable,
  getModelInfo,
  reloadModel,
  SignalFeatures,
  SignalQualityPrediction,
} from './signal-scorer-model';

// ─── Synthetic Data Generation ────────────────────────────────────────────────
export { generateSyntheticData } from './generate-synthetic-data';
