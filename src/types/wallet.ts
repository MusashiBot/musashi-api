// Wallet intelligence data types

export type WalletActivityType =
  | 'trade'
  | 'position_opened'
  | 'position_increased'
  | 'position_reduced'
  | 'position_closed'
  | 'redeemed'
  | 'unknown';

export interface WalletActivity {
  wallet: string;
  activityType: WalletActivityType;
  platform: 'polymarket';
  marketId?: string;
  conditionId?: string;
  tokenId?: string;
  marketTitle?: string;
  marketSlug?: string;
  outcome?: string;
  side?: 'buy' | 'sell';
  price?: number;
  size?: number;
  value?: number;
  timestamp: string;
  url?: string;
}

export interface WalletPosition {
  wallet: string;
  platform: 'polymarket';
  marketId?: string;
  conditionId?: string;
  tokenId?: string;
  marketTitle: string;
  marketSlug?: string;
  outcome: string;
  quantity: number;
  averagePrice?: number;
  currentPrice?: number;
  currentValue?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  url?: string;
  updatedAt: string;
}

export interface MarketWalletFlow {
  marketId?: string;
  conditionId?: string;
  tokenId?: string;
  marketTitle?: string;
  window: '1h' | '24h' | '7d';
  walletCount: number;
  smartWalletCount: number;
  buyVolume: number;
  sellVolume: number;
  netVolume: number;
  netDirection: 'YES' | 'NO' | 'mixed' | 'unknown';
  largeTrades: WalletActivity[];
}
