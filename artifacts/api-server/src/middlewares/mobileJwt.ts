import jwt from "jsonwebtoken";

/**
 * Secret used to sign/verify our own mobile-app session tokens.
 *
 * This is intentionally separate from Clerk entirely — after we verify a
 * user's password against Clerk's Backend API (clerkClient.users.verifyPassword),
 * we mint our own JWT here rather than trying to obtain a real Clerk session
 * token, since Clerk only allows session creation via their Frontend API
 * (which is not recommended for direct/native integration — see
 * https://clerk.com/docs/guides/how-clerk-works/overview).
 *
 * IMPORTANT: set MOBILE_JWT_SECRET in your Render environment variables to
 * a long, random, unique string before deploying. Never reuse an existing
 * secret. Generate one with: openssl rand -base64 48
 */
const MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET;

if (!MOBILE_JWT_SECRET) {
  // Fail loudly at startup rather than silently issuing insecure tokens.
  throw new Error(
    "MOBILE_JWT_SECRET environment variable is not set. Generate one with " +
      "`openssl rand -base64 48` and add it to your Render environment variables.",
  );
}

const MOBILE_JWT_ISSUER = "treefriend-mobile-auth";
const MOBILE_JWT_EXPIRY = "30d";

export interface MobileJwtPayload {
  clerkId: string;
  email: string;
}

/** Mints a mobile session JWT for a user who has just been verified against Clerk. */
export function signMobileJwt(payload: MobileJwtPayload): string {
  return jwt.sign(payload, MOBILE_JWT_SECRET as string, {
    issuer: MOBILE_JWT_ISSUER,
    expiresIn: MOBILE_JWT_EXPIRY,
  });
}

/**
 * Verifies a mobile session JWT. Returns the payload if valid, or null if
 * the token is missing, malformed, expired, or not one of ours (wrong
 * issuer) — callers should treat null as "not a mobile token" and fall
 * through to trying Clerk's own verification instead.
 */
export function verifyMobileJwt(token: string): MobileJwtPayload | null {
  try {
    const decoded = jwt.verify(token, MOBILE_JWT_SECRET as string, {
      issuer: MOBILE_JWT_ISSUER,
    });
    if (typeof decoded === "object" && decoded.clerkId && decoded.email) {
      return { clerkId: decoded.clerkId as string, email: decoded.email as string };
    }
    return null;
  } catch {
    return null;
  }
}
