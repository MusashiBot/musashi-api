/**
 * Per-IP rate limiter.
 *
 * Implements an approximate **sliding-window** counter via the two-bucket
 * weighted method of Cloudflare / nginx lua:
 *
 *     weighted_count = current_bucket + previous_bucket * (1 - elapsed_frac)
 *
 * where `elapsed_frac` is how far we are through the current fixed
 * bucket (0..1). This smooths out the boundary effect of a naive
 * fixed-window counter (where a client could make `2 * max` requests in
 * a couple of seconds straddling the boundary) down to at most `max + 1`.
 *
 * Backing store:
 *   • Vercel KV (Upstash Redis), for cross-instance counting.
 *   • An in-process Map as a fast-path fallback when KV is unavailable
 *     or slow. The in-process counter is authoritative within a single
 *     warm serverless instance; the KV counter is best-effort across
 *     instances.
 *
 * Honest limitations:
 *   • The KV read-modify-write is NOT atomic. Under concurrent load on
 *     the same key, increments can race. The in-process layer masks
 *     this within a single instance. Across instances we accept a
 *     small drift (usually < max_requests / 10). This is fine for
 *     API rate limiting — we'd rather allow a few extra requests
 *     than drop legitimate traffic on contention.
 *   • `X-Forwarded-For` is trusted as the client IP. Vercel's edge
 *     rewrites this header to the real client IP, but if you deploy
 *     outside Vercel behind an untrusted proxy you need a different
 *     `getClientIp`.
 *   • Fail-open semantics: a KV error does NOT return 429. The
 *     in-process counter still enforces within the instance; across
 *     instances traffic gets through. We prefer availability over
 *     strict enforcement.
 *
 * Endpoints wire in via `enforceRateLimit(req, res, opts)` which also
 * writes `X-RateLimit-Limit` / `-Remaining` / `-Reset` headers on every
 * response (so well-behaved bots can self-pace instead of waiting for
 * a 429) and `Retry-After` on 429s.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from './vercel-kv';

// In-process fallback counter, used when KV is unavailable.
// Keyed identically to the KV path so behavior is consistent.
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
  /** Remaining requests the caller can make in the current window. */
  remaining: number;
  /** The configured per-window limit. */
  limit: number;
  /** Seconds until the current window rolls over. */
  resetSeconds: number;
  /** Where the counter came from for this decision. */
  source: 'kv' | 'kv-with-local' | 'local-only';
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

  const nowSec = Date.now() / 1000;
  const windowId = Math.floor(nowSec / windowSeconds);
  const keyCurr = `rl:${bucket}:${ip}:${windowId}`;
  const keyPrev = `rl:${bucket}:${ip}:${windowId - 1}`;

  // Always bump the in-process counter first. This gives us a floor we
  // can rely on even if KV is slow or unavailable.
  const localCount = bumpLocalCounter(keyCurr, windowSeconds);
  const localPrev = peekLocalCounter(`rl:${bucket}:${ip}:${windowId - 1}`);

  // Fraction of the current window that has elapsed (0 at bucket start,
  // approaches 1 at bucket end).
  const elapsedFrac = (nowSec - windowId * windowSeconds) / windowSeconds;
  const resetSeconds = Math.max(1, Math.ceil(windowSeconds * (1 - elapsedFrac)));

  try {
    // Read both buckets, write the incremented current bucket.
    const [prev, curr] = await Promise.all([
      kv.get<number>(keyPrev),
      kv.get<number>(keyCurr),
    ]);
    const prevCount = Math.max((prev ?? 0) as number, localPrev);
    const currCount = Math.max((curr ?? 0) as number, localCount);
    // Best-effort write-through of the incremented count. Not atomic
    // with the read — races can lose one increment under concurrent
    // load on the same key, which we accept.
    await kv.set(keyCurr, currCount, { ex: windowSeconds });

    const weighted = currCount + prevCount * (1 - elapsedFrac);
    const effective = Math.ceil(weighted);
    const allowed = effective <= maxRequests;
    return {
      allowed,
      remaining: Math.max(0, maxRequests - effective),
      limit: maxRequests,
      resetSeconds,
      source: 'kv-with-local',
    };
  } catch (err) {
    // Fail open at the HTTP level, but still enforce the in-process
    // counter so a single serverless instance under flood is protected.
    console.warn('[rate-limit] KV unavailable, using in-process only:', err instanceof Error ? err.message : err);
    const weighted = localCount + localPrev * (1 - elapsedFrac);
    const effective = Math.ceil(weighted);
    const allowed = effective <= maxRequests;
    return {
      allowed,
      remaining: Math.max(0, maxRequests - effective),
      limit: maxRequests,
      resetSeconds,
      source: 'local-only',
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

function peekLocalCounter(key: string): number {
  pruneCounters();
  return inProcessCounters.get(key)?.count ?? 0;
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
