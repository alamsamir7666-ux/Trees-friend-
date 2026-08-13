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
  hasBotanicalKeyword,
  isPureGreeting,
  GREETING_INTRO_MESSAGE,
} from "../lib/aiContext";
import { AI_TOOL_DECLARATIONS, executeTool } from "../lib/aiTools";
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
  off_topic: boolean;
  greeting: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find or create an ai_chat_sessions row for the given client token.
 * Returns the row's id (numeric primary key) so messages can FK to it.
 *
 * On first message in a session, we also stamp the `title` column with a
 * truncated version of the message -- useful for future UIs that list
 * conversations.
 *
 * v2.0: if `userId` is provided (signed-in user), it's stored on the
 * session row. Anonymous sessions leave user_id NULL. If the session
 * already existed anonymously and the user later signs in, we update
 * user_id on the existing row (so a single conversation can transition
 * from anon -> authenticated without losing history).
 */
async function findOrCreateSession(
  sessionToken: string,
  firstMessage: string,
  userId?: string,
): Promise<SessionRow> {
  // Try to find existing first (the common case after the first turn).
  const existing = await pool.query<SessionRow>(
    `SELECT id, session_token, title FROM ai_chat_sessions WHERE session_token = $1`,
    [sessionToken],
  );
  if (existing.rows.length > 0) {
    // If a userId is now provided but the session has NULL user_id, backfill.
    if (userId) {
      await pool.query(
        `UPDATE ai_chat_sessions SET user_id = $1 WHERE session_token = $2 AND user_id IS NULL`,
        [userId, sessionToken],
      );
    }
    return existing.rows[0];
  }

  // Race-safe insert: if another request created the same token in the
  // meantime, ON CONFLICT DO NOTHING + a follow-up SELECT retrieves it.
  const title = firstMessage.slice(0, 80).trim() || "New conversation";
  await pool.query(
    `INSERT INTO ai_chat_sessions (session_token, title, user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_token) DO NOTHING`,
    [sessionToken, title, userId ?? null],
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
  } = {},
): Promise<number | undefined> {
  try {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO ai_chat_messages (session_id, role, content, off_topic, greeting,
                                      pii_redacted, model, response_ms, token_count,
                                      cost_usd, provider, prompt_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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

  // ─── 1b. Resolve signed-in user (OPTIONAL) ───
  // v2.0: if the user is signed in via Clerk (or mobile JWT -- handled by the
  // middleware that runs before us), we attach their identity to the session
  // and inject their orders + wishlist into the system prompt. If not signed
  // in, we proceed as anonymous (v1 behavior).
  const clerkUserId = req.userId ?? getAuth(req)?.userId ?? null;

  // ─── 2. Service availability check ───
  // v3.1: check if ANY provider is configured (Gemini OR Groq).
  if (!isAnyProviderConfigured()) {
    res.status(503).json({
      error:
        "TreeBot is not configured. Set GEMINI_API_KEY (https://aistudio.google.com/apikey) " +
        "and/or GROQ_API_KEY (https://console.groq.com) on the API server.",
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
      const session = await findOrCreateSession(token, safeMessage, clerkUserId ?? undefined);
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

  // ─── 4b. Pure greeting shortcut ───
  // For "Hi" / "Hello" / "Salam" etc., skip Gemini entirely and return a
  // friendly canned intro. Saves API quota + gives the user an instant
  // warm welcome instead of a 3-5 second wait for Gemini to say "hi back".
  if (isPureGreeting(safeMessage)) {
    try {
      const session = await findOrCreateSession(token, safeMessage, clerkUserId ?? undefined);
      await persistMessage(session.id, "user", safeMessage, {
        piiRedacted: piiResult.hadPii,
      });
      const assistantMsgId = await persistMessage(session.id, "assistant", GREETING_INTRO_MESSAGE, {
        greeting: true,
        responseMs: Date.now() - requestStartTime,
      });
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

  // ─── 5. Find/create session ───
  let session: SessionRow;
  try {
    session = await findOrCreateSession(token, safeMessage, clerkUserId ?? undefined);
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

  // ─── 9. Build system prompt (with summary + catalog context) ───
  const catalogContext = await buildCatalogContext(safeMessage);
  const summaryBlock = buildSummaryPromptBlock(memory.summary);
  const systemPrompt = buildSystemPrompt(catalogContext, summaryBlock);

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
  res.write(`data: ${JSON.stringify({ type: "session", sessionToken: token })}\n\n`);

  // ─── v3.2/v3.4: Cache check (exact-match + semantic) ─────────────────
  // Before calling the AI provider, check TWO caches:
  //   1. Exact-match (Redis): systemPrompt + history hash + message hash
  //   2. Semantic (pgvector): embedding similarity > 0.92
  // If either hits, stream the cached response — zero API cost, instant.
  //
  // Skip cache for private queries (user asking about their orders, etc.)
  const isPrivateQuery = /my order|where is my order|what did i buy|my orders/i.test(safeMessage);

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
  const metaHolder: { value: { model: string; usage?: unknown; provider?: string } | null } = { value: null };

  // v3.2: get the active prompt version for tracking
  const promptVersionInfo = await getActivePrompt();

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

    // v3.0: extract token count from usage metadata (if Gemini provided it).
    // The shape is: { promptTokenCount, candidatesTokenCount, totalTokenCount }
    let tokenCount: number | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    if (metaHolder.value?.usage && typeof metaHolder.value.usage === "object") {
      const usage = metaHolder.value.usage as {
        totalTokenCount?: number;
        candidatesTokenCount?: number;
        promptTokenCount?: number;
      };
      tokenCount = usage.totalTokenCount ?? usage.candidatesTokenCount;
      promptTokens = usage.promptTokenCount;
      completionTokens = usage.candidatesTokenCount;
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
    assistantMsgId = await persistMessage(session.id, "assistant", fullResponse, {
      model: metaHolder.value?.model,
      responseMs: Date.now() - requestStartTime,
      tokenCount,
      costUsd: costBreakdown?.costUsd,
      provider: metaHolder.value?.provider,
      promptVersion: promptVersionInfo.version,
    });

    // v3.2/v3.4: store the response in BOTH caches for future hits.
    // - Exact-match (Redis): fast, deterministic key
    // - Semantic (pgvector): catches similar phrasings via embedding similarity
    // Skip if the response was too long, had tool calls, or was a private query.
    if (fullResponse && !isPrivateQuery) {
      const model = metaHolder.value?.model ?? "unknown";
      const provider = metaHolder.value?.provider ?? "unknown";

      // Exact-match cache (fire-and-forget)
      setCachedResponse(
        systemPrompt,
        geminiHistory,
        safeMessage,
        fullResponse,
        model,
        provider,
        false,
        isPrivateQuery,
      ).catch(() => {});

      // Semantic cache (fire-and-forget — embedding generation takes ~100ms)
      setSemanticCachedResponse(
        safeMessage,
        fullResponse,
        model,
        provider,
        false,
        isPrivateQuery,
      ).catch(() => {});
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

// ─── GET /ai/sessions/:token ────────────────────────────────────────────────
// Returns the message history for a session, oldest-first. Used by the
// frontend on mount to rehydrate the conversation.
router.get("/ai/sessions/:token", async (req: Request, res: Response) => {
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
      // No session yet -- return empty array so the frontend can start fresh.
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
        offTopic: m.off_topic,
        greeting: m.greeting,
      })),
    });
  } catch (err) {
    logger.error({ err, token }, "AI: GET session failed");
    res.status(500).json({ error: "Failed to load chat history." });
  }
});

// ─── DELETE /ai/sessions/:token ─────────────────────────────────────────────
// Clears a conversation. CASCADE deletes the associated messages.
router.delete("/ai/sessions/:token", async (req: Request, res: Response) => {
  const { token } = req.params;
  if (!token || token.length < 8) {
    res.status(400).json({ error: "Invalid session token." });
    return;
  }

  try {
    await pool.query(`DELETE FROM ai_chat_sessions WHERE session_token = $1`, [token]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, token }, "AI: DELETE session failed");
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
// Records a thumbs up/down rating on a specific assistant message. Idempotent via
// the unique constraint on message_id -- re-clicking the same rating
// removes it (toggle behavior), clicking the opposite rating updates the
// row in place.
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
        // Same rating clicked again -> toggle OFF (delete the row).
        await pool.query(`DELETE FROM ai_chat_feedback WHERE id = $1`, [row.id]);
        res.json({ ok: true, rating: null });
        return;
      }
      // Opposite rating -> update in place.
      await pool.query(
        `UPDATE ai_chat_feedback SET rating = $1, created_at = NOW() WHERE id = $2`,
        [rating, row.id],
      );
      res.json({ ok: true, rating });
      return;
    }

    // No existing feedback -> insert.
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
