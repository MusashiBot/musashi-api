import { useEffect, useState, useCallback } from 'react';
import { getMusashiWebSocket, WSConnectionState } from '../services/websocket';

export function useWebSocket() {
  const [state, setState] = useState<WSConnectionState>({
    connected: false,
    connecting: false,
    error: null,
    lastUpdate: 0,
  });

  const [markets, setMarkets] = useState<any[]>([]);
  const [arbitrage, setArbitrage] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);

  useEffect(() => {
    const ws = getMusashiWebSocket();

    // Subscribe to state changes
    const unsubscribeState = ws.onStateChange((newState) => {
      setState(newState);
    });

    // Subscribe to market updates
    const unsubscribeMarkets = ws.on('market-update', (event) => {
      if (event.data) {
        setMarkets(event.data);
      }
    });

    // Subscribe to arbitrage updates
    const unsubscribeArbitrage = ws.on('arbitrage-update', (event) => {
      if (event.data) {
        setArbitrage(event.data);
      }
    });

    // Subscribe to health updates
    const unsubscribeHealth = ws.on('health', (event) => {
      if (event.data) {
        setHealth(event.data);
      }
    });

    // Connect to WebSocket
    ws.connect().catch((err) => {
      console.error('[useWebSocket] Connection failed:', err);
    });

    return () => {
      unsubscribeState();
      unsubscribeMarkets();
      unsubscribeArbitrage();
      unsubscribeHealth();
    };
  }, []);

  const subscribe = useCallback((channel: 'markets' | 'arbitrage' | 'health') => {
    const ws = getMusashiWebSocket();
    switch (channel) {
      case 'markets':
        return ws.requestMarketUpdate();
      case 'arbitrage':
        return ws.requestArbitrageUpdate();
      case 'health':
        return ws.requestHealthUpdate();
    }
  }, []);

  return {
    connected: state.connected,
    connecting: state.connecting,
    error: state.error,
    lastUpdate: state.lastUpdate,
    markets,
    arbitrage,
    health,
    subscribe,
  };
}
