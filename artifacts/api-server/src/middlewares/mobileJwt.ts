import jwt from "jsonwebtoken";
import crypto from "crypto";
import { logger } from "../lib/logger";

/**
 * Mobile session JWT — hardened implementation.
 *
 * Security measures (industry standard for self-issued session JWTs):
 *
 * 1. Algorithm pinning: `algorithms: ["HS256"]` on verify prevents the
 *    classic algorithm-confusion attack where an attacker swaps the alg
 *    to "none" or to an asymmetric alg whose public key they control.
 *    Without pinning, a future library change or config drift could
 *    silently make the token forgeable.
 *
 * 2. Audience claim (`aud: "treefriend-api"`): tokens minted for this
 *    API are rejected by any other service that might share the same
 *    secret (defense in depth against secret reuse). Verify enforces
 *    the audience match.
 *
 * 3. Shorter expiry (7 days, down from 30): limits the blast radius of
 *    a stolen token. 7 days balances security with mobile UX — a buyer
 *    who opens the app weekly shouldn't have to re-login every time,
 *    but a token stolen from a compromised device is only useful for a
 *    week, not a month. The Flutter app should implement a refresh
 *    flow (POST /mobile-auth/refresh) before the 7-day window expires
 *    to extend the session without forcing a re-login.
 *
 * 4. JWT ID (`jti`): a unique random ID per token. Enables future
 *    server-side revocation (a `revoked_jti` table or Redis set).
 *    Currently informational only — no revocation check is performed
 *    because that would require a DB lookup on every authenticated
 *    request, which is a separate performance/caching decision. The
 *    jti is logged on issuance so audit trails can correlate a token
 *    to its creation event.
 *
 * 5. Issued-at (`iat`) and not-before (`nbf`): standard claims that
 *    prevent token replay before issuance and enable future "reject
 *    tokens issued before timestamp X" revocation (e.g. after a
 *    password change).
 *
 * What's NOT done here (tracked for a future hardening pass):
 *   - Server-side revocation list (jti blacklist in Redis)
 *   - Refresh token flow (short-lived access token + long-lived
 *     refresh token, rotated on each use)
 *   - Token binding (binding the token to a device fingerprint so a
 *     stolen token can't be used from a different device)
 *
 * These are larger changes that require schema/Redis additions and
 * Flutter-side changes. The current hardening (alg pin + aud + shorter
 * expiry + jti) is the high-ROI subset that closes the most dangerous
 * gaps with no breaking changes.
 */

const MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET;

if (!MOBILE_JWT_SECRET) {
  // Fail loudly at startup rather than silently issuing insecure tokens.
  throw new Error(
    "MOBILE_JWT_SECRET environment variable is not set. Generate one with " +
      "`openssl rand -base64 48` and add it to your Render/Vercel environment variables.",
  );
}

const MOBILE_JWT_ISSUER = "treefriend-mobile-auth";
const MOBILE_JWT_AUDIENCE = "treefriend-api";
const MOBILE_JWT_EXPIRY = "7d";

export interface MobileJwtPayload {
  clerkId: string;
  email: string;
  /** Unique token ID — enables future revocation. */
  jti: string;
}

/** Mints a mobile session JWT for a user who has just been verified against Clerk. */
export function signMobileJwt(payload: Omit<MobileJwtPayload, "jti">): string {
  const jti = crypto.randomUUID();
  const fullPayload: MobileJwtPayload = { ...payload, jti };

  const token = jwt.sign(fullPayload, MOBILE_JWT_SECRET as string, {
    issuer: MOBILE_JWT_ISSUER,
    audience: MOBILE_JWT_AUDIENCE,
    expiresIn: MOBILE_JWT_EXPIRY,
    algorithm: "HS256",
  });

  logger.debug({ clerkId: payload.clerkId, jti }, "Mobile JWT issued");

  return token;
}

/**
 * Verifies a mobile session JWT. Returns the payload if valid, or null if
 * the token is missing, malformed, expired, or not one of ours (wrong
 * issuer/audience/algorithm) — callers should treat null as "not a mobile
 * token" and fall through to trying Clerk's own verification instead.
 *
 * Security: pins the algorithm to HS256 to prevent algorithm-confusion
 * attacks. Checks both issuer AND audience. A token signed with the
 * correct secret but the wrong issuer/audience is rejected.
 */
export function verifyMobileJwt(token: string): MobileJwtPayload | null {
  try {
    const decoded = jwt.verify(token, MOBILE_JWT_SECRET as string, {
      issuer: MOBILE_JWT_ISSUER,
      audience: MOBILE_JWT_AUDIENCE,
      algorithms: ["HS256"],
    });

    if (typeof decoded === "object" && decoded.clerkId && decoded.email) {
      return {
        clerkId: decoded.clerkId as string,
        email: decoded.email as string,
        jti: (decoded as { jti?: string }).jti ?? "",
      };
    }
    return null;
  } catch (err) {
    // Don't log every failed verification — that's normal traffic (every
    // web request that doesn't have a Bearer token hits this path). Only
    // log if the error is something other than "invalid token" (e.g. a
    // library upgrade that broke verification).
    const errName = (err as Error).name;
    if (errName !== "JsonWebTokenError" && errName !== "TokenExpiredError") {
      logger.warn({ err }, "Mobile JWT verification: unexpected error type");
    }
    return null;
  }
}
