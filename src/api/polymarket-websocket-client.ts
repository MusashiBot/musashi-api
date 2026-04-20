/**
 * Polymarket WebSocket Client
 *
 * Connects to Polymarket's CLOB WebSocket API for real-time price updates.
 * Maintains an in-memory orderbook snapshot with automatic reconnection.
 *
 * WebSocket API: wss://ws-subscriptions-clob.polymarket.com/ws/market
 */

import { WebSocket, RawData } from 'ws';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const RECONNECT_DELAY = 5000; // 5 seconds
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * WebSocket is opt-in. Without this flag, no outbound WS connection is made.
 * This keeps unit tests, CI, and serverless cold-starts free of surprise network I/O
 * (and avoids noisy parse errors from non-JSON server handshakes).
 */
function isPolyWebSocketEnabled(): boolean {
  return process.env.MUSASHI_POLYMARKET_WS === '1';
}

// WebSocket ready states
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

/**
 * WebSocket message types
 */
interface WSPriceUpdate {
  market: string; // token_id
  event_type: 'price_change' | 'book_update';
  price?: string; // Current price (0-1)
  bid?: string; // Best bid price
  ask?: string; // Best ask price
  timestamp: number;
}

interface WSSubscribeMessage {
  type: 'subscribe';
  markets: string[];
}

interface WSHeartbeatMessage {
  type: 'ping';
}

/**
 * In-memory orderbook snapshot for a single market
 */
interface OrderBookSnapshot {
  tokenId: string;
  price: number; // Mid price
  bid: number;
  ask: number;
  spread: number;
  timestamp: number;
  lastUpdated: Date;
}

/**
 * WebSocket client state
 */
class PolymarketWebSocketClient {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  
  // In-memory orderbook: tokenId -> snapshot
  private orderbooks: Map<string, OrderBookSnapshot> = new Map();
  
  // Markets to subscribe to (token IDs)
  private subscribedMarkets: Set<string> = new Set();

  constructor() {
    // Connection is started lazily via ensureStarted() — never auto-connect here.
  }

  /** Establish the outbound WebSocket (idempotent). */
  public ensureStarted(): void {
    this.connect();
  }

  /**
   * Connect to WebSocket API
   */
  private connect(): void {
    if (this.ws && (this.ws.readyState === WS_CONNECTING || this.ws.readyState === WS_OPEN)) {
      console.log('[Polymarket WS] Already connected or connecting');
      return;
    }

    console.log('[Polymarket WS] Connecting to', WS_URL);

    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('error', (error) => this.handleError(error));
      this.ws.on('close', () => this.handleClose());
    } catch (error) {
      console.error('[Polymarket WS] Connection error:', error);
      this.scheduleReconnect();
    }
  }

  /**
   * Handle WebSocket open event
   */
  private handleOpen(): void {
    console.log('[Polymarket WS] Connected successfully');
    this.isConnected = true;
    this.reconnectAttempts = 0;

    // Start heartbeat
    this.startHeartbeat();

    // Resubscribe to markets if any
    if (this.subscribedMarkets.size > 0) {
      this.subscribeToMarkets(Array.from(this.subscribedMarkets));
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: RawData): void {
    const raw = data.toString().trim();
    if (!raw.startsWith('{') && !raw.startsWith('[')) {
      // Server may send plain-text errors (e.g. "INVALID OPERATION"); ignore quietly.
      return;
    }
    try {
      const message = JSON.parse(raw) as WSPriceUpdate;

      if (message.event_type === 'price_change' || message.event_type === 'book_update') {
        this.updateOrderBook(message);
      }
    } catch {
      // Malformed JSON — ignore (do not spam logs / stack traces)
    }
  }

  /**
   * Update in-memory orderbook from WebSocket message
   */
  private updateOrderBook(message: WSPriceUpdate): void {
    const tokenId = message.market;
    const now = Date.now();

    // Parse prices
    const price = message.price ? parseFloat(message.price) : null;
    const bid = message.bid ? parseFloat(message.bid) : null;
    const ask = message.ask ? parseFloat(message.ask) : null;

    // Calculate mid price and spread
    let midPrice: number;
    let bidPrice: number;
    let askPrice: number;

    if (bid !== null && ask !== null) {
      midPrice = (bid + ask) / 2;
      bidPrice = bid;
      askPrice = ask;
    } else if (price !== null) {
      // If only price is provided, use it as mid and estimate bid/ask
      midPrice = price;
      bidPrice = price - 0.005; // Estimate 0.5% spread
      askPrice = price + 0.005;
    } else {
      // No price data, skip update
      return;
    }

    const spread = askPrice - bidPrice;

    // Update snapshot
    const snapshot: OrderBookSnapshot = {
      tokenId,
      price: midPrice,
      bid: bidPrice,
      ask: askPrice,
      spread,
      timestamp: message.timestamp || now,
      lastUpdated: new Date(),
    };

    this.orderbooks.set(tokenId, snapshot);
  }

  /**
   * Handle WebSocket errors
   */
  private handleError(error: Error): void {
    console.error('[Polymarket WS] Error:', error.message);
  }

  /**
   * Handle WebSocket close event
   */
  private handleClose(): void {
    console.log('[Polymarket WS] Connection closed');
    this.isConnected = false;
    this.stopHeartbeat();

    // Schedule reconnect
    this.scheduleReconnect();
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    this.stopHeartbeat(); // Clear any existing timer

    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WS_OPEN) {
        const ping: WSHeartbeatMessage = { type: 'ping' };
        this.ws.send(JSON.stringify(ping));
      }
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Stop heartbeat timer
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('[Polymarket WS] Max reconnect attempts reached, giving up');
      return;
    }

    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    this.reconnectAttempts++;
    const delay = RECONNECT_DELAY * this.reconnectAttempts;

    console.log(`[Polymarket WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Subscribe to market updates for given token IDs
   */
  public subscribeToMarkets(tokenIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      console.warn('[Polymarket WS] Not connected, queuing subscription');
      tokenIds.forEach(id => this.subscribedMarkets.add(id));
      return;
    }

    const message: WSSubscribeMessage = {
      type: 'subscribe',
      markets: tokenIds,
    };

    this.ws.send(JSON.stringify(message));
    tokenIds.forEach(id => this.subscribedMarkets.add(id));

    console.log(`[Polymarket WS] Subscribed to ${tokenIds.length} markets`);
  }

  /**
   * Get current orderbook snapshot for a token
   * @param tokenId - Polymarket numeric token ID
   * @param maxAgeMs - Maximum age of snapshot in milliseconds (default: 5000ms)
   * @returns OrderBook snapshot or null if not available or stale
   */
  public getOrderBook(tokenId: string, maxAgeMs: number = 5000): OrderBookSnapshot | null {
    const snapshot = this.orderbooks.get(tokenId);

    if (!snapshot) {
      return null;
    }

    // Check if snapshot is fresh
    const age = Date.now() - snapshot.lastUpdated.getTime();
    if (age > maxAgeMs) {
      return null; // Stale data
    }

    return snapshot;
  }

  /**
   * Get current price for a token
   * @param tokenId - Polymarket numeric token ID
   * @param maxAgeMs - Maximum age of price in milliseconds (default: 5000ms)
   * @returns Price or null if not available or stale
   */
  public getPrice(tokenId: string, maxAgeMs: number = 5000): number | null {
    const snapshot = this.getOrderBook(tokenId, maxAgeMs);
    return snapshot ? snapshot.price : null;
  }

  /**
   * Check if WebSocket is connected
   */
  public isWsConnected(): boolean {
    return this.isConnected && this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  /**
   * Get all cached orderbooks
   */
  public getAllOrderBooks(): Map<string, OrderBookSnapshot> {
    return new Map(this.orderbooks);
  }

  /**
   * Disconnect and cleanup
   */
  public disconnect(): void {
    console.log('[Polymarket WS] Disconnecting...');

    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WS_OPEN || this.ws.readyState === WS_CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.orderbooks.clear();
    this.subscribedMarkets.clear();
  }
}

// Singleton instance
let wsClient: PolymarketWebSocketClient | null = null;

/**
 * Get WebSocket client singleton when the feature flag is enabled.
 *
 * Note for Vercel/serverless: this singleton only lives for the lifetime of a
 * single invocation container. Cold starts reset module state, so this improves
 * latency only for warm invocations and should not be treated as a durable
 * always-on feed. For durable WS ingestion, run a persistent worker/service.
 */
function getWSClient(): PolymarketWebSocketClient | null {
  if (!isPolyWebSocketEnabled()) {
    return null;
  }
  if (!wsClient) {
    wsClient = new PolymarketWebSocketClient();
    wsClient.ensureStarted();
  }
  return wsClient;
}

/**
 * Get WebSocket prices for given token IDs
 * @param tokenIds - Array of Polymarket numeric token IDs
 * @returns Map of tokenId -> price (only includes fresh prices)
 */
export function getWebSocketPrices(tokenIds: string[]): Map<string, number> {
  const client = getWSClient();
  const prices = new Map<string, number>();
  if (!client) {
    return prices;
  }

  // Ensure markets are subscribed
  client.subscribeToMarkets(tokenIds);

  // Collect fresh prices
  for (const tokenId of tokenIds) {
    const price = client.getPrice(tokenId);
    if (price !== null) {
      prices.set(tokenId, price);
    }
  }

  return prices;
}

/**
 * Get orderbook snapshot for a token ID
 * @param tokenId - Polymarket numeric token ID
 * @param maxAgeMs - Maximum age of snapshot (default: 5000ms)
 * @returns OrderBook snapshot or null if not available
 */
export function getWebSocketOrderBook(
  tokenId: string,
  maxAgeMs: number = 5000
): OrderBookSnapshot | null {
  const client = getWSClient();
  if (!client) {
    return null;
  }
  client.subscribeToMarkets([tokenId]);
  return client.getOrderBook(tokenId, maxAgeMs);
}

/**
 * Check if WebSocket is connected and operational
 */
export function isWebSocketConnected(): boolean {
  const client = getWSClient();
  return client !== null && client.isWsConnected();
}

/**
 * Get all cached orderbooks from WebSocket
 */
export function getAllWebSocketOrderBooks(): Map<string, OrderBookSnapshot> {
  const client = getWSClient();
  return client ? client.getAllOrderBooks() : new Map();
}

/**
 * Disconnect WebSocket client (for testing/shutdown)
 */
export function disconnectWebSocket(): void {
  if (wsClient) {
    wsClient.disconnect();
    wsClient = null;
  }
}

/**
 * Export OrderBookSnapshot type for consumers
 */
export type { OrderBookSnapshot };
