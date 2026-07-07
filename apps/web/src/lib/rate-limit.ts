// =============================================================================
// Rate Limiter — In-memory sliding window implementation.
// Interface is designed for a future Redis upgrade:
//   Replace checkRateLimit() internals with ioredis/Upstash calls
//   without changing any call sites.
//
// Caveat: In serverless deployments (Vercel), each function instance has its
// own memory. This provides per-instance limiting only. For strict cross-
// instance limits, swap the store for Redis (e.g. Upstash @upstash/ratelimit).
// =============================================================================

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  /** Unix timestamp (seconds) when the window resets */
  resetAt: number;
}

interface WindowEntry {
  count: number;
  /** Unix timestamp (ms) when this window expires */
  resetAt: number;
}

// Module-level store — lives for the lifetime of the Node.js process
const store = new Map<string, WindowEntry>();
let lastFullCleanup = 0;

function cleanup(now: number): void {
  // Full sweep at most once every 5 minutes to prevent unbounded memory growth
  if (now - lastFullCleanup < 5 * 60 * 1000) return;
  lastFullCleanup = now;
  for (const [key, entry] of store) {
    if (now > entry.resetAt) store.delete(key);
  }
}

/**
 * Check and increment a rate-limit counter.
 * @param key     Unique string identifying the subject (e.g. "ip:1.2.3.4" or "company:uuid")
 * @param limit   Maximum requests allowed per window
 * @param windowMs Window duration in milliseconds
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  cleanup(now);

  const entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    const resetAt = now + windowMs;
    store.set(key, { count: 1, resetAt });
    return { success: true, remaining: limit - 1, resetAt: Math.ceil(resetAt / 1000) };
  }

  if (entry.count >= limit) {
    return { success: false, remaining: 0, resetAt: Math.ceil(entry.resetAt / 1000) };
  }

  entry.count++;
  return {
    success: true,
    remaining: limit - entry.count,
    resetAt: Math.ceil(entry.resetAt / 1000),
  };
}

/**
 * Extract the most reliable client IP from a request.
 * Works with Vercel, Cloudflare, and standard proxies.
 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/**
 * Build a 429 Too Many Requests response with standard headers.
 */
export function buildRateLimitResponse(resetAt: number): Response {
  const retryAfter = Math.max(1, resetAt - Math.floor(Date.now() / 1000));
  return new Response(
    JSON.stringify({ error: "Too many requests. Please try again later." }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfter),
        "X-RateLimit-Reset": String(resetAt),
      },
    }
  );
}
