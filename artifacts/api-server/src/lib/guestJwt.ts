import jwt from "jsonwebtoken";
import crypto from "crypto";

/**
 * Guest session JWT — phone-verified guest identity for cart/checkout.
 *
 * Part 2 of the Daraz-style guest checkout implementation. After a buyer
 * verifies their phone via OTP (Part 1), this module issues a token pair:
 *   1. Access token (30 min) — used for API auth via Authorization: Bearer
 *   2. Refresh token (7 days) — used to silently obtain new access tokens
 *      WITHOUT re-OTP verification
 *
 * This is the industry-standard pattern (OAuth2, Daraz, Amazon, Shopify):
 *   - Short-lived access token limits the blast radius of a stolen token
 *   - Long-lived refresh token lets the buyer keep shopping across
 *     sessions without re-verifying their phone every 30 minutes
 *   - The refresh token has a DIFFERENT audience claim so it can't be
 *     used as an access token and vice versa
 *
 * Token rotation: each POST /auth/guest-otp/refresh issues a NEW refresh
 * token, invalidating the old one (not enforced server-side yet — would
 * need a Redis blacklist for true rotation, but the short access TTL
 * limits the window). This is the same trade-off as the mobile JWT
 * implementation (see middlewares/mobileJwt.ts).
 *
 * Why a JWT (not just the phone number in a header)?
 *   - A bare phone number in a header can be trivially spoofed — any
 *     caller could claim to be any phone. The JWT's HMAC signature
 *     proves the phone was verified by our OTP flow.
 *   - Same `jsonwebtoken` library + `MOBILE_JWT_SECRET` as mobileJwt.ts —
 *     no new dependencies, no new env vars to configure.
 *
 * Why reuse MOBILE_JWT_SECRET (not a separate GUEST_JWT_SECRET)?
 *   - The issuer + audience claims prevent cross-use between mobile-auth
 *     tokens, guest access tokens, and guest refresh tokens. Each has a
 *     distinct issuer/audience pair, so they can't be confused.
 *   - One fewer env var to manage. Standard practice.
 *
 * Token shapes:
 *
 *   ACCESS token payload:
 *     { phone, type: "guest_access", iss: "treefriend-guest-auth",
 *       aud: "treefriend-guest-api", exp: 30m, iat, jti }
 *
 *   REFRESH token payload:
 *     { phone, type: "guest_refresh", iss: "treefriend-guest-auth",
 *       aud: "treefriend-guest-refresh", exp: 7d, iat, jti }
 */

const GUEST_JWT_SECRET = process.env.MOBILE_JWT_SECRET;

if (!GUEST_JWT_SECRET) {
  throw new Error(
    "MOBILE_JWT_SECRET environment variable is not set. Generate one with " +
      "`openssl rand -base64 48` and add it to your environment variables.",
  );
}

const ISSUER = "treefriend-guest-auth";
const ACCESS_AUDIENCE = "treefriend-guest-api";
const REFRESH_AUDIENCE = "treefriend-guest-refresh";
const ACCESS_EXPIRY = "30m"; // 30 minutes — short-lived for security
const REFRESH_EXPIRY = "7d"; // 7 days — survives across sessions

export interface GuestJwtPayload {
  phone: string; // normalized bare-local form (01XXXXXXXXX)
  jti: string;
}

export interface GuestTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds until access token expires
}

/**
 * Sign a guest ACCESS token for a verified phone number.
 * Short-lived (30 min). Used for API authentication.
 */
function signAccessToken(phone: string): string {
  const jti = crypto.randomUUID();
  return jwt.sign({ phone, type: "guest_access", jti }, GUEST_JWT_SECRET as string, {
    issuer: ISSUER,
    audience: ACCESS_AUDIENCE,
    expiresIn: ACCESS_EXPIRY as any,
    algorithm: "HS256",
  });
}

/**
 * Sign a guest REFRESH token for a verified phone number.
 * Long-lived (7 days). Used ONLY to obtain new access tokens via
 * POST /auth/guest-otp/refresh. Cannot be used for API auth.
 */
function signRefreshToken(phone: string): string {
  const jti = crypto.randomUUID();
  return jwt.sign({ phone, type: "guest_refresh", jti }, GUEST_JWT_SECRET as string, {
    issuer: ISSUER,
    audience: REFRESH_AUDIENCE,
    expiresIn: REFRESH_EXPIRY as any,
    algorithm: "HS256",
  });
}

/**
 * Mint an access + refresh token pair for a newly verified guest.
 *
 * Called by `POST /auth/guest-otp/verify` after `verifyCode` succeeds.
 * The frontend stores BOTH tokens in localStorage:
 *   - Access token: sent as `Authorization: Bearer <token>` on every request
 *   - Refresh token: sent only to `POST /auth/guest-otp/refresh` when the
 *     access token expires
 *
 * When the access token expires (30 min), the frontend calls the refresh
 * endpoint with the refresh token, gets a new access token, and continues
 * — no re-OTP needed. The buyer can shop for up to 7 days without
 * re-verifying their phone.
 */
export function signGuestTokenPair(phone: string): GuestTokenPair {
  return {
    accessToken: signAccessToken(phone),
    refreshToken: signRefreshToken(phone),
    expiresIn: 30 * 60, // 30 minutes in seconds
  };
}

/**
 * Verify a guest ACCESS token. Returns the payload if valid, or null.
 *
 * Called by `requireGuestOrAuth` middleware (middlewares/auth.ts) to
 * authenticate guest requests. Returns null for:
 *   - Expired tokens (30-min TTL)
 *   - Tokens signed with a different secret
 *   - Tokens with the wrong issuer/audience (refresh tokens, mobile-auth
 *     tokens, Clerk tokens, etc.)
 *   - Malformed tokens
 *
 * The caller should treat null as "not a guest token" and fall through
 * to the next auth method (Clerk or mobile JWT).
 */
export function verifyGuestJwt(token: string): GuestJwtPayload | null {
  try {
    const decoded = jwt.verify(token, GUEST_JWT_SECRET as string, {
      issuer: ISSUER,
      audience: ACCESS_AUDIENCE,
      algorithms: ["HS256"],
    });

    if (
      typeof decoded === "object" &&
      (decoded as any).type === "guest_access" &&
      typeof (decoded as any).phone === "string"
    ) {
      return {
        phone: (decoded as any).phone as string,
        jti: (decoded as { jti?: string }).jti ?? "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Verify a guest REFRESH token. Returns the payload if valid, or null.
 *
 * Called ONLY by `POST /auth/guest-otp/refresh` to issue a new access
 * token. A refresh token CANNOT be used as an access token (different
 * audience claim) and vice versa.
 *
 * Returns null for:
 *   - Expired refresh tokens (7-day TTL)
 *   - Access tokens (wrong audience — defense-in-depth)
 *   - Tokens signed with a different secret
 *   - Malformed tokens
 */
export function verifyGuestRefreshToken(token: string): GuestJwtPayload | null {
  try {
    const decoded = jwt.verify(token, GUEST_JWT_SECRET as string, {
      issuer: ISSUER,
      audience: REFRESH_AUDIENCE,
      algorithms: ["HS256"],
    });

    if (
      typeof decoded === "object" &&
      (decoded as any).type === "guest_refresh" &&
      typeof (decoded as any).phone === "string"
    ) {
      return {
        phone: (decoded as any).phone as string,
        jti: (decoded as { jti?: string }).jti ?? "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract and verify a guest ACCESS token from the Authorization header.
 *
 * Returns the payload if the header contains a valid `Bearer <guest-access-jwt>`,
 * or null if the header is absent, not a Bearer token, or the token isn't
 * a valid guest access token.
 *
 * Convenience wrapper for middleware — reads the header, strips the
 * "Bearer " prefix, and calls verifyGuestJwt.
 */
export function extractGuestJwtFromHeader(
  authHeader: string | undefined,
): GuestJwtPayload | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  return verifyGuestJwt(token);
}

// ─── Backward compatibility ──────────────────────────────────────────────────
//
// signGuestJwt() was the old single-token API. It's kept for backward
// compatibility with any code that still calls it, but new code should
// use signGuestTokenPair() which returns both access + refresh tokens.
// The old signGuestJwt returns just the access token (no refresh).

export function signGuestJwt(phone: string): string {
  return signAccessToken(phone);
}
