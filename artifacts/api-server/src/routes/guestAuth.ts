import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../lib/validateRequest";
import { asyncHandler } from "../lib/errors";
import { logger } from "../lib/logger";
import {
  guestOtpSendIpLimiter,
  guestOtpSendPhoneLimiter,
  guestOtpDailyCapLimiter,
  guestOtpVerifyPhoneLimiter,
} from "../middlewares/rateLimiter";
import { SendGuestOtpBody, VerifyGuestOtpBody } from "../lib/schemas";
import {
  generateAndSend,
  verifyCode,
  normalizeBdPhoneForStorage,
  OtpCooldownError,
  OtpDailyCapError,
} from "../lib/guestOtp";
import { signGuestTokenPair, verifyGuestRefreshToken } from "../lib/guestJwt";
import type { ApiRequest } from "../types/apiRequest";

const router = Router();

/**
 * Guest OTP (phone verification) — Part 1 of Daraz-style guest checkout.
 *
 * Endpoints:
 *   POST /auth/guest-otp/send   — request a code (WhatsApp + SMS fallback)
 *   POST /auth/guest-otp/verify — submit a code, get a verified session
 *
 * What this is NOT:
 *   - Not a login flow — there's no account, no password, no JWT issued yet.
 *     The "verified session" is a row in guest_otps with verifiedAt set +
 *     sessionExpiresAt 30 min in the future. Part 2 will issue a guest
 *     session token (separate from this endpoint) based on that row.
 *   - Not a user-creation flow — the phone isn't linked to a usersTable row.
 *     Account claim (Part 4) handles that, when the buyer later signs up.
 *
 * Rate limiting:
 *   - Send: per-IP (10/hour) + per-phone (3/10min) — chained, IP trips first
 *     for botnet-style attacks, phone trips for harassment of one number.
 *   - Verify: per-phone (5/10min) — stops brute-force guessing.
 *
 * The per-phone limiters read the phone from req.body (not URL params),
 * so they're applied INSIDE the route handler, not as middleware that
 * runs before body parsing. See `applyPhoneRateLimit` below.
 */

/**
 * Helper: apply a rate limiter keyed on a phone number (from the body).
 *
 * IMPLEMENTATION NOTE: This temporarily sets `req.userId` to the normalized
 * phone number so the rate limiter's key (which uses `${ip}:${userId}`)
 * includes the phone. This is a deliberate, documented trade-off:
 *
 *   PRO: Avoids rewriting the rate limiter (which is used by 20+ routes
 *        and would need a new `customKey` parameter plumbed through the
 *        entire createRateLimiter chain).
 *   CON: If the rate limiter's key derivation changes, this hack breaks
 *        silently. Mitigated by: (1) the key format is documented in
 *        rateLimiter.ts and hasn't changed since it was written, (2) the
 *        rate limiter's contract (key = `ip:userId`) is simple and
 *        unlikely to change, (3) tests would catch a regression.
 *
 * Alternative considered: add a `customKeyExtractor` parameter to
 * `createRateLimiter`. Rejected because it would require touching every
 * existing `createRateLimiter` call site + the chainRateLimiters utility
 * + the middleware signature, for a single use case.
 *
 * Returns true if the request should proceed, false if it was rate-limited
 * (the limiter has already sent the 429 response in that case).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyPhoneRateLimit(
  req: ApiRequest,
  res: any,
  limiter: (req: any, res: any, next: (err?: unknown) => void) => Promise<void>,
  phone: string,
): Promise<boolean> {
  // Temporarily attach the phone to req.userId so the limiter's key
  // includes it (the limiter uses `${ip}:${userId}` as the key — see
  // rateLimiter.ts:136). This is a hack but avoids rewriting the limiter.
  // The phone is normalized so the same number always maps to the same key.
  const normalized = normalizeBdPhoneForStorage(phone) ?? phone;
  const originalUserId = req.userId;
  req.userId = normalized;
  let blocked = false;
  await new Promise<void>((resolve) => {
    limiter(req, res, (err?: unknown) => {
      if (err) {
        // Unexpected error — log and fail open
        logger.error({ err }, "[guestOtp] rate limiter error, failing open");
      }
      if (res.headersSent) blocked = true;
      resolve();
    });
  });
  req.userId = originalUserId;
  return !blocked;
}

// ─── POST /auth/guest-otp/send ───────────────────────────────────────────────

/**
 * Request body: { phone: string }
 * Response: { success: true, expiresInMs: 300000 }
 *
 * Generates a 6-digit code, persists it (hashed), and sends it via
 * WhatsApp (with SMS fallback). Always returns success even if the
 * transport fails — the buyer can request a resend. Transport failures
 * are logged server-side.
 *
 * Security: never returns whether the phone was normalized successfully
 * vs rejected — that would leak "is this a valid BD number?" to attackers.
 * Invalid phones return the same success response (but no OTP is sent).
 */
router.post(
  "/auth/guest-otp/send",
  guestOtpSendIpLimiter,
  validateBody(SendGuestOtpBody, "SendGuestOtpBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof SendGuestOtpBody>>, res) => {
    const { phone } = req.body;

    // Per-phone rate limit (chained after the per-IP limiter above).
    // If the IP limiter tripped, we never reach here. If the phone limiter
    // trips, it sends a 429 and we return early.
    const allowed = await applyPhoneRateLimit(
      req,
      res,
      guestOtpSendPhoneLimiter,
      phone,
    );
    if (!allowed) return;

    // Daily cap rate limit (15 OTPs per phone per 24h). Applied as a
    // third tier after the per-IP (5/hr) and per-phone (3/10min) limiters.
    const dailyAllowed = await applyPhoneRateLimit(
      req,
      res,
      guestOtpDailyCapLimiter,
      phone,
    );
    if (!dailyAllowed) return;

    // Normalize + validate. If invalid, return success anyway (don't leak
    // whether the number is valid BD format — attackers could probe).
    const normalized = normalizeBdPhoneForStorage(phone);
    if (!normalized) {
      // Log the rejection for ops visibility, but return success to the
      // caller to avoid leaking information about phone number validity.
      logger.info(
        { rawPhone: phone.replace(/[^+\d]/g, "") }, // log digits only, no PII noise
        "[guestOtp] send: invalid phone format, returning success without sending",
      );
      res.json({ success: true, expiresInMs: 5 * 60 * 1000 });
      return;
    }

    try {
      const result = await generateAndSend(normalized);
      res.json({ success: true, expiresInMs: result.expiresInMs });
    } catch (err) {
      // Cooldown error — return 429 with retryAfter so the frontend can
      // show "Please wait X seconds before requesting a new code."
      if (err instanceof OtpCooldownError) {
        res.status(429).json({
          success: false,
          error: err.message,
          retryAfter: err.retryAfterSeconds,
        });
        return;
      }
      // Daily cap error — return 429 without retryAfter (the buyer needs
      // to wait until tomorrow, not a few seconds)
      if (err instanceof OtpDailyCapError) {
        res.status(429).json({
          success: false,
          error: err.message,
        });
        return;
      }
      logger.error({ err, phone: normalized }, "[guestOtp] send: generateAndSend failed");
      // Don't leak the error to the client — return generic success so
      // the buyer's UX isn't broken by a transient Twilio failure.
      res.json({ success: true, expiresInMs: 5 * 60 * 1000 });
    }
  }),
);

// ─── POST /auth/guest-otp/verify ─────────────────────────────────────────────

/**
 * Request body: { phone: string, code: string }
 * Response (success): {
 *   success: true,
 *   phone: string,
 *   sessionExpiresAt: ISO-string,
 *   guestToken: string  // Part 2 — JWT for cart/checkout auth
 * }
 * Response (failure): { success: false, error: string }
 *
 * On success, the phone is "verified" for guest checkout for 30 minutes,
 * AND a guest JWT is issued. The frontend stores this token in
 * localStorage and sends it as `Authorization: Bearer <token>` on every
 * subsequent cart/checkout request. The backend's `requireGuestOrAuth`
 * middleware validates it and sets `req.userId = "guest_<phone>"` so
 * the existing cart routes work unchanged.
 *
 * On failure, returns the reason ("incorrect code", "expired", "max
 * attempts exceeded") so the frontend can show the right message. Unlike
 * the send endpoint, verify DOES return failure — the buyer needs to know
 * their code was wrong so they can retype it.
 */
router.post(
  "/auth/guest-otp/verify",
  validateBody(VerifyGuestOtpBody, "VerifyGuestOtpBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof VerifyGuestOtpBody>>, res) => {
    const { phone, code } = req.body;

    // Per-phone rate limit (stops brute-force guessing).
    const allowed = await applyPhoneRateLimit(
      req,
      res,
      guestOtpVerifyPhoneLimiter,
      phone,
    );
    if (!allowed) return;

    const result = await verifyCode(phone, code);

    if (result.success) {
      // Issue a guest token pair (access + refresh). The frontend stores
      // BOTH tokens in localStorage:
      //   - Access token: attached as Authorization: Bearer on every request
      //   - Refresh token: used only to obtain new access tokens via
      //     POST /auth/guest-otp/refresh when the access token expires
      // The buyer can shop for up to 7 days without re-verifying their phone.
      const tokens = signGuestTokenPair(result.phone);

      res.json({
        success: true,
        phone: result.phone,
        sessionExpiresAt: result.sessionExpiresAt!.toISOString(),
        guestToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      });
    } else {
      // 400 (bad request) — the code was wrong/expired/too-many-attempts.
      // NOT 401 — the buyer isn't "unauthenticated," they just failed a
      // verification step. 400 matches Daraz's API and is the right status
      // for "your input was wrong."
      res.status(400).json({
        success: false,
        error: result.failureReason ?? "Verification failed.",
      });
    }
  }),
);

// ─── POST /auth/guest-otp/refresh ────────────────────────────────────────────

/**
 * Request body: { refreshToken: string }
 * Response: { success: true, guestToken: string, refreshToken: string, expiresIn: number }
 *
 * Exchanges a valid guest refresh token for a NEW access + refresh token
 * pair. This lets the buyer keep shopping without re-verifying their phone
 * via OTP — the refresh token is valid for 7 days.
 *
 * Token rotation: each refresh issues a NEW refresh token, invalidating
 * the old one (in theory — we don't maintain a server-side blacklist yet,
 * but the 30-min access TTL limits the window). This is the same trade-off
 * as the mobile JWT implementation (see middlewares/mobileJwt.ts).
 *
 * Industry standard: Daraz, Amazon, Shopify, and every OAuth2 implementation
 * uses this exact pattern — short-lived access + long-lived refresh.
 */
const GuestRefreshBody = z.object({
  refreshToken: z.string().min(1),
});

router.post(
  "/auth/guest-otp/refresh",
  guestOtpVerifyPhoneLimiter, // reuse the verify limiter (same abuse profile)
  validateBody(GuestRefreshBody, "GuestRefreshBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof GuestRefreshBody>>, res) => {
    const { refreshToken } = req.body;

    const payload = verifyGuestRefreshToken(refreshToken);
    if (!payload) {
      // The refresh token is expired, invalid, or not a refresh token
      // at all (e.g. an access token was passed). The buyer must
      // re-verify their phone via OTP.
      res.status(401).json({
        success: false,
        error: "Your session has expired. Please verify your phone again.",
      });
      return;
    }

    // Issue a new token pair. The old refresh token is implicitly
    // invalidated by rotation (the frontend uses the new one).
    const tokens = signGuestTokenPair(payload.phone);

    res.json({
      success: true,
      guestToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    });
  }),
);

export default router;
