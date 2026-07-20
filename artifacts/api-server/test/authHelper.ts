import { signMobileJwt } from "../src/middlewares/mobileJwt";

/**
 * Signs a real mobile-app session JWT using the test process's own
 * MOBILE_JWT_SECRET (set in test/setupEnv.ts before this module is ever
 * imported). This is the exact function the real Flutter app's backend
 * call site invokes after verifying a password against Clerk
 * (routes/mobileAuth.ts) -- nothing here is a shortcut or a bypass flag.
 *
 * Pass this token as `Authorization: Bearer <token>` on a supertest
 * request and it drives requireAuth's resolveIdentity() -> real DB
 * upsert -> real role/status resolution exactly as production does for a
 * mobile client, no mocking of any of that chain.
 */
export function mintMobileJwt(clerkId: string, email: string): string {
  return signMobileJwt({ clerkId, email });
}

export function authHeader(clerkId: string, email: string): { Authorization: string } {
  return { Authorization: `Bearer ${mintMobileJwt(clerkId, email)}` };
}
