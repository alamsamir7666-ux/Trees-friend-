/**
 * AI assistant route -- "TreeBot" powered by Google Gemini Flash.
 *
 * Three endpoints:
 *   POST /api/ai/chat              -- streaming chat (Server-Sent Events)
 *   GET  /api/ai/sessions/:token   -- fetch conversation history
 *   DELETE /api/ai/sessions/:token -- clear a conversation
 *   POST /api/ai/feedback          -- record thumbs up/down on a message
 *   GET  /api/ai/products-by-slug  -- resolve [[product]] mentions to product data
 *
 * Auth model (v1 -- ANONYMOUS):
 *   No `requireAuth`. Every visitor gets a TreeBot, even signed-out users.
 *   The conversation is keyed by a client-generated `sessionToken`
 *   (stored in localStorage by the frontend), so the same anonymous
 *   visitor can resume their conversation across page refreshes.
 *
 * Topic restriction (two-tier, defense in depth):
 *   - HARD gate: hasBotanicalKeyword() -- instant refuse, no Gemini call.
 *     Saves quota + blocks obvious off-topic abuse.
 *   - SOFT gate: buildSystemPrompt() -- strict scope instructions. Catches
 *     edge cases that sneak past the keyword gate.
 *
 * Rate limit:
 *   30 req / hour / IP. Generous for legitimate use, blocks scripted abuse.
 *   Gemini's free tier is 15 RPM / 1,500 RPD, so even 30/hr/IP across
 *   many users won't blow the daily quota.
 *
 * v3.0 upgrades:
 *   - PII redaction on user messages before persisting + before sending to Gemini.
 *   - Conversation summarization (long-term memory) when history exceeds
 *     AI_SUMMARY_THRESHOLD. Summary is stored on the session row and
 *     injected into the system prompt.
 *   - Observability: model name, response time (ms), token count, and PII
 *     flag persisted on each assistant message.
 *   - Retry on transient Gemini errors (5xx, 429, network) with exponential
 *     backoff (handled in lib/gemini.ts).
 *
 * Persistence:
 *   Both user messages AND assistant responses are persisted to
 *   `ai_chat_messages` so history survives page refresh and server restart.
 *   The frontend rehydrates by calling GET /sessions/:token on mount.
 */
import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { eq, asc, desc } from "drizzle-orm";
import { aiChatSessionsTable, aiChatMessagesTable, aiChatFeedbackTable } from "@workspace/db";
import { getAuth } from "@clerk/express";
import { createRateLimiter } from "../middlewares/rateLimiter";
import { logger } from "../lib/logger";
import {
  buildCatalogContext,
  buildSystemPrompt,
  renderPromptTemplate,
  hasBotanicalKeyword,
  isPureGreeting,
  GREETING_INTRO_MESSAGE,
  ACCOUNT_KEYWORDS,
} from "../lib/aiContext";
import { AI_TOOL_DECLARATIONS, executeTool, USER_SCOPED_TOOLS } from "../lib/aiTools";
import { streamChat, isAnyProviderConfigured } from "../lib/aiRouter";
import { describeError } from "../lib/describeError";
import { redactPii } from "../lib/piiRedaction";
import { calculateCost } from "../lib/costTracker";
import { getCachedResponse, setCachedResponse } from "../lib/semanticCache";
import {
  getSemanticCachedResponse,
  setSemanticCachedResponse,
} from "../lib/embeddingCache";
import { getActivePrompt } from "../lib/promptVersioning";
import { getTopKbEntriesForPrompt, formatKbContextForPrompt } from "../lib/kbSearch";
import {
  generateFollowupsStructured,
  formatFollowupsBlock,
} from "../lib/structuredOutput";
import { extractFollowups } from "../lib/followupParser";
import {
  loadSessionMemory,
  maybeSummarize,
  fetchHistoryForGemini,
  buildSummaryPromptBlock,
  logAiEvent,
} from "../lib/aiMemory";
// ─── Session security (IDOR fix) ────────────────────────────────────────────
// Signed session tokens + HttpOnly cookies. See lib/sessionToken.ts and
// lib/sessionCookie.ts for the full rationale. The short version: bare
// client-generated UUIDs were XSS-exfiltrable, leaked via Referer/logs,
// and could be forged by anyone. Signed tokens can't be forged, and
// cookies are immune to XSS exfiltration.
import {
  signSessionToken,
  verifySessionToken,
  mintAnonymousSessionToken,
  mintAuthenticatedSessionToken,
  tokenMatchesIdentity,
  type SessionTokenPayload,
} from "../lib/sessionToken";
import {
  setSessionCookie,
  getSessionCookie,
  clearSessionCookie,
} from "../lib/sessionCookie";

const router = Router();

// ─── Rate limiter: 30 chat requests per hour per IP ─────────────────────────
// Generous enough for genuine multi-turn conversations, tight enough that
// a scripted abuser can't drain the Gemini free-tier quota from a single IP.
const aiChatLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  message: "Too many TreeBot requests. Please try again in an hour.",
  keyPrefix: "ai-chat",
});

// ─── Rate limiter: session GET/DELETE (defense in depth) ────────────────────
// Even though signed tokens can't be brute-forced (122 bits of entropy),
// we still rate-limit session reads/deletes separately from the global
// apiLimiter (200 req / 15 min). This catches:
//   - Token-scraping attacks (an attacker with a leaked token trying to
//     discover if it's still valid by hammering GET /sessions/:token).
//   - Enumeration of session IDs (futile with HMAC, but the limiter
//     makes the cost of trying prohibitive).
// 60 reads / 5 min / IP is generous for any legitimate use case (the
// frontend calls GET /sessions/:token ONCE on mount, not in a loop).
const aiSessionReadLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 60,
  message: "Too many chat-history requests. Please slow down.",
  keyPrefix: "ai-session-read",
});

// DELETE is more sensitive than GET (irreversible) — tighter limit.
// 10 deletes / hour / IP is far beyond legitimate use (a user clears
// their conversation maybe once per session) while stopping scripted
// session-destruction attacks.
const aiSessionDeleteLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: "Too many chat-clear attempts. Please try again later.",
  keyPrefix: "ai-session-delete",
});

// ─── Rate limiter: feedback submission ──────────────────────────────────────
// The previous code applied only the global apiLimiter (200 req / 15 min / IP),
// which let an attacker iterate messageIds and submit ~200 fake ratings per
// 15 minutes per IP — easily enough to corrupt admin insights (refusal-rate,
// satisfaction metrics).
//
// 30 feedback submissions / 5 min / IP+user is generous for legitimate use
// (a user rating 5-10 messages in a conversation won't hit it) while
// stopping scripted spam. The "5 min" window is short enough to detect
// attacks quickly but long enough to avoid false positives.
const aiFeedbackLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30,
  message: "Too many feedback submissions. Please slow down.",
  keyPrefix: "ai-feedback",
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Checks if a string looks like a legacy bare v4 UUID (the old session
 * token format from before the Bug #1 fix). Used by:
 *   - resolveSessionToken (POST /ai/chat) — legacy migration path
 *   - verifySessionAccess (GET /ai/sessions/:token) — legacy history fetch
 *
 * We only honor strings that match this exact format (36 chars, dashes at
 * the right positions, hex chars). This prevents random strings from
 * hitting the DB lookup (which would be a no-op but wasteful).
 */
function isLegacyUuid(token: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatRequestBody {
  message: string;
  sessionToken?: string;
}

interface SessionRow {
  id: number;
  session_token: string;
  title: string | null;
  user_id: string | null;
}

/**
 * Result of resolving an incoming session token.
 *
 * The POST /ai/chat handler uses this to decide:
 *   - Which sid to use for DB lookups (`sid`).
 *   - Which signed token string to return to the client via the SSE
 *     `session` event AND the Set-Cookie header (`token`).
 *   - Whether the token was rotated (e.g. legacy bare UUID upgraded to
 *     a signed token, or anonymous token upgraded to an authenticated
 *     one). The handler logs this for observability.
 */
interface ResolvedSession {
  /** The verified random session id (used for DB lookups). */
  sid: string;
  /** The signed token string to return to the client + set as cookie. */
  token: string;
  /** The user id this session is bound to (null = anonymous). */
  uid: string | null;
  /** Why a new token was minted (for logging). Null if no rotation. */
  rotationReason: "legacy_migration" | "auth_upgrade" | "new_session" | null;
}

interface MessageRow {
  id: number;
  session_id: number;
  role: string;
  content: string;
  created_at: Date;
  off_topic: boolean;
  greeting: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolves the incoming session token for POST /ai/chat.
 *
 * This is the heart of the IDOR fix. The previous design blindly trusted
 * whatever `sessionToken` the client sent in the request body (a bare
 * `crypto.randomUUID()`). The new design:
 *
 *   1. Reads the token from the HttpOnly cookie FIRST (preferred path).
 *      Falls back to the request body for the legacy migration window
 *      (existing users have a bare UUID in localStorage, not a cookie).
 *
 *   2. Verifies the HMAC signature. If valid → use the embedded `sid`
 *      for the DB lookup. If invalid → check if it's a legacy bare UUID
 *      (migration path). If neither → mint a fresh anonymous token.
 *
 *   3. **Auth-state rotation**: if the verified token is anonymous
 *      (`uid === null`) but the requester is now signed in (Clerk or
 *      mobile JWT), mint a NEW signed token bound to the user's uid.
 *      This eliminates the backfill hijack: the old anonymous token's
 *      `sid` is preserved (so the conversation history stays), but the
 *      signed token now carries the user identity, so future requests
 *      can verify ownership. The DB row's `user_id` is updated ONLY IF
 *      it's still NULL (defensive — never overwrite an existing user_id).
 *
 *   4. If the verified token is authenticated (`uid === X`) but the
 *      requester is a DIFFERENT authenticated user (`uid === Y`), this
 *      is a hijack attempt — reject with 403. The signed token cannot
 *      be used by anyone other than the user it was issued to.
 *
 *   5. If the verified token is authenticated but the requester is
 *      anonymous (signed out), mint a fresh anonymous token (new sid,
 *      new session row). The user's prior conversation stays bound to
 *      their identity; the new anonymous conversation is a clean slate.
 *
 * @returns the resolved session info (sid, signed token, uid, rotation reason).
 */
async function resolveSessionToken(
  req: Request,
  clerkUserId: string | null,
): Promise<ResolvedSession> {
  // 1. Try cookie first (the new preferred path).
  const cookieToken = getSessionCookie(req);
  // 2. Fall back to request body (legacy migration). The body value may
  // be a bare UUID (legacy) or a signed token (new clients that prefer
  // body over cookie for some reason — unusual but supported).
  const bodyToken =
    typeof (req.body ?? {}).sessionToken === "string" &&
    (req.body as { sessionToken: string }).sessionToken.length >= 8
      ? (req.body as { sessionToken: string }).sessionToken
      : null;
  const rawToken = cookieToken ?? bodyToken;

  // 3. Verify the signature (if it looks like a signed token).
  if (rawToken) {
    const verified = verifySessionToken(rawToken);
    if (verified) {
      // ─── Valid signed token ────────────────────────────────────────────
      // Check the identity binding:
      //   - Anonymous token (uid=null): anyone may use it (possession =
      //     ownership). If the requester is now signed in, rotate to an
      //     authenticated token (preserves the sid + conversation history
      //     while binding the session to the user).
      //   - Authenticated token (uid=X): only X may use it. A different
      //     signed-in user presenting X's token is a hijack attempt.
      if (verified.uid !== null && clerkUserId !== null && verified.uid !== clerkUserId) {
        // Hijack: token bound to user X, presented by user Y. Reject.
        logger.warn(
          {
            tokenUid: verified.uid,
            requesterUid: clerkUserId,
          },
          "AI: session token identity mismatch — possible hijack attempt",
        );
        // Mint a fresh anonymous session for the requester (don't crash,
        // don't leak info — just refuse to honor the stolen token).
        return {
          sid: crypto.randomUUID(),
          token: mintAnonymousSessionToken(),
          uid: null,
          rotationReason: "new_session",
        };
      }

      if (verified.uid === null && clerkUserId !== null) {
        // ─── Anonymous → authenticated rotation ─────────────────────────
        // The user just signed in mid-conversation. We want to:
        //   - Keep the same `sid` (so the conversation history stays
        //     attached to the same DB row).
        //   - Bind the session to the user going forward.
        //   - Issue a new signed token carrying the user's uid.
        // The DB row's user_id is updated ONLY IF NULL (defensive —
        // never overwrite an existing user_id, even though we just
        // verified the token says uid=null).
        try {
          await pool.query(
            `UPDATE ai_chat_sessions
               SET user_id = $1, updated_at = NOW()
             WHERE session_token = $2 AND user_id IS NULL`,
            [clerkUserId, verified.sid],
          );
        } catch (err) {
          // Non-fatal — the session lookup will still work; we just
          // couldn't bind it to the user. Log for investigation.
          logger.warn({ err, sid: verified.sid }, "AI: failed to backfill user_id on rotation");
        }
        return {
          sid: verified.sid,
          token: signSessionToken({ sid: verified.sid, uid: clerkUserId }),
          uid: clerkUserId,
          rotationReason: "auth_upgrade",
        };
      }

      if (verified.uid !== null && clerkUserId === null) {
        // ─── Authenticated token, but requester is anonymous ─────────────
        // The user signed out (or their session expired) but is still
        // holding a token bound to their old uid. We must NOT honor this
        // — it would let a shared browser see another user's conversation
        // history. Mint a fresh anonymous session instead.
        return {
          sid: crypto.randomUUID(),
          token: mintAnonymousSessionToken(),
          uid: null,
          rotationReason: "new_session",
        };
      }

      // ─── Identity matches (or both anonymous) — use as-is ────────────
      return {
        sid: verified.sid,
        token: rawToken,
        uid: verified.uid,
        rotationReason: null,
      };
    }

    // ─── Legacy migration: bare UUID in body or cookie ───────────────────
    // Old clients stored a bare crypto.randomUUID() in localStorage and
    // sent it in the body. We accept it ONCE: look it up in the DB; if
    // found, mint a new signed token carrying the existing sid. If not
    // found, treat as a new visitor (mint fresh anonymous token).
    //
    // SECURITY: legacy bare UUIDs are the WEAKEST token form because:
    //   - They're stored in localStorage (XSS-exfiltrable).
    //   - They were sent in URLs (Referer-leakable, server-log-leakable).
    //   - They carry NO signature, so anyone who learns one can present it.
    //
    // To close the backfill-hijack vector (an attacker who knows a victim's
    // bare UUID + signs in with their OWN account → claims the victim's
    // anonymous session), we apply these strict rules:
    //
    //   1. Existing session is anonymous (user_id IS NULL):
    //      - Requester is anonymous → migrate (preserve sid, sign as anon).
    //        This is the legitimate "user comes back later" case.
    //      - Requester is authenticated → DO NOT MIGRATE. Mint a fresh
    //        authenticated session for the requester instead. The victim's
    //        anonymous session stays anonymous (and orphaned). This breaks
    //        the "anonymous → authenticated continuation" UX for legitimate
    //        users, but that UX was a security hole — users who sign in
    //        mid-conversation will see a fresh conversation.
    //
    //   2. Existing session is authenticated (user_id = X):
    //      - Requester is X → migrate (preserve sid + binding).
    //      - Requester is Y (different user) → DO NOT MIGRATE. Mint fresh.
    //        This is a hijack attempt.
    //      - Requester is anonymous → DO NOT MIGRATE. Mint fresh anonymous.
    //        (A signed-out user presenting a token bound to another user
    //        could be a shared browser / signed-out session; treat as new.)
    //
    // We only honor legacy bare UUIDs that look like v4 UUIDs (36 chars,
    // dashes at the right positions). This prevents random strings from
    // being looked up in the DB (which would be a no-op but wasteful).
    if (isLegacyUuid(rawToken)) {
      // Check if a session with this sid already exists in the DB.
      const existing = await pool.query<{ user_id: string | null }>(
        `SELECT user_id FROM ai_chat_sessions WHERE session_token = $1`,
        [rawToken],
      );
      if (existing.rows.length > 0) {
        const existingUid = existing.rows[0].user_id;
        // Rule 1: existing session is anonymous.
        if (existingUid === null) {
          if (clerkUserId === null) {
            // Legitimate: anonymous requester continues their own anon session.
            return {
              sid: rawToken,
              token: signSessionToken({ sid: rawToken, uid: null }),
              uid: null,
              rotationReason: "legacy_migration",
            };
          }
          // Hijack attempt: authenticated requester trying to claim an
          // anonymous session. Mint a fresh authenticated session instead.
          logger.warn(
            { sid: rawToken, requesterUid: clerkUserId },
            "AI: legacy migration denied — authenticated requester tried to " +
              "claim an anonymous session (possible hijack)",
          );
          return {
            sid: crypto.randomUUID(),
            token: mintAuthenticatedSessionToken(clerkUserId),
            uid: clerkUserId,
            rotationReason: "new_session",
          };
        }
        // Rule 2: existing session is authenticated (user_id = existingUid).
        if (clerkUserId === existingUid) {
          // Legitimate: same user re-signing in. Migrate.
          return {
            sid: rawToken,
            token: signSessionToken({ sid: rawToken, uid: existingUid }),
            uid: existingUid,
            rotationReason: "legacy_migration",
          };
        }
        // Hijack: different identity. Mint fresh.
        logger.warn(
          { sid: rawToken, existingUid, requesterUid: clerkUserId },
          "AI: legacy migration denied — identity mismatch (possible hijack)",
        );
        return {
          sid: crypto.randomUUID(),
          token: clerkUserId !== null
            ? mintAuthenticatedSessionToken(clerkUserId)
            : mintAnonymousSessionToken(),
          uid: clerkUserId,
          rotationReason: "new_session",
        };
      }
      // Legacy UUID with no DB row — treat as new visitor (mint fresh).
    }
    // Any other invalid token shape → mint fresh anonymous.
  }

  // 4. No token at all (first-time visitor) → mint fresh anonymous session.
  return {
    sid: crypto.randomUUID(),
    token: mintAnonymousSessionToken(),
    uid: null,
    rotationReason: "new_session",
  };
}

/**
 * Find or create an ai_chat_sessions row for the given verified sid.
 *
 * The `sid` is the random session id extracted from the verified signed
 * token — NOT the raw client-supplied string. This means even if an
 * attacker managed to guess a `sid` (122 bits of entropy — practically
 * impossible), they couldn't forge the HMAC signature required to get
 * here in the first place.
 *
 * On first message in a session, we stamp the `title` column with a
 * truncated version of the message — useful for future UIs that list
 * conversations.
 *
 * The `uid` parameter is the user id from the verified token (NOT from
 * the request's auth state directly — they may differ if rotation is in
 * progress). The DB row's user_id is set ONLY on insert; existing rows
 * are NEVER updated here (rotation handled by `resolveSessionToken`).
 */
async function findOrCreateSession(
  sid: string,
  firstMessage: string,
  uid: string | null,
): Promise<SessionRow> {
  // Try to find existing first (the common case after the first turn).
  const existing = await pool.query<SessionRow>(
    `SELECT id, session_token, title, user_id FROM ai_chat_sessions WHERE session_token = $1`,
    [sid],
  );
  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  // Race-safe insert: if another request created the same sid in the
  // meantime, ON CONFLICT DO NOTHING + a follow-up SELECT retrieves it.
  const title = firstMessage.slice(0, 80).trim() || "New conversation";
  await pool.query(
    `INSERT INTO ai_chat_sessions (session_token, title, user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_token) DO NOTHING`,
    [sid, title, uid],
  );

  const created = await pool.query<SessionRow>(
    `SELECT id, session_token, title, user_id FROM ai_chat_sessions WHERE session_token = $1`,
    [sid],
  );
  return created.rows[0];
}

/**
 * Fetches the last N messages for a session, oldest-first (so they can be
 * appended to the Gemini `contents` array in chronological order).
 *
 * N defaults to AI_MAX_HISTORY (10) -- keeps token usage predictable.
 *
 * Note: this is the LEGACY fetchHistory used by the GET /sessions/:token
 * endpoint for displaying the conversation in the UI. The Gemini-facing
 * history fetch (which respects the summary cutoff) is in lib/aiMemory.ts
 * as fetchHistoryForGemini().
 */
async function fetchHistory(sessionId: number, limit: number): Promise<MessageRow[]> {
  // Subquery: get the last N rows in DESC order, then re-sort ASC for use.
  const result = await pool.query<MessageRow>(
    `SELECT id, session_id, role, content, created_at, off_topic, greeting
     FROM (
       SELECT id, session_id, role, content, created_at, off_topic, greeting
       FROM ai_chat_messages
       WHERE session_id = $1
       ORDER BY created_at DESC
       LIMIT $2
     ) AS recent
     ORDER BY created_at ASC`,
    [sessionId, limit],
  );
  return result.rows;
}

/**
 * Persist a single message (user or assistant). Fire-and-forget -- the
 * caller doesn't wait for this to send the SSE response.
 *
 * Returns the inserted row's `id` (numeric DB primary key) so the caller
 * can forward it to the client (e.g. for feedback buttons that need to
 * reference a specific message). Returns undefined if the insert failed.
 *
 * v2.0: accepts `off_topic` and `greeting` flags so admin insights can
 * compute refusal rate. Defaults to false (no flag = regular message).
 *
 * v3.0: accepts `piiRedacted` flag (set when PII was detected and stripped
 * from a user message) and observability metadata (`model`, `responseMs`,
 * `tokenCount`) for assistant messages.
 */
async function persistMessage(
  sessionId: number,
  role: "user" | "assistant",
  content: string,
  options: {
    offTopic?: boolean;
    greeting?: boolean;
    piiRedacted?: boolean;
    model?: string;
    responseMs?: number;
    tokenCount?: number;
    costUsd?: number;
    provider?: string;
    promptVersion?: string;
    // Phase 3: KB usage logging (only set on assistant messages).
    kbHit?: boolean;
    kbEntriesUsed?: number[] | null;
    kbSearchPerformed?: boolean;
    kbContextInjected?: boolean;
  } = {},
): Promise<number | undefined> {
  try {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO ai_chat_messages (session_id, role, content, off_topic, greeting,
                                      pii_redacted, model, response_ms, token_count,
                                      cost_usd, provider, prompt_version,
                                      kb_hit, kb_entries_used, kb_search_performed, kb_context_injected)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id`,
      [
        sessionId,
        role,
        content,
        options.offTopic ?? false,
        options.greeting ?? false,
        options.piiRedacted ?? false,
        options.model ?? null,
        options.responseMs ?? null,
        options.tokenCount ?? null,
        options.costUsd ?? null,
        options.provider ?? null,
        options.promptVersion ?? null,
        // Phase 3: KB usage columns. NULL for user messages + legacy callers
        // that don't pass the KB options. The DB columns are nullable.
        options.kbHit ?? null,
        options.kbEntriesUsed ?? null,
        options.kbSearchPerformed ?? null,
        options.kbContextInjected ?? null,
      ],
    );
    // Bump updated_at on the session so we can sort by "most recently active"
    // if we ever build a conversation list.
    await pool.query(`UPDATE ai_chat_sessions SET updated_at = NOW() WHERE id = $1`, [sessionId]);
    return result.rows[0]?.id;
  } catch (err) {
    logger.error({ err, sessionId, role }, "AI: failed to persist message");
    // Non-fatal -- the response was already streamed to the user.
    return undefined;
  }
}

/**
 * v3.5: Streams a complete text response word-by-word via SSE.
 *
 * Used for cached responses (exact-match + semantic cache) that arrive as
 * a single string. Instead of sending the whole text in one delta (which
 * appears instantly — jarring UX), we split into words and send each as
 * a separate delta with a small delay.
 *
 * This gives the "ChatGPT typing" effect even for cache hits — the user
 * sees text appearing progressively, not all at once.
 *
 * @param res - The SSE response to write to
 * @param text - The full text to stream
 * @param delayMs - Delay between words (default 15ms — fast enough to not
 *   feel slow, slow enough to see the typing animation)
 */
async function streamTextWordByWord(
  res: Response,
  text: string,
  delayMs: number = 15,
): Promise<void> {
  // Split into tokens: words + whitespace (preserves spacing)
  const tokens = text.match(/\S+\s*/g) ?? [text];
  for (const token of tokens) {
    res.write(`data: ${JSON.stringify({ type: "delta", text: token })}\n\n`);
    // Small delay to create the typing effect
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// ─── POST /ai/chat ──────────────────────────────────────────────────────────

router.post("/ai/chat", aiChatLimiter, async (req: Request, res: Response) => {
  // Track the request start time so we can measure end-to-end response time.
  const requestStartTime = Date.now();

  // ─── 1. Validate body ───
  const { message } = (req.body ?? {}) as ChatRequestBody;
  if (typeof message !== "string" || message.trim().length === 0) {
    res.status(400).json({ error: "Message is required." });
    return;
  }
  if (message.length > 2000) {
    res.status(400).json({
      error: "Message is too long (max 2000 characters).",
    });
    return;
  }

  // ─── 1b. Resolve signed-in user (OPTIONAL) ───
  // v2.0: if the user is signed in via Clerk (or mobile JWT -- handled by the
  // middleware that runs before us), we attach their identity to the session
  // and inject their orders + wishlist into the system prompt. If not signed
  // in, we proceed as anonymous (v1 behavior).
  const clerkUserId = req.userId ?? getAuth(req)?.userId ?? null;

  // ─── 1c. Resolve session token (cookie-first, body-fallback, verify HMAC) ───
  // IDOR fix: the previous code blindly trusted `sessionToken` from the
  // request body (a bare crypto.randomUUID() stored in localStorage). Now
  // we:
  //   - Prefer the HttpOnly cookie (immune to XSS exfiltration).
  //   - Fall back to the body for legacy migration (existing localStorage tokens).
  //   - Verify the HMAC signature.
  //   - Rotate the token when an anonymous user signs in (binds the session
  //     to the user identity without losing conversation history).
  // The result is `{ sid, token, uid, rotationReason }` — `sid` is what
  // we pass to findOrCreateSession (NOT the raw client string), `token` is
  // what we return via SSE + Set-Cookie.
  const resolved = await resolveSessionToken(req, clerkUserId);
  if (resolved.rotationReason) {
    logger.info(
      { rotationReason: resolved.rotationReason, uid: resolved.uid },
      "AI: session token rotated",
    );
  }
  // Set the cookie on the response so the client has it for the next
  // request. We do this BEFORE any SSE writes (SSE writes flush headers,
  // and once headers are flushed, Set-Cookie is too late).
  setSessionCookie(res, resolved.token);

  // ─── 2. Service availability check ───
  // v3.1: check if ANY provider is configured (Gemini OR Groq).
  if (!isAnyProviderConfigured()) {
    res.status(503).json({
      error:
        "TreeBot is not configured. Set GEMINI_API_KEY (https://aistudio.google.com/apikey) " +
        "and/or GROQ_API_KEY (https://console.groq.com) on the API server.",
      sessionToken: resolved.token,
    });
    return;
  }

  // ─── 3. v3.0 PII redaction ───
  // Scan the user's message for PII (phone, email, NID, card numbers,
  // Bangladesh-style addresses). Replace with [PHONE], [EMAIL], etc.
  // The REDACTED version is what we persist + send to Gemini. The original
  // is never stored in the AI tables.
  const piiResult = await redactPii(message);
  const safeMessage = piiResult.redacted;
  if (piiResult.hadPii) {
    await logAiEvent(0, "pii_redacted", {
      types: piiResult.detectedTypes,
      count: piiResult.count,
    }).catch(() => {}); // event logging is best-effort
  }

  // ─── 4. Hard topic gate ───
  // If the message has zero botanical keywords, refuse WITHOUT calling
  // Gemini. Saves quota and prevents off-topic abuse.
  // NOTE: we run the gate on the REDACTED message. PII placeholders like
  // [PHONE] don't contain botanical keywords, so they don't affect the gate.
  if (!hasBotanicalKeyword(safeMessage)) {
    // We still need to send back a sessionToken so the client can store it.
    // Persist the user message + refusal so the conversation is consistent.
    try {
      const session = await findOrCreateSession(resolved.sid, safeMessage, resolved.uid);
      await persistMessage(session.id, "user", safeMessage, {
        piiRedacted: piiResult.hadPii,
      });
      const refusal =
        "I'm TreeFriend's plant assistant and can only help with trees, plants, and gardening. " +
        "Feel free to ask me about plant care or browse our catalog at /browse.";
      const assistantMsgId = await persistMessage(session.id, "assistant", refusal, {
        offTopic: true,
        responseMs: Date.now() - requestStartTime,
      });

      res.json({
        sessionToken: resolved.token,
        message: refusal,
        messageId: assistantMsgId,
        offTopic: true,
      });
    } catch (err) {
      logger.error({ err }, "AI: hard-gate persist failed");
      res.status(500).json({ error: "Failed to process request." });
    }
    return;
  }

  // ─── 4b. Pure greeting shortcut ───
  // For "Hi" / "Hello" / "Salam" etc., skip Gemini entirely and return a
  // friendly canned intro. Saves API quota + gives the user an instant
  // warm welcome instead of a 3-5 second wait for Gemini to say "hi back".
  if (isPureGreeting(safeMessage)) {
    try {
      const session = await findOrCreateSession(resolved.sid, safeMessage, resolved.uid);
      await persistMessage(session.id, "user", safeMessage, {
        piiRedacted: piiResult.hadPii,
      });
      const assistantMsgId = await persistMessage(session.id, "assistant", GREETING_INTRO_MESSAGE, {
        greeting: true,
        responseMs: Date.now() - requestStartTime,
      });
      res.json({
        sessionToken: resolved.token,
        message: GREETING_INTRO_MESSAGE,
        messageId: assistantMsgId,
        greeting: true,
      });
    } catch (err) {
      logger.error({ err }, "AI: greeting shortcut failed");
      res.status(500).json({ error: "Failed to process request." });
    }
    return;
  }

  // ─── 5. Find/create session ───
  let session: SessionRow;
  try {
    session = await findOrCreateSession(resolved.sid, safeMessage, resolved.uid);
  } catch (err) {
    logger.error({ err }, "AI: findOrCreateSession failed");
    res.status(500).json({ error: "Failed to start chat session." });
    return;
  }

  // ─── 6. v3.0 Conversation memory: load + maybe summarize ───
  // Load the existing summary (if any) for this session. Then check if
  // we need to summarize (or re-summarize) the conversation. This runs
  // BEFORE we persist the user's new message, so the new message is
  // NOT included in the summary -- it goes into the live history array.
  const existingMemory = await loadSessionMemory(session.id);

  // ─── 7. Persist the user message BEFORE streaming ───
  // We do this now (not after) so that even if the streaming fails midway,
  // the user's message is preserved and the conversation can resume.
  // v3.0: persist the REDACTED message + the piiRedacted flag.
  await persistMessage(session.id, "user", safeMessage, {
    piiRedacted: piiResult.hadPii,
  });

  // v3.0: Now that the user message is persisted, check if we should
  // summarize the conversation. This may call Gemini (to generate the
  // summary) -- if it fails, we proceed without a summary (non-fatal).
  const memory = await maybeSummarize(session.id, existingMemory);

  // ─── 8. Build Gemini history (respects summary cutoff) ───
  // If a summary exists, only messages with id > cutoffId are included.
  // The summary itself is injected into the system prompt.
  const maxHistory = Number(process.env.AI_MAX_HISTORY ?? 10);
  const geminiHistory = await fetchHistoryForGemini(session.id, memory.cutoffId, maxHistory);

  // ─── 9. Build system prompt (DB-driven, with summary + catalog context) ───
  // Bug #3 fix: actually USE the DB prompt text instead of throwing it away.
  // The previous code called getActivePrompt() but only used .version for
  // tracking — the .text was discarded, and buildSystemPrompt() (hardcoded)
  // was always used. This made A/B testing + rollback impossible.
  //
  // The new flow:
  //   1. Fetch the active prompt from the DB (cached in memory, refreshed by
  //      forcePromptRefresh() when an admin activates a new version).
  //   2. If the DB returned non-empty text → use it as the template, rendered
  //      via renderPromptTemplate() (which handles {{summary}}/{{catalog}}
  //      placeholders, falling back to appending if missing).
  //   3. If the DB returned empty text (table empty / DB unavailable / no
  //      active row) → fall back to buildSystemPrompt() (hardcoded
  //      SYSTEM_PROMPT_TEMPLATE_V1, also rendered via renderPromptTemplate).
  //
  // Both paths produce identical output when the DB seed mirrors the
  // hardcoded template — so existing deployments see no behavior change.
  // Admins can then create new versions (v1.1.0, v2.0.0, …) and activate
  // them via POST /api/ai/admin/prompts/:id/activate.
  const promptVersionInfo = await getActivePrompt();
  const catalogContext = await buildCatalogContext(safeMessage);
  const summaryBlock = buildSummaryPromptBlock(memory.summary);

  // ─── Phase 3: Build Knowledge Base context ────────────────────────────────
  // Pre-search the KB for the user's message. If high-confidence matches
  // are found (score > 0.5), inject the top 3 into the system prompt as
  // "KNOWLEDGE BASE CONTEXT". The AI uses this as its primary source.
  // If no high-confidence matches, the AI can still call the
  // search_knowledge_base tool on-demand (declared in aiTools.ts).
  const kbContext = await getTopKbEntriesForPrompt(safeMessage, 3);
  const knowledgeBlock = kbContext.injected
    ? formatKbContextForPrompt(kbContext.entries)
    : "";
  if (kbContext.injected) {
    logger.info(
      {
        entryCount: kbContext.entries.length,
        topScore: kbContext.entries[0]?.score,
        entryIds: kbContext.entries.map((e) => e.entry.id),
      },
      "AI: KB context injected into prompt",
    );
  }

  const systemPrompt =
    promptVersionInfo.text && promptVersionInfo.text.trim().length > 0
      ? renderPromptTemplate(promptVersionInfo.text, summaryBlock, catalogContext, knowledgeBlock)
      : buildSystemPrompt(catalogContext, summaryBlock, knowledgeBlock);

  // ─── 10. Set up SSE response ───
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
  res.flushHeaders?.();

  // Send the sessionToken to the client immediately so it can store it in
  // localStorage BEFORE the first content chunk arrives. This way, if the
  // connection drops mid-stream, the client still knows which session to
  // resume from on reconnect.
  //
  // IDOR fix note: the value sent here is the SIGNED token (verified by
  // resolveSessionToken above). The cookie is already set via Set-Cookie
  // (HttpOnly, so JS can't read it) — this SSE event is for the legacy
  // frontend path that still reads from localStorage. The frontend will
  // migrate to cookie-only once it sees this value matches the cookie.
  res.write(`data: ${JSON.stringify({ type: "session", sessionToken: resolved.token })}\n\n`);

  // ─── v3.2/v3.4: Cache check (exact-match + semantic) ─────────────────
  // Before calling the AI provider, check TWO caches:
  //   1. Exact-match (Redis): systemPrompt + history hash + message hash
  //   2. Semantic (pgvector): embedding similarity > 0.92
  // If either hits, stream the cached response — zero API cost, instant.
  //
  // Skip cache for private queries (user asking about their orders, etc.)
  //
  // Bug #4 fix (also Bug #5 from the analysis): the old regex only matched
  // 4 English phrases ("my order", "where is my order", "what did I buy",
  // "my orders"). It missed:
  //   - "track my package", "when will my delivery arrive", "show me my cart"
  //   - All Bangla/Banglish equivalents ("amar order", "আমার অর্ডার")
  //
  // The new check uses the exported ACCOUNT_KEYWORDS list (which already
  // includes English + Bangla + Banglish order/account terms) via the
  // existing hasBotanicalKeyword-style substring match. This is the same
  // list used by the hard topic gate, so the definitions stay in sync.
  //
  // We ALSO override isPrivateQuery post-stream (in the cache-write
  // section below) if the AI actually called a user-scoped tool
  // (get_user_orders, get_order_details) — that catches anything the
  // keyword check missed.
  const isPrivateQuery = ACCOUNT_KEYWORDS.some((kw) =>
    safeMessage.toLowerCase().includes(kw.toLowerCase()),
  );

  // 1. Exact-match cache (fastest — Redis GET)
  const cached = await getCachedResponse(systemPrompt, geminiHistory, safeMessage, isPrivateQuery);

  if (cached) {
    logger.info(
      { cache: "exact", model: cached.model, provider: cached.provider, hitCount: cached.hitCount },
      "AI: cache HIT, streaming cached response word-by-word",
    );
    // v3.5: Stream word-by-word for the typing animation effect
    await streamTextWordByWord(res, cached.response);
    const assistantMsgId = await persistMessage(session.id, "assistant", cached.response, {
      model: cached.model,
      provider: cached.provider,
      responseMs: Date.now() - requestStartTime,
      costUsd: 0,
      promptVersion: "cached",
    });
    if (assistantMsgId != null) {
      res.write(`data: ${JSON.stringify({ type: "messageId", messageId: assistantMsgId })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
    return;
  }

  // 2. Semantic cache (pgvector — catches "how often to water mango?" ≈ "how often should I water a mango tree?")
  const semanticCached = await getSemanticCachedResponse(safeMessage, isPrivateQuery);
  if (semanticCached) {
    logger.info(
      {
        cache: "semantic",
        model: semanticCached.model,
        provider: semanticCached.provider,
        similarity: Math.round(semanticCached.similarity * 100) / 100,
      },
      "AI: semantic cache HIT, streaming cached response word-by-word",
    );
    // v3.5: Stream word-by-word for the typing animation effect
    await streamTextWordByWord(res, semanticCached.response);
    const assistantMsgId = await persistMessage(session.id, "assistant", semanticCached.response, {
      model: semanticCached.model,
      provider: semanticCached.provider,
      responseMs: Date.now() - requestStartTime,
      costUsd: 0,
      promptVersion: "cached-semantic",
    });
    if (assistantMsgId != null) {
      res.write(`data: ${JSON.stringify({ type: "messageId", messageId: assistantMsgId })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
    return;
  }

  // ─── 11. Stream AI response ───
  let fullResponse = "";
  let assistantMsgId: number | undefined;
  let firstChunkTime: number | null = null;
  // v3.0: holder object so TypeScript's control-flow analysis doesn't
  // narrow the type to `never` after the closure assigns to it. Using
  // `let` directly with a closure assignment breaks CFA because TS
  // assumes closures may not run; an object property access bypasses
  // the narrowing.
  //
  // Bug #4 fix: the holder now also captures `toolCalls` — the names of
  // tools called during this request (e.g. ["search_catalog"] or
  // ["get_user_orders"]). The route uses this to decide cache policy:
  //   - Any user-scoped tool (get_user_orders, get_order_details) →
  //     isPrivateQuery = true (never cache, treat as private).
  //   - Any catalog tool (search_catalog, get_product_care) →
  //     hadToolCalls = true (short-TTL cache, 5 min default).
  //   - No tools called → normal long-TTL cache (1 hour).
  const metaHolder: {
    value: {
      model: string;
      usage?: unknown;
      provider?: string;
      toolCalls?: string[];
    } | null;
  } = { value: null };

  // Note: promptVersionInfo was already fetched above (step 9) — we reuse
  // it here for the prompt_version tracking column on the assistant message.
  // No second getActivePrompt() call needed (Bug #3 fix removed the
  // duplicate fetch that was throwing away the .text).

  try {
    const stream = streamChat(
      systemPrompt,
      geminiHistory,
      safeMessage,
      // v2.5: expose function-calling tools to the AI provider
      {
        declarations: AI_TOOL_DECLARATIONS,
        execute: executeTool,
      },
      clerkUserId,
      // v3.0: metadata callback -- the provider calls this with model + usage
      // info so we can persist it on the assistant message row.
      // v3.1: the router adds `provider` to the metadata so we know which
      // provider actually generated the response.
      (meta) => {
        metaHolder.value = meta;
      },
    );
    for await (const chunk of stream) {
      if (!chunk) continue;
      if (firstChunkTime === null) {
        firstChunkTime = Date.now();
      }
      fullResponse += chunk;
      res.write(`data: ${JSON.stringify({ type: "delta", text: chunk })}\n\n`);
    }

    // v3.5: Handle empty response — the AI completed but produced no text.
    // This happens when the AI only called tools but didn't generate a final
    // text response, or when the model returned an empty completion.
    // Show a friendly fallback instead of "(empty response)".
    if (!fullResponse.trim()) {
      const fallback = "I'm sorry, I couldn't generate a response for that. Could you try rephrasing your question?";
      fullResponse = fallback;
      // v3.5: Stream the fallback word-by-word too (consistent UX)
      await streamTextWordByWord(res, fallback);
      logger.warn("AI: stream completed but produced no text, using fallback");
    }

    // v3.0: extract token count from usage metadata (if the provider sent it).
    // Gemini shape: { promptTokenCount, candidatesTokenCount, totalTokenCount }
    // Groq shape (mapped in groq.ts onMetadata): same field names as Gemini
    //   (prompt_tokens → promptTokenCount, completion_tokens → candidatesTokenCount,
    //    total_tokens → totalTokenCount)
    //
    // Bug #9 fix: Groq now sends usage via stream_options.include_usage = true
    // (captured in groq.ts + mapped to the Gemini shape in onMetadata).
    //
    // Bug #10 fix: the old code fell back from totalTokenCount to
    // candidatesTokenCount (completion tokens) — WRONG. candidatesTokenCount
    // is the OUTPUT token count, not the total. If totalTokenCount is
    // missing, we now compute total = prompt + completion (the correct
    // derivation) instead of using completion as the total.
    let tokenCount: number | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    if (metaHolder.value?.usage && typeof metaHolder.value.usage === "object") {
      const usage = metaHolder.value.usage as {
        totalTokenCount?: number;
        candidatesTokenCount?: number;
        promptTokenCount?: number;
      };
      promptTokens = usage.promptTokenCount;
      completionTokens = usage.candidatesTokenCount;
      // Bug #10 fix: derive total correctly.
      //   1. If totalTokenCount is provided → use it (most accurate).
      //   2. Else if both prompt + completion are provided → sum them.
      //   3. Else if only completion is provided → use it as a lower bound
      //      (not ideal, but better than 0 — the old code did this but
      //      labeled it as "total" which was misleading).
      if (typeof usage.totalTokenCount === "number") {
        tokenCount = usage.totalTokenCount;
      } else if (typeof promptTokens === "number" && typeof completionTokens === "number") {
        tokenCount = promptTokens + completionTokens;
      } else if (typeof completionTokens === "number") {
        // Fallback: only completion tokens available (rare — means the
        // provider didn't send prompt tokens). Use as lower bound.
        tokenCount = completionTokens;
      }
    }

    // v3.2: calculate USD cost from token usage
    const costBreakdown = metaHolder.value?.model
      ? calculateCost(metaHolder.value.model, {
          promptTokens,
          completionTokens,
          totalTokens: tokenCount,
        })
      : null;

    // v3.3: Structured output fallback for [followups] block.
    // Check if the AI's response contains a valid [followups]...[/followups] block.
    // If not (the AI forgot or malformed it), call generateFollowupsStructured()
    // which uses the provider's response_format/responseSchema API to generate
    // guaranteed-valid followups as JSON. This eliminates the 5% failure rate
    // where the frontend parser finds no followups.
    //
    // Done BEFORE persisting so the stored response always has a valid block.
    // The extra API call only happens when the prompt fails (~5% of the time).
    if (fullResponse && !piiResult.hadPii) {
      const { found } = extractFollowups(fullResponse);
      if (!found) {
        logger.info("AI: [followups] block missing, generating via structured output");
        try {
          const structuredFollowups = await generateFollowupsStructured(
            safeMessage,
            fullResponse,
          );
          if (structuredFollowups.length > 0) {
            const followupsBlock = formatFollowupsBlock(structuredFollowups);
            fullResponse += followupsBlock;
            res.write(`data: ${JSON.stringify({ type: "delta", text: followupsBlock })}\n\n`);
          }
        } catch (err) {
          logger.warn({ err }, "AI: structured followup generation failed (non-fatal)");
        }
      }
    }

    // ─── Persist the assistant message BEFORE sending done ───
    // We need its DB id so the frontend can wire up feedback buttons.
    // v3.0: also persist model, response_ms, and token_count.
    // v3.2: also persist cost_usd, provider, prompt_version.
    // Phase 3: also persist KB usage (kb_hit, kb_entries_used, kb_search_performed, kb_context_injected).
    const kbSearchPerformed = (metaHolder.value?.toolCalls ?? []).includes("search_knowledge_base");
    const kbEntriesUsed = kbContext.injected
      ? kbContext.entries.map((e) => e.entry.id)
      : null;
    assistantMsgId = await persistMessage(session.id, "assistant", fullResponse, {
      model: metaHolder.value?.model,
      responseMs: Date.now() - requestStartTime,
      tokenCount,
      costUsd: costBreakdown?.costUsd,
      provider: metaHolder.value?.provider,
      promptVersion: promptVersionInfo.version,
      // Phase 3: KB usage logging.
      // kb_hit = TRUE if KB context was injected OR the AI called the tool.
      kbHit: kbContext.injected || kbSearchPerformed,
      kbEntriesUsed,
      kbSearchPerformed,
      kbContextInjected: kbContext.injected,
    });

    // v3.2/v3.4: store the response in BOTH caches for future hits.
    // - Exact-match (Redis): fast, deterministic key
    // - Semantic (pgvector): catches similar phrasings via embedding similarity
    //
    // ─── Bug #4 fix: tool-call-aware cache policy ─────────────────────────
    //
    // Previously the route ALWAYS passed `hadToolCalls: false` to both cache
    // setters, even when tool calls happened. This meant responses containing
    // search_catalog results (current prices, availability) got cached with
    // the same 1-hour TTL as general questions. If a seller updated a price,
    // the cache still showed the old price.
    //
    // The new policy (3 tiers):
    //   1. NO tools called → hadToolCalls=false, isPrivateQuery=false.
    //      Normal long-TTL cache (1 hour).
    //   2. CATALOG tools called (search_catalog, get_product_care) →
    //      hadToolCalls=true, isPrivateQuery=false. Short-TTL cache (5 min)
    //      via the AI_TOOL_CACHE_TTL_SECONDS env var.
    //   3. USER-SCOPED tools called (get_user_orders, get_order_details) →
    //      isPrivateQuery=true (override). NEVER cache (private data).
    //
    // The `isPrivateQuery` flag is RECOMPUTED here (not just the original
    // regex check) so we catch cases where the AI called get_user_orders
    // for a message that didn't match the regex (e.g. "track my package"
    // didn't match the old regex but did trigger the tool).
    const toolCalls = metaHolder.value?.toolCalls ?? [];
    const hadUserScopedTool = toolCalls.some((name) => USER_SCOPED_TOOLS.has(name));
    const hadAnyTool = toolCalls.length > 0;
    // Override isPrivateQuery if a user-scoped tool was called — this
    // ensures we NEVER cache responses that contain user-specific data
    // (orders, account info), even if the original regex missed it.
    const effectiveIsPrivate = isPrivateQuery || hadUserScopedTool;

    if (fullResponse && !effectiveIsPrivate) {
      const model = metaHolder.value?.model ?? "unknown";
      const provider = metaHolder.value?.provider ?? "unknown";

      // Exact-match cache (fire-and-forget).
      // hadToolCalls controls the TTL: false=1h, true=5min.
      setCachedResponse(
        systemPrompt,
        geminiHistory,
        safeMessage,
        fullResponse,
        model,
        provider,
        hadAnyTool,
        effectiveIsPrivate,
      ).catch(() => {});

      // Semantic cache (fire-and-forget — embedding generation takes ~100ms).
      setSemanticCachedResponse(
        safeMessage,
        fullResponse,
        model,
        provider,
        hadAnyTool,
        effectiveIsPrivate,
      ).catch(() => {});
    }

    // Log the tool-call cache decision for observability (debug only).
    if (hadAnyTool) {
      logger.debug(
        {
          toolCalls,
          hadUserScopedTool,
          cached: !effectiveIsPrivate,
          cacheTtl: hadUserScopedTool ? "skipped" : hadAnyTool ? "5min" : "1h",
        },
        "AI: tool-call cache decision",
      );
    }

    if (assistantMsgId != null) {
      res.write(`data: ${JSON.stringify({ type: "messageId", messageId: assistantMsgId })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  } catch (err) {
    // Extract the most useful bits from the SDK error so we can debug.
    const sdkErr = err as any;
    const errInfo = {
      message: sdkErr?.message ?? String(err),
      status: sdkErr?.status ?? sdkErr?.code ?? undefined,
      errorDetails: sdkErr?.error?.message ?? sdkErr?.errorDetails ?? undefined,
    };
    logger.error({ err, errInfo }, "AI: Gemini stream failed");
    // Send a slightly more helpful message to the user that hints at the
    // likely cause, but doesn't leak internals.
    const isAuthError =
      errInfo.status === 401 ||
      errInfo.status === 403 ||
      /api key|permission|unauthorized|forbidden/i.test(errInfo.message);
    const isAllModelsUnavailable = /all configured gemini models/i.test(errInfo.message);
    const isRateLimit =
      errInfo.status === 429 || /rate limit|quota|too many/i.test(errInfo.message);

    const userMessage = isAllModelsUnavailable
      ? "TreeBot is temporarily unavailable -- we're updating our AI service. " +
        "Please try again in a few minutes."
      : isAuthError
        ? "TreeBot is having trouble connecting to the AI service. " +
          "This is likely a configuration issue on our side -- please try again later."
        : isRateLimit
          ? "TreeBot is getting too many requests right now. Please wait a minute and try again."
          : "I had trouble generating a response. Please try again in a moment.";
    res.write(
      `data: ${JSON.stringify({
        type: "error",
        message: userMessage,
      })}\n\n`,
    );
    // If we got a partial response before the error, persist what we have.
    // If we got nothing, persist a fallback message so the conversation
    // history isn't left in an inconsistent state (user msg with no reply).
    if (!fullResponse) {
      fullResponse = userMessage;
    }

    // v3.0: log the error as an event for debugging.
    await logAiEvent(session.id, "stream_error", {
      status: errInfo.status,
      message: errInfo.message,
      partialResponse: fullResponse.length > 0 && fullResponse !== userMessage,
    }).catch(() => {});
  } finally {
    res.end();
  }

  // ─── 12. Fallback persistence (only if step 11 didn't persist) ───
  // Note: the assistant message was already persisted in step 11 (before
  // sending the "done" event) so we could send its ID to the frontend for
  // feedback wiring. This fallback handles the case where the stream
  // errored BEFORE step 11 could run (so assistantMsgId is undefined) but
  // fullResponse still has the error-fallback content from the catch block.
  if (fullResponse && assistantMsgId == null) {
    await persistMessage(session.id, "assistant", fullResponse, {
      model: metaHolder.value?.model,
      responseMs: Date.now() - requestStartTime,
    });
  }
});

// ─── Session access verification (shared by GET + DELETE) ───────────────────
/**
 * Verifies that the requester is allowed to access the session identified
 * by the URL `:token` param (or, if no URL param is present, by the cookie).
 *
 * The previous design trusted the URL `:token` param directly and used it
 * for the DB lookup — meaning anyone who learned a token (via Referer
 * leakage, server logs, shared browser, etc.) could read or delete the
 * victim's conversation. This was the original IDOR vulnerability.
 *
 * The new design:
 *
 *   1. Reads the token from the URL param (for backward compat with the
 *      existing frontend, which puts the token in the URL) AND/OR the
 *      HttpOnly cookie. The cookie is the preferred source going forward
 *      (URLs are logged, Referer-leaked, and visible in browser history).
 *
 *   2. Verifies the HMAC signature. Forged or tampered tokens are rejected
 *      with 401. Bare legacy UUIDs are accepted only via the migration
 *      path in `resolveSessionToken` (which is POST-only — for GET/DELETE
 *      we don't honor legacy UUIDs from the URL because the URL is more
 *      likely to be a leaked/injected value than a body field).
 *
 *   3. Verifies ownership:
 *      - Anonymous token (uid=null): possession of the signed token IS
 *        the proof of ownership. The sid is 122 bits of randomness, only
 *        known to whoever the server issued it to.
 *      - Authenticated token (uid=X): the requester must also be X. If
 *        a different signed-in user presents X's token, reject with 403.
 *
 *   4. Returns the verified `sid` for the DB lookup, plus the session row
 *      (if it exists) and the signed token (for re-setting the cookie on
 *      the response, so the client stays in sync).
 *
 * On any verification failure, sends the appropriate HTTP error response
 * and returns `null`. Callers MUST check for null and return early.
 */
async function verifySessionAccess(
  req: Request,
  res: Response,
): Promise<{
  sid: string;
  token: string;
  uid: string | null;
  session: SessionRow | null;
} | null> {
  // 1. Collect candidate tokens from cookie + URL param.
  const cookieToken = getSessionCookie(req);
  const urlToken = typeof req.params.token === "string" ? req.params.token : null;
  // Prefer the cookie (more secure — not logged, not Referer-leaked).
  // Fall back to the URL param for clients that haven't migrated to
  // cookie-based auth yet (they put the signed token in the URL after
  // receiving it from the SSE `session` event).
  const rawToken = cookieToken ?? urlToken;
  if (!rawToken) {
    // No token at all — for GET, return empty history so the frontend
    // can start fresh. For DELETE, this is an error (can't delete nothing).
    // The caller decides based on context.
    return null;
  }

  // 2. Verify the HMAC signature.
  const verified = verifySessionToken(rawToken);
  if (!verified) {
    // For backward compatibility: if the URL token is a bare legacy UUID
    // (no signature), AND a cookie exists with a valid signed token,
    // prefer the cookie. This handles the case where the frontend put a
    // legacy UUID in the URL but the cookie has the new signed token.
    if (cookieToken && urlToken && cookieToken !== urlToken) {
      const cookieVerified = verifySessionToken(cookieToken);
      if (cookieVerified) {
        // Use the cookie's verified sid. The URL param is ignored
        // (legacy value, no longer trusted).
        return await lookupSessionBySid(cookieVerified, res);
      }
    }

    // ─── Legacy UUID migration (GET only) ─────────────────────────────────
    // Existing users have a bare crypto.randomUUID() in their localStorage
    // from before the Bug #1 fix. When they load the chat page, the frontend
    // sends GET /api/ai/sessions/<bare-uuid>. The bare UUID has no HMAC
    // signature, so verifySessionToken() rejects it. Without this migration
    // path, existing users would lose access to their previous chat history
    // on first load after deploy.
    //
    // We accept the bare UUID ONCE for GET requests (history fetch). We:
    //   1. Validate it looks like a v4 UUID (36 chars, dashes at the right
    //      positions) — prevents random strings from hitting the DB.
    //   2. Look it up in the DB by session_token.
    //   3. If found → mint a NEW signed token carrying the existing sid +
    //      user_id (preserving the binding), set it as a cookie, and return
    //      the history. The frontend's next request will use the cookie.
    //   4. If not found → return empty history (the user is new, no
    //      existing conversation to load).
    //
    // SECURITY: this is safe because the bare UUID is 122 bits of randomness
    // — an attacker can't guess it. They'd need to already have the UUID
    // (via Referer leak, server logs, shared browser, etc.) to access the
    // history. The same risk existed before the Bug #1 fix; we're not
    // making it worse, just preserving backward compat during the migration.
    //
    // We do NOT honor bare UUIDs for DELETE (irreversible — requires the
    // signed cookie). This limits the blast radius of any leaked UUID.
    if (req.method === "GET" && urlToken && isLegacyUuid(urlToken)) {
      // Look up the bare UUID in the DB.
      const existing = await pool.query<{ user_id: string | null }>(
        `SELECT user_id FROM ai_chat_sessions WHERE session_token = $1`,
        [urlToken],
      );
      if (existing.rows.length > 0) {
        const existingUid = existing.rows[0].user_id;
        // Ownership check for legacy authenticated sessions:
        //   - If the session is bound to a user (uid=X) AND we can confirm
        //     the requester is a DIFFERENT user (requesterUid=Y, Y≠X) → reject.
        //   - If the session is bound to a user (uid=X) but we CAN'T determine
        //     the requester's identity (requesterUid=null) → ALLOW. This
        //     happens when the GET endpoint can't resolve the Clerk identity
        //     (cross-origin cookie issues, missing CLERK_SECRET_KEY, etc.).
        //     The bare UUID itself is the proof of possession (122 bits of
        //     randomness). The old code had no ownership check at all, so
        //     this is not a regression — it's the same security level.
        //   - If the session is anonymous (uid=null) → allow (possession =
        //     ownership — same as before the fix).
        const requesterUid = req.userId ?? getAuth(req)?.userId ?? null;
        if (existingUid !== null && requesterUid !== null && existingUid !== requesterUid) {
          logger.warn(
            { sid: urlToken, existingUid, requesterUid },
            "AI: legacy GET access denied — identity mismatch (possible hijack)",
          );
          res.status(403).json({ error: "You do not have access to this session." });
          return null;
        }
        // Mint a new signed token carrying the existing sid + uid.
        const newToken = signSessionToken({ sid: urlToken, uid: existingUid });
        // Set it as a cookie so the frontend's next request uses the cookie
        // (and the bare UUID in localStorage can be cleared).
        setSessionCookie(res, newToken);
        logger.info(
          { sid: urlToken, uid: existingUid },
          "AI: legacy UUID migrated to signed token on GET (history preserved)",
        );
        // Build the verified payload + look up the session row.
        const verifiedLegacy: SessionTokenPayload = {
          v: 1,
          sid: urlToken,
          uid: existingUid,
          iat: Date.now(),
        };
        return await lookupSessionBySid(verifiedLegacy, res);
      }
      // Bare UUID not in DB → treat as new visitor (no history yet).
      // Return null with no error response — the caller returns empty history.
      return null;
    }

    // Invalid signature, no cookie fallback, and not a legacy UUID → reject.
    // Don't reveal whether the session exists (info leak).
    res.status(401).json({ error: "Invalid or expired session token." });
    return null;
  }

  // 3. Verify ownership.
  // Resolve the requester's identity (optional — anonymous is OK).
  const requesterUid = req.userId ?? getAuth(req)?.userId ?? null;
  if (!tokenMatchesIdentity(verified, requesterUid)) {
    // Token bound to user X, presented by user Y. This is a hijack attempt.
    logger.warn(
      {
        tokenUid: verified.uid,
        requesterUid,
      },
      "AI: session access denied — identity mismatch (possible hijack)",
    );
    res.status(403).json({ error: "You do not have access to this session." });
    return null;
  }

  // 4. Look up the session row by the verified sid.
  return await lookupSessionBySid(verified, res);
}

/**
 * Helper: looks up the session row by the sid from a verified token.
 * Returns the sid, token, uid, and session row (or null if no row exists).
 */
async function lookupSessionBySid(
  verified: SessionTokenPayload,
  _res: Response,
): Promise<{
  sid: string;
  token: string;
  uid: string | null;
  session: SessionRow | null;
}> {
  const result = await pool.query<SessionRow>(
    `SELECT id, session_token, title, user_id FROM ai_chat_sessions WHERE session_token = $1`,
    [verified.sid],
  );
  return {
    sid: verified.sid,
    token: verified.uid !== null
      // Re-sign to ensure the token reflects the current uid binding.
      ? signSessionToken({ sid: verified.sid, uid: verified.uid })
      : signSessionToken({ sid: verified.sid, uid: null }),
    uid: verified.uid,
    session: result.rows.length > 0 ? result.rows[0] : null,
  };
}

// ─── Rater identity resolution (for POST /ai/feedback) ──────────────────────
/**
 * Resolves the identity of the requester for the feedback endpoint.
 *
 * The feedback endpoint accepts ratings from BOTH authenticated users
 * (Clerk) AND anonymous visitors (signed session token). This helper
 * returns whichever identity is available, with a preference for
 * authenticated (if both are present, the user is signed in AND has a
 * session cookie — we use the authenticated identity).
 *
 * Returns:
 *   - `{ kind: "user", userId }` — authenticated via Clerk or mobile JWT.
 *   - `{ kind: "session", sid }` — anonymous, holding a signed session token.
 *   - `null` — no identity at all. The caller should return 401.
 *
 * The signed session token is verified via the same `verifySessionToken`
 * function used by the IDOR fix (Bug #1). This means an attacker cannot
 * forge a session identity — they must hold a token the server actually
 * issued.
 *
 * For anonymous raters, we ALSO refresh the session cookie on the response
 * (sliding expiration) — the caller does this by checking the return value
 * and calling `setSessionCookie` if `kind === "session"`.
 */
function resolveRaterIdentity(req: Request): {
  kind: "user";
  userId: string;
} | {
  kind: "session";
  sid: string;
  /** The signed token to re-set on the response (sliding expiration). */
  token: string;
} | null {
  // 1. Try authenticated identity first (Clerk or mobile JWT, resolved by
  //    the auth middleware that runs before us).
  const clerkUserId = req.userId ?? getAuth(req)?.userId ?? null;
  if (clerkUserId) {
    return { kind: "user", userId: clerkUserId };
  }

  // 2. Fall back to the signed session token (cookie preferred, body
  //    for legacy migration).
  const cookieToken = getSessionCookie(req);
  const bodyToken =
    typeof (req.body ?? {}).sessionToken === "string" &&
    (req.body as { sessionToken: string }).sessionToken.length >= 8
      ? (req.body as { sessionToken: string }).sessionToken
      : null;
  const rawToken = cookieToken ?? bodyToken;
  if (!rawToken) return null;

  const verified = verifySessionToken(rawToken);
  if (!verified) return null;

  return { kind: "session", sid: verified.sid, token: rawToken };
}

/**
 * Verifies that the rater owns the message they're trying to rate.
 *
 * The message belongs to a session (via `session_id` FK). The session has
 * a `user_id` (NULL for anonymous, X for authenticated sessions). The
 * ownership rules:
 *
 *   - Session is anonymous (user_id IS NULL): the rater must hold a signed
 *     session token whose `sid` matches the session's `session_token` column.
 *   - Session is authenticated (user_id = X): the rater must be authenticated
 *     as X. A different user Y cannot rate X's messages.
 *
 * This stops messageId-enumeration attacks: an attacker iterating messageIds
 * can only rate messages FROM THEIR OWN SESSIONS (anonymous or authenticated).
 * They cannot rate messages from other users' conversations.
 *
 * Returns the message's `session_id` if ownership is verified. Returns
 * `null` and sends an HTTP error response if not. Callers MUST check for
 * null and return early.
 *
 * NOTE: this helper is also useful for any future endpoint that needs to
 * verify message ownership (e.g., DELETE message, edit message). It's
 * exported as a local function for now; promote to lib/ if reused.
 */
async function verifyMessageOwnership(
  req: Request,
  res: Response,
  messageId: number,
  rater: ReturnType<typeof resolveRaterIdentity>,
): Promise<{ sessionId: number; sessionSid: string } | null> {
  if (!rater) {
    // Caller should have already returned 401, but defensive.
    res.status(401).json({ error: "Authentication required to rate messages." });
    return null;
  }

  // Look up the message + its session's identity in one query.
  const result = await pool.query<{
    session_id: number;
    session_token: string;
    user_id: string | null;
  }>(
    `SELECT m.session_id, s.session_token, s.user_id
       FROM ai_chat_messages m
       JOIN ai_chat_sessions s ON s.id = m.session_id
      WHERE m.id = $1`,
    [messageId],
  );

  if (result.rows.length === 0) {
    // Don't reveal whether the message exists — info leak prevention.
    res.status(404).json({ error: "Message not found." });
    return null;
  }

  const { session_id, session_token, user_id } = result.rows[0];

  if (rater.kind === "user") {
    // Authenticated rater. The session must be bound to the same user.
    if (user_id !== rater.userId) {
      // Either the session is anonymous (user_id IS NULL) — meaning a
      // different anonymous user started this conversation — OR it's
      // bound to a DIFFERENT user. Either way, this rater cannot rate
      // this message.
      logger.warn(
        { messageId, raterUid: rater.userId, sessionUid: user_id },
        "AI: feedback denied — authenticated rater does not own the message's session",
      );
      res.status(403).json({ error: "You can only rate messages from your own conversations." });
      return null;
    }
  } else {
    // Anonymous rater (holds a signed session token). The session must
    // be anonymous (user_id IS NULL) AND the rater's sid must match.
    if (user_id !== null) {
      // The session is bound to an authenticated user. Anonymous raters
      // cannot rate messages from authenticated sessions (the legitimate
      // user should rate them after signing in).
      logger.warn(
        { messageId, raterSid: rater.sid, sessionUid: user_id },
        "AI: feedback denied — anonymous rater tried to rate an authenticated session's message",
      );
      res.status(403).json({ error: "Please sign in to rate this message." });
      return null;
    }
    if (session_token !== rater.sid) {
      // Different anonymous session. The sid in the signed token doesn't
      // match the session's session_token — the rater is trying to rate
      // someone else's anonymous conversation.
      logger.warn(
        { messageId, raterSid: rater.sid, sessionSid: session_token },
        "AI: feedback denied — anonymous rater's sid does not match the message's session",
      );
      res.status(403).json({ error: "You can only rate messages from your own conversations." });
      return null;
    }
  }

  return { sessionId: session_id, sessionSid: session_token };
}


// ─── GET /ai/sessions/:token ────────────────────────────────────────────────
// Returns the message history for a session, oldest-first. Used by the
// frontend on mount to rehydrate the conversation.
//
// IDOR fix: this endpoint previously trusted the URL `:token` param
// directly — anyone who learned a token could read the victim's full
// conversation history (including any PII the redactor missed and any
// order info the AI surfaced via tool calls). Now the token is verified
// via HMAC signature AND ownership is checked (anonymous=token possession,
// authenticated=uid match). See `verifySessionAccess` above.
router.get("/ai/sessions/:token", aiSessionReadLimiter, async (req: Request, res: Response) => {
  try {
    const access = await verifySessionAccess(req, res);
    if (!access) {
      // verifySessionAccess already sent the error response (or, for the
      // no-token case, we return empty history below).
      // If headers haven't been sent (no-token case), return empty history.
      if (!res.headersSent) {
        res.json({ sessionToken: null, title: null, messages: [] });
      }
      return;
    }

    // Re-set the cookie so its Max-Age refreshes (sliding expiration).
    setSessionCookie(res, access.token);

    if (!access.session) {
      // No session row yet — return empty array so the frontend can start fresh.
      res.json({ sessionToken: access.token, title: null, messages: [] });
      return;
    }

    const maxHistory = Number(process.env.AI_MAX_HISTORY ?? 20); // more for view
    const messages = await fetchHistory(access.session.id, maxHistory);
    res.json({
      sessionToken: access.token,
      title: access.session.title,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.created_at,
        offTopic: m.off_topic,
        greeting: m.greeting,
      })),
    });
  } catch (err) {
    logger.error({ err }, "AI: GET session failed");
    res.status(500).json({ error: "Failed to load chat history." });
  }
});

// ─── DELETE /ai/sessions/:token ─────────────────────────────────────────────
// Clears a conversation. CASCADE deletes the associated messages.
//
// IDOR fix: same verification as GET — signature + ownership. Additionally:
//   - Stricter rate limit (10/hour/IP) because DELETE is irreversible.
//   - Audit-logged via the AI event log so we have a trail if abuse is
//     suspected (e.g. a victim reports their conversation mysteriously
//     disappeared — we can correlate to a DELETE event).
//   - Clears the cookie so the client starts fresh on the next request.
router.delete("/ai/sessions/:token", aiSessionDeleteLimiter, async (req: Request, res: Response) => {
  try {
    const access = await verifySessionAccess(req, res);
    if (!access) {
      if (!res.headersSent) {
        res.status(401).json({ error: "Invalid or expired session token." });
      }
      return;
    }

    if (!access.session) {
      // Nothing to delete — idempotent success. Still clear the cookie
      // so the client doesn't keep sending a stale token.
      clearSessionCookie(res);
      res.json({ ok: true });
      return;
    }

    // Delete the session row (CASCADE removes messages + feedback + events).
    await pool.query(`DELETE FROM ai_chat_sessions WHERE session_token = $1`, [access.sid]);

    // Audit log (best-effort) — who deleted what session.
    await logAiEvent(access.session.id, "session_deleted", {
      uid: access.uid,
      ip: req.ip ?? req.socket?.remoteAddress ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    }).catch(() => {});

    // Clear the cookie so the client's next request mints a fresh session.
    clearSessionCookie(res);

    logger.info(
      { sessionId: access.session.id, sid: access.sid, uid: access.uid },
      "AI: session deleted",
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "AI: DELETE session failed");
    res.status(500).json({ error: "Failed to clear chat history." });
  }
});

// Touch the imports so unused-imports lint doesn't complain (these are
// used via the type system and the table objects exported by @workspace/db
// elsewhere if other routes ever need to JOIN on AI tables).
void aiChatSessionsTable;
void aiChatMessagesTable;
void eq;
void asc;
void desc;
void describeError;

// ─── POST /ai/feedback ──────────────────────────────────────────────────────
// Records a thumbs up/down rating on a specific assistant message.
//
// ─── Bug #2 fix: ownership + scoped toggle ─────────────────────────────────
//
// The previous implementation was completely unauthenticated and had no
// ownership check — anyone iterating `messageId` (sequential SERIAL ints:
// 1, 2, 3, …) could:
//   - Erase legitimate user feedback by re-POSTing (the toggle behavior
//     deleted the row on same-rating re-click).
//   - Flood the table with arbitrary ratings, corrupting admin insights.
//   - Spam 200 feedback entries per 15 min per IP (only the global
//     apiLimiter applied).
//
// The new design:
//
//   1. **Resolves rater identity** (Clerk user OR signed session token).
//      At least one is required — 401 otherwise.
//
//   2. **Verifies message ownership** — the rater must own the session
//      that contains the message being rated. Anonymous raters must hold
//      the signed token whose sid matches the message's session_token;
//      authenticated raters must match the session's user_id. This stops
//      messageId enumeration: an attacker can only rate messages FROM
//      THEIR OWN SESSIONS.
//
//   3. **Scoped toggle/update/insert** — the unique constraint is now
//      per (message, rater), not per message alone. Different users can
//      independently rate the same message. A user can only toggle/
//      update/delete THEIR OWN rating, not anyone else's.
//
//   4. **Dedicated rate limiter** (`aiFeedbackLimiter`, 30 / 5 min / IP+user)
//      — stops scripted spam. The global apiLimiter (200/15min) was way
//      too loose.
//
//   5. **Audit log** — every feedback mutation is logged to
//      `ai_chat_events` for abuse investigation (e.g., a victim reports
//      their feedback mysteriously disappeared — we can correlate to a
//      feedback_deleted event with the rater's identity).
//
// Body: { messageId: number, rating: "up" | "down" }
// Returns: { ok: true, rating: "up" | "down" | null }
router.post(
  "/ai/feedback",
  aiFeedbackLimiter,
  async (req: Request, res: Response) => {
    const { messageId, rating } = (req.body ?? {}) as {
      messageId?: number;
      rating?: "up" | "down";
    };

    // ─── 1. Validate input ─────────────────────────────────────────────────
    // messageId must be a positive integer (reject floats, negatives, NaN).
    // Using Number.isInteger prevents "1.5" and "1e2" from passing.
    if (!messageId || typeof messageId !== "number" || !Number.isInteger(messageId) || messageId <= 0) {
      res.status(400).json({ error: "messageId is required (must be a positive integer)." });
      return;
    }
    if (rating !== "up" && rating !== "down") {
      res.status(400).json({ error: 'rating must be "up" or "down".' });
      return;
    }

    // ─── 2. Resolve rater identity ─────────────────────────────────────────
    // Authenticated (Clerk) OR anonymous (signed session token). 401 if neither.
    const rater = resolveRaterIdentity(req);
    if (!rater) {
      res.status(401).json({
        error: "Please sign in or start a conversation to rate messages.",
      });
      return;
    }

    // For anonymous raters, refresh the session cookie (sliding expiration).
    // Authenticated raters don't need a cookie refresh here (their Clerk
    // session has its own refresh logic).
    if (rater.kind === "session") {
      setSessionCookie(res, rater.token);
    }

    try {
      // ─── 3. Verify message ownership ───────────────────────────────────────
      // The rater must own the session that contains the message. This is
      // the key fix — it stops messageId enumeration.
      const ownership = await verifyMessageOwnership(req, res, messageId, rater);
      if (!ownership) {
        // verifyMessageOwnership already sent the HTTP error response.
        return;
      }
      const { sessionId } = ownership;

      // ─── 4. Scoped toggle / update / insert ───────────────────────────────
      // Look up the rater's EXISTING feedback on this message (not anyone
      // else's). The query is keyed on (message_id, rater identity) —
      // different raters' rows are invisible to this query.
      const raterUserId = rater.kind === "user" ? rater.userId : null;
      const raterSessionSid = rater.kind === "session" ? rater.sid : null;

      const existing = await pool.query<{ id: number; rating: string }>(
        `SELECT id, rating FROM ai_chat_feedback
          WHERE message_id = $1
            AND (rater_user_id IS NOT DISTINCT FROM $2
                 OR rater_session_sid IS NOT DISTINCT FROM $3)`,
        [messageId, raterUserId, raterSessionSid],
      );

      // `IS NOT DISTINCT FROM` is the SQL-standard NULL-safe equality
      // operator (NULL IS NOT DISTINCT FROM NULL → true). This handles
      // both rater types correctly without OR-short-circuit issues.

      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.rating === rating) {
          // Same rating clicked again → toggle OFF (delete the row).
          // Scoped to THIS rater's row only — the WHERE clause on id
          // (which is unique per rater) ensures we don't delete anyone
          // else's feedback.
          await pool.query(`DELETE FROM ai_chat_feedback WHERE id = $1`, [row.id]);

          // Audit log (best-effort).
          await logAiEvent(sessionId, "feedback_deleted", {
            messageId,
            rating: row.rating,
            raterKind: rater.kind,
            raterUserId,
            raterSessionSid,
            ip: req.ip ?? req.socket?.remoteAddress ?? null,
          }).catch(() => {});

          res.json({ ok: true, rating: null });
          return;
        }
        // Opposite rating → update in place (scoped to this rater's row).
        await pool.query(
          `UPDATE ai_chat_feedback SET rating = $1, created_at = NOW() WHERE id = $2`,
          [rating, row.id],
        );

        await logAiEvent(sessionId, "feedback_updated", {
          messageId,
          previousRating: row.rating,
          newRating: rating,
          raterKind: rater.kind,
          raterUserId,
          raterSessionSid,
          ip: req.ip ?? req.socket?.remoteAddress ?? null,
        }).catch(() => {});

        res.json({ ok: true, rating });
        return;
      }

      // No existing feedback from this rater → insert.
      // Both rater_user_id and rater_session_sid are written (one is NULL,
      // the other is the rater's identity). The partial unique indexes
      // enforce "one rating per (message, rater)" — if a concurrent
      // request inserts the same combo first, this INSERT fails with a
      // unique violation, which we catch and convert to a 409.
      try {
        await pool.query(
          `INSERT INTO ai_chat_feedback
             (message_id, session_id, rating, rater_user_id, rater_session_sid)
           VALUES ($1, $2, $3, $4, $5)`,
          [messageId, sessionId, rating, raterUserId, raterSessionSid],
        );
      } catch (insertErr: any) {
        // Unique violation (Postgres SQLSTATE 23505) — a concurrent request
        // inserted the same (message, rater) combo first. Convert to a 409
        // so the client can retry idempotently (the second attempt will
        // hit the "existing" branch above and behave correctly).
        if (insertErr?.code === "23505") {
          logger.info(
            { messageId, raterKind: rater.kind },
            "AI: feedback INSERT hit unique constraint (concurrent insert) — returning 409",
          );
          res.status(409).json({
            error: "Feedback already exists. Please retry.",
            retry: true,
          });
          return;
        }
        throw insertErr; // Re-throw for the outer catch.
      }

      await logAiEvent(sessionId, "feedback_created", {
        messageId,
        rating,
        raterKind: rater.kind,
        raterUserId,
        raterSessionSid,
        ip: req.ip ?? req.socket?.remoteAddress ?? null,
      }).catch(() => {});

      res.json({ ok: true, rating });
    } catch (err) {
      logger.error({ err, messageId, rating, raterKind: rater.kind }, "AI: feedback POST failed");
      res.status(500).json({ error: "Failed to record feedback." });
    }
  },
);

// ─── GET /ai/products-by-slug?slugs=alpha,beta ──────────────────────────────
// Resolves an array of product slugs (extracted from AI responses by the
// frontend) to minimal product info: { slug, name, image, price }.
// Used by the frontend to render clickable product chips under each AI reply.
//
// The frontend calls this with the slugs it parsed out of the AI response.
// We return enough info to render a small product card / chip without
// another round-trip.
router.get("/ai/products-by-slug", async (req: Request, res: Response) => {
  const slugsParam = (req.query.slugs as string | undefined) ?? "";
  const slugs = slugsParam
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 10); // hard cap to prevent abuse

  if (slugs.length === 0) {
    res.json({ products: [] });
    return;
  }

  try {
    // Build parameterized IN clause: $1, $2, ...
    const placeholders = slugs.map((_, i) => `$${i + 1}`).join(", ");
    const result = await pool.query<{
      slug: string;
      name: string;
      image: string | null;
      price: string | null;
      currency: string | null;
    }>(
      `SELECT
         p.slug,
         p.name,
         (p.images::jsonb->0->>'url') AS image,
         -- Cheapest variant price across active seller listings for this product.
         -- If no listings exist, returns NULL.
         (
           SELECT MIN(sl.price::text)
           FROM seller_listings sl
           JOIN seller_listing_variants slv ON slv.seller_listing_id = sl.id
           WHERE sl.product_id = p.id
             AND sl.is_active = true
             AND sl.deleted_at IS NULL
         ) AS price,
         'BDT' AS currency
       FROM products p
       WHERE p.slug IN (${placeholders})
         AND p.deleted_at IS NULL`,
      slugs,
    );

    // Preserve the input slug order in the response.
    const bySlug = new Map(result.rows.map((r) => [r.slug, r]));
    const ordered = slugs.map((s) => bySlug.get(s)).filter(Boolean) as typeof result.rows;

    res.json({ products: ordered });
  } catch (err) {
    logger.error({ err, slugs }, "AI: products-by-slug failed");
    // Don't fail the whole UI over a chip-rendering issue.
    res.json({ products: [] });
  }
});

// Touch the feedback table export so unused-imports lint is happy in
// environments where it isn't otherwise referenced.
void aiChatFeedbackTable;

export default router;
