/**
 * WebSocket Service for Real-time Updates
 * Connects to the Musashi API backend for streaming market data
 */

export type WSEventType = 'connect' | 'disconnect' | 'error' | 'market-update' | 'arbitrage-update' | 'signal' | 'health';

export interface WSEvent {
  type: WSEventType;
  data?: any;
  timestamp: number;
}

export interface WSConnectionState {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  lastUpdate: number;
}

export class MusashiWebSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private listeners: Map<WSEventType, Set<(event: WSEvent) => void>> = new Map();
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 3000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private state: WSConnectionState = {
    connected: false,
    connecting: false,
    error: null,
    lastUpdate: 0,
  };
  private stateListeners: Set<(state: WSConnectionState) => void> = new Set();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(baseUrl: string = 'ws://127.0.0.1:3000') {
    this.url = baseUrl.replace(/^https?/, 'ws');
  }

  /**
   * Connect to WebSocket server
   */
  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.state.connected || this.state.connecting) {
        resolve();
        return;
      }

      this.updateState({ connecting: true });

      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          console.log('[WebSocket] Connected');
          this.reconnectAttempts = 0;
          this.updateState({ connected: true, connecting: false, error: null });
          this.emit('connect', { type: 'connect', timestamp: Date.now() });
          this.startHeartbeat();
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            this.handleMessage(message);
            this.updateState({ lastUpdate: Date.now() });
          } catch (err) {
            console.error('[WebSocket] Failed to parse message:', err);
          }
        };

        this.ws.onerror = (event) => {
          console.error('[WebSocket] Error:', event);
          const error = 'WebSocket connection error';
          this.updateState({ error });
          this.emit('error', { type: 'error', data: error, timestamp: Date.now() });
          reject(event);
        };

        this.ws.onclose = () => {
          console.log('[WebSocket] Disconnected');
          this.updateState({ connected: false, connecting: false });
          this.emit('disconnect', { type: 'disconnect', timestamp: Date.now() });
          this.stopHeartbeat();
          this.attemptReconnect();
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Unknown connection error';
        this.updateState({ error, connecting: false });
        reject(err);
      }
    });
  }

  /**
   * Disconnect from WebSocket server
   */
  public disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.updateState({ connected: false, connecting: false });
  }

  /**
   * Subscribe to WebSocket events
   */
  public on(type: WSEventType, handler: (event: WSEvent) => void): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }

    this.listeners.get(type)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.listeners.get(type)?.delete(handler);
    };
  }

  /**
   * Subscribe to connection state changes
   */
  public onStateChange(handler: (state: WSConnectionState) => void): () => void {
    this.stateListeners.add(handler);

    // Return unsubscribe function
    return () => {
      this.stateListeners.delete(handler);
    };
  }

  /**
   * Get current connection state
   */
  public getState(): WSConnectionState {
    return { ...this.state };
  }

  /**
   * Send a message to the WebSocket server
   */
  public send(type: string, data?: any): boolean {
    if (!this.ws || this.state.connected === false) {
      console.warn('[WebSocket] Not connected, cannot send message');
      return false;
    }

    try {
      this.ws.send(JSON.stringify({ type, data, timestamp: Date.now() }));
      return true;
    } catch (err) {
      console.error('[WebSocket] Failed to send message:', err);
      return false;
    }
  }

  /**
   * Request market updates
   */
  public requestMarketUpdate(): boolean {
    return this.send('subscribe', { channel: 'markets' });
  }

  /**
   * Request arbitrage updates
   */
  public requestArbitrageUpdate(): boolean {
    return this.send('subscribe', { channel: 'arbitrage' });
  }

  /**
   * Request health updates
   */
  public requestHealthUpdate(): boolean {
    return this.send('subscribe', { channel: 'health' });
  }

  // ─── Private Methods ───────────────────────────────────────────────────

  private handleMessage(message: any): void {
    const { type, data, timestamp = Date.now() } = message;

    switch (type) {
      case 'market-update':
        this.emit('market-update', { type: 'market-update', data, timestamp });
        break;

      case 'arbitrage-update':
        this.emit('arbitrage-update', { type: 'arbitrage-update', data, timestamp });
        break;

      case 'signal':
        this.emit('signal', { type: 'signal', data, timestamp });
        break;

      case 'health':
        this.emit('health', { type: 'health', data, timestamp });
        break;

      case 'pong':
        // Heartbeat response, ignore
        break;

      default:
        console.warn('[WebSocket] Unknown message type:', type);
    }
  }

  private emit(type: WSEventType, event: WSEvent): void {
    const handlers = this.listeners.get(type);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(event);
        } catch (err) {
          console.error('[WebSocket] Handler error:', err);
        }
      });
    }
  }

  private updateState(partial: Partial<WSConnectionState>): void {
    const newState = { ...this.state, ...partial };

    if (JSON.stringify(newState) !== JSON.stringify(this.state)) {
      this.state = newState;
      this.stateListeners.forEach((listener) => {
        try {
          listener(this.state);
        } catch (err) {
          console.error('[WebSocket] State listener error:', err);
        }
      });
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(
        `[WebSocket] Max reconnection attempts (${this.maxReconnectAttempts}) reached`
      );
      this.updateState({
        error: 'Connection lost - maximum reconnection attempts reached',
      });
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;

    console.log(
      `[WebSocket] Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms`
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        console.error('[WebSocket] Reconnection failed:', err);
      });
    }, delay);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.state.connected) {
        this.send('ping');
      }
    }, 30000); // Every 30 seconds
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
}

// Singleton instance
let wsInstance: MusashiWebSocket | null = null;

export function getMusashiWebSocket(baseUrl?: string): MusashiWebSocket {
  if (!wsInstance) {
    wsInstance = new MusashiWebSocket(baseUrl);
  }
  return wsInstance;
}

export function resetMusashiWebSocket(): void {
  if (wsInstance) {
    wsInstance.disconnect();
    wsInstance = null;
  }
}
