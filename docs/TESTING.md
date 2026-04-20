# Testing ladder

Run checks in this order before merging API-facing changes.

## 1. Local static checks (required)

```bash
pnpm typecheck
pnpm test:ci
```

Before interviews or high-stakes demos, **`pnpm interview:check`** runs the same ladder as `test:ci` and prints concise talking points.

`test:ci` runs:

- TypeScript (`tsconfig.json` + `api/tsconfig.json`)
- `tests/unit/*.test.mjs` — pure-analysis and utility unit coverage (sentiment, entities, kelly sizing, keyword matcher, cache/rate-limit helpers)
- `tests/api/*.test.mjs` — handler-level API coverage (core, feed, markets, wallet, risk, internal/cron guards)
- [scripts/test-smoke-imports.ts](../scripts/test-smoke-imports.ts) — ensures critical modules load without optional native deps at import time
- [tests/wallet-endpoints.test.mjs](../tests/wallet-endpoints.test.mjs) — wallet-flow / smart-money handler behavior

You can also run the expanded suites directly:

```bash
pnpm test:unit   # unit-level logic tests
pnpm test:api    # API handler tests with mocked upstreams
pnpm test:all    # unit + api + wallet + smoke
```

## 2. Remote contract tests (recommended for API changes)

Hit a **deployed** or **local** API:

```bash
# Production (default in test script)
pnpm test:agent

# Local dev server (pnpm dev in another terminal)
MUSASHI_API_BASE_URL=http://127.0.0.1:3000 pnpm test:agent:local
```

Default per-request timeout is **30s** (`MUSASHI_TEST_TIMEOUT_MS`). If production cold starts or load cause curl timeouts, retry or run `MUSASHI_TEST_TIMEOUT_MS=45000 pnpm test:agent`.

### Preview deployments

Point tests at your Vercel preview URL:

```bash
export MUSASHI_API_BASE_URL="https://<preview>.vercel.app"
# If Deployment Protection is on:
export VERCEL_AUTOMATION_BYPASS_SECRET="<secret>"
pnpm test:agent
```

## 3. Performance / stress (optional)

```bash
MUSASHI_TEST_INCLUDE_PERF=1 pnpm test:agent
MUSASHI_TEST_INCLUDE_STRESS=1 pnpm test:agent
```

## 4. Performance endpoints (integration)

Requires a running API with DB:

```bash
MUSASHI_API_BASE_URL=http://127.0.0.1:3000 node --import tsx scripts/test-performance-endpoints.ts
```

If the server is unreachable, the script exits **0** after printing `SKIP` (safe for CI without a server).

## 5. CI pipeline

GitHub Actions runs `pnpm install`, `pnpm typecheck`, and `pnpm test:ci` on push/PR (see [.github/workflows/ci.yml](../.github/workflows/ci.yml)). Optional **backtest artifact** and **collect-resolutions** workflows are documented in [DEPLOYMENT.md](./DEPLOYMENT.md). SLO ideas for production metrics are in [SLO.md](./SLO.md).

How to ship or hand in the project (PR vs résumé vs email): [SUBMISSION.md](./SUBMISSION.md).
