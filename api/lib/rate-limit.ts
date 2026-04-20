import type { VercelRequest } from '@vercel/node';

const buckets = new Map<string, number[]>();

export function getClientIp(req: VercelRequest): string {
  const xf = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xf) ? xf[0] : xf;
  const first = (raw || '').split(',')[0].trim();
  return first || 'unknown';
}

/**
 * Sliding-window rate limiter (per serverless instance). For production abuse protection,
 * pair with edge/WAF limits — see docs/ENVIRONMENT.md.
 */
export function isRateLimited(key: string, limitPerMinute: number): boolean {
  if (!Number.isFinite(limitPerMinute) || limitPerMinute <= 0) {
    return false;
  }

  const now = Date.now();
  const windowStart = now - 60_000;
  const stamps = buckets.get(key) ?? [];
  const fresh = stamps.filter(t => t > windowStart);

  if (fresh.length >= limitPerMinute) {
    buckets.set(key, fresh);
    return true;
  }

  fresh.push(now);
  buckets.set(key, fresh);
  return false;
}

export function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}
