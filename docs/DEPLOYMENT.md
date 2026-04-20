# Deployment checklist

## 1. Supabase schema

Apply migrations from [supabase/migrations/](../supabase/migrations/) in order:

```bash
# From repo root, with Supabase CLI linked to your project
supabase db push
```

Minimum tables for ML/metrics paths:

- `20260226000000_initial_schema.sql` — core app tables
- `20260418000000_signal_outcomes.sql` — signal logging and resolutions

Verify in Supabase SQL editor:

```sql
select count(*) from signal_outcomes;
```

## 2. Vercel environment variables

Configure in **Project → Settings → Environment Variables** (Production + Preview as needed):

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- Optional: `SUPABASE_SERVICE_KEY` (only if you run batch jobs against the same project — lock down RLS policies)
- Optional: `INTERNAL_API_KEY` for `/api/internal/resolve-market`
- Optional: `KV_REST_API_URL`, `KV_REST_API_TOKEN` for persistent movers history
- Optional feature flags — see [ENVIRONMENT.md](./ENVIRONMENT.md)

## 3. Install command

The project uses `pnpm install --frozen-lockfile` ([vercel.json](../vercel.json)). Native optional dependencies (`sharp` pulled in by `@xenova/transformers` when semantic matching runs) require **install scripts enabled** on the build image. If builds fail on `sharp`, see [NATIVE_DEPS.md](./NATIVE_DEPS.md).

## 4. Cron (optional)

[vercel.json](../vercel.json) defines a cron for `/api/cron/collect-tweets`. Add a separate scheduled invocation for `collect-resolutions` via:

- External cron hitting a secured route you add, or
- GitHub Actions running `pnpm collect:resolutions` with secrets

Do not expose `SUPABASE_SERVICE_KEY` to the browser.

## 5. Post-deploy verification

```bash
curl -sS "$DEPLOY_URL/api/health" | jq .
pnpm test:agent   # set MUSASHI_API_BASE_URL to the deployment URL
```

## 6. Preview branches

For PR previews, set:

```bash
export MUSASHI_API_BASE_URL="https://your-preview.vercel.app"
export VERCEL_AUTOMATION_BYPASS_SECRET="..."  # if protection enabled
pnpm test:agent
```

## 7. GitHub Actions (optional automation)

Starter workflows live under [.github/workflows/](../.github/workflows/):

| Workflow | Purpose |
|----------|---------|
| `ci.yml` | `pnpm typecheck` + `pnpm test:ci` on every push/PR |
| `backtest-report.yml` | **workflow_dispatch** — runs `pnpm ci:backtest` and uploads `reports/BACKTEST_REPORT.md` (requires `SUPABASE_URL` + `SUPABASE_ANON_KEY` secrets) |
| `collect-resolutions.yml` | **workflow_dispatch** — runs `pnpm collect:resolutions` (requires `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`) |

Configure repository **Secrets** before enabling scheduled runs. Resolution collection should stay **idempotent**: the script only updates rows where `outcome IS NULL`.
