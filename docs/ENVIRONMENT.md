# Environment variables

Single reference for runtime configuration. Values are read at process start on serverless (set in Vercel Project Settings).

## Required for core API

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Supabase project URL (`NEXT_PUBLIC_SUPABASE_URL` is also accepted where noted in code). |
| `SUPABASE_ANON_KEY` | Public anon key for client-safe reads/writes allowed by RLS. |

## Optional — extended features

| Variable | Default | Purpose |
|----------|---------|---------|
| `SUPABASE_SERVICE_KEY` | — | Service role key for batch jobs (`collect-resolutions`) and admin-style updates. Prefer restricted roles in production. |
| `INTERNAL_API_KEY` | — | Bearer/API key for `POST /api/internal/resolve-market`. |
| `KV_REST_API_URL` | — | Upstash / Vercel KV REST URL for movers price history. |
| `KV_REST_API_TOKEN` | — | KV token. Without KV, code falls back to in-memory store (dev only). |

`GET /api/metrics/performance` uses the same Supabase URL variables plus **`SUPABASE_SERVICE_KEY`** or **`SUPABASE_ANON_KEY`** (each with `NEXT_PUBLIC_*` aliases where applicable) to aggregate `signal_outcomes`.

## Market cache & arbitrage

| Variable | Default | Purpose |
|----------|---------|---------|
| `MARKET_CACHE_TTL_SECONDS` | `20` | How long unified market list stays in memory. |
| `ARBITRAGE_CACHE_TTL_SECONDS` | `15` | TTL for recomputing arbitrage scan over cached markets. |
| `MUSASHI_POLYMARKET_TARGET_COUNT` | `1200` | Target Polymarket markets to fetch (pagination). |
| `MUSASHI_POLYMARKET_MAX_PAGES` | `20` | Max pagination pages for Polymarket. |
| `MUSASHI_KALSHI_TARGET_COUNT` | `1000` | Target Kalshi markets. |
| `MUSASHI_KALSHI_MAX_PAGES` | `20` | Max pagination pages for Kalshi. |

## Real-time Polymarket WebSocket

| Variable | Default | Purpose |
|----------|---------|---------|
| `MUSASHI_POLYMARKET_WS` | unset (off) | Set to `1` to enable outbound WebSocket to Polymarket CLOB for fresher YES prices. **Off** in CI/tests by default to avoid surprise network I/O. |

## Semantic arbitrage matching

| Variable | Default | Purpose |
|----------|---------|---------|
| `MUSASHI_DISABLE_SEMANTIC_MATCHING` | unset | Set to `1` to skip transformer embeddings and use **text/synonym fallback only** — faster cold starts and no `sharp`/model download on cold paths. |

## Risk session endpoint

| Variable | Default | Purpose |
|----------|---------|---------|
| `RISK_CAUTION_THRESHOLD` | `-0.05` | Session P&amp;L fraction triggering **caution** throttle. |
| `RISK_HALT_THRESHOLD` | `-0.10` | Session P&amp;L fraction triggering **halt**. |
| `ALLOWED_ORIGIN` | — | **Required in production.** The exact origin of your frontend (e.g. `https://app.yoursite.com`). Omitting this in production causes the server to refuse requests with a 500. Falls back to `*` outside production. |
| `RISK_RATE_LIMIT` | `30` | Per-IP requests/min for `/api/risk/session`. |

## Rate limiting (application layer)

Per-instance sliding window; use Vercel Firewall / Upstash for global limits at scale.

| Variable | Default | Purpose |
|----------|---------|---------|
| `MUSASHI_ANALYZE_TEXT_RATE_LIMIT_PER_MIN` | `120` | Max POSTs to `/api/analyze-text` per client IP per minute. Set `0` to disable. |
| `MUSASHI_ARBITRAGE_RATE_LIMIT_PER_MIN` | `90` | Max GETs to `/api/markets/arbitrage` per client IP per minute. Set `0` to disable. |

## ML shadow / diagnostics

| Variable | Default | Purpose |
|----------|---------|---------|
| `MUSASHI_ML_SHADOW` | unset | Set to `1` to compute ML score alongside rule-based signal **without** changing suggested action confidence (comparison for training). |
| `MUSASHI_ML_ENABLED` | unset | Set to `true` to activate ML-based confidence adjustment in signal generation. Requires `MUSASHI_ML_SHADOW` validation first. |
| `ML_MIN_REAL_SIGNALS` | `200` | Minimum non-synthetic resolved signals required before ML scorer is trusted. Hard floor of **50** — values below are clamped with a warning. |

## Resolution collector batch job

| Variable | Default | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | — | Accepted alias for Supabase URL in `collect-resolutions.ts`. Prefer `SUPABASE_URL` everywhere new. |
| `COLLECT_RESOLUTIONS_FAIL_ON_ERROR` | unset | Set to `1` to exit non‑zero if any row update fails (strict CI). |

## Testing / remote contract tests

| Variable | Default | Purpose |
|----------|---------|---------|
| `MUSASHI_API_BASE_URL` | `https://musashi-api.vercel.app` | Target for `pnpm test:agent` — set to preview deployment or `http://127.0.0.1:3000` for local. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | — | Preview deployment protection bypass header for automated tests. |

See [TESTING.md](./TESTING.md) for the full test ladder.
