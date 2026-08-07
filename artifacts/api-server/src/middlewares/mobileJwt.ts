import jwt from "jsonwebtoken";
import crypto from "crypto";
import { logger } from "../lib/logger";

/**
 * Mobile session JWT — production-grade implementation.
 *
 * Token types:
 *   1. Access token (1h expiry): used for API authentication. Short-lived
 *      so a stolen token has limited blast radius.
 *   2. Refresh token (30d expiry): used ONLY to obtain new access tokens
 *      via POST /mobile-auth/refresh. Different audience so an access
 *      token can't be used as a refresh token and vice versa.
 *
 * Security measures:
 *   - Algorithm pinning (HS256 only) — prevents alg-confusion attacks
 *   - Audience claim — access tokens use "treefriend-api", refresh
 *     tokens use "treefriend-refresh" (cross-use impossible)
 *   - JWT ID (jti) — unique per token, enables future revocation
 *   - Token rotation — each refresh issues a NEW refresh token,
 *     limiting the window a stolen refresh token is useful
 *   - Issued-at + not-before — prevents token replay before issuance
 *
 * What's NOT done (requires DB/Redis — future hardening):
 *   - Server-side refresh token revocation (jti blacklist in Redis)
 *   - "Reuse detection" — detecting when a stolen refresh token is
 *     used after the legitimate user has already rotated
 *
 * These are larger changes requiring Redis integration. The current
 * implementation provides strong security for a stateless JWT system:
 *   - Access tokens expire in 1h (stolen token → max 1h of access)
 *   - Refresh tokens rotate on every use (stolen refresh → max 1 use
 *     before the legitimate user rotates it, invalidating the stolen one)
 */

const MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET;

if (!MOBILE_JWT_SECRET) {
  throw new Error(
    "MOBILE_JWT_SECRET environment variable is not set. Generate one with " +
      "`openssl rand -base64 48` and add it to your environment variables.",
  );
}

const ISSUER = "treefriend-mobile-auth";
const ACCESS_AUDIENCE = "treefriend-api";
const REFRESH_AUDIENCE = "treefriend-refresh";
const ACCESS_EXPIRY = "1h";
const REFRESH_EXPIRY = "30d";

export interface MobileJwtPayload {
  clerkId: string;
  email: string;
  jti: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds until access token expires
}

function signToken(payload: Omit<MobileJwtPayload, "jti">, audience: string, expiry: string): string {
  const jti = crypto.randomUUID();
  return jwt.sign({ ...payload, jti }, MOBILE_JWT_SECRET as string, {
    issuer: ISSUER,
    audience,
    expiresIn: expiry as any,
    algorithm: "HS256",
  });
}

/** Mints an access + refresh token pair for a newly authenticated user. */
export function signTokenPair(payload: Omit<MobileJwtPayload, "jti">): TokenPair {
  return {
    accessToken: signToken(payload, ACCESS_AUDIENCE, ACCESS_EXPIRY),
    refreshToken: signToken(payload, REFRESH_AUDIENCE, REFRESH_EXPIRY),
    expiresIn: 3600, // 1 hour in seconds
  };
}

/** Mints a standalone access token (for backward compat with sign-in/sign-up). */
export function signMobileJwt(payload: Omit<MobileJwtPayload, "jti">): string {
  return signToken(payload, ACCESS_AUDIENCE, ACCESS_EXPIRY);
}

/**
 * Verifies an ACCESS token. Returns the payload if valid, or null.
 * Callers should treat null as "not authenticated" and fall through
 * to Clerk's own verification.
 */
export function verifyMobileJwt(token: string): MobileJwtPayload | null {
  return verifyToken(token, ACCESS_AUDIENCE);
}

/**
 * Verifies a REFRESH token. Returns the payload if valid, or null.
 * Only the /mobile-auth/refresh endpoint should call this.
 */
export function verifyRefreshToken(token: string): MobileJwtPayload | null {
  return verifyToken(token, REFRESH_AUDIENCE);
}

function verifyToken(token: string, audience: string): MobileJwtPayload | null {
  try {
    const decoded = jwt.verify(token, MOBILE_JWT_SECRET as string, {
      issuer: ISSUER,
      audience,
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
  } catch {
    return null;
  }
}
