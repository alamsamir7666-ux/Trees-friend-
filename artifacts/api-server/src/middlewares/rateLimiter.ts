/**
 * Redis-backed rate limiter (Upstash).
 *
 * Why Redis:
 *   The previous implementation used an in-memory Map + setInterval
 *   cleanup. On Vercel (and any multi-instance deployment), that's
 *   broken: every Lambda instance has its own Map, so a determined
 *   attacker hitting different instances is never throttled. The
 *   setInterval cleanup also doesn't run reliably on serverless
 *   (frozen between invocations).
 *
 *   Upstash Redis is HTTP-based (no persistent connection), so it works
 *   in serverless environments where TCP connection pooling doesn't.
 *   The @upstash/ratelimit package implements the sliding-window
 *   algorithm on top of it, which is the industry standard for
 *   distributed rate limiting.
 *
 * Configuration:
 *   Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in your env
 *   vars (Vercel → Storage → Upstash Integration → Connect to project).
 *   If unset, the limiter falls back to an in-memory Map for local dev
 *   — NEVER use this fallback in production. The fallback logs a
 *   prominent warning on first use.
 *
 * Per-user vs per-IP:
 *   The key is `prefix:ip:userId`. userId is populated when the limiter
 *   runs AFTER requireAuth (see app.ts — limiters are now mounted after
 *   Clerk middleware, and per-route limiters run after requireAuth in
 *   their respective route files). When userId is unavailable (pre-auth
 *   routes like /mobile-auth/sign-in), the key degrades to IP-only,
 *   which is still correct for credential-guessing protection.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

// ─── Redis client (lazy-init, falls back to in-memory for dev) ──────────────

let _redis: Redis | null = null;
let _redisInitAttempted = false;
let _fallbackWarned = false;

function getRedis(): Redis | null {
  if (_redisInitAttempted) return _redis;
  _redisInitAttempted = true;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    // Fall back to in-memory for local dev. The fallback limiter is
    // created by createRateLimiter below when getRedis() returns null.
    return null;
  }

  try {
    _redis = new Redis({ url, token });
    logger.info("Rate limiter: connected to Upstash Redis");
  } catch (err) {
    logger.error({ err }, "Rate limiter: failed to connect to Upstash Redis, falling back to in-memory (NOT production-safe)");
  }
  return _redis;
}

// ─── In-memory fallback (dev only) ──────────────────────────────────────────

interface InMemoryEntry {
  count: number;
  resetAt: number;
}

const inMemoryStore = new Map<string, InMemoryEntry>();

// Clean up expired entries every 5 minutes. This interval only runs on
// long-lived processes (Render) — on Vercel serverless it's a no-op
// (frozen between invocations), which is fine because the fallback is
// dev-only.
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of inMemoryStore.entries()) {
      if (entry.resetAt < now) inMemoryStore.delete(key);
    }
  }, 5 * 60 * 1000).unref?.();
}

// ─── Rate limiter factory ───────────────────────────────────────────────────

export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
  keyPrefix?: string;
}) {
  const {
    windowMs,
    max,
    message = "Too many requests. Please try again later.",
    keyPrefix = "rl",
  } = options;

  // Upstash ratelimit instance (created once per limiter, reused across
  // requests). Uses the sliding-window algorithm for accuracy.
  // Created lazily inside the middleware so we don't construct it at
  // module-load time (when Redis env vars may not be set yet in dev).
  let upstashLimiter: Ratelimit | null = null;
  function getLimiter(): Ratelimit | null {
    const redis = getRedis();
    if (!redis) return null;
    if (!upstashLimiter) {
      upstashLimiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(max, `${windowMs}ms`),
        prefix: `ratelimit:${keyPrefix}`,
        analytics: process.env.NODE_ENV === "production",
      });
    }
    return upstashLimiter;
  }

  return async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    // Key: prefix + IP + optional userId (populated when this limiter
    // runs after requireAuth). userId is undefined for pre-auth routes
    // like /mobile-auth/sign-in, which is fine — IP-only is still
    // correct there.
    const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    const userId = req.userId ?? "";
    const key = `${ip}:${userId}`;

    const redis = getRedis();

    if (redis) {
      // ─── Production path: Upstash Redis ───
      const limiter = getLimiter();
      if (limiter) {
        try {
          const result = await limiter.limit(key);
          res.setHeader("X-RateLimit-Limit", max);
          res.setHeader("X-RateLimit-Remaining", Math.max(0, result.remaining));
          res.setHeader("X-RateLimit-Reset", Math.ceil(result.reset / 1000));

          if (!result.success) {
            res.status(429).json({ error: message });
            return;
          }
          next();
          return;
        } catch (err) {
          // If Redis is unreachable, log and FAIL OPEN (allow the request).
          // Failing closed would block every user during a Redis outage —
          // a worse outcome than letting a few extra requests through.
          // The global apiLimiter still provides some protection.
          logger.error({ err, keyPrefix }, "Rate limiter: Redis error, failing open");
          next();
          return;
        }
      }
    }

    // ─── Dev fallback: in-memory Map ───
    if (!_fallbackWarned && process.env.NODE_ENV === "production") {
      logger.warn(
        "Rate limiter: UPSTASH_REDIS_REST_URL not set — using in-memory fallback. " +
          "This is NOT safe for production multi-instance deployments. " +
          "Add Upstash Redis via Vercel → Storage → Upstash Integration.",
      );
      _fallbackWarned = true;
    }

    const memKey = `${keyPrefix}:${key}`;
    const now = Date.now();
    const entry = inMemoryStore.get(memKey);

    if (!entry || entry.resetAt < now) {
      inMemoryStore.set(memKey, { count: 1, resetAt: now + windowMs });
      res.setHeader("X-RateLimit-Limit", max);
      res.setHeader("X-RateLimit-Remaining", max - 1);
      next();
      return;
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
  return async function chainedRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    let i = 0;
    async function run() {
      if (i >= limiters.length) return next();
      const limiter = limiters[i++];
      await new Promise<void>((resolve, reject) => {
        limiter(req, res, (err?: unknown) => {
          if (err) return reject(err);
          resolve();
        });
      });
      if (res.headersSent) return; // a limiter sent a 429
      await run();
    }
    try {
      await run();
    } catch (err) {
      next(err);
    }
  };
}

// ─── Pre-configured limiters ────────────────────────────────────────────────

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

// ─── Guest-only limiters (P0-3) ─────────────────────────────────────────────
//
// Guest endpoints (POST /orders/guest, POST /bkash/create-payment/guest) had
// NO per-route limiter — only the global apiLimiter (200 req / 15 min / IP)
// applied. A botnet could create up to 200 guest orders per IP per 15 min,
// each with empty carts (caught at validation) or bogus data, or trigger
// 200 bKash Create Payment API calls per IP per 15 min (each consuming a
// real external API call to bKash). The authenticated equivalents
// (POST /orders, POST /bkash/create-payment) both have checkoutLimiter
// (10/15min), so this closes the consistency gap.
//
// Separate limiters (not reusing checkoutLimiter) for two reasons:
//   1. Guest endpoints key on IP only (no userId available pre-auth), so
//      mixing them into the same counter as authenticated checkout would
//      let an attacker burn a legitimate signed-in user's checkout budget
//      by hitting the guest endpoint from the same IP.
//   2. Tighter limit for guest order creation (5/15min) than authenticated
//      (10/15min) — guests have less trust capital, and bKash Create
//      Payment calls cost real money per invocation.

// Guest order creation: POST /orders/guest. 5 orders / 15 min / IP is
// generous for legitimate guest shoppers (a single guest rarely places
// more than 1-2 orders in a session) while stopping order-spam attacks.
export const guestCheckoutLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Too many guest checkout attempts from this IP. Please sign in or try again later.",
  keyPrefix: "guest-checkout",
});

// Guest bKash payment creation: POST /bkash/create-payment/guest. Each call
// triggers a real external bKash Create Payment API request (costs money /
// rate-limit budget on bKash's side), so 3/15min is intentionally tighter
// than guestCheckoutLimiter. Legitimate guests virtually never need to
// retry bKash payment creation more than once or twice.
export const guestBkashLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: "Too many bKash payment attempts from this IP. Please try again later.",
  keyPrefix: "guest-bkash",
});
