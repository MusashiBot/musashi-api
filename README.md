# musashi-api

`musashi-api` is the standalone backend repository for Musashi.

It keeps the shared prediction-market intelligence stack that used to live inside the monolithic `Musashi/` project:

- REST API handlers in [`api/`](./api)
- Analysis pipeline in [`src/analysis/`](./src/analysis)
- Market/Twitter clients in [`src/api/`](./src/api)
- SDK client in [`src/sdk/`](./src/sdk)
- Supabase schema and the auxiliary backend server in [`server/`](./server)

## Goal

This repo is the source of truth for shared functionality. Consumers should call this API instead of importing code from legacy monolith paths.

## Interview narrative (keep it honest)

No project **guarantees** an internship—recruiters also weigh timing, referrals, and how you communicate. This repo **does** give you concrete talking points many candidates lack: production-style API wiring, explicit feature flags, a **closed-loop ML story** (log → resolve → measure → backtest), and honest limits (mid-price vs executable edge, serverless constraints).

Before a call, run **`pnpm interview:check`** (same checks as CI plus pitch prompts). In production, **`GET /api/health`** includes **`operational_readiness`** booleans derived from env (Supabase, KV, internal routes) so you can show configuration discipline without opening the dashboard.

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Local API shim on `http://127.0.0.1:3000` |
| `pnpm backend:dev` | Supabase-backed auxiliary backend from [`server/api-server.mjs`](./server/api-server.mjs) |
| `pnpm test:agent` | Contract/smoke tests against production URL (`MUSASHI_API_BASE_URL` overrides — preview or local) |
| `pnpm test:agent:local` | Same suite against `http://127.0.0.1:3000` |
| `pnpm test:ci` | **Required ladder:** typecheck + smoke imports + wallet tests |
| `pnpm typecheck` | Core sources + Vercel API handlers |
| `pnpm collect:resolutions` | Batch-update `signal_outcomes` from venue resolutions ([`scripts/ml/collect-resolutions.ts`](./scripts/ml/collect-resolutions.ts)) |
| `pnpm ci:backtest` | Writes `reports/BACKTEST_REPORT.md` (needs Supabase env; see [`scripts/backtest/run-backtest.ts`](./scripts/backtest/run-backtest.ts)) |
| `pnpm interview:check` | Runs `test:ci` then prints interview talking points ([`scripts/interview-ready.ts`](./scripts/interview-ready.ts)) |

## Environment & deployment

- **Full flag matrix:** [`docs/ENVIRONMENT.md`](./docs/ENVIRONMENT.md)
- **Deploy checklist (Supabase migrations, Vercel secrets):** [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md)
- **Testing ladder & preview URLs:** [`docs/TESTING.md`](./docs/TESTING.md)
- **`sharp` / transformers troubleshooting:** [`docs/NATIVE_DEPS.md`](./docs/NATIVE_DEPS.md)
- **Polymarket WS operations (top-N, backpressure):** [`docs/WS_STRATEGY.md`](./docs/WS_STRATEGY.md)
- **Portfolio / correlation risk (beyond session API):** [`docs/PORTFOLIO_RISK.md`](./docs/PORTFOLIO_RISK.md)

Key toggles: `MUSASHI_POLYMARKET_WS`, cache TTLs (`MARKET_CACHE_TTL_SECONDS`, `ARBITRAGE_CACHE_TTL_SECONDS`), risk thresholds (`RISK_CAUTION_THRESHOLD`, `RISK_HALT_THRESHOLD`), `MUSASHI_DISABLE_SEMANTIC_MATCHING`, `MUSASHI_ML_SHADOW`.

## Notes

- Historical reference docs remain in `*.upstream.md` files where present.
- `vercel.json` routes must stay aligned with handlers under [`api/`](./api); [`api/health.ts`](./api/health.ts) summarizes supported endpoints.

## Submitting / shipping

- **PR vs email, applications, course hand-in:** [`docs/SUBMISSION.md`](./docs/SUBMISSION.md)
