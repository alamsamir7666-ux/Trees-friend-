import { Router } from "express";
import type { z } from "zod";
import { validateBody } from "../lib/validateRequest";
import { asyncHandler } from "../lib/errors";
import { logger } from "../lib/logger";
import {
  guestOtpSendIpLimiter,
  guestOtpSendPhoneLimiter,
  guestOtpVerifyPhoneLimiter,
} from "../middlewares/rateLimiter";
import { SendGuestOtpBody, VerifyGuestOtpBody } from "../lib/schemas";
import {
  generateAndSend,
  verifyCode,
  normalizeBdPhoneForStorage,
} from "../lib/guestOtp";
import { signGuestJwt } from "../lib/guestJwt";
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
 * The standard rate-limiter middleware keys on IP + optional userId. For
 * phone-keyed limiting, we need to add the phone to the key. This helper
 * runs the limiter manually, with a phone-augmented key.
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
      // Issue a guest JWT — the frontend stores this and sends it as
      // Authorization: Bearer <token> on cart/checkout requests. The
      // token carries the verified phone number, signed with the same
      // MOBILE_JWT_SECRET used for mobile-auth tokens (distinguished by
      // issuer + audience — see lib/guestJwt.ts).
      const guestToken = signGuestJwt(result.phone);

      res.json({
        success: true,
        phone: result.phone,
        sessionExpiresAt: result.sessionExpiresAt!.toISOString(),
        guestToken,
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

export default router;
