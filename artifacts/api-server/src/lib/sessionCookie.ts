/**
 * HttpOnly cookie helpers for AI chat session tokens.
 *
 * ─── Why cookies, not localStorage ──────────────────────────────────────────
 *
 * The previous design stored the bare `crypto.randomUUID()` session token
 * in `localStorage` and sent it on every request as a JSON body field.
 * This is XSS-exfiltrable: any injected script can read localStorage and
 * ship the token off-site, then an attacker can resume the victim's
 * conversation from anywhere in the world.
 *
 * Cookies set with `HttpOnly` are NOT readable from JavaScript at all —
 * only the server sees them. Combined with `Secure` (HTTPS-only) and
 * `SameSite=Lax` (sent on same-site requests + top-level navigations,
 * blocked on cross-site POSTs — the standard CSRF defense), this is the
 * industry-standard transport for session credentials (used by Rails'
 * `cookies.signed`, Django's `SESSION_COOKIE_HTTPONLY`, Express session,
 * Next-auth, every Google/Microsoft auth library, etc.).
 *
 * ─── Cross-origin note ──────────────────────────────────────────────────────
 *
 * If the frontend (Vite dev server, Vercel preview deploys) is on a
 * different origin than the API, the browser will only send the cookie
 * cross-origin if:
 *   - `SameSite=None` (we downgrade when CORS_ORIGIN differs from the
 *     API origin), AND
 *   - `Secure=true` (always set in production; in dev we allow Secure=false
 *     over plain HTTP for localhost testing).
 *
 * The CORS middleware in app.ts is already configured with
 * `credentials: true` (which sets `Access-Control-Allow-Credentials: true`),
 * and the frontend MUST send `credentials: "include"` on every fetch so
 * the browser includes the cookie. See useAiChat.ts for the client side.
 *
 * ─── Backward compatibility / migration ─────────────────────────────────────
 *
 * Existing users have a bare UUID in `localStorage["treebot.sessionToken"]`.
 * On the first request after this change, the backend sees a bare UUID in
 * the request body (no signature). It treats this as a "legacy migration"
 * event:
 *   1. Looks up the UUID in the DB; if found, mints a NEW signed token
 *      bound to that sid.
 *   2. Sets the new token as an HttpOnly cookie + returns it in the SSE
 *      `session` event so the frontend can clear the legacy localStorage
 *      value (the cookie takes over).
 *   3. The old bare UUID is NOT invalidated (we can't, without a DB
 *      migration), but it will stop being used the moment the frontend
 *      deletes it from localStorage. After ~30 days we can drop the
 *      legacy UUID lookup code entirely.
 *
 * If the bare UUID doesn't exist in the DB, the server just mints a fresh
 * anonymous token (no migration — treat as a new visitor).
 */
import { type Request, type Response } from "express";
import { logger } from "./logger";

const COOKIE_NAME = "tf_ai_session";

// Cookie lifetime: 30 days. Matches the refresh-token lifetime for
// mobile auth, which is the closest comparable "I want to stay logged in
// for a while" UX in this codebase. Tunable via env if needed.
const COOKIE_MAX_AGE_SECONDS = Number(process.env.AI_SESSION_COOKIE_MAX_AGE ?? 60 * 60 * 24 * 30);

// Determine if we're in a cross-origin deployment (frontend origin != API
// origin). In that case we need SameSite=None + Secure so the cookie is
// sent on cross-origin credentialed requests. If same-origin (e.g. the
// API serves the frontend), SameSite=Lax is sufficient and safer.
//
// We compute this once at module load (env vars don't change at runtime).
// ALLOWED_ORIGINS is the same env var consumed by the CORS middleware in
// app.ts — if it's a list of origins different from the API origin, we
// treat it as cross-origin.
function isCrossOrigin(): boolean {
  const allowed = process.env.ALLOWED_ORIGINS;
  if (!allowed) return false; // dev with no CORS allowlist
  const origins = allowed
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  if (origins.length === 0) return false;
  // If any allowed origin has a different host than the API (we can't
  // easily know the API origin here without a request), assume cross-origin.
  // Over-conservative is safe — SameSite=None + Secure works for both
  // same-origin and cross-origin.
  return true;
}

const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Cookie attributes. We log them once at startup for debugging.
const COOKIE_ATTRIBUTES = {
  httpOnly: true,
  secure: IS_PRODUCTION, // HTTPS-only in prod; allow HTTP for localhost dev
  sameSite: (isCrossOrigin() ? "none" : "lax") as "none" | "lax" | "strict",
  path: "/",
  maxAge: COOKIE_MAX_AGE_SECONDS * 1000, // Express uses ms, not seconds
} as const;

if (IS_PRODUCTION) {
  logger.info(
    {
      cookie: COOKIE_NAME,
      httpOnly: COOKIE_ATTRIBUTES.httpOnly,
      secure: COOKIE_ATTRIBUTES.secure,
      sameSite: COOKIE_ATTRIBUTES.sameSite,
      maxAgeSeconds: COOKIE_MAX_AGE_SECONDS,
    },
    "AI session cookie attributes initialized",
  );
}

/**
 * Sets the AI chat session token as an HttpOnly cookie on the response.
 *
 * Called from POST /ai/chat after the token has been verified or freshly
 * minted. Also called when rotating an anonymous token to an authenticated
 * one (sign-in transition).
 */
export function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, COOKIE_ATTRIBUTES);
}

/**
 * Reads the AI chat session token from the request cookie.
 *
 * Returns the raw token string (still needs to be verified via
 * `verifySessionToken`) or `null` if no cookie is present.
 *
 * Called from POST /ai/chat AND GET/DELETE /ai/sessions/:token.
 */
export function getSessionCookie(req: Request): string | null {
  const raw = req.cookies?.[COOKIE_NAME];
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw;
}

/**
 * Clears the AI chat session cookie. Called when the user explicitly
 * clears the conversation (DELETE /ai/sessions/:token) so the next
 * request mints a fresh anonymous session.
 */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: COOKIE_ATTRIBUTES.sameSite,
    path: "/",
  });
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
