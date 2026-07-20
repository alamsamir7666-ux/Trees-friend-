/**
 * Runs before every test file (vitest.config.ts `setupFiles`), and before
 * anything in this file imports `../src/app` transitively -- several
 * modules throw at import time if their required env var is absent
 * (middlewares/mobileJwt.ts -> MOBILE_JWT_SECRET, lib/credentialEncryption.ts
 * -> CREDENTIAL_ENCRYPTION_KEY is lazy but still needs a valid value once a
 * courier/payment-config test calls it, lib/db -> DATABASE_URL). Setting
 * these here, rather than per-file, guarantees every test file sees the
 * same values and none can accidentally run without them.
 *
 * DATABASE_URL is intentionally NOT defaulted here -- if it's missing, every
 * test should fail loudly (via lib/db's own "did you forget to provision a
 * database?" error) rather than silently pointing at some other database.
 * The reproduction steps in PART3_HANDOFF.md always set it explicitly.
 *
 * CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY are syntactically valid but
 * entirely fake -- see PART3_HANDOFF.md for why these are required at all
 * (app.ts's clerkMiddleware runs globally, before requireAuth ever gets a
 * chance to try the mobile-JWT path first) and why fake values are safe
 * here (every request in this suite authenticates via a self-signed mobile
 * JWT; Clerk's own verifier is never actually invoked for those requests,
 * it just needs to not throw at middleware-construction time).
 */

process.env.MOBILE_JWT_SECRET ??= "test-mobile-jwt-secret-do-not-use-in-prod";
// Must decode to exactly 32 bytes (see lib/credentialEncryption.ts's loadKey).
process.env.CREDENTIAL_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.CLERK_PUBLISHABLE_KEY ??= "pk_test_Y2xlcmsudGVzdC5leGFtcGxlLmNvbSQ";
process.env.CLERK_SECRET_KEY ??= `sk_test_${"a".repeat(40)}`;
process.env.NODE_ENV ??= "test";
