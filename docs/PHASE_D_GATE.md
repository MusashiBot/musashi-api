# Phase D — gate before committing

Phase D (execution layer, custody, institutional reliability) should **not** start until:

1. **Evidence loop works** — signals resolve into `signal_outcomes`, metrics and backtests run on schedule ([Phase B](./SLO.md)).
2. **Legal / product sign-off** — prediction-market execution varies by jurisdiction; custody and liability need explicit ownership.
3. **Separate service boundary** — authenticated trading keys and wallet flows rarely belong on the same serverless surface as read-heavy intelligence APIs.

Until then, document APIs as **research and screening only**, not order placement.
