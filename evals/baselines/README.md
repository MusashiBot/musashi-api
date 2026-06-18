# Eval baselines

Committed metric snapshots the runner diffs against to catch regressions, one
file per matcher variant, e.g.:

- `arbitrage.dev.keyword-overlap.json`
- `arbitrage.dev.bm25.json`

Per-variant files mean a regression in one implementation can't be masked by an
improvement in another.
