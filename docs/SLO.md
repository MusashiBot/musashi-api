# Service objectives (dashboard backend)

Operational targets using [`api/metrics/performance.ts`](../api/metrics/performance.ts) and logs. Tune after you have **steady resolution ingestion** into `signal_outcomes`.

## Availability & latency

| Metric | Target | Notes |
|--------|--------|-------|
| Health (`GET /api/health`) | HTTP 200 when upstream feeds respond | Degraded when Polymarket or Kalshi fetch fails |
| Analyze-text (`POST /api/analyze-text`) | p95 &lt; 8s cold, &lt; 3s warm | Dominated by market fetch + optional transformer cold start |
| Arbitrage (`GET /api/markets/arbitrage`) | p95 &lt; 10s cold | Full cross-product scan when semantic matching is enabled |

Measure with `MUSASHI_TEST_INCLUDE_PERF=1 pnpm test:agent` or your APM.

## Resolution coverage

| Metric | Target | Notes |
|--------|--------|--------|
| % signals with `outcome` within 14 days of market resolution | Rising week over week | Run [`scripts/ml/collect-resolutions.ts`](../scripts/ml/collect-resolutions.ts) on a schedule |
| Unresolved backlog | Stable or shrinking | Query `signal_outcomes` where `outcome IS NULL` |

## Quality (after enough labeled rows)

| Metric | Target | Notes |
|--------|--------|--------|
| Brier score | Down over rolling windows | Logistic model + calibration (see [ML_CALIBRATION.md](./ML_CALIBRATION.md)) |
| Win rate vs confidence bucket | Monotone (high-confidence buckets win more) | Use backtest calibration tables |

## Cache efficiency

| Metric | Target | Notes |
|--------|--------|--------|
| Market-cache age | Within `MARKET_CACHE_TTL_SECONDS` | Surfaced in analyze-text metadata |
| KV-backed movers coverage | Enough history for replay | Optional `KV_REST_*` |

See [DEPLOYMENT.md](./DEPLOYMENT.md) for migrations and cron wiring.
