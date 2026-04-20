# Portfolio-level risk (beyond session)

[`api/risk/session.ts`](../api/risk/session.ts) applies **client-reported** daily P&amp;L against `RISK_CAUTION_THRESHOLD` / `RISK_HALT_THRESHOLD`. That is appropriate when the bot owns state client-side.

## Server-side positions

If you ever persist user positions or balances on the server:

- Treat as **highly sensitive** — consent, retention limits, and access audit requirements apply.
- A **server-side journal** can enforce caps that session-only APIs cannot (e.g. gross exposure across markets).

## Correlation-aware caps (client or server)

Related markets (same underlying event, nested strikes) can breach nominal per-market limits while staying under naive totals. Mitigations:

- Bucket exposure by **normalized topic / event cluster** (manual mapping or embeddings).
- Cap **sum of Kelly fractions** across correlated buckets, not only per ticket.

Until product requires it, keep portfolio logic in **bot configuration** and document assumptions in bot runbooks rather than expanding API scope prematurely.
