# Arbitrage holdout fixtures

`holdout.jsonl` lives here (JSONL, one fixture per line, conforming to
`../schema.json`).

**Frozen set — do not iterate against it.** This split exists to detect
overfitting to `../dev.jsonl`. Run it manually/periodically (and before merging
changes to matching logic), not on every CI run. If `dev` improves but `holdout`
regresses, that's the overfitting signal.
