import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const TABLES = {
  accounts: 'user_accounts',
  pluginUsage: 'plugin_usage_records',
  subscriptions: 'orders_subscriptions',
  signalOutcomes: 'signal_outcomes',
} as const;

export type AppDatabase = {
  public: {
    Tables: {
      user_accounts: {
        Row: {
          id: string;
          email: string;
          role: 'user' | 'admin';
          subscription_status: 'free' | 'trial' | 'active' | 'canceled' | 'expired';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          email: string;
          role?: 'user' | 'admin';
          subscription_status?: 'free' | 'trial' | 'active' | 'canceled' | 'expired';
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          role?: 'user' | 'admin';
          subscription_status?: 'free' | 'trial' | 'active' | 'canceled' | 'expired';
          created_at?: string;
          updated_at?: string;
        };
      };
      plugin_usage_records: {
        Row: {
          id: string;
          user_id: string;
          extension_version: string;
          device_id: string;
          event_type: 'install' | 'activate' | 'usage';
          is_active: boolean;
          activity_at: string;
          metadata: Record<string, unknown> | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          extension_version: string;
          device_id: string;
          event_type: 'install' | 'activate' | 'usage';
          is_active?: boolean;
          activity_at?: string;
          metadata?: Record<string, unknown> | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          extension_version?: string;
          device_id?: string;
          event_type?: 'install' | 'activate' | 'usage';
          is_active?: boolean;
          activity_at?: string;
          metadata?: Record<string, unknown> | null;
        };
      };
      orders_subscriptions: {
        Row: {
          id: string;
          user_id: string;
          amount_usd: number;
          payment_method: 'card' | 'paypal' | 'apple_pay' | 'google_pay' | 'crypto' | 'other';
          subscription_status: 'pending' | 'active' | 'canceled' | 'expired' | 'refunded';
          started_at: string;
          expires_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          amount_usd: number;
          payment_method: 'card' | 'paypal' | 'apple_pay' | 'google_pay' | 'crypto' | 'other';
          subscription_status?: 'pending' | 'active' | 'canceled' | 'expired' | 'refunded';
          started_at?: string;
          expires_at: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          amount_usd?: number;
          payment_method?: 'card' | 'paypal' | 'apple_pay' | 'google_pay' | 'crypto' | 'other';
          subscription_status?: 'pending' | 'active' | 'canceled' | 'expired' | 'refunded';
          started_at?: string;
          expires_at?: string;
          created_at?: string;
          updated_at?: string;
        };
      };
      signal_outcomes: {
        Row: {
          signal_id: string;
          event_id: string;
          market_id: string;
          platform: 'polymarket' | 'kalshi';
          predicted_direction: 'YES' | 'NO' | 'HOLD';
          predicted_prob: number;
          confidence: number;
          edge: number;
          signal_type: string;
          urgency: string;
          features: Record<string, unknown>;
          created_at: string;
          resolution_date: string | null;
          outcome: 'YES' | 'NO' | null;
          was_correct: boolean | null;
          pnl: number | null;
        };
        Insert: {
          signal_id?: string;
          event_id: string;
          market_id: string;
          platform: 'polymarket' | 'kalshi';
          predicted_direction: 'YES' | 'NO' | 'HOLD';
          predicted_prob: number;
          confidence: number;
          edge: number;
          signal_type: string;
          urgency: string;
          features: Record<string, unknown>;
          created_at?: string;
          resolution_date?: string | null;
          outcome?: 'YES' | 'NO' | null;
          was_correct?: boolean | null;
          pnl?: number | null;
        };
        Update: {
          signal_id?: string;
          event_id?: string;
          market_id?: string;
          platform?: 'polymarket' | 'kalshi';
          predicted_direction?: 'YES' | 'NO' | 'HOLD';
          predicted_prob?: number;
          confidence?: number;
          edge?: number;
          signal_type?: string;
          urgency?: string;
          features?: Record<string, unknown>;
          created_at?: string;
          resolution_date?: string | null;
          outcome?: 'YES' | 'NO' | null;
          was_correct?: boolean | null;
          pnl?: number | null;
        };
      };
    };
  };
};

export function createSupabaseBrowserClient(
  supabaseUrl: string,
  supabaseAnonKey: string,
): SupabaseClient<AppDatabase> {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase URL or Anon Key.');
  }

  return createClient<AppDatabase>(supabaseUrl, supabaseAnonKey);
}

export async function testSupabaseConnection(client: SupabaseClient<AppDatabase>): Promise<void> {
  const [accountsResult, usageResult, subscriptionsResult, signalOutcomesResult] = await Promise.all([
    client.from(TABLES.accounts).select('id').limit(1),
    client.from(TABLES.pluginUsage).select('id').limit(1),
    client.from(TABLES.subscriptions).select('id').limit(1),
    client.from(TABLES.signalOutcomes).select('signal_id').limit(1),
  ]);

  const errors = [accountsResult.error, usageResult.error, subscriptionsResult.error, signalOutcomesResult.error].filter(Boolean);

  if (errors.length > 0) {
    const details = errors.map((error) => error?.message ?? 'Unknown Supabase error').join(' | ');
    throw new Error(`Supabase connection failed: ${details}`);
  }
}
