# ML calibration roadmap

When enough resolved rows exist in `signal_outcomes`, improve probability quality **offline** before changing production defaults.

## Steps

1. **Time-based splits** — train on older windows, validate on newer markets (avoid leakage from overlapping titles).
2. **Platt scaling or isotonic regression** — map raw model scores to calibrated probabilities on the validation fold.
3. **Shadow comparison** — keep `MUSASHI_ML_SHADOW=1` while comparing rule-based vs ML buckets against realized outcomes.
4. **Flip defaults only after** — lower Brier score vs baseline on held-out dates and stable bucket calibration.

Training scripts live under [`src/ml/`](../src/ml/). Model weights path is consumed by [`src/ml/signal-scorer-model.ts`](../src/ml/signal-scorer-model.ts).
