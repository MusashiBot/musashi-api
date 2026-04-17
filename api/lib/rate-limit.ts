import type { VercelRequest, VercelResponse } from '@vercel/node';

const RATE_LIMIT_MAX_REQUESTS = 30;
const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * IP-based fixed-window rate limiter backed by Vercel KV (Upstash Redis).
 *
 * Uses a dynamic import of @vercel/kv so that local development without
 * KV credentials degrades gracefully — the catch block returns true,
 * allowing all requests through rather than blocking legitimate traffic.
 *
 * Returns true if the request is within the rate limit, false if it was
 * rejected with a 429 response (caller should return immediately).
 */
export async function checkRateLimit(
  req: VercelRequest,
  res: VercelResponse
): Promise<boolean> {
  try {
    const rawIp = req.headers['x-forwarded-for'];
    const ip = (Array.isArray(rawIp) ? rawIp[0] : rawIp) ?? 'unknown';
    const key = `ratelimit:${ip}`;

    // Dynamic import matches the pattern in vercel-kv.ts and allows the
    // module to load even when @vercel/kv credentials are not configured.
    const { kv } = await import('@vercel/kv');
    const count: number = await kv.incr(key);
    // Set the TTL only on the first increment so the window is fixed, not
    // sliding — subsequent increments within the window do not reset it.
    if (count === 1) await kv.expire(key, RATE_LIMIT_WINDOW_SECONDS);

    if (count > RATE_LIMIT_MAX_REQUESTS) {
      res.status(429).json({
        success: false,
        error: `Rate limit exceeded. Max ${RATE_LIMIT_MAX_REQUESTS} requests per ${RATE_LIMIT_WINDOW_SECONDS}s window.`,
      });
      return false;
    }

    return true;
  } catch {
    // KV unavailable (local dev, missing credentials, or Upstash outage).
    // Fail open — allow the request rather than blocking legitimate traffic.
    return true;
  }
}
