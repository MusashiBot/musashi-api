# Matcher Eval Fixtures

Frozen test data for the matcher evaluation harness ([scripts/eval-matcher.ts](../eval-matcher.ts)).

These files exist so that running the eval gives the same numbers every time, regardless of when you run it. Live Polymarket/Kalshi data changes constantly — markets close, prices move, new markets appear — so the eval deliberately uses a snapshot pinned to a specific date.

## Setup

The keyword-matcher eval runs with no extra setup.

The embedding-matcher eval (`--matcher=embedding` or `--matcher=compare`) requires a Gemini API key. Get a free-tier key at [aistudio.google.com](https://aistudio.google.com) and add it to `.env.local` at the project root:

```
GEMINI_API_KEY=your-key-here
```

The same key is needed if you regenerate `markets-embeddings-{date}.json` via `scripts/embed-markets.ts`.

## Files

| File | What it is | Regenerate with |
|---|---|---|
| `markets-snapshot-{date}.json` | ~100–150 markets pulled from the hosted Musashi API, manually curated for category coverage and edge cases. | `pnpm tsx scripts/snapshot-markets.ts` (then trim by hand) |
| `dataset-{date}.jsonl` | Labeled `(tweet, expected_market_ids[])` pairs. 50 real tweets pulled from `/api/feed` + 100 hand-written synthetic ones. | Hand-built. See dataset format in eval-matcher.ts. |
| `markets-embeddings-{date}.json` | Gemini `gemini-embedding-001` vectors (3072-dim) for each market in the snapshot. Cached so we don't re-embed on every eval run. | `pnpm tsx scripts/embed-markets.ts` (needs `GEMINI_API_KEY`) |
| `tweets-embeddings-{date}.json` | Cached tweet embeddings created on the fly by the eval. Reused across runs so re-runs hit the cache instead of calling Gemini again. | Auto-generated on first `--matcher=embedding` run. |

## Versioning

The `{date}` suffix is the date the file was generated (e.g. `markets-snapshot-2026-06-01.json`). The snapshot and dataset are created as a pair — the dataset's `expected_market_ids` must reference markets that exist in the matching snapshot. If you refresh one, refresh the other.

## Don't

- Don't replace these with live API calls — the whole point is reproducibility.
- Don't edit the embeddings file by hand — it's generated.
- Don't reuse a dataset across mismatched snapshot dates.
