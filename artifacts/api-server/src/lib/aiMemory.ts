/**
 * v3.0 Conversation memory for the TreeBot assistant.
 *
 * Problem:
 *   v2.5 capped Gemini's history at AI_MAX_HISTORY=10 messages. Long
 *   conversations silently lost early context — if a user mentioned their
 *   garden setup in turn 1, by turn 12 the assistant had forgotten.
 *
 * Solution:
 *   When the history array exceeds AI_SUMMARY_THRESHOLD messages, we ask
 *   Gemini to summarize the OLDER half. The summary is stored on the
 *   session row and injected into the system prompt on subsequent turns.
 *   Messages below the summary cutoff are excluded from the history array
 *   sent to Gemini (the summary replaces them — much cheaper token-wise).
 *
 * Flow:
 *   1. After persisting the user's message, fetch full history.
 *   2. If history.length >= AI_SUMMARY_THRESHOLD AND no summary exists yet,
 *      summarize the older half (everything except the most recent N).
 *   3. If a summary already exists AND more than AI_RESUMMARIZE_INTERVAL
 *      new messages have accumulated since the last summary, regenerate
 *      the summary (incorporating both the old summary + new messages).
 *   4. Build the Gemini history array: include only messages with
 *      id > summaryCutoffId. The summary is injected into the system
 *      prompt as "PRIOR CONVERSATION SUMMARY".
 *
 * Token budget:
 *   A typical summary is 50-150 tokens. A typical message is 30-200 tokens.
 *   Summarizing 10 messages saves ~500-1500 tokens per turn — significant
 *   on the Gemini free tier (1,500 RPD daily quota).
 *
 * Failure handling:
 *   Summarization is best-effort. If Gemini fails to summarize (network,
 *   quota, etc.), we proceed WITHOUT a summary — the history array just
 *   includes the most recent AI_MAX_HISTORY messages (v2.5 behavior).
 *   The user's chat experience is unaffected.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { summarizeConversationRouted } from "./aiRouter";

// ─── Config ──────────────────────────────────────────────────────────────────

const SUMMARY_THRESHOLD = Number(process.env.AI_SUMMARY_THRESHOLD ?? 12);
const RESUMMARIZE_INTERVAL = Number(process.env.AI_RESUMMARIZE_INTERVAL ?? 8);
const RECENT_HISTORY_KEEP = Number(process.env.AI_MAX_HISTORY ?? 10);

// ─── Types ───────────────────────────────────────────────────────────────────

interface MessageRow {
  id: number;
  role: string;
  content: string;
  created_at: Date;
}

export interface SessionMemory {
  /** The summary text to inject into the system prompt. NULL if no summary. */
  summary: string | null;
  /**
   * The message id cutoff. Messages with id <= cutoffId are considered
   * "summarized" and should be EXCLUDED from the history array sent to
   * Gemini. NULL if no summary.
   */
  cutoffId: number | null;
}

// ─── Public functions ────────────────────────────────────────────────────────

/**
 * Loads the current session memory (summary + cutoff) from the DB.
 *
 * Returns { summary: null, cutoffId: null } if no summary exists yet.
 */
export async function loadSessionMemory(sessionId: number): Promise<SessionMemory> {
  try {
    const result = await pool.query<{
      summary: string | null;
      summary_cutoff_id: number | null;
    }>(`SELECT summary, summary_cutoff_id FROM ai_chat_sessions WHERE id = $1`, [sessionId]);
    if (result.rows.length === 0) {
      return { summary: null, cutoffId: null };
    }
    return {
      summary: result.rows[0].summary,
      cutoffId: result.rows[0].summary_cutoff_id,
    };
  } catch (err) {
    logger.error({ err, sessionId }, "Memory: failed to load session memory");
    return { summary: null, cutoffId: null };
  }
}

/**
 * Decides whether to summarize (or re-summarize) the conversation, and
 * if so, calls the AI provider's summarize function + persists the result.
 *
 * Called AFTER the user's message is persisted but BEFORE building the
 * Gemini history array.
 *
 * Logic:
 *   - If no summary exists AND total messages >= SUMMARY_THRESHOLD:
 *     summarize the older half (everything except the most recent
 *     RECENT_HISTORY_KEEP messages).
 *   - If summary exists AND messages-since-last-summary >= RESUMMARIZE_INTERVAL:
 *     regenerate the summary, incorporating the old summary + new messages.
 *
 * Idempotent: if the conversation is short and no summary is needed,
 * this is a no-op (returns the existing memory).
 */
export async function maybeSummarize(
  sessionId: number,
  currentMemory: SessionMemory,
): Promise<SessionMemory> {
  try {
    // Count total messages in the session.
    const countResult = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ai_chat_messages WHERE session_id = $1`,
      [sessionId],
    );
    const totalMessages = countResult.rows[0]?.count ?? 0;

    // Case 1: No summary yet, conversation just crossed the threshold.
    if (!currentMemory.summary && totalMessages >= SUMMARY_THRESHOLD) {
      logger.info(
        { sessionId, totalMessages, threshold: SUMMARY_THRESHOLD },
        "Memory: generating initial conversation summary",
      );
      await generateAndStoreSummary(sessionId, null, null);
      return await loadSessionMemory(sessionId);
    }

    // Case 2: Summary exists, but enough new messages have accumulated
    // to warrant a re-summarization.
    if (currentMemory.summary && currentMemory.cutoffId != null) {
      const sinceCutoffResult = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM ai_chat_messages
         WHERE session_id = $1 AND id > $2`,
        [sessionId, currentMemory.cutoffId],
      );
      const newMessagesSinceSummary = sinceCutoffResult.rows[0]?.count ?? 0;

      if (newMessagesSinceSummary >= RESUMMARIZE_INTERVAL) {
        logger.info(
          {
            sessionId,
            newMessagesSinceSummary,
            interval: RESUMMARIZE_INTERVAL,
          },
          "Memory: regenerating conversation summary",
        );
        await generateAndStoreSummary(sessionId, currentMemory.summary, currentMemory.cutoffId);
        return await loadSessionMemory(sessionId);
      }
    }

    // No summarization needed — return existing memory.
    return currentMemory;
  } catch (err) {
    logger.error({ err, sessionId }, "Memory: maybeSummarize failed");
    // Non-fatal — proceed without summary.
    return currentMemory;
  }
}

/**
 * Fetches the messages to include in the Gemini history array, respecting
 * the summary cutoff.
 *
 * - If a summary exists (cutoffId != null), only returns messages with
 *   id > cutoffId, capped at RECENT_HISTORY_KEEP.
 * - If no summary, returns the last RECENT_HISTORY_KEEP messages (v2.5
 *   behavior).
 *
 * Returns oldest-first (the order Gemini expects in the contents array).
 */
export async function fetchHistoryForGemini(
  sessionId: number,
  cutoffId: number | null,
  limit: number = RECENT_HISTORY_KEEP,
): Promise<{ role: "user" | "model"; text: string }[]> {
  try {
    let result;
    if (cutoffId != null) {
      // Only messages AFTER the cutoff (the summary already captured
      // everything up to and including cutoffId).
      result = await pool.query<MessageRow>(
        `SELECT id, role, content FROM (
           SELECT id, role, content, created_at
           FROM ai_chat_messages
           WHERE session_id = $1 AND id > $2
           ORDER BY created_at DESC
           LIMIT $3
         ) AS recent
         ORDER BY created_at ASC`,
        [sessionId, cutoffId, limit],
      );
    } else {
      // No summary — fall back to v2.5 behavior.
      result = await pool.query<MessageRow>(
        `SELECT id, role, content FROM (
           SELECT id, role, content, created_at
           FROM ai_chat_messages
           WHERE session_id = $1
           ORDER BY created_at DESC
           LIMIT $2
         ) AS recent
         ORDER BY created_at ASC`,
        [sessionId, limit],
      );
    }

    return result.rows.map((m) => ({
      role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      text: m.content,
    }));
  } catch (err) {
    logger.error({ err, sessionId, cutoffId }, "Memory: fetchHistoryForGemini failed");
    return [];
  }
}

/**
 * Builds the summary injection block for the system prompt.
 *
 * Returns an empty string if no summary exists. Otherwise returns:
 *
 *   PRIOR CONVERSATION SUMMARY:
 *   <summary text>
 *
 *   (The most recent messages are shown to you in the history array.
 *   Use both the summary and recent history to answer the user's question.)
 */
export function buildSummaryPromptBlock(summary: string | null): string {
  if (!summary) return "";
  return (
    `\n\nPRIOR CONVERSATION SUMMARY:\n${summary}\n\n` +
    `(The summary above captures earlier turns of this conversation. The most recent ` +
    `messages are in the history array. Use BOTH to answer the user's question ` +
    `with full context.)\n`
  );
}

// ─── Internals ───────────────────────────────────────────────────────────────

/**
 * Calls Gemini to summarize the conversation, then persists the summary
 * + cutoff on the session row.
 *
 * @param sessionId - The session id
 * @param oldSummary - Existing summary (if regenerating). NULL on first summary.
 * @param oldCutoffId - Existing cutoff id (if regenerating). NULL on first summary.
 *
 * The summarization includes:
 *   - The old summary (if exists) — provides continuity
 *   - All messages with id > oldCutoffId, EXCEPT the most recent
 *     RECENT_HISTORY_KEEP messages (those stay in the history array)
 */
async function generateAndStoreSummary(
  sessionId: number,
  oldSummary: string | null,
  oldCutoffId: number | null,
): Promise<void> {
  // Fetch messages to summarize: everything after oldCutoffId, except the
  // most recent RECENT_HISTORY_KEEP messages.
  const result = await pool.query<MessageRow>(
    `SELECT id, role, content FROM (
       SELECT id, role, content, created_at
       FROM ai_chat_messages
       WHERE session_id = $1
         ${oldCutoffId != null ? "AND id > $2" : ""}
       ORDER BY created_at DESC
       LIMIT $3
     ) AS to_summarize
     ORDER BY created_at ASC`,
    oldCutoffId != null
      ? [sessionId, oldCutoffId, Number.MAX_SAFE_INTEGER]
      : [sessionId, Number.MAX_SAFE_INTEGER],
  );

  // Take everything except the most recent RECENT_HISTORY_KEEP messages.
  const allMessages = result.rows;
  const toSummarize = allMessages.slice(0, Math.max(0, allMessages.length - RECENT_HISTORY_KEEP));

  if (toSummarize.length === 0) {
    logger.warn({ sessionId }, "Memory: no messages to summarize");
    return;
  }

  // The new cutoff is the id of the LAST message we're summarizing.
  const newCutoffId = toSummarize[toSummarize.length - 1].id;

  // Build the input for Gemini: old summary (if any) + messages to summarize.
  const messagesForSummary = toSummarize.map((m) => ({
    role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
    content: m.content,
  }));

  // If we have an old summary, prepend it as context.
  const summaryInput = oldSummary
    ? [
        { role: "assistant" as const, content: `(Previous summary: ${oldSummary})` },
        ...messagesForSummary,
      ]
    : messagesForSummary;

  // Call the AI provider to summarize (tries Gemini first, falls back to Groq).
  const summary = await summarizeConversationRouted(summaryInput);

  // Persist the new summary + cutoff.
  await pool.query(
    `UPDATE ai_chat_sessions
     SET summary = $1,
         summary_cutoff_id = $2,
         summarized_count = $3,
         summary_updated_at = NOW()
     WHERE id = $4`,
    [summary, newCutoffId, toSummarize.length, sessionId],
  );

  // Mark the summarized messages as `summarized = TRUE` so admin can see
  // which messages are compressed into the summary vs sent verbatim.
  const summarizedIds = toSummarize.map((m) => m.id);
  if (summarizedIds.length > 0) {
    // Build parameterized IN clause.
    const placeholders = summarizedIds.map((_, i) => `$${i + 2}`).join(", ");
    await pool.query(
      `UPDATE ai_chat_messages SET summarized = TRUE WHERE session_id = $1 AND id IN (${placeholders})`,
      [sessionId, ...summarizedIds],
    );
  }

  // Log an event for debugging.
  await logAiEvent(sessionId, "summary_generated", {
    summarizedCount: toSummarize.length,
    newCutoffId,
    regenerated: oldSummary != null,
    summaryLength: summary.length,
  });

  logger.info(
    { sessionId, summarizedCount: toSummarize.length, newCutoffId, summaryLength: summary.length },
    "Memory: conversation summary generated + stored",
  );
}

/**
 * Logs an event to the ai_chat_events table (v3.0 audit trail).
 *
 * Best-effort: failures are logged but don't propagate. The event log is
 * for debugging/observability only — never block the main chat flow on it.
 */
export async function logAiEvent(
  sessionId: number,
  type: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO ai_chat_events (session_id, type, payload)
       VALUES ($1, $2, $3)`,
      [sessionId, type, payload ? JSON.stringify(payload) : null],
    );
  } catch (err) {
    logger.debug({ err, sessionId, type }, "Memory: failed to log AI event (non-fatal)");
  }
}
