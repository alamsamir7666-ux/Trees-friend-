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
 *   - Send: per-IP (5/hr) + per-phone (3/10min) + per-phone daily cap (15/24h)
 *     — chained, IP trips first for botnet-style attacks, phone trips for
 *     harassment of one number, daily cap stops paced abuse.
 *   - Verify: per-phone (5/10min) — stops brute-force guessing.
 *
 * Per-phone limiters use a `keyFn` that reads `req.body.phone` (populated
 * by express.json() which runs globally before any route middleware).
 * This replaced the old `applyPhoneRateLimit` helper that temporarily
 * mutated req.userId — see rateLimiter.ts's phoneFromBodyKeyFn comment
 * for the full rationale.
 */

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
 *
 * Rate limiting order (chained):
 *   1. guestOtpSendIpLimiter   (per-IP, 5/hr)      — mounted as middleware
 *   2. validateBody             (Zod parse of { phone }) — provides req.body
 *   3. guestOtpSendPhoneLimiter (per-phone, 3/10min) — middleware, reads req.body.phone via keyFn
 *   4. guestOtpDailyCapLimiter  (per-phone, 15/24h) — middleware, same keyFn
 *   5. route handler            — generateAndSend + send via WhatsApp/SMS
 *
 * Steps 3 and 4 must run AFTER validateBody (step 2) so req.body.phone
 * is populated when their keyFn fires. Express runs middlewares in the
 * order they're listed in the router.post(...) call, so this ordering
 * is structural, not runtime-configurable.
 */
router.post(
  "/auth/guest-otp/send",
  guestOtpSendIpLimiter,
  validateBody(SendGuestOtpBody, "SendGuestOtpBody"),
  guestOtpSendPhoneLimiter,
  guestOtpDailyCapLimiter,
  asyncHandler(async (req: ApiRequest<z.infer<typeof SendGuestOtpBody>>, res) => {
    const { phone } = req.body;

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
 *
 * Rate limiting order (chained):
 *   1. validateBody               (Zod parse of { phone, code })
 *   2. guestOtpVerifyPhoneLimiter  (per-phone, 5/10min) — reads req.body.phone via keyFn
 *   3. route handler               — verifyCode + signGuestTokenPair
 */
router.post(
  "/auth/guest-otp/verify",
  validateBody(VerifyGuestOtpBody, "VerifyGuestOtpBody"),
  guestOtpVerifyPhoneLimiter,
  asyncHandler(async (req: ApiRequest<z.infer<typeof VerifyGuestOtpBody>>, res) => {
    const { phone, code } = req.body;

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
 *
 * Rate limiting: reuses guestOtpVerifyPhoneLimiter (5/10min per IP — the
 * refresh body has no phone field, so the phone-keyed keyFn returns "" and
 * the limiter degrades to IP-only keying, which is correct for refresh
 * since the abuse vector here is scripted token-rotation floods from one
 * IP, not harassment of one phone number).
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
