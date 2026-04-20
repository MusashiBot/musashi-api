# Matcher evaluation

Deterministic before/after measurement for the keyword-matcher quality gate
introduced in `src/analysis/match-quality.ts`.

## What it measures

For each tweet in `fixtures/tweets.json` we run the matcher twice — once
with the quality gate disabled (baseline) and once enabled (default
options) — against a 1,857-market snapshot in
`fixtures/markets.snapshot.json`. A match is counted as **junk** if it
satisfies any of:

| rule                | threshold                               |
|---------------------|-----------------------------------------|
| thin-market         | `volume24h < $5,000`                    |
| extreme-price       | `yesPrice < 2%` or `yesPrice > 98%`     |
| cross-domain        | `market.category ∉ tweet.expectedCategories` (non-empty) |
| weak-signal         | no phrase-match AND `confidence < 0.55` |

These are deterministic proxies for "would a bot actually execute
this?". Nothing requires manual annotation.

## How to reproduce

```bash
# 1. (optional) regenerate the market snapshot from live Polymarket + Kalshi
npx tsx scripts/matcher-eval/snapshot-markets.ts

# 2. run the eval
npx tsx scripts/matcher-eval/run-eval.ts
```

The latest numbers are persisted to `fixtures/eval-result.json` for
automation.
