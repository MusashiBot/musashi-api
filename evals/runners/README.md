# Eval runners

- `arbitrage.ts` (to come) — deterministic, fixture-only runner. Scores one or
  more **named** matcher functions against `../data/arbitrage/dev.jsonl` and
  diffs results against `../baselines/`. This is the **required CI check**.
  Matchers are pluggable so existing and new implementations (e.g. the current
  `areMarketsSimilar` vs a BM25 variant) are scored side by side over identical
  inputs; the runner regenerates keywords via the real keyword generator and
  treats `minConfidence` as a sweepable parameter.
- `arbitrage.live.ts` (to come) — hits the live API/DB. **Manual only**, never
  in the required CI check.

`uncertain`-labeled pairs are excluded from precision/recall and reported
separately (watchlist / abstention).
