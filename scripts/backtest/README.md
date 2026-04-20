# Signal-pipeline backtest

Monte Carlo backtest of the end-to-end signal pipeline
(`matcher → sentiment → signal → edge`) with calibration-sensitivity
analysis. Answers two questions a bot developer cares about:

1. **Does the sizing math actually help?** Compare KELLY, FLAT, RANDOM
   over the same signal stream.
2. **What happens when the signals are wrong?** Vary calibration from
   0.0 (signals are noise) to 1.0 (signals are perfectly calibrated)
   and watch return + Sharpe degrade gracefully — Kelly should under-
   perform FLAT at low calibration and over-perform at high.

## Method

* Corpus: the same 30 tweets used by the matcher eval × the same 1,857
  market snapshot.
* Per tweet → take the top non-HOLD signal (if any) with positive
  `ev_per_dollar`.
* Only trade signals on markets priced in `[0.10, 0.90]` with 24h
  volume ≥ $25k. Penny markets are theoretically +EV but not
  executable at any realistic size.
* 500 replications per strategy, RNG seeded for reproducibility.
* Kelly stake = `min(kellyFraction, 10%) × min(current, 2 × starting)
  bankroll` — the "fixed-fraction-of-peak" cap real desks use so a
  lucky streak doesn't size subsequent trades past book depth.
* Fees and adverse-execution slippage priced via `src/analysis/fees.ts`.

## How to reproduce

```bash
# Requires the market snapshot from scripts/matcher-eval
npx tsx scripts/matcher-eval/snapshot-markets.ts    # optional, regenerate
npx tsx scripts/backtest/run-backtest.ts
```

Results are persisted to `fixtures/result.json`.
