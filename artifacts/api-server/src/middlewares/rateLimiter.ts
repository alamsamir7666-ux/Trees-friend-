/**
 * Simple in-memory rate limiter.
 * For production with multiple instances, replace with Redis-backed limiter
 * using the `rate-limiter-flexible` package.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key);
  }
}, 5 * 60 * 1000);

export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
  keyPrefix?: string;
}) {
  const { windowMs, max, message = "Too many requests. Please try again later.", keyPrefix = "rl" } = options;

  return function rateLimitMiddleware(req: any, res: any, next: any) {
    // Key: prefix + IP + optional userId
    const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    const userId = req.userId ?? "";
    const key = `${keyPrefix}:${ip}:${userId}`;

    const now = Date.now();
    const entry = store.get(key);

    if (!entry || entry.resetAt < now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader("X-RateLimit-Limit", max);
      res.setHeader("X-RateLimit-Remaining", max - 1);
      return next();
    }

    entry.count++;
    const remaining = Math.max(0, max - entry.count);
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", Math.ceil(entry.resetAt / 1000));

    if (entry.count > max) {
      res.status(429).json({ error: message });
      return;
    }

    next();
  };
}

// Pre-configured limiters
export const apiLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 200,
  message: "Too many requests from this IP. Please try again in 15 minutes.",
  keyPrefix: "api",
});

export const checkoutLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many checkout attempts. Please wait before trying again.",
  keyPrefix: "checkout",
});

export const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many authentication attempts. Please try again later.",
  keyPrefix: "auth",
});

export const newsletterLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 3,
  message: "Too many subscription attempts.",
  keyPrefix: "newsletter",
});

export const stockAlertLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Too many stock alert requests.",
  keyPrefix: "stockalert",
});
