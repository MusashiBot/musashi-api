import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getMarkets } from './lib/market-cache';
import { kv } from './lib/vercel-kv';
import {
  getMoversKey,
  META_LAST_SNAPSHOT_RUN,
} from './lib/price-snapshots';

type CheckStatus = 'healthy' | 'degraded' | 'down';
interface CheckResult {
  status: CheckStatus;
  detail?: Record<string, unknown>;
  error?: string;
}

const POLY_MIN_HEALTHY = parseInt(process.env.HEALTH_POLY_MIN || '800', 10);
const KALSHI_MIN_HEALTHY = parseInt(process.env.HEALTH_KALSHI_MIN || '200', 10);
const FRESHNESS_MAX_AGE_MS = 5 * 60 * 1000;
const KV_PROBE_KEY = 'health:probe';
const KV_PROBE_TIMEOUT_MS = 1500;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout>;
  const timer = new Promise<T>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(handle));
}

async function checkMarketCounts(): Promise<CheckResult> {
  try {
    const markets = await getMarkets();
    const poly = markets.filter((m) => m.platform === 'polymarket').length;
    const kalshi = markets.filter((m) => m.platform === 'kalshi').length;

    const polyOk = poly >= POLY_MIN_HEALTHY;
    const kalshiOk = kalshi >= KALSHI_MIN_HEALTHY;

    return {
      status: polyOk && kalshiOk ? 'healthy' : 'degraded',
      detail: {
        polymarket: { markets: poly, threshold: POLY_MIN_HEALTHY, ok: polyOk },
        kalshi: { markets: kalshi, threshold: KALSHI_MIN_HEALTHY, ok: kalshiOk },
        total: markets.length,
      },
    };
  } catch (err) {
    return { status: 'down', error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkKvReachable(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    await withTimeout(kv.set(KV_PROBE_KEY, t0, { ex: 60 }), KV_PROBE_TIMEOUT_MS, 'KV write');
    await withTimeout(kv.get<number>(KV_PROBE_KEY), KV_PROBE_TIMEOUT_MS, 'KV read');
    const latency = Date.now() - t0;
    return {
      status: latency > 1000 ? 'degraded' : 'healthy',
      detail: { latency_ms: latency },
    };
  } catch (err) {
    return { status: 'down', error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkFreshness(
  key: string,
  label: string,
  extract: (v: any) => string | undefined,
): Promise<CheckResult> {
  try {
    const value = await kv.get<any>(key);
    if (!value) {
      return { status: 'degraded', error: `${label}: no run recorded yet` };
    }
    const ts = extract(value);
    if (!ts) {
      return { status: 'degraded', error: `${label}: missing timestamp` };
    }
    const ageMs = Date.now() - new Date(ts).getTime();
    return {
      status: ageMs > FRESHNESS_MAX_AGE_MS ? 'degraded' : 'healthy',
      detail: { last_run: ts, age_seconds: Math.floor(ageMs / 1000) },
    };
  } catch (err) {
    return { status: 'down', error: err instanceof Error ? err.message : String(err) };
  }
}

function rollup(checks: Record<string, CheckResult>): CheckStatus {
  const statuses = Object.values(checks).map((c) => c.status);
  if (statuses.every((s) => s === 'healthy')) return 'healthy';
  if (statuses.some((s) => s === 'down')) return 'down';
  return 'degraded';
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({ success: false, error: 'Method not allowed. Use GET.' });
    return;
  }

  const startTime = Date.now();

  try {
    const [marketCounts, kvReach, snapshotFresh, moversFresh] = await Promise.all([
      checkMarketCounts(),
      checkKvReachable(),
      checkFreshness(META_LAST_SNAPSHOT_RUN, 'snapshots', (v) => v?.timestamp),
      checkFreshness(getMoversKey('0.05'), 'movers', (v) => v?.computedAt),
    ]);

    const checks = {
      market_counts: marketCounts,
      kv_reachable: kvReach,
      snapshot_freshness: snapshotFresh,
      movers_freshness: moversFresh,
    };

    const overall = rollup(checks);

    const body = {
      success: overall === 'healthy',
      data: {
        status: overall,
        timestamp: new Date().toISOString(),
        response_time_ms: Date.now() - startTime,
        version: '2.1.0',
        checks,
      },
    };

    const statusCode = overall === 'healthy' ? 200 : 503;
    res.status(statusCode).json(body);
  } catch (error) {
    console.error('[Health API] Error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
