import jwt from "jsonwebtoken";
import crypto from "crypto";

/**
 * Guest session JWT — phone-verified guest identity for cart/checkout.
 *
 * Part 2 of the Daraz-style guest checkout implementation. After a buyer
 * verifies their phone via OTP (Part 1), this module issues a short-lived
 * JWT that carries the verified phone number. The frontend stores this
 * token in localStorage and sends it as `Authorization: Bearer <token>`
 * on every API request. The backend's `requireGuestOrAuth` middleware
 * (see middlewares/auth.ts) validates it and sets `req.userId` to
 * `guest_<phone>` so the existing cart routes work unchanged.
 *
 * Why a JWT (not just the phone number in a header)?
 *   - A bare phone number in a header can be trivially spoofed — any
 *     caller could claim to be any phone. The JWT's HMAC signature
 *     proves the phone was verified by our OTP flow.
 *   - The JWT carries an expiry, so a stolen token has a limited blast
 *     radius (30 min, matching the OTP session TTL).
 *   - Same `jsonwebtoken` library + `MOBILE_JWT_SECRET` as mobileJwt.ts —
 *     no new dependencies, no new env vars to configure.
 *
 * Why reuse MOBILE_JWT_SECRET (not a separate GUEST_JWT_SECRET)?
 *   - The issuer + audience claims prevent cross-use between mobile-auth
 *     tokens and guest tokens. `verifyGuestJwt` rejects any token whose
 *     issuer isn't `treefriend-guest-auth`, so a mobile-auth token can't
 *     be used as a guest token and vice versa.
 *   - One fewer env var to manage. The secret's job is to sign tokens
 *     with a key only the server knows — using the same key for two
 *     different token types (distinguished by issuer/audience) is
 *     standard practice (OAuth2 access tokens + refresh tokens often
 *     share a signing key).
 *
 * Token shape:
 *   Header: { alg: "HS256", typ: "JWT" }
 *   Payload: {
 *     phone: "01700123456",     // normalized bare-local form
 *     type: "guest",            // distinguishes from mobile JWTs
 *     iss: "treefriend-guest-auth",
 *     aud: "treefriend-guest-api",
 *     exp: <now + 30 min>,
 *     iat: <now>,
 *     jti: "<uuid>"              // for future revocation support
 *   }
 */

const GUEST_JWT_SECRET = process.env.MOBILE_JWT_SECRET;

if (!GUEST_JWT_SECRET) {
  throw new Error(
    "MOBILE_JWT_SECRET environment variable is not set. Generate one with " +
      "`openssl rand -base64 48` and add it to your environment variables.",
  );
}

const ISSUER = "treefriend-guest-auth";
const AUDIENCE = "treefriend-guest-api";
const EXPIRY = "30m"; // 30 minutes — matches OTP verified-session TTL

export interface GuestJwtPayload {
  phone: string; // normalized bare-local form (01XXXXXXXXX)
  jti: string;
}

/**
 * Sign a guest JWT for a verified phone number.
 *
 * Called by `POST /auth/guest-otp/verify` after `verifyCode` succeeds.
 * The returned token is sent to the frontend, which stores it in
 * localStorage and attaches it as `Authorization: Bearer <token>` on
 * subsequent requests.
 */
export function signGuestJwt(phone: string): string {
  const jti = crypto.randomUUID();
  return jwt.sign({ phone, type: "guest", jti }, GUEST_JWT_SECRET as string, {
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: EXPIRY as any,
    algorithm: "HS256",
  });
}

/**
 * Verify a guest JWT. Returns the payload if valid, or null.
 *
 * Called by `requireGuestOrAuth` middleware (middlewares/auth.ts) to
 * authenticate guest requests. Returns null for:
 *   - Expired tokens (30-min TTL)
 *   - Tokens signed with a different secret
 *   - Tokens with the wrong issuer/audience (mobile-auth tokens, Clerk
 *     tokens, etc.)
 *   - Malformed tokens
 *
 * The caller should treat null as "not a guest token" and fall through
 * to the next auth method (Clerk or mobile JWT).
 */
export function verifyGuestJwt(token: string): GuestJwtPayload | null {
  try {
    const decoded = jwt.verify(token, GUEST_JWT_SECRET as string, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });

    // Verify the type claim — defense-in-depth against a mobile JWT
    // that happened to share the same issuer/audience (shouldn't happen
    // given they're distinct, but the check is free).
    if (
      typeof decoded === "object" &&
      (decoded as any).type === "guest" &&
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
 * Extract and verify a guest JWT from the Authorization header.
 *
 * Returns the payload if the header contains a valid `Bearer <guest-jwt>`,
 * or null if the header is absent, not a Bearer token, or the token isn't
 * a valid guest JWT.
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
