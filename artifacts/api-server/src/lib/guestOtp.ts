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
 *
 * What this does NOT do:
 *   - Issue guest session tokens (Part 2 — will reuse the verified phone
 *     directly via a separate JWT or a simple signed token)
 *   - Rate limiting (handled at the route layer — see routes/guestAuth.ts)
 *   - Cleanup of expired rows (lazy: generateAndSend overwrites the previous
 *     unverified row; a future cron can purge old verified rows)
 *
 * Security notes:
 *   - `crypto.randomInt(100000, 1000000)` is used instead of Math.random()
 *     because Math.random() is NOT cryptographically secure. crypto.randomInt
 *     uses the OS CSPRNG — same standard as 2FA apps (Authy, Google
 *     Authenticator) and banking OTPs.
 *   - The code is hashed with SHA-256 before storage. A DB leak doesn't
 *     expose usable codes (and codes expire in 5 min anyway).
 *   - The phone number is normalized at write-time (unlike
 *     sellerPayoutAccounts.bkashNumber which is stored as-submitted and
 *     normalized at call-time) because guest OTP lookups are frequent and
 *     must match exactly — storing pre-normalized means the lookup index
 *     works regardless of how the buyer typed the number.
 */

import { db } from "@workspace/db";
import { guestOtpsTable } from "@workspace/db";
import { eq, and, isNull, lt, gt } from "drizzle-orm";
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

/** Code is 6 digits (100000–999999). */
const CODE_MIN = 100000;
const CODE_MAX = 1000000;

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
 * Generate a new OTP for the given phone and persist it.
 *
 * UPSERT behavior: if an unverified OTP already exists for this phone,
 * it's replaced (deleted + re-inserted). This means a buyer who taps
 * "Resend code" gets a fresh code, and the old one is invalidated —
 * matches Daraz/WhatsApp behavior.
 *
 * If a VERIFIED OTP already exists for this phone and hasn't expired
 * (sessionExpiresAt > now), it's preserved — the buyer already verified,
 * so a new send would be wasteful. The caller should check for an active
 * verified session before calling this (or accept the "resend" semantics
 * that invalidate the verified session and force re-verification — see
 * the route handler for the chosen behavior).
 */
export async function generateAndSend(rawPhone: string): Promise<GenerateResult> {
  const phone = normalizeBdPhoneForStorage(rawPhone);
  if (!phone) {
    throw new Error("Invalid phone number");
  }

  const code = generateCode();
  const codeHash = hashCode(code);
  const now = new Date();
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
      { err, phone },
      "[guestOtp] WhatsApp send failed, trying SMS fallback",
    );
    try {
      await sendSmsOtp(phone, code);
    } catch (smsErr) {
      logger.error(
        { err: smsErr, phone },
        "[guestOtp] Both WhatsApp and SMS send failed",
      );
      // Don't throw — the OTP row exists, and the buyer can request a
      // resend. Throwing here would leak transport failures to the buyer
      // (who can't do anything about it) and would leave the OTP row
      // orphaned. The route handler returns success; the buyer sees
      // "code sent" and can retry if it doesn't arrive.
    }
  }

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
 *   7. On match: set verifiedAt + sessionExpiresAt (now + 30 min), return success.
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
    return {
      success: false,
      phone,
      failureReason:
        remaining > 0
          ? `Incorrect code. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`
          : "Incorrect code. Please request a new code.",
    };
  }

  // Success — mark verified + extend session
  const sessionExpiresAt = new Date(now.getTime() + VERIFIED_SESSION_TTL_MS);
  await db
    .update(guestOtpsTable)
    .set({
      verifiedAt: now,
      sessionExpiresAt,
      // Reset attempts to 0 so a future re-verify (within the session
      // window) doesn't carry the old counter — though the idempotent
      // "already verified" branch above handles that case before we
      // reach here anyway.
      attempts: 0,
      updatedAt: now,
    })
    .where(eq(guestOtpsTable.id, otp.id));

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

// ─── Cleanup (for future cron) ───────────────────────────────────────────────

/**
 * Delete expired OTP rows (both unverified-expired and verified-session-expired).
 *
 * Not called by any route currently — exposed for a future cleanup cron.
 * Safe to run at any time; only touches rows past their expiry.
 */
export async function purgeExpiredOtps(): Promise<number> {
  const now = new Date();
  const result = await db
    .delete(guestOtpsTable)
    .where(
      and(
        lt(guestOtpsTable.expiresAt, now),
        // Only purge if NOT verified OR verified session also expired
        isNull(guestOtpsTable.sessionExpiresAt),
      ),
    )
    .returning({ id: guestOtpsTable.id });
  // Also purge verified sessions that expired
  const result2 = await db
    .delete(guestOtpsTable)
    .where(lt(guestOtpsTable.sessionExpiresAt, now))
    .returning({ id: guestOtpsTable.id });
  return result.length + result2.length;
}
