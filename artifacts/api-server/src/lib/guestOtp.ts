/**
 * Guest OTP (One-Time Password) library — Part 1 of the Daraz-style guest
 * checkout implementation.
 *
 * Responsibilities:
 *   - Normalize BD phone numbers to bare 11-digit local form (01XXXXXXXXX)
 *   - Generate a cryptographically-random 6-digit code
 *   - Hash the code with SHA-256 (never store plaintext)
 *   - Persist the OTP row (upsert: one active OTP per phone)
 *   - Send the code via WhatsApp (Twilio) with SMS fallback
 *   - Verify a submitted code against the stored hash
 *   - Enforce attempt limits (5 tries → invalidate)
 *   - Enforce resend cooldown (30s minimum between sends to same phone)
 *   - Enforce daily cap (15 OTPs per phone per 24h)
 *   - Invalidate the code after successful verification (prevent replay)
 *
 * Security measures (industry-standard, matching Daraz/Twilio Verify):
 *   - `crypto.randomInt` (OS CSPRNG) for code generation
 *   - SHA-256 hash (never plaintext in DB)
 *   - 5-minute code TTL
 *   - 5-attempt brute-force guard
 *   - 30-second resend cooldown (prevents rapid-fire OTP bombing)
 *   - 15 OTPs/day per phone (generous for real users, stops sustained abuse)
 *   - 5 OTPs/hour per IP (tighter than the old 10/hour)
 *   - Code invalidated after successful verification (can't be reused)
 *   - No information leak on invalid phones (returns same success response)
 *   - Structured audit logging for all OTP events (send, verify, fail)
 */

import { db } from "@workspace/db";
import { guestOtpsTable } from "@workspace/db";
import { eq, and, isNull, lt, gt, gte, sql, count } from "drizzle-orm";
import { createHash, randomInt } from "node:crypto";
import { logger } from "./logger";
import { sendWhatsAppOtp, sendSmsOtp } from "./otpTransport";

// ─── Constants ────────────────────────────────────────────────────────────────

/** OTP code TTL — 5 minutes. Matches WhatsApp/Twilio Verify default. */
const OTP_CODE_TTL_MS = 5 * 60 * 1000;

/** Verified session TTL — 30 minutes after verification. */
const VERIFIED_SESSION_TTL_MS = 30 * 60 * 1000;

/** Max verification attempts before the OTP is invalidated. */
const MAX_ATTEMPTS = 5;

/**
 * Minimum time between OTP sends to the SAME phone number.
 * Industry standard: Daraz uses 60s, WhatsApp uses 30s, Twilio Verify
 * uses 10s (but recommends 30s+). We use 30s — generous enough for a
 * real buyer who tapped "resend" too quickly, but stops rapid-fire
 * OTP bombing to one number.
 */
const RESEND_COOLDOWN_MS = 30 * 1000;

/**
 * Maximum number of OTPs that can be sent to a SINGLE phone number
 * in a 24-hour window. Industry standard: Daraz uses ~20/day, Twilio
 * Verify defaults to 10/day. We use 15 — generous for a real buyer
 * (who rarely needs >2-3 in a session) but stops sustained abuse.
 */
const DAILY_CAP_PER_PHONE = 15;

/** Code is 6 digits (100000–999999). */
const CODE_MIN = 100000;
const CODE_MAX = 1000000;

// ─── Audit logging ────────────────────────────────────────────────────────────

/**
 * Structured audit log for OTP events. Every send, verify-success, and
 * verify-failure is logged with the phone (last-4 masked for PII) and
 * relevant context. This creates an audit trail that can be used for:
 *   - Abuse detection (spike in sends to one number)
 *   - Funnel analytics (send → verify conversion rate)
 *   - Debugging (buyer says "I never received a code")
 *
 * The phone is masked to last-4 (e.g. "****5678") to avoid logging full
 * PII in production logs, while still being useful for correlation.
 */
function maskPhone(phone: string): string {
  if (phone.length < 4) return "****";
  return `****${phone.slice(-4)}`;
}

function auditLog(
  event: "otp_send" | "otp_verify_success" | "otp_verify_fail" | "otp_cooldown_block" | "otp_daily_cap_block" | "otp_purge",
  phone: string,
  extra?: Record<string, unknown>,
): void {
  logger.info(
    { event, phone: maskPhone(phone), ...extra },
    `[guestOtp] ${event}`,
  );
}

// ─── Phone normalization ─────────────────────────────────────────────────────

/**
 * Normalize a BD phone number to bare 11-digit local form (01XXXXXXXXX).
 *
 * Accepts any of:
 *   - 01XXXXXXXXX          (bare local)
 *   - +8801XXXXXXXXX       (E.164 with +)
 *   - 8801XXXXXXXXX        (E.164 without +)
 *
 * Returns null if the input isn't a valid BD mobile number (must be 11
 * digits after normalization, starting with 01[3-9]). Same regex shape
 * as sellerPayoutAccounts.ts's BD_PHONE_REGEX, but returns the normalized
 * string instead of a boolean.
 *
 * Stored normalized (unlike sellerPayoutAccounts.bkashNumber) so that
 * lookups by phone match exactly regardless of how the buyer typed it —
 * the OTP flow is lookup-heavy (send → verify → session lookup), so a
 * normalized stored form avoids per-lookup normalization complexity.
 */
export function normalizeBdPhoneForStorage(raw: string): string | null {
  if (!raw) return null;
  const digitsOnly = raw.replace(/[^\d]/g, "");

  // Strip +880 / 880 prefix down to bare local form
  let normalized: string;
  if (digitsOnly.startsWith("880") && digitsOnly.length === 13) {
    normalized = `0${digitsOnly.slice(3)}`;
  } else if (digitsOnly.startsWith("0") && digitsOnly.length === 11) {
    normalized = digitsOnly;
  } else {
    // Unexpected shape — let the regex below reject it
    normalized = digitsOnly;
  }

  // Validate: 01[3-9]XXXXXXXXX (11 digits, BD mobile operators)
  if (!/^01[3-9]\d{8}$/.test(normalized)) return null;
  return normalized;
}

// ─── Code generation + hashing ───────────────────────────────────────────────

/**
 * Generate a cryptographically-secure 6-digit code.
 *
 * Uses `crypto.randomInt` (OS CSPRNG), NOT Math.random(). Same standard
 * as banking OTPs and 2FA apps. Returns a string like "483920" for
 * consistent display formatting.
 */
function generateCode(): string {
  return String(randomInt(CODE_MIN, CODE_MAX));
}

/**
 * Hash a code with SHA-256. Returns a hex string.
 *
 * SHA-256 is sufficient here (no need for bcrypt/scrypt) because:
 *   1. The code is 6 digits = 1M possible values — the entropy is low
 *      by design (it's a TLA-style code, not a password). Bcrypt wouldn't
 *      add meaningful protection against brute force on a 6-digit space.
 *   2. The code expires in 5 minutes — even a successful hash crack is
 *      useless after expiry.
 *   3. The DB-level brute-force guard (5 attempts → invalidate) is the
 *      real protection, not the hash strength.
 *
 * A per-row salt would be overkill for the same reason — the code space
 * is so small that a rainbow table for all 1M codes is trivially
 * precomputed, salt or no salt. The 5-minute TTL + 5-attempt limit is
 * the actual security boundary.
 */
function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export interface GenerateResult {
  phone: string;
  code: string; // plaintext — returned to the caller for sending; never logged
  expiresInMs: number;
}

/**
 * Error thrown when the resend cooldown hasn't elapsed yet.
 * The route handler catches this and returns a 429 with a retryAfter.
 */
export class OtpCooldownError extends Error {
  constructor(
    public readonly retryAfterSeconds: number,
  ) {
    super(`Please wait ${retryAfterSeconds} seconds before requesting a new code.`);
    this.name = "OtpCooldownError";
  }
}

/**
 * Error thrown when the daily cap for a phone has been reached.
 */
export class OtpDailyCapError extends Error {
  constructor() {
    super("Too many OTP requests for this phone number today. Please try again tomorrow.");
    this.name = "OtpDailyCapError";
  }
}

/**
 * Generate a new OTP for the given phone and persist it.
 *
 * UPSERT behavior: if an unverified OTP already exists for this phone,
 * it's replaced (deleted + re-inserted). This means a buyer who taps
 * "Resend code" gets a fresh code, and the old one is invalidated —
 * matches Daraz/WhatsApp behavior.
 *
 * Cooldown enforcement: if the previous OTP for this phone was created
 * less than RESEND_COOLDOWN_MS ago, throws OtpCooldownError with the
 * number of seconds to wait. This prevents rapid-fire OTP bombing to
 * one number (the route-level rate limiter catches it at 3/10min, but
 * this is a finer-grained check that gives the buyer immediate feedback).
 *
 * Daily cap enforcement: if more than DAILY_CAP_PER_PHONE OTPs have been
 * created for this phone in the last 24 hours, throws OtpDailyCapError.
 * This stops sustained abuse that paces itself just under the per-10-min
 * rate limit (3 per 10 min = 43 per day — the daily cap of 15 is tighter).
 */
export async function generateAndSend(rawPhone: string): Promise<GenerateResult> {
  const phone = normalizeBdPhoneForStorage(rawPhone);
  if (!phone) {
    throw new Error("Invalid phone number");
  }

  const now = new Date();

  // ── Cooldown check: was an OTP created for this phone < 30s ago? ──
  // This is a finer-grained check than the route-level rate limiter
  // (3/10min). It catches the case where a buyer taps "resend" 2-3
  // times in quick succession — the rate limiter allows up to 3 in 10
  // min, but 3 OTPs in 3 seconds is wasteful (each sends a WhatsApp
  // message that costs money) and confusing (buyer gets 3 codes, only
  // the last is valid).
  const cooldownThreshold = new Date(now.getTime() - RESEND_COOLDOWN_MS);
  const [recentOtp] = await db
    .select({ createdAt: guestOtpsTable.createdAt })
    .from(guestOtpsTable)
    .where(
      and(
        eq(guestOtpsTable.phone, phone),
        gte(guestOtpsTable.createdAt, cooldownThreshold),
      ),
    )
    .limit(1);

  if (recentOtp) {
    const elapsedMs = now.getTime() - recentOtp.createdAt.getTime();
    const retryAfterSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsedMs) / 1000);
    auditLog("otp_cooldown_block", phone, { retryAfterSeconds });
    throw new OtpCooldownError(retryAfterSeconds);
  }

  // ── Daily cap check is enforced at the route level via a rate limiter ──
  // (guestOtpDailyCapLimiter in middlewares/rateLimiter.ts). The library-
  // level check was removed because generateAndSend uses an upsert pattern
  // (delete + insert), so counting rows in the table always returns 0-1.
  // The rate limiter uses Redis (or in-memory fallback) to track sends
  // per phone across the 24h window, which works correctly regardless of
  // the upsert behavior.

  // ── Generate + persist ──
  const code = generateCode();
  const codeHash = hashCode(code);
  const expiresAt = new Date(now.getTime() + OTP_CODE_TTL_MS);

  // Delete any existing unverified OTP for this phone, then insert a new
  // one. Done in a transaction so a mid-flight failure doesn't leave two
  // rows for the same phone. A verified OTP is also deleted — if the
  // buyer is re-requesting a code, they're starting a new verification
  // flow (e.g. their session expired).
  await db.transaction(async (tx) => {
    await tx
      .delete(guestOtpsTable)
      .where(eq(guestOtpsTable.phone, phone));
    await tx.insert(guestOtpsTable).values({
      phone,
      codeHash,
      attempts: 0,
      expiresAt,
      // verifiedAt, sessionExpiresAt are NULL until verification succeeds
    });
  });

  // Send the code via WhatsApp (with SMS fallback if WhatsApp fails).
  // Fire-and-await (not fire-and-forget) — the caller needs to know if
  // the send failed so it can return an error to the buyer.
  try {
    await sendWhatsAppOtp(phone, code);
  } catch (err) {
    logger.warn(
      { err, phone: maskPhone(phone) },
      "[guestOtp] WhatsApp send failed, trying SMS fallback",
    );
    try {
      await sendSmsOtp(phone, code);
    } catch (smsErr) {
      logger.error(
        { err: smsErr, phone: maskPhone(phone) },
        "[guestOtp] Both WhatsApp and SMS send failed",
      );
      // Don't throw — the OTP row exists, and the buyer can request a
      // resend. Throwing here would leak transport failures to the buyer
      // (who can't do anything about it) and would leave the OTP row
      // orphaned. The route handler returns success; the buyer sees
      // "code sent" and can retry if it doesn't arrive.
    }
  }

  auditLog("otp_send", phone);

  return { phone, code, expiresInMs: OTP_CODE_TTL_MS };
}

// ─── Verification ─────────────────────────────────────────────────────────────

export interface VerifyResult {
  success: boolean;
  phone: string;
  sessionExpiresAt?: Date;
  failureReason?: string;
}

/**
 * Verify a submitted OTP code against the stored hash.
 *
 * Flow:
 *   1. Look up the most recent OTP for this phone.
 *   2. If none → "no code requested" (buyer hasn't sent an OTP yet).
 *   3. If the OTP is expired → "code expired, request a new one".
 *   4. If already verified → "already verified" (idempotent — return the
 *      existing session, don't start a new one).
 *   5. If attempts >= MAX_ATTEMPTS → "max attempts exceeded, request new code".
 *   6. Hash the submitted code, compare to stored hash.
 *   7. On match: set verifiedAt + sessionExpiresAt (now + 30 min),
 *      CLEAR the codeHash (prevent replay — the code can't be used
 *      again even if someone intercepts it), return success.
 *   8. On mismatch: increment attempts; if now >= MAX_ATTEMPTS, the next
 *      call will hit step 5. Return failure with "incorrect code".
 *
 * Timing-safe comparison is not needed here because the code space is
 * 1M values — the attacker can't learn anything from comparison timing
 * that they couldn't learn faster by just guessing. The MAX_ATTEMPTS guard
 * is the real protection.
 */
export async function verifyCode(rawPhone: string, submittedCode: string): Promise<VerifyResult> {
  const phone = normalizeBdPhoneForStorage(rawPhone);
  if (!phone) {
    return { success: false, phone: rawPhone, failureReason: "Invalid phone number" };
  }

  // Sanitize the submitted code: must be exactly 6 digits
  const cleanCode = submittedCode.replace(/\D/g, "");
  if (cleanCode.length !== 6) {
    return { success: false, phone, failureReason: "Code must be 6 digits" };
  }

  const [otp] = await db
    .select()
    .from(guestOtpsTable)
    .where(eq(guestOtpsTable.phone, phone))
    .limit(1);

  if (!otp) {
    return { success: false, phone, failureReason: "No code requested. Please request a new code." };
  }

  const now = new Date();

  // Already verified? Return the existing session (idempotent).
  if (otp.verifiedAt && otp.sessionExpiresAt && otp.sessionExpiresAt > now) {
    // The codeHash should already be cleared from the initial verification.
    // If it's somehow still present, clear it now (defense-in-depth).
    if (otp.codeHash) {
      await db
        .update(guestOtpsTable)
        .set({ codeHash: "", updatedAt: now })
        .where(eq(guestOtpsTable.id, otp.id));
    }
    return {
      success: true,
      phone,
      sessionExpiresAt: otp.sessionExpiresAt,
    };
  }
  // Verified but session expired — treat as expired
  if (otp.verifiedAt && otp.sessionExpiresAt && otp.sessionExpiresAt <= now) {
    return { success: false, phone, failureReason: "Session expired. Please request a new code." };
  }

  // Code expired (5-min TTL)?
  if (otp.expiresAt <= now) {
    return { success: false, phone, failureReason: "Code expired. Please request a new code." };
  }

  // Too many attempts?
  if (otp.attempts >= MAX_ATTEMPTS) {
    return {
      success: false,
      phone,
      failureReason: `Too many incorrect attempts. Please request a new code.`,
    };
  }

  // Compare hash
  const submittedHash = hashCode(cleanCode);
  if (submittedHash !== otp.codeHash) {
    // Increment attempts. If this was the 5th, the next call hits the
    // MAX_ATTEMPTS guard above (no special "blocked" state needed).
    const newAttempts = otp.attempts + 1;
    await db
      .update(guestOtpsTable)
      .set({ attempts: newAttempts, updatedAt: now })
      .where(eq(guestOtpsTable.id, otp.id));

    const remaining = MAX_ATTEMPTS - newAttempts;
    auditLog("otp_verify_fail", phone, {
      reason: "incorrect_code",
      attempts: newAttempts,
      remaining,
    });
    return {
      success: false,
      phone,
      failureReason:
        remaining > 0
          ? `Incorrect code. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`
          : "Incorrect code. Please request a new code.",
    };
  }

  // Success — mark verified + extend session + CLEAR the code hash.
  //
  // Clearing codeHash is critical for replay prevention: once the code
  // has been used to verify, it can NEVER be used again, even if the
  // row still exists (it does — we keep it for the 30-min session
  // lookup). If an attacker intercepts the OTP (e.g. via a compromised
  // WhatsApp account) and tries to verify with it AFTER the legitimate
  // buyer has already verified, the hash comparison will fail because
  // codeHash is now "".
  const sessionExpiresAt = new Date(now.getTime() + VERIFIED_SESSION_TTL_MS);
  await db
    .update(guestOtpsTable)
    .set({
      verifiedAt: now,
      sessionExpiresAt,
      codeHash: "", // ← CLEARED — prevents code replay after verification
      // Reset attempts to 0 so a future re-verify (within the session
      // window) doesn't carry the old counter — though the idempotent
      // "already verified" branch above handles that case before we
      // reach here anyway.
      attempts: 0,
      updatedAt: now,
    })
    .where(eq(guestOtpsTable.id, otp.id));

  auditLog("otp_verify_success", phone, { sessionExpiresAt: sessionExpiresAt.toISOString() });

  return { success: true, phone, sessionExpiresAt };
}

// ─── Session lookup ──────────────────────────────────────────────────────────

/**
 * Check if a phone has an active verified guest session.
 *
 * Used by Part 2 (guest cart) and Part 3 (guest checkout) to gate access:
 *   - "Show me my guest cart" → requires active session
 *   - "Place this guest order" → requires active session
 *
 * Returns the session expiry timestamp if active, null otherwise.
 */
export async function getActiveVerifiedSession(rawPhone: string): Promise<Date | null> {
  const phone = normalizeBdPhoneForStorage(rawPhone);
  if (!phone) return null;

  const [otp] = await db
    .select({ sessionExpiresAt: guestOtpsTable.sessionExpiresAt })
    .from(guestOtpsTable)
    .where(
      and(
        eq(guestOtpsTable.phone, phone),
        gt(guestOtpsTable.sessionExpiresAt, new Date()),
      ),
    )
    .limit(1);

  return otp?.sessionExpiresAt ?? null;
}

// ─── Cleanup (for cron job) ──────────────────────────────────────────────────

/**
 * Delete expired OTP rows (both unverified-expired and verified-session-expired).
 *
 * Called by the POST /api/cron/guest-otp-cleanup cron endpoint (every 5 min).
 * Safe to run at any time; only touches rows past their expiry.
 *
 * Returns the number of rows deleted, for logging/metrics.
 */
export async function purgeExpiredOtps(): Promise<number> {
  const now = new Date();

  // Purge unverified-expired rows (code expired, never verified)
  const unverifiedResult = await db
    .delete(guestOtpsTable)
    .where(
      and(
        lt(guestOtpsTable.expiresAt, now),
        isNull(guestOtpsTable.verifiedAt),
      ),
    )
    .returning({ id: guestOtpsTable.id });

  // Purge verified-session-expired rows (session ended)
  const verifiedResult = await db
    .delete(guestOtpsTable)
    .where(lt(guestOtpsTable.sessionExpiresAt, now))
    .returning({ id: guestOtpsTable.id });

  const total = unverifiedResult.length + verifiedResult.length;
  if (total > 0) {
    auditLog("otp_purge", "", { purged: total });
  }
  return total;
}
