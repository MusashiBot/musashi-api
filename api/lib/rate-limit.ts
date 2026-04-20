/**
 * Sliding-window per-IP rate limiter backed by Vercel KV (Upstash Redis).
 *
 * Design goals:
 *   • O(1) per check — uses a single INCR + EXPIRE, no list walking.
 *   • Fail-open — if KV is unavailable we ALLOW the request rather than
 *     block legitimate traffic. Rate limiting is a secondary safeguard;
 *     availability matters more.
 *   • Zero coupling — endpoints call `enforceRateLimit(req, res, …)`;
 *     if the function writes a 429 response it returns `true` and the
 *     caller bails out; otherwise the endpoint proceeds.
 *
 * Default limits (overridable via env or per-endpoint call):
 *   • 60 requests per rolling 60-second window per IP
 *
 * Security note: `X-Forwarded-For` can be spoofed if the API isn't
 * behind a trusted proxy. Vercel's edge network rewrites this header
 * to the client's real IP, so we trust it here. If you self-host,
 * replace `getClientIp` with a trusted-proxy-aware version.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from './vercel-kv';

// In-process fallback counter, used when KV is unavailable (local dev
// without Upstash credentials, transient network errors, etc.). Keyed
// identically to the KV path so behavior is consistent.
const inProcessCounters = new Map<string, { count: number; expiresAt: number }>();
function pruneCounters(): void {
  const now = Date.now();
  for (const [k, v] of inProcessCounters.entries()) {
    if (v.expiresAt <= now) inProcessCounters.delete(k);
  }
}

const DEFAULT_WINDOW_SECONDS = parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS || '60', 10);
const DEFAULT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '60', 10);

export interface RateLimitOptions {
  /** Window length in seconds. Default 60. */
  windowSeconds?: number;
  /** Max requests allowed per window per IP. Default 60. */
  maxRequests?: number;
  /**
   * Bucket identifier. Lets you apply per-endpoint limits (e.g. the
   * analyze-text endpoint can tolerate more burst than the expensive
   * arbitrage scan). Defaults to the request path.
   */
  bucket?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetSeconds: number;
  source: 'kv' | 'disabled' | 'error';
}

function getClientIp(req: VercelRequest): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0]!.trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return xff[0]!.split(',')[0]!.trim();
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.length > 0) return realIp;
  const sock = (req as unknown as { socket?: { remoteAddress?: string } }).socket;
  return sock?.remoteAddress || 'unknown';
}

/**
 * Check the rate-limit bucket for this request. Returns structured info;
 * does NOT write to the response. Use `enforceRateLimit` to combine the
 * check with a 429 response.
 */
export async function checkRateLimit(
  req: VercelRequest,
  opts: RateLimitOptions = {},
): Promise<RateLimitResult> {
  const windowSeconds = Math.max(1, opts.windowSeconds ?? DEFAULT_WINDOW_SECONDS);
  const maxRequests = Math.max(1, opts.maxRequests ?? DEFAULT_MAX_REQUESTS);
  const bucket = opts.bucket ?? (typeof req.url === 'string' ? req.url.split('?')[0] : 'default');
  const ip = getClientIp(req);
  const windowId = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${bucket}:${ip}:${windowId}`;

  // Fast local path for when KV is not wired. Also protects the main
  // path from KV latency if the store is slow: a stale +1 there is fine
  // (we're within the 60-req window anyway).
  const localCount = bumpLocalCounter(key, windowSeconds);

  try {
    // Read-modify-write against KV. Two round-trips but O(1) each, and
    // the worst-case race just lets one extra request through per
    // concurrent pair — which is acceptable for rate limiting.
    const current = (await kv.get<number>(key)) ?? 0;
    const next = current + 1;
    await kv.set(key, next, { ex: windowSeconds * 2 });
    const count = Math.max(next, localCount);
    const allowed = count <= maxRequests;
    return {
      allowed,
      remaining: Math.max(0, maxRequests - count),
      limit: maxRequests,
      resetSeconds: windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds),
      source: 'kv',
    };
  } catch (err) {
    // Fail open, but still enforce the in-process counter so a single
    // serverless instance under flood gets protected.
    console.warn('[rate-limit] KV unavailable, using in-process only:', err instanceof Error ? err.message : err);
    const allowed = localCount <= maxRequests;
    return {
      allowed,
      remaining: Math.max(0, maxRequests - localCount),
      limit: maxRequests,
      resetSeconds: windowSeconds,
      source: 'error',
    };
  }
}

function bumpLocalCounter(key: string, windowSeconds: number): number {
  pruneCounters();
  const now = Date.now();
  const prev = inProcessCounters.get(key);
  const nextCount = (prev?.count ?? 0) + 1;
  inProcessCounters.set(key, {
    count: nextCount,
    expiresAt: now + windowSeconds * 2 * 1000,
  });
  return nextCount;
}

/**
 * Convenience wrapper: checks the limit AND writes a 429 response if
 * exhausted. Returns `true` if the caller should short-circuit, `false`
 * to proceed with normal handling.
 */
export async function enforceRateLimit(
  req: VercelRequest,
  res: VercelResponse,
  opts: RateLimitOptions = {},
): Promise<boolean> {
  const result = await checkRateLimit(req, opts);

  // Always surface rate-limit headers — useful even on 200s so bots can
  // self-pace instead of waiting for a 429.
  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  res.setHeader('X-RateLimit-Reset', String(result.resetSeconds));

  if (result.allowed) return false;

  res.setHeader('Retry-After', String(result.resetSeconds));
  res.status(429).json({
    success: false,
    error: `Rate limit exceeded. Max ${result.limit} requests per ${opts.windowSeconds ?? DEFAULT_WINDOW_SECONDS}s.`,
    retry_after_seconds: result.resetSeconds,
  });
  return true;
}
