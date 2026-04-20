# Arbitrage realism & scalability

## Mid-price vs executable edge

[`src/api/arbitrage-detector.ts`](../src/api/arbitrage-detector.ts) compares venue **YES mid prices** from unified market polling. Mid vs mid **overstates** edge when spreads are wide or depth is thin.

Liquidity-adjusted **`net_spread`** subtracts a volume-tier penalty — a conservative proxy for bid/ask friction, not a live order book.

For **Polymarket**, [`src/api/polymarket-price-poller.ts`](../src/api/polymarket-price-poller.ts) exposes CLOB **`getOrderBookForMarket` / bid-ask** when you need true spread and depth for a token. Future work: thread best bid/ask into the unified `Market` object when latency budget allows.

**Kalshi** executable prices may require authenticated book endpoints — keep mid-based arbs labeled as screening, not guarantees.

## Semantic scan cost

Full pairing is **O(n²)** in platform sizes. Mitigations:

- **`MUSASHI_DISABLE_SEMANTIC_MATCHING=1`** — synonym/keyword fallback only (faster, no transformers).
- **Blocking** — same category / time window / reduced candidate lists (roadmap).
- **Embedding index** — batch embeddings + ANN retrieval (roadmap).

## Optional WebSocket

When **`MUSASHI_POLYMARKET_WS=1`**, fresher YES prints are possible but require **subscription management**, **backpressure**, and schema drift tolerance — treat as experimental until conformance tests exist. See [WS_STRATEGY.md](./WS_STRATEGY.md).
