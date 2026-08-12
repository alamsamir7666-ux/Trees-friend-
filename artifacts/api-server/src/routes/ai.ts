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
  aiChatFeedbackTable,
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
 *
 * Returns the inserted row's `id` (numeric DB primary key) so the caller
 * can forward it to the client (e.g. for feedback buttons that need to
 * reference a specific message). Returns undefined if the insert failed.
 */
async function persistMessage(
  sessionId: number,
  role: "user" | "assistant",
  content: string,
): Promise<number | undefined> {
  try {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO ai_chat_messages (session_id, role, content)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [sessionId, role, content],
    );
    // Bump updated_at on the session so we can sort by "most recently active"
    // if we ever build a conversation list.
    await pool.query(
      `UPDATE ai_chat_sessions SET updated_at = NOW() WHERE id = $1`,
      [sessionId],
    );
    return result.rows[0]?.id;
  } catch (err) {
    logger.error({ err, sessionId, role }, "AI: failed to persist message");
    // Non-fatal — the response was already streamed to the user.
    return undefined;
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
      const assistantMsgId = await persistMessage(session.id, "assistant", refusal);

      res.json({
        sessionToken: token,
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

  // ─── 3b. Pure greeting shortcut ───
  // For "Hi" / "Hello" / "Salam" etc., skip Gemini entirely and return a
  // friendly canned intro. Saves API quota + gives the user an instant
  // warm welcome instead of a 3-5 second wait for Gemini to say "hi back".
  if (isPureGreeting(message)) {
    try {
      const session = await findOrCreateSession(token, message);
      await persistMessage(session.id, "user", message);
      const assistantMsgId = await persistMessage(
        session.id,
        "assistant",
        GREETING_INTRO_MESSAGE,
      );
      res.json({
        sessionToken: token,
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
  let assistantMsgId: number | undefined;
  try {
    const stream = streamGeminiChat(systemPrompt, geminiHistory, message);
    for await (const chunk of stream) {
      if (!chunk) continue;
      fullResponse += chunk;
      res.write(`data: ${JSON.stringify({ type: "delta", text: chunk })}\n\n`);
    }
    // ─── Persist the assistant message BEFORE sending done ───
    // We need its DB id so the frontend can wire up feedback buttons.
    assistantMsgId = await persistMessage(session.id, "assistant", fullResponse);
    if (assistantMsgId != null) {
      res.write(
        `data: ${JSON.stringify({ type: "messageId", messageId: assistantMsgId })}\n\n`,
      );
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
    const isAllModelsUnavailable = /all configured gemini models/i.test(
      errInfo.message,
    );
    const isRateLimit =
      errInfo.status === 429 || /rate limit|quota|too many/i.test(errInfo.message);

    const userMessage = isAllModelsUnavailable
      ? "TreeBot is temporarily unavailable — we're updating our AI service. " +
        "Please try again in a few minutes."
      : isAuthError
        ? "TreeBot is having trouble connecting to the AI service. " +
          "This is likely a configuration issue on our side — please try again later."
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
  } finally {
    res.end();
  }

  // ─── 9. Persist the assistant response (fire-and-forget) ───
  // Note: the assistant message was already persisted in step 8 (before
  // sending the "done" event) so we could send its ID to the frontend for
  // feedback wiring. This fallback handles the case where the stream
  // errored BEFORE step 8 could run (so assistantMsgId is undefined) but
  // fullResponse still has the error-fallback content from the catch block.
  if (fullResponse && assistantMsgId == null) {
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

// ─── POST /ai/feedback ──────────────────────────────────────────────────────
// Records a 👍/👎 rating on a specific assistant message. Idempotent via
// the unique constraint on message_id — re-clicking the same rating
// removes it (toggle behavior), clicking the opposite rating updates
// the row in place.
//
// Body: { messageId: number, rating: "up" | "down" }
// Returns: { ok: true, rating: "up" | "down" | null }
router.post("/ai/feedback", async (req: Request, res: Response) => {
  const { messageId, rating } = (req.body ?? {}) as {
    messageId?: number;
    rating?: "up" | "down";
  };

  if (!messageId || typeof messageId !== "number") {
    res.status(400).json({ error: "messageId is required." });
    return;
  }
  if (rating !== "up" && rating !== "down") {
    res.status(400).json({ error: 'rating must be "up" or "down".' });
    return;
  }

  try {
    // Look up the message to (a) verify it exists, (b) get its session_id
    // for the FK on the feedback row.
    const msgResult = await pool.query<{ session_id: number }>(
      `SELECT session_id FROM ai_chat_messages WHERE id = $1`,
      [messageId],
    );
    if (msgResult.rows.length === 0) {
      res.status(404).json({ error: "Message not found." });
      return;
    }
    const sessionId = msgResult.rows[0].session_id;

    // Check if feedback already exists for this message.
    const existing = await pool.query<{ id: number; rating: string }>(
      `SELECT id, rating FROM ai_chat_feedback WHERE message_id = $1`,
      [messageId],
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.rating === rating) {
        // Same rating clicked again → toggle OFF (delete the row).
        await pool.query(`DELETE FROM ai_chat_feedback WHERE id = $1`, [row.id]);
        res.json({ ok: true, rating: null });
        return;
      }
      // Opposite rating → update in place.
      await pool.query(
        `UPDATE ai_chat_feedback SET rating = $1, created_at = NOW() WHERE id = $2`,
        [rating, row.id],
      );
      res.json({ ok: true, rating });
      return;
    }

    // No existing feedback → insert.
    await pool.query(
      `INSERT INTO ai_chat_feedback (message_id, session_id, rating)
       VALUES ($1, $2, $3)`,
      [messageId, sessionId, rating],
    );
    res.json({ ok: true, rating });
  } catch (err) {
    logger.error({ err, messageId, rating }, "AI: feedback POST failed");
    res.status(500).json({ error: "Failed to record feedback." });
  }
});

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
    const ordered = slugs
      .map((s) => bySlug.get(s))
      .filter(Boolean) as typeof result.rows;

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
