# Polymarket WebSocket — operational strategy

Enable with **`MUSASHI_POLYMARKET_WS=1`**. Implementation: [`src/api/polymarket-websocket-client.ts`](../src/api/polymarket-websocket-client.ts). Deeper file-level notes: [`REAL_TIME_IMPLEMENTATION.md`](../REAL_TIME_IMPLEMENTATION.md).

## Production checklist

1. **Subscription budget** — Subscribe only to **top-N** markets by volume or those referenced by active bots; unbounded token lists will overwhelm memory and outbound bandwidth on serverless.
2. **Backpressure** — If inbound message rate exceeds processing, drop stale book updates before serving (your client already tracks freshness; expose max age in bot logic).
3. **Schema conformance** — Polymarket may add message shapes; tolerate unknown fields and log parse failures at debug level (avoid failing the whole connection on one bad frame).
4. **Fail open** — [`polymarket-price-poller.ts`](../src/api/polymarket-price-poller.ts) REST fallbacks remain the reliability baseline when WS is disabled or degraded.

## Cost / ops

WebSocket is **off by default** so CI and cold paths stay predictable. Enable in prod only when latency-sensitive paths justify the connection and monitoring.
