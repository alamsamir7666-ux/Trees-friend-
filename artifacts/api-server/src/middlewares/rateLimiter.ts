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
    logger.error(
      { err },
      "Rate limiter: failed to connect to Upstash Redis, falling back to in-memory (NOT production-safe)",
    );
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
  setInterval(
    () => {
      const now = Date.now();
      for (const [key, entry] of inMemoryStore.entries()) {
        if (entry.resetAt < now) inMemoryStore.delete(key);
      }
    },
    5 * 60 * 1000,
  ).unref?.();
}

// ─── Rate limiter factory ───────────────────────────────────────────────────

/**
 * Optional custom key extractor. When provided, the limiter uses this
 * function's return value (combined with IP) as the rate-limit key,
 * instead of the default `userId`. Used by routes where the keying
 * dimension lives in `req.body` rather than `req.userId` — e.g.
 * guest-OTP routes key on the phone number in the body, which isn't
 * available as `req.userId` (the OTP flow runs PRE-auth).
 *
 * The function MUST be synchronous and MUST NOT throw — returning an
 * empty string falls back to IP-only keying (the safe default for
 * pre-auth routes where the body field is absent or malformed).
 */
export type RateLimitKeyFn = (req: Request) => string;

export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
  keyPrefix?: string;
  /**
   * Custom key extractor. When provided, the limiter key becomes
   * `${ip}:${keyFn(req)}` instead of the default `${ip}:${userId}`.
   * Returning an empty string degrades to IP-only keying.
   */
  keyFn?: RateLimitKeyFn;
}) {
  const {
    windowMs,
    max,
    message = "Too many requests. Please try again later.",
    keyPrefix = "rl",
    keyFn,
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
    // Key derivation:
    //   - Default: `ip:userId` — populated when this limiter runs after
    //     requireAuth. userId is undefined for pre-auth routes like
    //     /mobile-auth/sign-in, which is fine — IP-only is still correct.
    //   - Custom: `ip:keyFn(req)` — used by routes where the keying
    //     dimension lives in req.body (e.g. guest-OTP phone limiters).
    //     keyFn must be synchronous and not throw; an empty return value
    //     degrades to IP-only keying.
    const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    const keyPart = keyFn ? safeKeyFn(keyFn, req) : (req.userId ?? "");
    const key = `${ip}:${keyPart}`;

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
            // Gap #3 fix: Retry-After header (RFC 9110 §10.2.3). Tells
            // clients exactly how many seconds to wait before retrying.
            // All major APIs (GitHub, Stripe, Twitter, AWS) include this
            // on 429 responses. Without it, clients have to guess or poll.
            // Upstash's result.reset is a Unix timestamp in ms.
            const retryAfterSeconds = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
            res.setHeader("Retry-After", retryAfterSeconds);
            res.status(429).json({ error: message, retryAfter: retryAfterSeconds });
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
      // Gap #3 fix: Retry-After header for the in-memory fallback path too.
      // entry.resetAt is a Unix timestamp in ms.
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", retryAfterSeconds);
      res.status(429).json({ error: message, retryAfter: retryAfterSeconds });
      return;
    }
    next();
  };
}

/**
 * Wraps a keyFn so it can never throw into the limiter's hot path. If
 * the function throws (e.g. req.body is missing the expected field),
 * we log once and fall back to an empty string — which the limiter
 * treats as "IP-only keying" (same as the pre-auth default). This is
 * the safe degradation: the request still gets the IP-bucket protection,
 * just without the per-phone (or per-whatever) scoping.
 */
function safeKeyFn(fn: RateLimitKeyFn, req: Request): string {
  try {
    const v = fn(req);
    return typeof v === "string" ? v : "";
  } catch (err) {
    logger.warn(
      { err },
      "Rate limiter: keyFn threw — degrading to IP-only keying for this request",
    );
    return "";
  }
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
  return async function chainedRateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
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
  windowMs: 15 * 60 * 1000, // 15 minutes
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
  windowMs: 60 * 60 * 1000, // 1 hour
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

// YouTube transcript auto-fetch (admin-only, server-side scrape via youtubei.js).
//
// Why this needs a dedicated limiter (vs. relying on requireAdmin alone):
//   YouTube's bot-protection kicks in around ~100 requests/hour per IP on
//   datacenter IPs. Once an IP is flagged, EVERY admin on this Render
//   instance loses the auto-fetch feature (they all hit the same outgoing
//   IP). So a single compromised admin token — or even just an over-eager
//   admin bulk-uploading 50 videos — could permanently break the feature
//   for everyone on the instance.
//
// The limit is intentionally generous enough for normal admin use (10
// fetches/hour = one video every 6 minutes, which is way more than any
// human admin would do) but strict enough to stop the runaway-abuse case.
// If an admin genuinely needs to bulk-import 20+ videos, they should
// paste the URLs into a script and stagger them over a few hours, OR set
// YOUTUBE_SESSION_COOKIE (which makes the bot check a non-issue).
//
// Per-admin (not per-IP) because:
//   - requireAdmin has already authenticated the user by the time this
//     limiter runs, so req.userId is set. The key becomes
//     `youtube:ip:userId`, which means each admin has their own 10/hour
//     budget regardless of how many admins share the server's outgoing IP.
//   - This protects against one bad admin burning the quota for everyone.
export const youtubeFetchLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message:
    "Too many YouTube transcript fetches (10/hour per admin). " +
    "If you need to bulk-import, space requests over a few hours, or set " +
    "YOUTUBE_SESSION_COOKIE to bypass bot protection.",
  keyPrefix: "youtube",
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

// ─── Guest OTP limiters (Part 1 of Daraz-style guest checkout) ──────────────
//
// Two-tier protection against OTP abuse:
//   1. Per-IP: stops a single attacker from spamming OTPs to many numbers
//      from one IP (e.g. a botnet node). 10/hour is generous for a real
//      buyer (one checkout = 1-2 OTP sends) but blocks scripted spam.
//   2. Per-phone: stops an attacker from repeatedly sending OTPs to ONE
//      number (SMS-bombing / WhatsApp-bombing harassment). 3/10min per
//      phone — Daraz uses a similar limit. A real buyer who fat-fingers
//      "resend" 4 times in 10 minutes gets a "please wait" message.
//
// Both apply on SEND (POST /auth/guest-otp/send). VERIFY has its own
// limiter (5/10min per phone) to stop brute-force guessing of the 6-digit
// code — though the OTP-level 5-attempts guard (see lib/guestOtp.ts) is
// the primary brute-force defense, the route limiter adds defense-in-depth
// against an attacker rotating between codes for the same phone.

// Per-IP send limiter — applied first in the chain. Keyed on IP only
// (no userId available pre-auth). 5/hour is tight enough to stop OTP
// bombing across multiple numbers from one IP, while still allowing
// a real buyer (who sends 1-2 OTPs per session) plenty of headroom.
// Daraz uses a similar limit for their OTP send endpoint.
export const guestOtpSendIpLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: "Too many OTP requests from this IP. Please try again later.",
  keyPrefix: "guest-otp-send-ip",
});

// ─── Phone-extracting keyFn (used by the per-phone OTP limiters below) ───────
//
// The previous implementation of per-phone OTP rate limiting used an
// `applyPhoneRateLimit` helper that temporarily MUTATED `req.userId` to
// the normalized phone number before invoking the limiter, then restored
// it. That was a documented hack — it relied on the limiter's key
// derivation being exactly `${ip}:${userId}` and would silently break
// (per-phone limiters collapsing to IP-only keying) if the key format
// ever changed.
//
// The proper fix exposes a `keyFn` option on `createRateLimiter` so
// the limiter's key derivation is configurable at construction time.
// Each phone-keyed limiter below passes a keyFn that reads the phone
// from `req.body.phone` (populated by `express.json()` which runs
// globally before any route middleware). The keyFn returns the
// normalized phone string, or "" if the body is malformed — "" degrades
// to IP-only keying, the same safe default the IP limiter already uses.
//
// Body field: `phone`. This is the raw, unnormalized phone string as
// sent by the client. Normalization happens here (rather than relying
// on the route handler's normalizeBdPhoneForStorage call) so the
// limiter is self-contained and doesn't depend on the handler running
// first — the limiter runs BEFORE the handler in the middleware chain.
import { normalizeBdPhoneForStorage } from "../lib/guestOtp";

const phoneFromBodyKeyFn: RateLimitKeyFn = (req) => {
  const raw = (req.body as { phone?: unknown } | undefined)?.phone;
  if (typeof raw !== "string" || raw.length === 0) return "";
  // Normalize so the same number always maps to the same limiter key
  // regardless of how the client formatted it (+880 vs 880 vs 0 prefix).
  // If normalization fails (invalid format), the limiter still works —
  // it just keys on the raw string, which is fine because an invalid
  // phone will be rejected by the route handler anyway.
  return normalizeBdPhoneForStorage(raw) ?? raw;
};

// Per-phone send limiter — applied second. Keyed on IP + phone (the
// phone comes from req.body via the keyFn defined below — see the
// phoneFromBodyKeyFn comment for why this replaced the old
// applyPhoneRateLimit req.userId hack). 3 per 10 minutes matches
// Daraz's resend throttle — a real buyer rarely needs more than 2
// sends (original + one resend if the first didn't arrive).
export const guestOtpSendPhoneLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 3,
  message: "Too many OTP requests for this phone number. Please wait before requesting a new code.",
  keyPrefix: "guest-otp-send-phone",
  keyFn: phoneFromBodyKeyFn,
});

// Daily cap per phone — applied third. 15 per 24 hours is generous for a
// real buyer (who rarely needs >2-3 in a session) but stops sustained
// abuse that paces itself just under the 10-min rate limit (3 per 10 min
// = 43 per day — this cap of 15 is much tighter).
// Daraz uses ~20/day, Twilio Verify defaults to 10/day.
export const guestOtpDailyCapLimiter = createRateLimiter({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 15,
  message: "Too many OTP requests for this phone number today. Please try again tomorrow.",
  keyPrefix: "guest-otp-daily-cap",
  keyFn: phoneFromBodyKeyFn,
});

// Verify limiter — 5 attempts per 10 minutes per phone. The OTP-level
// 5-attempts guard (lib/guestOtp.ts:MAX_ATTEMPTS) already invalidates
// the code after 5 wrong guesses, but this route-level limiter stops
// an attacker from requesting a new code and immediately burning 5 more
// guesses in a tight loop (the phone-send limiter would eventually
// trip, but this limiter catches the rapid-fire case faster).
export const guestOtpVerifyPhoneLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5,
  message: "Too many verification attempts for this phone number. Please wait before trying again.",
  keyPrefix: "guest-otp-verify-phone",
  keyFn: phoneFromBodyKeyFn,
});

// ─── Wishlist limiter (applies to authenticated AND guest users) ──────────────
//
// All wishlist mutation routes (POST/DELETE /wishlist/:productId, POST/DELETE
// /wishlist/seller-listing-variant/:variantId, POST /wishlist/merge) use
// requireGuestOrAuth, so a guest JWT is enough to write rows. Without a
// per-route limiter, a scripted attacker with one guest JWT could:
//   - Add thousands of wishlist rows (one per product) → DB pollution +
//     bloated GET /wishlist responses for whichever Clerk account later
//     claims that guest phone.
//   - Hammer POST /wishlist/merge in a tight loop to exhaust DB connections.
//
// 60 mutations / 15 min / user is generous for any real buyer (a heavy
// shopping session rarely hearts more than 20-30 items) while stopping
// scripted abuse. Keyed on `ip:userId` (the limiter's default), so each
// guest (with a distinct guest_<phone> userId) gets their own budget.
export const wishlistLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,
  message: "Too many wishlist changes. Please slow down and try again later.",
  keyPrefix: "wishlist",
});

// ─── Review limiter (authenticated only — guests can't review) ───────────────
//
// POST /reviews/:productId and POST /seller-listings/:id/reviews both stayed
// requireAuth (industry standard — Amazon, Daraz, Etsy, Shopee all require
// an account to review). But they had NO per-route limiter, only the global
// apiLimiter (200/15min). Combined with the purchase-eligibility check, an
// attacker is bounded by how many products they've actually purchased — but
// a legitimate power-buyer with 50 past purchases could still flood 200
// reviews in 15 minutes if they scripted it, polluting the review feed.
//
// 10 reviews / hour / user is generous (no real buyer writes more than a
// few reviews per session) while stopping both rapid-fire double-submits
// and paced review-spam attacks.
export const reviewLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: "You've submitted too many reviews recently. Please try again later.",
  keyPrefix: "review",
});

// ─── Public order tracking limiter ──────────────────────────────────────────
//
// GET /orders/track/:trackingId is fully public (no auth, no OTP) — the 48-bit
// random tracking ID is the bearer secret. Without a per-route limiter, an
// attacker could brute-force tracking IDs at 200/15min/IP (the global limiter)
// hoping to land a real order. At ~2^48 tracking-ID entropy this is infeasible
// in absolute terms, but:
//   1. A scripted sweep could still hit real orders by chance over time, and
//      every hit returned the full shipping address (PII leak, now fixed
//      separately by redacting PII in the response).
//   2. The endpoint is otherwise inconsistent with the rest of the system
//      (every other mutation/PII route has a per-route limiter).
//
// 30 lookups / 15 min / IP is generous for a real buyer (who tracks maybe 1-2
// orders at a time) while making brute-force sweeps impractical.
export const trackOrderLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Too many tracking lookups. Please try again later.",
  keyPrefix: "track-order",
});
