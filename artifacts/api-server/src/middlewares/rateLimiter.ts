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

/**
 * Chain multiple rate-limit middlewares so a route can enforce a short
 * "burst" cap and a longer "sustained" cap at the same time (the standard
 * two-tier pattern used by most production chat/messaging APIs — e.g. a
 * hard per-second/per-few-seconds ceiling to stop scripted flooding, plus
 * a looser per-minute-scale ceiling to stop sustained abuse that paces
 * itself just under the burst limit). Whichever limiter in the chain
 * trips first returns its own 429 message; if all pass, the request
 * proceeds normally. Each limiter keeps its own independent counters
 * (distinct keyPrefixes), so tripping one does not consume budget on
 * the others.
 */
export function chainRateLimiters(...limiters: ReturnType<typeof createRateLimiter>[]) {
  return function chainedRateLimitMiddleware(req: any, res: any, next: any) {
    let i = 0;
    function run() {
      if (i >= limiters.length) return next();
      const limiter = limiters[i++];
      limiter(req, res, (err?: unknown) => {
        if (err) return next(err);
        run();
      });
    }
    run();
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

// Chat messages (text + file/image uploads): buyer<->seller conversations
// had NO dedicated limiter, unlike product Q&A (1-hour cooldown) and
// reviews (one-per-purchase). The generic apiLimiter (200 req / 15 min,
// shared across every /api call the user makes) is far too loose to stop
// a user from flooding a single conversation with rapid-fire messages.
//
// Two-tier limiter, matching standard chat-API practice:
//   - chatMessageBurstLimiter: hard short-window cap (6 msgs / 10s) that
//     stops a scripted flood even if it fits under the sustained budget.
//   - chatMessageLimiter: sustained cap (30 msgs / 5 min, ~1 every 10s)
//     that stops slow, paced abuse a burst limiter alone wouldn't catch.
// Apply both via chainRateLimiters (see above) on every message-sending
// route.
export const chatMessageBurstLimiter = createRateLimiter({
  windowMs: 10 * 1000,
  max: 6,
  message: "You're sending messages too quickly. Please wait a few seconds.",
  keyPrefix: "chat-message-burst",
});

export const chatMessageLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: "You're sending messages too quickly. Please slow down and try again in a few minutes.",
  keyPrefix: "chat-message",
});

// Conversation creation: without this, a buyer could spam-create
// conversations with many different sellers in a tight loop (each POST
// /conversations either finds-or-creates a thread, so this is the choke
// point for "message N different sellers" style spam, separate from the
// per-conversation message flood above). 20 new/updated conversations per
// 15 minutes is generous for legitimate shopping behavior.
export const conversationCreateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many conversations started. Please try again later.",
  keyPrefix: "conversation-create",
});
