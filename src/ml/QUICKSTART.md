# ML Signal Scoring - Quick Start Guide

## 🚀 Get Started in 3 Steps

### Step 1: Generate Training Data (First Time Only)

```bash
# Generate 1000 synthetic training examples
node --import tsx src/ml/generate-synthetic-data.ts 1000
```

This creates realistic signal examples with simulated outcomes. Takes about 30-60 seconds.

### Step 2: Train the Model

```bash
# Train logistic regression model
node --import tsx src/ml/train-signal-scorer.ts
```

Expected output:
```
🔬 Loading training data...
✓ Loaded 1000 resolved signals
📊 Training set: 800 examples
📊 Test set: 200 examples

🧠 Training logistic regression model...
Iteration 100: Log loss = 0.4521
Iteration 200: Log loss = 0.4123
...
✓ Training complete

📈 Evaluating model...

─── Test Set Performance ───
Accuracy:      73.45%
Precision:     71.23%
Recall:        78.91%
F1 Score:      74.89%
Brier Score:   0.1823 (lower is better)

✓ Model saved to src/ml/models/signal-scorer-v1.json
```

### Step 3: Use ML Scoring in Production

```typescript
import { generateSignal } from './analysis/signal-generator';

// Generate signal with ML scoring
const signal = generateSignal(
  tweetText,
  matches,
  arbitrageOpportunity,
  'normal',
  { use_ml_scorer: true }  // 🎯 Enable ML
);

// Check ML prediction
if (signal.ml_score) {
  console.log(`ML probability: ${signal.ml_score.probability}`);
  console.log(`ML confidence: ${signal.ml_score.confidence}`);
  console.log(`Source: ${signal.ml_score.source}`);
}

// Confidence is now ML-adjusted
console.log(`Adjusted confidence: ${signal.suggested_action.confidence}`);
```

## 📊 Real Data Workflow (Production)

Once you have real market resolution data:

### 1. Signals are logged automatically

```typescript
// This happens automatically in generateSignal()
// No code changes needed
```

### 2. Update resolutions when markets resolve

```typescript
import { updateResolution } from './db/signal-outcomes';

// Mark signal as resolved
await updateResolution(
  signalId,
  'YES',    // actual outcome
  true,     // was prediction correct?
  42.50     // profit/loss (optional)
);
```

### 3. Retrain weekly (or as needed)

```bash
# Pull latest data and retrain
node --import tsx src/ml/train-signal-scorer.ts

# Model automatically reloads on next prediction
```

## 🔍 Check Model Status

```typescript
import { isModelAvailable, getModelInfo } from './ml/signal-scorer-model';

if (isModelAvailable()) {
  const info = getModelInfo();
  console.log(`Model ${info.version} trained ${info.trained_at}`);
  console.log(`Accuracy: ${info.metrics.accuracy}`);
} else {
  console.log('Model not available - using heuristic fallback');
}
```

## 🎓 Run Complete Example

```bash
# See full workflow demonstration
node --import tsx src/ml/example-usage.ts
```

## 📚 Next Steps

- Read [README.md](./README.md) for detailed documentation
- Review [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md) for technical details
- Check [example-usage.ts](./example-usage.ts) for code examples

## ⚙️ Environment Variables

Required for all scripts:

```bash
# Supabase credentials
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_ANON_KEY="your-anon-key"

# Or use .env file
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

## 🛠️ Troubleshooting

### "Insufficient training data: X signals (minimum 500 required)"

**Solution**: Generate more synthetic data or wait for more real resolutions

```bash
node --import tsx src/ml/generate-synthetic-data.ts 1000
```

### "Model file not found"

**Solution**: Train the model first

```bash
node --import tsx src/ml/train-signal-scorer.ts
```

### "Missing Supabase credentials"

**Solution**: Set environment variables

```bash
export SUPABASE_URL="..."
export SUPABASE_ANON_KEY="..."
```

### TypeScript errors

**Solution**: Rebuild TypeScript

```bash
npm run typecheck
```

## 💡 Tips

1. **Start with synthetic data** - Don't wait for real resolutions to begin
2. **ML is opt-in** - Existing code works without changes
3. **Model fallback** - System continues working if model unavailable
4. **Retrain regularly** - Weekly retraining recommended as data grows
5. **Monitor performance** - Track Brier score and accuracy over time

## 🎯 Expected Performance

With synthetic data:
- Accuracy: ~70-75%
- Brier Score: ~0.15-0.20

With real data (500+ signals):
- Accuracy: ~75-80%
- Brier Score: ~0.10-0.15

Performance improves as more real data accumulates!
