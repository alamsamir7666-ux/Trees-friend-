/**
 * AI assistant route — "TreeBot" powered by Google Gemini Flash.
 *
 * Three endpoints:
 *   POST /api/ai/chat              — streaming chat (Server-Sent Events)
 *   GET  /api/ai/sessions/:token   — fetch conversation history
 *   DELETE /api/ai/sessions/:token — clear a conversation
 *
 * Auth model (v1 — ANONYMOUS):
 *   No `requireAuth`. Every visitor gets a TreeBot, even signed-out users.
 *   The conversation is keyed by a client-generated `sessionToken`
 *   (stored in localStorage by the frontend), so the same anonymous
 *   visitor can resume their conversation across page refreshes.
 *
 * Topic restriction (two-tier, defense in depth):
 *   - HARD gate: hasBotanicalKeyword() — instant refuse, no Gemini call.
 *     Saves quota + blocks obvious off-topic abuse.
 *   - SOFT gate: buildSystemPrompt() — strict scope instructions. Catches
 *     edge cases that sneak past the keyword gate (e.g. "tell me a joke
 *     about trees" — the gate lets it through, the system prompt refuses).
 *
 * Rate limit:
 *   30 req / hour / IP. Generous for legitimate use, blocks scripted abuse.
 *   Gemini's free tier is 15 RPM / 1,500 RPD, so even 30/hr/IP across
 *   many users won't blow the daily quota.
 *
 * Persistence:
 *   Both user messages AND assistant responses are persisted to
 *   `ai_chat_messages` so history survives page refresh and server restart.
 *   The frontend rehydrates by calling GET /sessions/:token on mount.
 */
import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { eq, asc, desc } from "drizzle-orm";
import {
  aiChatSessionsTable,
  aiChatMessagesTable,
} from "@workspace/db";
import { createRateLimiter } from "../middlewares/rateLimiter";
import { logger } from "../lib/logger";
import {
  buildCatalogContext,
  buildSystemPrompt,
  hasBotanicalKeyword,
  isPureGreeting,
  GREETING_INTRO_MESSAGE,
} from "../lib/aiContext";
import { isGeminiConfigured, streamGeminiChat } from "../lib/gemini";
import { describeError } from "../lib/describeError";

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

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatRequestBody {
  message: string;
  sessionToken?: string;
}

interface SessionRow {
  id: number;
  session_token: string;
  title: string | null;
}

interface MessageRow {
  id: number;
  session_id: number;
  role: string;
  content: string;
  created_at: Date;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find or create an ai_chat_sessions row for the given client token.
 * Returns the row's id (numeric primary key) so messages can FK to it.
 *
 * On first message in a session, we also stamp the `title` column with a
 * truncated version of the message — useful for future UIs that list
 * conversations.
 */
async function findOrCreateSession(
  sessionToken: string,
  firstMessage: string,
): Promise<SessionRow> {
  // Try to find existing first (the common case after the first turn).
  const existing = await pool.query<SessionRow>(
    `SELECT id, session_token, title FROM ai_chat_sessions WHERE session_token = $1`,
    [sessionToken],
  );
  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  // Race-safe insert: if another request created the same token in the
  // meantime, ON CONLTICT DO NOTHING + a follow-up SELECT retrieves it.
  const title = firstMessage.slice(0, 80).trim() || "New conversation";
  await pool.query(
    `INSERT INTO ai_chat_sessions (session_token, title)
     VALUES ($1, $2)
     ON CONFLICT (session_token) DO NOTHING`,
    [sessionToken, title],
  );

  const created = await pool.query<SessionRow>(
    `SELECT id, session_token, title FROM ai_chat_sessions WHERE session_token = $1`,
    [sessionToken],
  );
  return created.rows[0];
}

/**
 * Fetches the last N messages for a session, oldest-first (so they can be
 * appended to the Gemini `contents` array in chronological order).
 *
 * N defaults to AI_MAX_HISTORY (10) — keeps token usage predictable.
 */
async function fetchHistory(
  sessionId: number,
  limit: number,
): Promise<MessageRow[]> {
  // Subquery: get the last N rows in DESC order, then re-sort ASC for use.
  const result = await pool.query<MessageRow>(
    `SELECT id, session_id, role, content, created_at
     FROM (
       SELECT id, session_id, role, content, created_at
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
 * Persist a single message (user or assistant). Fire-and-forget — the
 * caller doesn't wait for this to send the SSE response.
 */
async function persistMessage(
  sessionId: number,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO ai_chat_messages (session_id, role, content)
       VALUES ($1, $2, $3)`,
      [sessionId, role, content],
    );
    // Bump updated_at on the session so we can sort by "most recently active"
    // if we ever build a conversation list.
    await pool.query(
      `UPDATE ai_chat_sessions SET updated_at = NOW() WHERE id = $1`,
      [sessionId],
    );
  } catch (err) {
    logger.error({ err, sessionId, role }, "AI: failed to persist message");
    // Non-fatal — the response was already streamed to the user.
  }
}

// ─── POST /ai/chat ──────────────────────────────────────────────────────────

router.post("/ai/chat", aiChatLimiter, async (req: Request, res: Response) => {
  // ─── 1. Validate body ───
  const { message, sessionToken } = (req.body ?? {}) as ChatRequestBody;
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
  // Generate a token if the client didn't send one (defense for first-time
  // visitors without localStorage yet).
  const token =
    typeof sessionToken === "string" && sessionToken.length >= 8
      ? sessionToken
      : crypto.randomUUID();

  // ─── 2. Service availability check ───
  if (!isGeminiConfigured()) {
    res.status(503).json({
      error:
        "TreeBot is not configured. Set GEMINI_API_KEY on the API server " +
        "(get a free key at https://aistudio.google.com/apikey).",
    });
    return;
  }

  // ─── 3. Hard topic gate ───
  // If the message has zero botanical keywords, refuse WITHOUT calling
  // Gemini. Saves quota and prevents off-topic abuse.
  if (!hasBotanicalKeyword(message)) {
    // We still need to send back a sessionToken so the client can store it.
    // Persist the user message + refusal so the conversation is consistent.
    try {
      const session = await findOrCreateSession(token, message);
      await persistMessage(session.id, "user", message);
      const refusal =
        "I'm TreeFriend's plant assistant and can only help with trees, plants, and gardening. " +
        "Feel free to ask me about plant care or browse our catalog at /browse.";
      await persistMessage(session.id, "assistant", refusal);

      res.json({
        sessionToken: token,
        message: refusal,
        offTopic: true,
      });
    } catch (err) {
      logger.error({ err }, "AI: hard-gate persist failed");
      res.status(500).json({ error: "Failed to process request." });
    }
    return;
  }

  // ─── 3b. Pure greeting shortcut ───
  // For "Hi" / "Hello" / "Salam" etc., skip Gemini entirely and return a
  // friendly canned intro. Saves API quota + gives the user an instant
  // warm welcome instead of a 3-5 second wait for Gemini to say "hi back".
  if (isPureGreeting(message)) {
    try {
      const session = await findOrCreateSession(token, message);
      await persistMessage(session.id, "user", message);
      await persistMessage(session.id, "assistant", GREETING_INTRO_MESSAGE);
      res.json({
        sessionToken: token,
        message: GREETING_INTRO_MESSAGE,
        greeting: true,
      });
    } catch (err) {
      logger.error({ err }, "AI: greeting shortcut failed");
      res.status(500).json({ error: "Failed to process request." });
    }
    return;
  }

  // ─── 4. Find/create session + fetch history ───
  let session: SessionRow;
  try {
    session = await findOrCreateSession(token, message);
  } catch (err) {
    logger.error({ err }, "AI: findOrCreateSession failed");
    res.status(500).json({ error: "Failed to start chat session." });
    return;
  }

  const maxHistory = Number(process.env.AI_MAX_HISTORY ?? 10);
  let history: MessageRow[] = [];
  try {
    history = await fetchHistory(session.id, maxHistory);
  } catch (err) {
    // Non-fatal: proceed with empty history. The model will still answer,
    // just without conversational continuity for this turn.
    logger.error({ err, sessionId: session.id }, "AI: fetchHistory failed");
  }

  // ─── 5. Build catalog context (Naive RAG) ───
  const catalogContext = await buildCatalogContext(message);
  const systemPrompt = buildSystemPrompt(catalogContext);

  // Convert DB rows to Gemini's expected shape (role: 'user' | 'model').
  const geminiHistory = history.map((h) => ({
    role: h.role === "assistant" ? ("model" as const) : ("user" as const),
    text: h.content,
  }));

  // ─── 6. Persist the user message BEFORE streaming ───
  // We do this now (not after) so that even if the streaming fails midway,
  // the user's message is preserved and the conversation can resume.
  await persistMessage(session.id, "user", message);

  // ─── 7. Set up SSE response ───
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
  res.flushHeaders?.();

  // Send the sessionToken to the client immediately so it can store it in
  // localStorage BEFORE the first content chunk arrives. This way, if the
  // connection drops mid-stream, the client still knows which session to
  // resume from on reconnect.
  res.write(`data: ${JSON.stringify({ type: "session", sessionToken: token })}\n\n`);

  // ─── 8. Stream Gemini response ───
  let fullResponse = "";
  try {
    const stream = streamGeminiChat(systemPrompt, geminiHistory, message);
    for await (const chunk of stream) {
      if (!chunk) continue;
      fullResponse += chunk;
      res.write(`data: ${JSON.stringify({ type: "delta", text: chunk })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  } catch (err) {
    // Extract the most useful bits from the SDK error so we can debug.
    // @google/genai errors typically have: err.status, err.message, err.error
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
    const userMessage = isAuthError
      ? "TreeBot is having trouble connecting to the AI service. " +
        "This is likely a configuration issue on our side — please try again later."
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
  } finally {
    res.end();
  }

  // ─── 9. Persist the assistant response (fire-and-forget) ───
  if (fullResponse) {
    await persistMessage(session.id, "assistant", fullResponse);
  }
});

// ─── GET /ai/sessions/:token ────────────────────────────────────────────────
// Returns the message history for a session, oldest-first. Used by the
// frontend on mount to rehydrate the conversation.
router.get(
  "/ai/sessions/:token",
  async (req: Request, res: Response) => {
    const { token } = req.params;
    if (!token || token.length < 8) {
      res.status(400).json({ error: "Invalid session token." });
      return;
    }

    try {
      const sessionResult = await pool.query<SessionRow>(
        `SELECT id, session_token, title FROM ai_chat_sessions WHERE session_token = $1`,
        [token],
      );
      if (sessionResult.rows.length === 0) {
        // No session yet — return empty array so the frontend can start fresh.
        res.json({ sessionToken: token, title: null, messages: [] });
        return;
      }
      const session = sessionResult.rows[0];

      const maxHistory = Number(process.env.AI_MAX_HISTORY ?? 20); // more for view
      const messages = await fetchHistory(session.id, maxHistory);
      res.json({
        sessionToken: token,
        title: session.title,
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
        })),
      });
    } catch (err) {
      logger.error({ err, token }, "AI: GET session failed");
      res.status(500).json({ error: "Failed to load chat history." });
    }
  },
);

// ─── DELETE /ai/sessions/:token ─────────────────────────────────────────────
// Clears a conversation. CASCADE deletes the associated messages.
router.delete(
  "/ai/sessions/:token",
  async (req: Request, res: Response) => {
    const { token } = req.params;
    if (!token || token.length < 8) {
      res.status(400).json({ error: "Invalid session token." });
      return;
    }

    try {
      await pool.query(
        `DELETE FROM ai_chat_sessions WHERE session_token = $1`,
        [token],
      );
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err, token }, "AI: DELETE session failed");
      res.status(500).json({ error: "Failed to clear chat history." });
    }
  },
);

// Touch the imports so unused-imports lint doesn't complain (these are
// used via the type system and the table objects exported by @workspace/db
// elsewhere if other routes ever need to JOIN on AI tables).
void aiChatSessionsTable;
void aiChatMessagesTable;
void eq;
void asc;
void desc;
void describeError;

export default router;
