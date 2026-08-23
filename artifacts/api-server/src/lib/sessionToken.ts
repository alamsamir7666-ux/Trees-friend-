/**
 * Signed session tokens for the AI chat (TreeBot) subsystem.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 *
 * Previously, the AI chat endpoints (`POST /ai/chat`, `GET /ai/sessions/:token`,
 * `DELETE /ai/sessions/:token`) trusted a bare `crypto.randomUUID()` generated
 * by the client and stored in `localStorage`. This had three serious
 * consequences:
 *
 *   1. **IDOR / session hijack**: anyone who learned a victim's token (via
 *      Referer leakage on a cross-origin image, server logs, a shared
 *      browser, an XSS exfiltration despite HttpOnly localStorage being
 *      safe-by-construction for cookies, etc.) could call
 *      `GET /ai/sessions/:token` and read the victim's full conversation
 *      history — including any PII the redactor missed and any order info
 *      the AI surfaced via `get_user_orders` tool calls.
 *
 *   2. **Backfill hijack**: when a signed-in user sent a request with a
 *      token whose DB row had `user_id IS NULL`, the route silently
 *      updated the row to bind the session to the requester's Clerk user
 *      id. An attacker who knew a victim's token could sign in with their
 *      OWN Clerk account, send one chat request with the victim's token,
 *      and "claim" the anonymous conversation as their own — at which
 *      point `get_user_orders` would return the ATTACKER's orders in the
 *      context of the victim's prior questions.
 *
 *   3. **Forgery**: a bare UUID carries no signature. Any client could
 *      mint a syntactically valid token (any v4 UUID works), so the
 *      server had no way to distinguish "token we issued" from "token
 *      someone made up".
 *
 * ─── The fix ─────────────────────────────────────────────────────────────────
 *
 * Session tokens are now **HMAC-signed** by the server. The format is:
 *
 *     <payloadB64>.<sigB64>
 *
 * where:
 *   - `payloadB64` = base64url(JSON{ v, sid, uid, iat })
 *       - `v`   = token format version (currently 1) — lets us evolve the
 *                 format without breaking existing tokens.
 *       - `sid` = the random session id stored in the DB's
 *                 `ai_chat_sessions.session_token` column. This is the
 *                 value used for DB lookups. 122 bits of entropy
 *                 (crypto.randomUUID v4).
 *       - `uid` = the Clerk user id this session is bound to, or `null`
 *                 for anonymous sessions. Once set, the token cannot be
 *                 used by any other user.
 *       - `iat` = issued-at (Unix ms). Used for forced rotation/expiry.
 *   - `sigB64` = base64url(HMAC-SHA256(payloadB64, AI_SESSION_SECRET))
 *
 * Verification is **constant-time** (`crypto.timingSafeEqual`) to prevent
 * timing side-channels from leaking signature bytes. The HMAC is computed
 * over the EXACT base64url payload string the client sent, so any byte-level
 * tampering with the payload before verification fails the signature check.
 *
 * This pattern is the industry standard for stateless session tokens (used
 * by Rails' `signed` cookie jar, Next-auth's CSRF tokens, Django's
 * `signed_cookies` session backend, Iron-style encrypted cookies, etc.).
 *
 * ─── Why HMAC, not JWT? ──────────────────────────────────────────────────────
 *
 * A signed (not encrypted) JWT would also work, but JWT is overkill here:
 *   - We don't need third-party verifiers (the AI chat is single-audience).
 *   - JWT's claims model (iss/aud/exp/nbf) adds bytes we don't need.
 *   - JWT libraries are heavier than ~40 lines of crypto.
 * The compact `payload.sig` format is simpler to reason about and audit.
 *
 * ─── Secret management ──────────────────────────────────────────────────────
 *
 * `AI_SESSION_SECRET` must be set in production. The startup check fails
 * fast (same pattern as `MOBILE_JWT_SECRET` and `CREDENTIAL_ENCRYPTION_KEY`)
 * rather than silently falling back to an insecure default. Generate with:
 *
 *     openssl rand -base64 48
 *
 * Rotating the secret invalidates ALL outstanding tokens (forces everyone
 * to start a new conversation) — back it up the same way you'd back up a
 * database password.
 */
import crypto from "crypto";
import { logger } from "./logger";

// ─── Configuration ───────────────────────────────────────────────────────────

const TOKEN_VERSION = 1;
const ALGORITHM = "sha256";

/**
 * The server-side signing secret. Loaded once at module init (not lazy)
 * because:
 *   - We want startup to fail FAST if the env var is missing in production.
 *   - Every request hits this code path, so lazy init provides no benefit.
 *
 * In test/dev, we fall back to a deterministic value (matching the pattern
 * in test/setupEnv.ts) so tests don't need to set the env var per-file.
 */
const SESSION_SECRET = (() => {
  const raw = process.env.AI_SESSION_SECRET;
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      // In production, fail-fast: no secret = no signed tokens = no AI chat.
      // This is a security-critical config, not a "nice to have".
      throw new Error(
        "AI_SESSION_SECRET environment variable is not set. Generate one with " +
          "`openssl rand -base64 48` and add it to your environment variables. " +
          "Required for signing AI chat session tokens (prevents session forgery " +
          "and IDOR attacks on /api/ai/sessions/*).",
      );
    }
    // Non-production: log once and use a deterministic dev value. Tests
    // override this via setupEnv.ts.
    logger.warn(
      "AI_SESSION_SECRET not set — using insecure dev fallback. " +
        "Do NOT use in production. Generate with: openssl rand -base64 48",
    );
    return "dev-insecure-ai-session-secret-do-not-use-in-prod";
  }
  // Validate minimum strength: HMAC-SHA256 keys should be at least 32 bytes
  // (256 bits) to match the hash output size. Shorter keys weaken the
  // signature against brute-force. We accept base64 or hex strings.
  const buf = Buffer.from(raw);
  if (buf.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `AI_SESSION_SECRET is too short (${buf.length} bytes decoded). ` +
          "Use `openssl rand -base64 48` to generate a 48-byte (384-bit) key.",
      );
    }
    logger.warn(
      `AI_SESSION_SECRET is only ${buf.length} bytes — too short for production. ` +
        "Regenerate with: openssl rand -base64 48",
    );
  }
  return raw;
})();

// ─── Types ───────────────────────────────────────────────────────────────────

/** The decoded payload of a verified session token. */
export interface SessionTokenPayload {
  /** Token format version. Currently always 1. */
  v: number;
  /**
   * The random session id. This is the value stored in the DB's
   * `ai_chat_sessions.session_token` column (used for lookups). The
   * signed token wraps this with an HMAC so it can't be forged.
   */
  sid: string;
  /**
   * The Clerk user id this session is bound to, or `null` for an
   * anonymous session. Once set, the token cannot be used by any
   * other authenticated user (the route verifies uid === req.userId).
   */
  uid: string | null;
  /** Unix ms when the token was issued. Used for forced rotation. */
  iat: number;
}

// ─── Encoding helpers ────────────────────────────────────────────────────────

/** base64url encoder (URL-safe, no padding) — for use in cookies + URLs. */
function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

/** base64url decoder. */
function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

// ─── Sign + Verify ───────────────────────────────────────────────────────────

/** Compute the HMAC-SHA256 signature of `payload` using the session secret. */
function sign(payload: string): string {
  const hmac = crypto.createHmac(ALGORITHM, SESSION_SECRET);
  hmac.update(payload, "utf8");
  return b64url(hmac.digest());
}

/**
 * Mints a signed session token string from a payload.
 *
 * Use this when:
 *   - A new anonymous conversation starts (POST /ai/chat with no token).
 *   - An anonymous user signs in — we issue a new token carrying their
 *     `uid` so subsequent requests bind the session to their identity.
 *   - The frontend explicitly clears + restarts a conversation.
 */
export function signSessionToken(payload: Omit<SessionTokenPayload, "v" | "iat">): string {
  const fullPayload: SessionTokenPayload = {
    v: TOKEN_VERSION,
    sid: payload.sid,
    uid: payload.uid,
    iat: Date.now(),
  };
  const payloadB64 = b64url(JSON.stringify(fullPayload));
  const sig = sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

/**
 * Verifies a signed session token.
 *
 * Returns the decoded payload if the signature is valid AND the token
 * format matches our current version. Returns `null` for any of:
 *   - Malformed input (no `.` separator, base64 decode failure, JSON parse failure)
 *   - Signature mismatch (forged or wrong secret)
 *   - Version mismatch (a future v2 token presented to v1 code)
 *   - Missing required fields (`sid` is mandatory; `uid` may be null)
 *
 * Constant-time comparison (`crypto.timingSafeEqual`) is used for the
 * signature check to prevent timing side-channels from leaking bytes.
 * The comparison is also short-circuit-safe: if the lengths differ, we
 * compare against a dummy buffer of equal length to keep the timing
 * constant (a common pattern — see Go's `crypto/subtle.ConstantTimeCompare`).
 */
export function verifySessionToken(token: string): SessionTokenPayload | null {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
    return null;
  }

  // Split on the LAST `.` in case the base64 payload happens to contain
  // one (base64url doesn't include `.` but defensive coding is cheap).
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === token.length - 1) {
    return null;
  }
  const payloadB64 = token.slice(0, dotIdx);
  const sigB64 = token.slice(dotIdx + 1);

  // Compute the expected signature over the EXACT payload bytes the
  // client sent (not a re-serialized version — that would let an attacker
  // tamper with whitespace, key order, etc.).
  const expectedSig = sign(payloadB64);
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  let receivedBuf: Buffer;
  try {
    receivedBuf = Buffer.from(sigB64, "utf8");
  } catch {
    return null;
  }

  // Constant-time comparison. If lengths differ, compare against the
  // expected buffer itself (always returns false) so we don't leak the
  // expected length via timing.
  let match: boolean;
  if (receivedBuf.length !== expectedBuf.length) {
    crypto.timingSafeEqual(expectedBuf, expectedBuf); // burn cycle, ignore result
    match = false;
  } else {
    match = crypto.timingSafeEqual(receivedBuf, expectedBuf);
  }
  if (!match) return null;

  // Signature valid — decode the payload.
  let payloadJson: string;
  try {
    payloadJson = b64urlDecode(payloadB64).toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== TOKEN_VERSION) return null;
  if (typeof obj.sid !== "string" || obj.sid.length === 0) return null;
  // `uid` may be null (anonymous) or a non-empty string.
  const uid = obj.uid;
  if (uid !== null && (typeof uid !== "string" || uid.length === 0)) {
    return null;
  }
  if (typeof obj.iat !== "number" || !Number.isFinite(obj.iat)) {
    return null;
  }
  return { v: obj.v, sid: obj.sid, uid: uid as string | null, iat: obj.iat };
}

/**
 * Mints a fresh anonymous session token. Convenience wrapper for
 * `signSessionToken({ sid, uid: null })`.
 *
 * Bug fix: now accepts an optional `sid` parameter. If provided, the token
 * carries THAT sid (so the caller can ensure the DB row + cookie share the
 * same sid). If omitted, a fresh `crypto.randomUUID()` is generated (the
 * original behavior — but callers should always pass `sid` to avoid the
 * session-token/cookie mismatch bug that caused chat history to vanish).
 *
 * Use this when a request arrives with no token at all (first-time visitor)
 * or with a token that failed verification (treat as a brand-new session
 * and discard any persisted state tied to the old sid).
 */
export function mintAnonymousSessionToken(sid?: string): string {
  return signSessionToken({ sid: sid ?? crypto.randomUUID(), uid: null });
}

/**
 * Mints a session token bound to an authenticated user. Used when an
 * anonymous user signs in mid-conversation — we rotate to a new token
 * carrying their uid, which:
 *   - Prevents the backfill hijack (the old anonymous token is
 *     invalidated because the new token has a different sid).
 *   - Ensures future `get_user_orders` tool calls are scoped to the
 *     correct user even if the cookie is somehow shared.
 *
 * Bug fix: now accepts an optional `sid` parameter. If provided, the token
 * carries THAT sid (so the caller can ensure the DB row + cookie share the
 * same sid). If omitted, a fresh `crypto.randomUUID()` is generated (the
 * original behavior — but callers should always pass `sid` to avoid the
 * session-token/cookie mismatch bug that caused chat history to vanish).
 */
export function mintAuthenticatedSessionToken(clerkUserId: string, sid?: string): string {
  return signSessionToken({ sid: sid ?? crypto.randomUUID(), uid: clerkUserId });
}

/**
 * Checks whether a token's bound `uid` matches the given (possibly null)
 * authenticated user id.
 *
 * Used by GET/DELETE /ai/sessions/:token to verify ownership:
 *   - Anonymous token (uid=null): allowed for any requester — possession
 *     of the signed token IS the proof of ownership (the sid is 122 bits
 *     of randomness, only known to whoever the server issued it to).
 *   - Authenticated token (uid=X), requester is Y (Y≠X): REJECTED — this
 *     is a hijack attempt (a different signed-in user presenting X's token).
 *   - Authenticated token (uid=X), requester is X: allowed (identity match).
 *   - Authenticated token (uid=X), requester is null (can't resolve identity):
 *     ALLOWED. The signed token itself is the proof of possession (122-bit
 *     entropy + HMAC signature). Requiring Clerk to re-resolve on every GET
 *     caused the "history disappears on reopen" bug: if Clerk's session JWT
 *     expired (or didn't resolve due to cross-origin timing), the GET
 *     returned 403 and the frontend silently showed an empty chat.
 *
 * v3.10 fix: the fourth case (authenticated token, null requester) was
 * previously REJECTED. Now it's ALLOWED — the signed token is sufficient
 * proof. This matches the legacy-UUID migration path's logic, which already
 * allowed this case (see verifySessionAccess in routes/ai.ts).
 *
 * Security trade-off: an attacker who steals the HttpOnly cookie could
 * read history. But the cookie is HttpOnly (no XSS), Secure (HTTPS-only),
 * and SameSite (no CSRF) — stealing it requires a compromised browser or
 * network MITM, which is already a total compromise. The UX cost of
 * rejecting (history disappears) is much higher than the marginal security
 * loss.
 */
export function tokenMatchesIdentity(
  payload: SessionTokenPayload,
  requesterUid: string | null,
): boolean {
  if (payload.uid === null) return true; // anonymous token — possession = ownership
  // Authenticated token:
  //   - If we can resolve the requester AND it's a different user → reject (hijack).
  //   - If we can't resolve the requester (null) → allow (signed token = proof).
  //   - If requester matches → allow.
  if (requesterUid === null) return true; // can't resolve — trust the signed token
  return payload.uid === requesterUid;
}
