/**
 * TreeBot Admin Insights API (v2.0).
 *
 * All endpoints are mounted under /api/ai/admin/* and require the
 * `requireAdmin` middleware (the user must have role='admin' in the
 * users table — see middlewares/auth.ts).
 *
 * Provides aggregated metrics about TreeBot usage for the new "TreeBot
 * Insights" admin tab:
 *
 *   GET  /api/ai/admin/overview        — headline counts + refusal rate
 *   GET  /api/ai/admin/timeseries      — daily message volume (last N days)
 *   GET  /api/ai/admin/top-questions   — top keywords from user messages
 *   GET  /api/ai/admin/top-products    — most-mentioned [[products]] in AI replies
 *   GET  /api/ai/admin/feedback        — paginated list of 👍/👎 rated messages
 *
 * Design notes:
 *   - All queries are read-only (SELECT) — no writes.
 *   - All queries use indexes (we created them in ensureAiTables.ts).
 *   - Time-bucketed queries use date_trunc('day', created_at) for
 *     cross-Postgres compatibility (Supabase/Neon/RDS all support it).
 *   - Pagination is cursor-style (offset + limit) — simple, and the
 *     admin UI doesn't need infinite scroll for feedback.
 *   - All endpoints return JSON; no streaming.
 */
import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { logger } from "../lib/logger";
import {
  getModelDebugInfo,
  discoverAvailableModels,
  forceRediscover,
  isGeminiConfigured,
} from "../lib/gemini";
import {
  getProvidersDebugInfo,
  forceAllProvidersRediscover,
} from "../lib/aiRouter";
// Bug #3 fix: prompt versioning + eval harness admin endpoints.
import {
  listPromptVersions,
  getActivePromptVersion,
  getPromptVersion,
  createPromptVersion,
  activatePromptVersion,
  deletePromptVersion,
} from "../lib/promptVersioning";
import {
  getEvalCases,
  getEvalResults,
  evaluateResponse,
  saveEvalResult,
  type EvalCase,
} from "../lib/evalHarness";
import { streamChat, isAnyProviderConfigured } from "../lib/aiRouter";
import { hasBotanicalKeyword } from "../lib/aiContext";
// Phase 1: Knowledge Base category management.
import {
  listKbCategories,
  getKbCategoryTree,
  getKbCategory,
  createKbCategory,
  updateKbCategory,
  moveKbCategory,
  deleteKbCategory,
  SLUG_REGEX,
  SLUG_MAX_LENGTH,
  NAME_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
} from "../lib/kbCategories";
// Phase 2: Knowledge Base source + entry + creator management.
import {
  listKbCreators,
  getKbCreator,
  createKbCreator,
  updateKbCreator,
  deleteKbCreator,
  CREATOR_SLUG_REGEX,
  CREATOR_SLUG_MAX_LENGTH,
  CREATOR_NAME_MAX_LENGTH,
  CREATOR_PROFILE_URL_MAX_LENGTH,
  VALID_SOURCE_TYPES,
} from "../lib/kbCreators";
import {
  listKbSources,
  getKbSource,
  createKbSource,
  updateKbSource,
  deleteKbSource,
  updateProcessingStatus,
  updateChunkingMetadata,
  SOURCE_TITLE_MAX_LENGTH,
  SOURCE_URL_MAX_LENGTH,
  RAW_TEXT_MAX_LENGTH,
  VALID_LANGUAGES,
  type KbSource,
} from "../lib/kbSources";
import {
  listKbEntries,
  getKbEntry,
  createEntry,
  createEntriesBatch,
  updateEntry,
  activateEntry,
  deactivateEntry,
  deleteEntry,
  ENTRY_TITLE_MAX_LENGTH,
  ENTRY_CONTENT_MAX_LENGTH,
  ENTRY_KEYWORD_MAX_COUNT,
  ENTRY_KEYWORD_MAX_LENGTH,
  ENTRY_PRIORITY_MIN,
  ENTRY_PRIORITY_MAX,
} from "../lib/kbEntries";
import { chunkTextWithAI } from "../lib/kbChunking";
import { searchKnowledgeBase, getKbStats } from "../lib/kbSearch";

const router = Router();

// All routes in this file require admin.
router.use(requireAdmin);

// ─── GET /api/ai/admin/overview ──────────────────────────────────────────────
// Headline stats for the dashboard cards.
//   - totalSessions: distinct ai_chat_sessions count
//   - totalMessages: distinct ai_chat_messages count
//   - totalFeedback: distinct ai_chat_feedback count (any rating)
//   - positiveFeedback, negativeFeedback: count by rating
//   - refusalRate: off_topic user messages / total user messages
//   - greetingCount: messages where greeting=true (excluded from refusal rate)
router.get("/ai/admin/overview", async (_req: Request, res: Response) => {
  try {
    const [sessions, messages, feedback, refusals, greetings] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM ai_chat_sessions"),
      pool.query(
        "SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE role = 'user')::int AS user_count FROM ai_chat_messages",
      ),
      pool.query(
        "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE rating = 'up')::int AS positive, COUNT(*) FILTER (WHERE rating = 'down')::int AS negative FROM ai_chat_feedback",
      ),
      pool.query(
        "SELECT COUNT(*)::int AS count FROM ai_chat_messages WHERE role = 'user' AND off_topic = TRUE",
      ),
      pool.query("SELECT COUNT(*)::int AS count FROM ai_chat_messages WHERE greeting = TRUE"),
    ]);

    const userMessageCount = messages.rows[0].user_count;
    const refusalCount = refusals.rows[0].count;
    // Refusal rate = off_topic user messages / (user messages excluding greetings).
    // Greetings are excluded because they aren't questions, so they shouldn't
    // count toward the "what % of questions did we refuse?" denominator.
    const refusalDenominator = Math.max(0, userMessageCount - greetings.rows[0].count);
    const refusalRate = refusalDenominator > 0 ? (refusalCount / refusalDenominator) * 100 : 0;

    res.json({
      totalSessions: sessions.rows[0].count,
      totalMessages: messages.rows[0].count,
      totalUserMessages: userMessageCount,
      totalAssistantMessages: messages.rows[0].count - userMessageCount,
      totalFeedback: feedback.rows[0].total,
      positiveFeedback: feedback.rows[0].positive,
      negativeFeedback: feedback.rows[0].negative,
      refusalCount,
      refusalRate: Math.round(refusalRate * 10) / 10, // 1 decimal place
      greetingCount: greetings.rows[0].count,
    });
  } catch (err) {
    logger.error({ err }, "AI admin: overview failed");
    res.status(500).json({ error: "Failed to load overview stats." });
  }
});

// ─── GET /api/ai/admin/timeseries?days=30 ────────────────────────────────────
// Daily message volume for the last N days. Returns:
//   [{ date: "2026-08-01", user: 12, assistant: 11, refusals: 1 }, ...]
router.get("/ai/admin/timeseries", async (req: Request, res: Response) => {
  const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 90);
  try {
    const result = await pool.query(
      `SELECT
         to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
         COUNT(*) FILTER (WHERE role = 'user')::int AS user_count,
         COUNT(*) FILTER (WHERE role = 'assistant')::int AS assistant_count,
         COUNT(*) FILTER (WHERE role = 'user' AND off_topic = TRUE)::int AS refusals
       FROM ai_chat_messages
       WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
       GROUP BY date_trunc('day', created_at)
       ORDER BY date_trunc('day', created_at) ASC`,
      [String(days)],
    );
    res.json({
      days,
      data: result.rows.map((r) => ({
        date: r.date,
        user: r.user_count,
        assistant: r.assistant_count,
        refusals: r.refusals,
      })),
    });
  } catch (err) {
    logger.error({ err }, "AI admin: timeseries failed");
    res.status(500).json({ error: "Failed to load timeseries." });
  }
});

// ─── GET /api/ai/admin/top-questions?limit=20 ────────────────────────────────
// Top keywords from user messages. We extract word tokens (>=4 chars,
// alpha-only) from user messages, exclude stop words, count frequency.
// Returns: [{ word: "mango", count: 15 }, ...]
router.get("/ai/admin/top-questions", async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);
  try {
    // Use Postgres regex to extract words, then aggregate in SQL.
    // This avoids pulling all messages into Node — much faster for large tables.
    const result = await pool.query(
      `SELECT word, COUNT(*)::int AS count
       FROM (
         SELECT lower(match[1]) AS word
         FROM ai_chat_messages,
              regexp_matches(content, '([a-zA-Z]{4,})', 'g') AS match
         WHERE role = 'user'
           AND off_topic = FALSE
           AND greeting = FALSE
       ) AS words
       WHERE word NOT IN (
         'that', 'this', 'with', 'from', 'have', 'they', 'will', 'what',
         'when', 'where', 'which', 'your', 'their', 'there', 'about',
         'would', 'could', 'should', 'please', 'tell', 'want', 'need',
         'know', 'like', 'just', 'also', 'some', 'them', 'then', 'than'
       )
       GROUP BY word
       ORDER BY count DESC
       LIMIT $1`,
      [limit],
    );
    res.json({
      keywords: result.rows.map((r) => ({ word: r.word, count: r.count })),
    });
  } catch (err) {
    logger.error({ err }, "AI admin: top-questions failed");
    res.status(500).json({ error: "Failed to load top questions." });
  }
});

// ─── GET /api/ai/admin/top-products?limit=20 ────────────────────────────────
// Most-mentioned [[product name]] tokens in assistant messages.
// Returns: [{ name: "Alphonso Mango", count: 8 }, ...]
router.get("/ai/admin/top-products", async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);
  try {
    // Extract [[...]] tokens via regex, strip brackets, aggregate.
    const result = await pool.query(
      `SELECT name, COUNT(*)::int AS count
       FROM (
         SELECT match[1] AS name
         FROM ai_chat_messages,
              regexp_matches(content, '\\[\\[([^\\]]+)\\]\\]', 'g') AS match
         WHERE role = 'assistant'
       ) AS mentions
       GROUP BY name
       ORDER BY count DESC
       LIMIT $1`,
      [limit],
    );
    res.json({
      products: result.rows.map((r) => ({ name: r.name, count: r.count })),
    });
  } catch (err) {
    logger.error({ err }, "AI admin: top-products failed");
    res.status(500).json({ error: "Failed to load top products." });
  }
});

// ─── GET /api/ai/admin/feedback?rating=down&limit=50&offset=0 ───────────────
// Paginated list of feedback-rated messages. Default: 👎 only (so the admin
// can see what's broken). Pass rating=all to get everything.
router.get("/ai/admin/feedback", async (req: Request, res: Response) => {
  const rating = (req.query.rating as string | undefined) ?? "down";
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);

  try {
    let queryText: string;
    const params: unknown[] = [limit, offset];

    if (rating === "all") {
      queryText = `
        SELECT
          f.id AS feedback_id,
          f.rating,
          f.comment,
          f.created_at AS feedback_at,
          m.id AS message_id,
          m.content AS assistant_content,
          m.created_at AS message_at,
          m.session_id,
          s.session_token,
          s.user_id,
          -- The user message that triggered this assistant response.
          -- Look up the message immediately before this one in the same session.
          (
            SELECT content
            FROM ai_chat_messages prev
            WHERE prev.session_id = m.session_id
              AND prev.created_at < m.created_at
              AND prev.role = 'user'
            ORDER BY prev.created_at DESC
            LIMIT 1
          ) AS user_question
        FROM ai_chat_feedback f
        JOIN ai_chat_messages m ON m.id = f.message_id
        JOIN ai_chat_sessions s ON s.id = f.session_id
        ORDER BY f.created_at DESC
        LIMIT $1 OFFSET $2`;
    } else if (rating === "up" || rating === "down") {
      params.unshift(rating);
      queryText = `
        SELECT
          f.id AS feedback_id,
          f.rating,
          f.comment,
          f.created_at AS feedback_at,
          m.id AS message_id,
          m.content AS assistant_content,
          m.created_at AS message_at,
          m.session_id,
          s.session_token,
          s.user_id,
          (
            SELECT content
            FROM ai_chat_messages prev
            WHERE prev.session_id = m.session_id
              AND prev.created_at < m.created_at
              AND prev.role = 'user'
            ORDER BY prev.created_at DESC
            LIMIT 1
          ) AS user_question
        FROM ai_chat_feedback f
        JOIN ai_chat_messages m ON m.id = f.message_id
        JOIN ai_chat_sessions s ON s.id = f.session_id
        WHERE f.rating = $1
        ORDER BY f.created_at DESC
        LIMIT $2 OFFSET $3`;
    } else {
      res.status(400).json({ error: 'rating must be "up", "down", or "all".' });
      return;
    }

    const result = await pool.query(queryText, params);

    // Also fetch total count for pagination UI.
    const countText =
      rating === "all"
        ? "SELECT COUNT(*)::int AS count FROM ai_chat_feedback"
        : "SELECT COUNT(*)::int AS count FROM ai_chat_feedback WHERE rating = $1";
    const countParams = rating === "all" ? [] : [rating];
    const countResult = await pool.query(countText, countParams);

    res.json({
      rating,
      total: countResult.rows[0].count,
      limit,
      offset,
      items: result.rows.map((r) => ({
        feedbackId: r.feedback_id,
        rating: r.rating,
        comment: r.comment,
        feedbackAt: r.feedback_at,
        messageId: r.message_id,
        assistantContent: r.assistant_content,
        messageAt: r.message_at,
        sessionId: r.session_id,
        sessionToken: r.session_token,
        userId: r.user_id,
        userQuestion: r.user_question,
      })),
    });
  } catch (err) {
    logger.error({ err }, "AI admin: feedback failed");
    res.status(500).json({ error: "Failed to load feedback." });
  }
});

// ─── GET /api/ai/admin/conversations?limit=20&offset=0 ────────────────────────
// Paginated list of ALL chat sessions (not just 👎 ones). Each row includes:
//   - session metadata (token, title, created_at, updated_at, user_id)
//   - message count
//   - last message preview (truncated)
//   - feedback counts (👍 / 👎)
//
// Used by the admin "Conversations" section to browse all TreeBot usage.
router.get("/ai/admin/conversations", async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);

  try {
    const result = await pool.query(
      `SELECT
         s.id,
         s.session_token,
         s.title,
         s.user_id,
         s.created_at,
         s.updated_at,
         (SELECT COUNT(*) FROM ai_chat_messages WHERE session_id = s.id)::int AS message_count,
         (SELECT COUNT(*) FROM ai_chat_feedback WHERE session_id = s.id AND rating = 'up')::int AS positive_count,
         (SELECT COUNT(*) FROM ai_chat_feedback WHERE session_id = s.id AND rating = 'down')::int AS negative_count,
         (
           SELECT content FROM ai_chat_messages
           WHERE session_id = s.id
           ORDER BY created_at DESC LIMIT 1
         ) AS last_message,
         (
           SELECT created_at FROM ai_chat_messages
           WHERE session_id = s.id
           ORDER BY created_at DESC LIMIT 1
         ) AS last_message_at
       FROM ai_chat_sessions s
       ORDER BY s.updated_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    const countResult = await pool.query("SELECT COUNT(*)::int AS count FROM ai_chat_sessions");

    res.json({
      total: countResult.rows[0].count,
      limit,
      offset,
      conversations: result.rows.map((r) => ({
        id: r.id,
        sessionToken: r.session_token,
        title: r.title,
        userId: r.user_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        messageCount: r.message_count,
        positiveFeedback: r.positive_count,
        negativeFeedback: r.negative_count,
        lastMessage: r.last_message ? r.last_message.slice(0, 200) : null,
        lastMessageAt: r.last_message_at,
      })),
    });
  } catch (err) {
    logger.error({ err }, "AI admin: conversations list failed");
    res.status(500).json({ error: "Failed to load conversations." });
  }
});

// ─── GET /api/ai/admin/conversations/:id ────────────────────────────────────
// Full message thread for a specific session. Returns all messages (up to 100)
// in chronological order, with feedback attached to each assistant message.
router.get("/ai/admin/conversations/:id", async (req: Request, res: Response) => {
  const sessionId = Number(req.params.id);
  if (!Number.isFinite(sessionId)) {
    res.status(400).json({ error: "Invalid session ID." });
    return;
  }

  try {
    // Fetch session metadata
    const sessionResult = await pool.query(
      `SELECT id, session_token, title, user_id, created_at, updated_at
       FROM ai_chat_sessions WHERE id = $1`,
      [sessionId],
    );
    if (sessionResult.rows.length === 0) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    const session = sessionResult.rows[0];

    // Fetch messages (up to 100, chronological order)
    const messagesResult = await pool.query(
      `SELECT id, role, content, created_at, off_topic, greeting
       FROM ai_chat_messages
       WHERE session_id = $1
       ORDER BY created_at ASC
       LIMIT 100`,
      [sessionId],
    );

    // Fetch feedback for all assistant messages in this session
    const feedbackResult = await pool.query(
      `SELECT message_id, rating, comment, created_at
       FROM ai_chat_feedback
       WHERE session_id = $1`,
      [sessionId],
    );
    const feedbackByMsg = new Map(feedbackResult.rows.map((f) => [f.message_id, f]));

    res.json({
      session: {
        id: session.id,
        sessionToken: session.session_token,
        title: session.title,
        userId: session.user_id,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
      },
      messages: messagesResult.rows.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.created_at,
        offTopic: m.off_topic,
        greeting: m.greeting,
        feedback: feedbackByMsg.get(m.id) ?? null,
      })),
    });
  } catch (err) {
    logger.error({ err, sessionId }, "AI admin: conversation detail failed");
    res.status(500).json({ error: "Failed to load conversation." });
  }
});

// ─── v3.0 new endpoints below ────────────────────────────────────────────────

// ─── GET /api/ai/admin/model-usage ──────────────────────────────────────────
// Model distribution + per-model latency stats. Returns:
//   [{ model, count, avg_response_ms, p95_response_ms, avg_tokens }, ...]
//
// v3.0: helps admins understand which Gemini model is actually serving
// traffic (the fallback chain may differ from what AI_MODEL is set to)
// and whether a particular model is slower than expected.
router.get("/ai/admin/model-usage", async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT
         COALESCE(model, '(canned/greeting)') AS model,
         COUNT(*)::int AS count,
         ROUND(AVG(response_ms))::int AS avg_response_ms,
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_ms)::int AS p95_response_ms,
         ROUND(AVG(token_count))::int AS avg_tokens
       FROM ai_chat_messages
       WHERE role = 'assistant'
         AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY model
       ORDER BY count DESC`,
    );
    res.json({
      models: result.rows.map((r) => ({
        model: r.model,
        count: r.count,
        avgResponseMs: r.avg_response_ms,
        p95ResponseMs: r.p95_response_ms,
        avgTokens: r.avg_tokens,
      })),
    });
  } catch (err) {
    logger.error({ err }, "AI admin: model-usage failed");
    res.status(500).json({ error: "Failed to load model usage stats." });
  }
});

// ─── GET /api/ai/admin/pii-stats ────────────────────────────────────────────
// PII redaction statistics. Returns:
//   {
//     totalUserMessages: number,
//     piiRedactedCount: number,
//     piiRate: number,            // % of user messages that had PII
//     byType: [{ type, count }]   // breakdown by PII type from events
//   }
//
// v3.0: helps admins understand how often users accidentally expose PII
// in chat (e.g. "call me at 017XXXXXXXX") and tune the regex patterns
// if needed.
router.get("/ai/admin/pii-stats", async (_req: Request, res: Response) => {
  try {
    const totalsResult = await pool.query<{
      total: number;
      redacted: number;
    }>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE pii_redacted = TRUE)::int AS redacted
       FROM ai_chat_messages
       WHERE role = 'user'
         AND created_at >= NOW() - INTERVAL '30 days'`,
    );
    const total = totalsResult.rows[0]?.total ?? 0;
    const redacted = totalsResult.rows[0]?.redacted ?? 0;
    const piiRate = total > 0 ? Math.round((redacted / total) * 1000) / 10 : 0;

    // Breakdown by PII type from the events table (v3.0 logs each redaction
    // with the detected types in the payload JSON).
    const byTypeResult = await pool.query<{ types_json: string; event_count: number }>(
      `SELECT
         (payload::json->>'detectedTypes') AS types_json,
         COUNT(*)::int AS event_count
       FROM ai_chat_events
       WHERE type = 'pii_redacted'
         AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY types_json`,
    );

    // Aggregate type counts across all events (each event may have multiple types).
    const typeCounts = new Map<string, number>();
    for (const row of byTypeResult.rows) {
      try {
        const types = JSON.parse(row.types_json ?? "[]") as string[];
        for (const t of types) {
          typeCounts.set(t, (typeCounts.get(t) ?? 0) + row.event_count);
        }
      } catch {
        // skip malformed payloads
      }
    }

    res.json({
      totalUserMessages: total,
      piiRedactedCount: redacted,
      piiRate,
      byType: Array.from(typeCounts.entries())
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count),
    });
  } catch (err) {
    logger.error({ err }, "AI admin: pii-stats failed");
    res.status(500).json({ error: "Failed to load PII stats." });
  }
});

// ─── GET /api/ai/admin/latency?days=30 ──────────────────────────────────────
// Daily latency trend. Returns:
//   [{ date, avg_ms, p95_ms, count }, ...]
//
// v3.0: tracks whether Gemini response times are degrading over time
// (e.g. due to model deprecation forcing fallback to slower models).
router.get("/ai/admin/latency", async (req: Request, res: Response) => {
  const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 90);
  try {
    const result = await pool.query(
      `SELECT
         to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
         ROUND(AVG(response_ms))::int AS avg_ms,
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_ms)::int AS p95_ms,
         COUNT(*)::int AS count
       FROM ai_chat_messages
       WHERE role = 'assistant'
         AND response_ms IS NOT NULL
         AND created_at >= NOW() - ($1 || ' days')::INTERVAL
       GROUP BY date_trunc('day', created_at)
       ORDER BY date_trunc('day', created_at) ASC`,
      [String(days)],
    );
    res.json({
      days,
      data: result.rows.map((r) => ({
        date: r.date,
        avgMs: r.avg_ms,
        p95Ms: r.p95_ms,
        count: r.count,
      })),
    });
  } catch (err) {
    logger.error({ err }, "AI admin: latency failed");
    res.status(500).json({ error: "Failed to load latency stats." });
  }
});

// ─── GET /api/ai/admin/events?sessionId=X&type=Y&limit=50 ───────────────────
// Append-only audit trail of significant AI events (v3.0). Returns events
// filtered by session and/or type, newest-first.
//
// Used by admins debugging a specific conversation (e.g. "why did this
// response take 10 seconds?") to see the event timeline: tool calls,
// retries, model fallbacks, summary generations, PII redactions, etc.
router.get("/ai/admin/events", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId ? Number(req.query.sessionId) : null;
  const type = (req.query.type as string | undefined) ?? null;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);

  try {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (sessionId != null && Number.isFinite(sessionId)) {
      params.push(sessionId);
      conditions.push(`session_id = $${params.length}`);
    }
    if (type) {
      params.push(type);
      conditions.push(`type = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const result = await pool.query(
      `SELECT id, session_id, type, payload, created_at
       FROM ai_chat_events
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );

    res.json({
      events: result.rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        type: r.type,
        payload: r.payload ? safeJsonParse(r.payload) : null,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    logger.error({ err }, "AI admin: events failed");
    res.status(500).json({ error: "Failed to load events." });
  }
});

/**
 * Safe JSON parse for event payloads. Returns the parsed object if valid,
 * or the raw string if parsing fails (defensive — never throw).
 */
function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ─── GET /api/ai/admin/top-questions (v3.0 upgrade) ─────────────────────────
// v3.0: now returns STEMMED keywords grouped by stem (e.g. "mango" and
// "mangos" both count toward the "mango" stem). This gives a more
// accurate picture of what users are asking about than the v2.0 raw-word
// count.
//
// Implementation: we apply a simple suffix-stripping stemmer in SQL
// (plural 's' removal + common 'ing'/'ed' suffixes). This isn't as
// sophisticated as the Porter stemmer, but it's good enough for
// analytics and runs entirely in Postgres (no Node.js post-processing).
router.get("/ai/admin/top-questions-v2", async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);
  try {
    const result = await pool.query(
      `SELECT stem, COUNT(*)::int AS count, ARRAY_AGG(DISTINCT original) AS variants
       FROM (
         SELECT
           lower(match[1]) AS original,
           -- Simple stemmer: strip trailing 's', 'es', 'ing', 'ed'.
           -- Not perfect but groups "mango"/"mangos", "plant"/"plants",
           -- "watering"/"water" together.
           lower(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(match[1], 'ing$', '', 'i'),
                   'ed$', '', 'i'
                 ),
                 'es$', '', 'i'
               ),
               's$', '', 'i'
             )
           ) AS stem
         FROM ai_chat_messages,
              regexp_matches(content, '([a-zA-Z]{4,})', 'g') AS match
         WHERE role = 'user'
           AND off_topic = FALSE
           AND greeting = FALSE
       ) AS words
       WHERE stem NOT IN (
         'that', 'thi', 'with', 'from', 'have', 'they', 'will', 'what',
         'when', 'where', 'which', 'your', 'their', 'there', 'about',
         'would', 'could', 'should', 'pleas', 'tell', 'want', 'need',
         'know', 'like', 'just', 'also', 'some', 'them', 'then', 'than'
       )
         AND length(stem) >= 3
       GROUP BY stem
       ORDER BY count DESC
       LIMIT $1`,
      [limit],
    );
    res.json({
      keywords: result.rows.map((r) => ({
        stem: r.stem,
        count: r.count,
        variants: r.variants,
      })),
    });
  } catch (err) {
    logger.error({ err }, "AI admin: top-questions-v2 failed");
    res.status(500).json({ error: "Failed to load top questions." });
  }
});

// ─── GET /api/ai/admin/models ───────────────────────────────────────────────
// v3.0.1: Debug endpoint showing the model selection state. Helps diagnose:
//   - "Which models are actually available for my API key?"
//   - "Which model is currently cached as working?"
//   - "Which models are on cooldown (recently 429'd)?"
//   - "What's the full fallback chain?"
//
// This is the FIRST endpoint to check when TreeBot is failing. It tells
// you exactly which models your GCP project has access to, so you know
// whether the issue is "no models available" (API key / billing problem)
// or "all models 429'd" (quota problem).
router.get("/ai/admin/models", async (req: Request, res: Response) => {
  try {
    // v3.0.2: ?refresh=1 forces a re-discovery by clearing the cache.
    if (req.query.refresh === "1") {
      await forceRediscover(); // v3.3: now async
      logger.info("AI admin: forced model re-discovery (cache cleared)");
    }

    const debugInfo = await getModelDebugInfo(); // v3.3: now async
    const geminiConfigured = isGeminiConfigured();

    // If discovery hasn't run yet (or was just cleared by refresh=1),
    // run it now so the admin sees actual data.
    let discovered = debugInfo.discoveredModels;
    if (!discovered && geminiConfigured) {
      discovered = await discoverAvailableModels();
    }

    res.json({
      geminiConfigured,
      workingModel: debugInfo.workingModel,
      discoveredModels: discovered,
      discoveryAttempted: debugInfo.discoveryAttempted,
      staticChain: debugInfo.staticChain,
      effectiveChain: discovered && discovered.length > 0 ? discovered : debugInfo.staticChain,
      cooldowns: debugInfo.cooldowns,
      aiModelEnv: debugInfo.aiModelEnv,
      hint: !geminiConfigured
        ? "GEMINI_API_KEY is not set. Set it and restart the server."
        : discovered && discovered.length === 0
          ? "ListModels returned 0 models. Check if your API key is valid."
          : discovered && discovered.length > 0
            ? `Discovered ${discovered.length} available model(s). These are the only models your API key can use.`
            : "Discovery not yet run. Send a chat message to trigger it, or call with ?refresh=1.",
    });
  } catch (err) {
    logger.error({ err }, "AI admin: models debug failed");
    res.status(500).json({ error: "Failed to load model debug info." });
  }
});

// ─── GET /api/ai/admin/providers ────────────────────────────────────────────
// v3.1: Multi-provider debug endpoint. Shows the status of ALL configured
// AI providers (Gemini + Groq), including:
//   - Which providers are configured (have API keys set)
//   - The provider fallback chain (order providers are tried)
//   - Per-provider: working model, model chain, cooldowns
//   - The AI_PROVIDERS env var value
//
// Pass ?refresh=1 to clear ALL provider caches + cooldowns (use after
// swapping API keys without restarting the server).
//
// This is the FIRST endpoint to check when TreeBot is failing. It tells
// you which providers are available and which is currently being used.
router.get("/ai/admin/providers", async (req: Request, res: Response) => {
  try {
    // ?refresh=1 clears all provider caches + cooldowns.
    if (req.query.refresh === "1") {
      await forceAllProvidersRediscover(); // v3.3: now async
      logger.info("AI admin: forced all-provider re-discovery (caches cleared)");
    }

    const debugInfo = await getProvidersDebugInfo(); // v3.3: now async

    res.json({
      ...debugInfo,
      hint:
        debugInfo.configuredProviders.length === 0
          ? "No providers configured. Set GEMINI_API_KEY and/or GROQ_API_KEY env vars."
          : `Provider chain: ${debugInfo.providerChain.join(" → ")}. ` +
            `Primary: ${debugInfo.providerChain[0]}. ` +
            `Fallbacks: ${debugInfo.providerChain.slice(1).join(", ") || "(none)"}.`,
    });
  } catch (err) {
    logger.error({ err }, "AI admin: providers debug failed");
    res.status(500).json({ error: "Failed to load providers debug info." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── Bug #3 fix: Prompt Versioning Admin Endpoints ─────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
//
// These endpoints were documented in promptVersioning.ts but never
// implemented. The route now USES the DB prompt text (Bug #3 fix above),
// so admins need a way to:
//   - List all versions (with active flag).
//   - Preview a specific version before activating.
//   - Create a new version (does NOT activate — explicit activation
//     prevents accidental prompt changes).
//   - Activate a version (deactivates all others, clears cache).
//   - Delete a version (with safeguards: can't delete active, can't
//     delete the last one).
//
// All endpoints require admin auth (router.use(requireAdmin) at the
// top of this file). Rate limiting is handled by the global apiLimiter
// (200 req / 15 min / IP) — sufficient for admin use.
//
// The prompt text supports two placeholders (rendered at runtime by
// renderPromptTemplate in aiContext.ts):
//   {{summary}}  — replaced with the conversation summary block (memory)
//   {{catalog}}  — replaced with the catalog search results (context)
// If a placeholder is missing from the text, the dynamic value is
// appended at the end (backward compat).

// ─── GET /api/ai/admin/prompts ───────────────────────────────────────────────
// Lists all prompt versions, active first, then by semver descending.
router.get("/ai/admin/prompts", async (_req: Request, res: Response) => {
  try {
    const versions = await listPromptVersions();
    res.json({
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        promptText: v.promptText,
        // Truncate in the list view for readability — the full text is
        // available via GET /api/ai/admin/prompts/:id. This keeps the
        // list response small (a 5KB prompt × 20 versions = 100KB
        // otherwise).
        promptTextPreview: v.promptText.slice(0, 200),
        promptTextLength: v.promptText.length,
        changeLog: v.changeLog,
        isActive: v.isActive,
        createdBy: v.createdBy,
        createdAt: v.createdAt,
      })),
    });
  } catch (err) {
    logger.error({ err }, "AI admin: list prompts failed");
    res.status(500).json({ error: "Failed to list prompt versions." });
  }
});

// ─── GET /api/ai/admin/prompts/active ───────────────────────────────────────
// Returns the currently active prompt version (full text).
router.get("/ai/admin/prompts/active", async (_req: Request, res: Response) => {
  try {
    const version = await getActivePromptVersion();
    if (!version) {
      res.status(404).json({ error: "No active prompt version found." });
      return;
    }
    res.json({ version });
  } catch (err) {
    logger.error({ err }, "AI admin: get active prompt failed");
    res.status(500).json({ error: "Failed to load active prompt version." });
  }
});

// ─── GET /api/ai/admin/prompts/:id ──────────────────────────────────────────
// Returns a specific prompt version (full text) — for preview before
// activating.
router.get("/ai/admin/prompts/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid version id." });
    return;
  }
  try {
    const version = await getPromptVersion(id);
    if (!version) {
      res.status(404).json({ error: "Prompt version not found." });
      return;
    }
    res.json({ version });
  } catch (err) {
    logger.error({ err, id }, "AI admin: get prompt version failed");
    res.status(500).json({ error: "Failed to load prompt version." });
  }
});

// ─── POST /api/ai/admin/prompts ─────────────────────────────────────────────
// Creates a new prompt version. Does NOT activate it — the admin must
// explicitly activate via POST /api/ai/admin/prompts/:id/activate.
//
// Body: { version: "1.1.0", promptText: "...", changeLog: "..." }
router.post("/ai/admin/prompts", async (req: Request, res: Response) => {
  const { version, promptText, changeLog } = (req.body ?? {}) as {
    version?: string;
    promptText?: string;
    changeLog?: string;
  };
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    res.status(400).json({ error: 'version must be a semver string like "1.1.0".' });
    return;
  }
  if (typeof promptText !== "string" || promptText.trim().length === 0) {
    res.status(400).json({ error: "promptText is required (non-empty string)." });
    return;
  }
  if (promptText.length > 50_000) {
    res.status(400).json({ error: "promptText is too long (max 50,000 characters)." });
    return;
  }
  // createdBy: the admin's email from req.dbUser (set by requireAuth).
  const createdBy = req.dbUser?.email ?? "admin";
  try {
    const created = await createPromptVersion(
      version,
      promptText,
      changeLog ?? "",
      createdBy,
    );
    if (!created) {
      // createPromptVersion returns null on validation failure or
      // duplicate version (UNIQUE constraint). Check if it's a duplicate.
      res.status(409).json({
        error: `Version "${version}" already exists. Use a different version number.`,
      });
      return;
    }
    logger.info({ version, createdBy }, "AI admin: created prompt version");
    res.status(201).json({ ok: true, version: created });
  } catch (err) {
    logger.error({ err, version }, "AI admin: create prompt failed");
    res.status(500).json({ error: "Failed to create prompt version." });
  }
});

// ─── POST /api/ai/admin/prompts/:id/activate ────────────────────────────────
// Activates a specific prompt version (deactivates all others).
// Clears the in-memory cache so the next request uses the new version.
router.post("/ai/admin/prompts/:id/activate", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid version id." });
    return;
  }
  try {
    const ok = await activatePromptVersion(id);
    if (!ok) {
      res.status(404).json({ error: "Prompt version not found." });
      return;
    }
    logger.info({ id, activatedBy: req.dbUser?.email }, "AI admin: activated prompt version");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, id }, "AI admin: activate prompt failed");
    res.status(500).json({ error: "Failed to activate prompt version." });
  }
});

// ─── DELETE /api/ai/admin/prompts/:id ────────────────────────────────────────
// Deletes a prompt version. Safeguards:
//   - Cannot delete the active version (must activate another first).
//   - Cannot delete the last version (at least one must exist).
router.delete("/ai/admin/prompts/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid version id." });
    return;
  }
  try {
    const result = await deletePromptVersion(id);
    if (!result.ok) {
      // 409 for safeguard violations (can't delete active / last version),
      // 404 for not found, 500 for DB error.
      const status = result.reason?.includes("not found") ? 404 : 409;
      res.status(status).json({ error: result.reason });
      return;
    }
    logger.info({ id, deletedBy: req.dbUser?.email }, "AI admin: deleted prompt version");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, id }, "AI admin: delete prompt failed");
    res.status(500).json({ error: "Failed to delete prompt version." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── Bug #3 fix: Eval Harness Admin Endpoints ───────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
//
// These endpoints were documented in evalHarness.ts but never implemented.
// The eval harness lets admins:
//   - Run the golden dataset against the CURRENT active prompt + provider.
//   - View historical eval results (for tracking prompt quality over time).
//   - List the golden cases (to add/remove cases, admins edit the DB
//     directly for now — a CRUD API is a future enhancement).
//
// The eval run sends each question through streamChat (same path as the
// real chat route, minus SSE streaming — we collect the full response
// synchronously). This tests the END-TO-END pipeline: prompt → model →
// response → evaluation.
//
// Rate limiting: the global apiLimiter (200/15min) applies. An eval run
// hits the AI provider 10 times (one per golden case), which is fine for
// admin use but shouldn't be spammed. The route logs each run for
// observability.

// ─── GET /api/ai/admin/eval/cases ────────────────────────────────────────────
// Lists all golden eval cases (the test dataset).
router.get("/ai/admin/eval/cases", async (_req: Request, res: Response) => {
  try {
    const cases = await getEvalCases();
    res.json({ cases, count: cases.length });
  } catch (err) {
    logger.error({ err }, "AI admin: list eval cases failed");
    res.status(500).json({ error: "Failed to list eval cases." });
  }
});

// ─── POST /api/ai/admin/eval/run ────────────────────────────────────────────
// Runs the golden dataset against the current active prompt + provider.
// Returns a summary + per-case results. Results are also persisted to
// ai_eval_results for historical tracking.
//
// Body (all optional): { useJudge?: boolean, category?: string }
//   - useJudge: if true, also runs the LLM-as-judge evaluation (slower,
//     costs more tokens, but gives a 1-5 quality score). Default false.
//   - category: if set, only run cases in that category (e.g.
//     "plant_care"). Default: run all cases.
//
// This is a LONG-running endpoint (10 cases × 2-5s each = 20-50s).
// The admin UI should show a loading spinner + not retry on timeout.
router.post("/ai/admin/eval/run", async (req: Request, res: Response) => {
  try {
    // Guard: don't run if no provider is configured (would just error
    // 10 times and waste time).
    if (!isAnyProviderConfigured()) {
      res.status(503).json({
        error: "No AI provider configured. Set GEMINI_API_KEY and/or GROQ_API_KEY.",
      });
      return;
    }

    const useJudge = req.body?.useJudge === true;
    const categoryFilter = typeof req.body?.category === "string" ? req.body.category : null;

    // Load golden cases.
    let cases = await getEvalCases();
    if (categoryFilter) {
      cases = cases.filter((c) => c.category === categoryFilter);
    }
    if (cases.length === 0) {
      res.status(404).json({ error: "No eval cases found (seed may have failed)." });
      return;
    }

    // Generate a run ID for grouping results.
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    logger.info({ runId, caseCount: cases.length, useJudge, categoryFilter }, "AI admin: starting eval run");

    // Run each case sequentially (parallel would blow the rate limit).
    const results: Array<{
      caseId: number;
      question: string;
      response: string;
      keywordOverlap: number;
      refused: boolean;
      passed: boolean;
      latencyMs: number;
      model: string | null;
      provider: string | null;
      error: string | null;
    }> = [];

    for (const evalCase of cases) {
      const caseStart = Date.now();
      try {
        // Build a minimal system prompt for the eval (no catalog context,
        // no summary — we want to test the prompt itself, not the
        // dynamic context). This matches what a user would get on their
        // first message with no history.
        const { getActivePrompt } = await import("../lib/promptVersioning");
        const { renderPromptTemplate, buildSystemPrompt } = await import("../lib/aiContext");
        const promptInfo = await getActivePrompt();
        const systemPrompt =
          promptInfo.text && promptInfo.text.trim().length > 0
            ? renderPromptTemplate(promptInfo.text, "", "")
            : buildSystemPrompt("", "");

        // Collect the full response (no streaming — we want the
        // complete text for evaluation).
        let fullResponse = "";
        const stream = streamChat(
          systemPrompt,
          [], // no history
          evalCase.question,
          { declarations: [], execute: async () => ({ error: "Tools disabled in eval" }) },
          undefined, // no userId (eval is anonymous)
          (meta) => {
            // We could capture model/provider here for tracking.
          },
        );
        for await (const chunk of stream) {
          fullResponse += chunk;
        }

        const latencyMs = Date.now() - caseStart;

        // Evaluate the response.
        const metrics = evaluateResponse(fullResponse, evalCase);

        // Optional: LLM-as-judge (slower, costs tokens).
        if (useJudge && !evalCase.expectedRefusal) {
          try {
            const { evaluateResponseWithJudge } = await import("../lib/evalHarness");
            await evaluateResponseWithJudge(evalCase.question, fullResponse, evalCase);
            // The judge-enhanced result is saved separately if needed.
            // For now, we just use the basic metrics for the pass/fail.
          } catch (judgeErr) {
            logger.warn({ err: judgeErr, caseId: evalCase.id }, "AI admin: eval judge failed (non-fatal)");
          }
        }

        // Persist the result.
        await saveEvalResult(
          runId,
          evalCase,
          fullResponse,
          metrics,
          latencyMs,
          null, // model — we'd capture this from the metadata callback
          null, // provider
          null,
        );

        results.push({
          caseId: evalCase.id,
          question: evalCase.question,
          response: fullResponse,
          keywordOverlap: metrics.keywordOverlap,
          refused: metrics.refused,
          passed: metrics.passed,
          latencyMs,
          model: null,
          provider: null,
          error: null,
        });
      } catch (err) {
        const latencyMs = Date.now() - caseStart;
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err, caseId: evalCase.id }, "AI admin: eval case failed");

        // Persist the error result.
        await saveEvalResult(
          runId,
          evalCase,
          "(error)",
          { keywordOverlap: 0, refused: false, passed: false },
          latencyMs,
          null,
          null,
          errorMsg,
        );

        results.push({
          caseId: evalCase.id,
          question: evalCase.question,
          response: "(error)",
          keywordOverlap: 0,
          refused: false,
          passed: false,
          latencyMs,
          model: null,
          provider: null,
          error: errorMsg,
        });
      }
    }

    // Compute summary.
    const passed = results.filter((r) => r.passed).length;
    const totalLatency = results.reduce((sum, r) => sum + r.latencyMs, 0);
    const avgLatencyMs = results.length > 0 ? Math.round(totalLatency / results.length) : 0;
    const avgKeywordOverlap =
      results.length > 0
        ? Math.round(
            (results.reduce((sum, r) => sum + r.keywordOverlap, 0) / results.length) * 100,
          ) / 100
        : 0;

    const summary = {
      runId,
      totalCases: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length > 0 ? Math.round((passed / results.length) * 1000) / 10 : 0,
      avgLatencyMs,
      avgKeywordOverlap,
      useJudge,
      categoryFilter,
    };

    logger.info({ ...summary }, "AI admin: eval run complete");

    res.json({ ...summary, results });
  } catch (err) {
    logger.error({ err }, "AI admin: eval run failed");
    res.status(500).json({ error: "Failed to run eval suite." });
  }
});

// ─── GET /api/ai/admin/eval/results?limit=50 ────────────────────────────────
// Returns historical eval results (most recent first).
router.get("/ai/admin/eval/results", async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
  try {
    const results = await getEvalResults(limit);
    res.json({ results, count: results.length });
  } catch (err) {
    logger.error({ err }, "AI admin: list eval results failed");
    res.status(500).json({ error: "Failed to list eval results." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── Phase 1: Knowledge Base Category Management ────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
//
// Admin CRUD for the KB category tree. All endpoints require requireAdmin
// (applied at the top of this file via `router.use(requireAdmin)`).
//
// Endpoints:
//   GET    /ai/admin/kb/categories        — list all (flat, with entry_count)
//   GET    /ai/admin/kb/categories/tree   — nested tree (for the admin UI)
//   GET    /ai/admin/kb/categories/:id    — single category
//   POST   /ai/admin/kb/categories        — create
//   PUT    /ai/admin/kb/categories/:id    — update
//   POST   /ai/admin/kb/categories/:id/move — move to a new parent
//   DELETE /ai/admin/kb/categories/:id    — delete (rejects if has entries)
//
// Validation:
//   name        — required, non-empty, max 100 chars
//   slug        — required, matches /^[a-z0-9-]+$/, max 80 chars
//   parentId    — optional, must be a valid existing category id (or null)
//   description — optional, max 500 chars
//
// Error responses:
//   400 — validation error (missing/invalid fields)
//   404 — category not found
//   409 — slug conflict, or delete attempted on category with entries
//   500 — unexpected server error (logged, generic message returned)

// ─── GET /ai/admin/kb/categories ─────────────────────────────────────────────
// Returns ALL categories (active + inactive), ordered by path ASC so the
// tree can be rebuilt by the caller. Each row includes a denormalized
// `entryCount` (count of ai_kb_entries in that category — 0 in Phase 1
// since the entries table is empty, but the JOIN is in place for Phase 2).
router.get("/ai/admin/kb/categories", async (_req: Request, res: Response) => {
  try {
    const categories = await listKbCategories();
    res.json({ categories, count: categories.length });
  } catch (err) {
    logger.error({ err }, "AI admin: list KB categories failed");
    res.status(500).json({ error: "Failed to list KB categories." });
  }
});

// ─── GET /ai/admin/kb/categories/tree ────────────────────────────────────────
// Returns a nested tree structure for the admin UI. Root nodes are at the
// top level, each with a `children` array (sorted by name). Built in
// Node (not SQL) — see getKbCategoryTree() for rationale.
router.get("/ai/admin/kb/categories/tree", async (_req: Request, res: Response) => {
  try {
    const tree = await getKbCategoryTree();
    res.json({ tree, count: tree.length });
  } catch (err) {
    logger.error({ err }, "AI admin: get KB category tree failed");
    res.status(500).json({ error: "Failed to build KB category tree." });
  }
});

// ─── GET /ai/admin/kb/categories/:id ─────────────────────────────────────────
// Returns a single category by id (with denormalized entryCount).
router.get("/ai/admin/kb/categories/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid category id." });
    return;
  }
  try {
    const category = await getKbCategory(id);
    if (!category) {
      res.status(404).json({ error: "KB category not found." });
      return;
    }
    res.json({ category });
  } catch (err) {
    logger.error({ err, id }, "AI admin: get KB category failed");
    res.status(500).json({ error: "Failed to load KB category." });
  }
});

// ─── POST /ai/admin/kb/categories ────────────────────────────────────────────
// Creates a new category. The path + depth are computed automatically from
// the parent (or as a root if parentId is null/omitted).
//
// Body: { name: string, slug: string, description?: string, parentId?: number | null }
router.post("/ai/admin/kb/categories", async (req: Request, res: Response) => {
  const { name, slug, description, parentId } = (req.body ?? {}) as {
    name?: string;
    slug?: string;
    description?: string;
    parentId?: number | null;
  };

  // Validate name.
  if (typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required (non-empty string)." });
    return;
  }
  if (name.trim().length > NAME_MAX_LENGTH) {
    res.status(400).json({ error: `name is too long (max ${NAME_MAX_LENGTH} characters).` });
    return;
  }
  // Validate slug.
  if (typeof slug !== "string" || slug.trim().length === 0) {
    res.status(400).json({ error: "slug is required (non-empty string)." });
    return;
  }
  if (!SLUG_REGEX.test(slug.trim()) || slug.trim().length > SLUG_MAX_LENGTH) {
    res.status(400).json({
      error: `slug must match ${SLUG_REGEX} and be at most ${SLUG_MAX_LENGTH} characters.`,
    });
    return;
  }
  if (slug.trim().startsWith("-") || slug.trim().endsWith("-")) {
    res.status(400).json({ error: "slug cannot start or end with a hyphen." });
    return;
  }
  // Validate description (optional).
  if (description !== undefined && description !== null && description.length > DESCRIPTION_MAX_LENGTH) {
    res.status(400).json({
      error: `description is too long (max ${DESCRIPTION_MAX_LENGTH} characters).`,
    });
    return;
  }
  // Validate parentId (optional — null/undefined means root).
  let normalizedParentId: number | null = null;
  if (parentId !== undefined && parentId !== null) {
    normalizedParentId = Number(parentId);
    if (!Number.isInteger(normalizedParentId) || normalizedParentId <= 0) {
      res.status(400).json({ error: "parentId must be a positive integer or null." });
      return;
    }
  }

  try {
    const created = await createKbCategory({
      name: name.trim(),
      slug: slug.trim(),
      description: description?.trim() || null,
      parentId: normalizedParentId,
    });
    if (!created) {
      // createKbCategory returns null on validation failure, parent-not-found,
      // or slug conflict. We can't easily distinguish them here without
      // changing the function signature — but the most common cause is a
      // slug conflict (the route already validated format + presence), so
      // we return 409. If the parent didn't exist, that's also a 409
      // (conflict with the requested state). For format errors that
      // somehow slipped through (e.g. leading hyphen), we return 400.
      // The lib's log entry has the specific reason for investigation.
      res.status(409).json({
        error: "Failed to create category. Slug conflict, parent not found, or validation error.",
      });
      return;
    }
    logger.info(
      { id: created.id, slug: created.slug, parentId: created.parentId, createdBy: req.dbUser?.email },
      "AI admin: created KB category",
    );
    res.status(201).json({ category: created });
  } catch (err) {
    logger.error({ err, name, slug, parentId }, "AI admin: create KB category failed");
    res.status(500).json({ error: "Failed to create KB category." });
  }
});

// ─── PUT /ai/admin/kb/categories/:id ─────────────────────────────────────────
// Updates a category's name, slug, description, and/or isActive flag.
// Parent changes are NOT allowed here — use POST .../:id/move instead.
//
// Body (all optional): { name?, slug?, description?, isActive? }
router.put("/ai/admin/kb/categories/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid category id." });
    return;
  }
  const { name, slug, description, isActive } = (req.body ?? {}) as {
    name?: string;
    slug?: string;
    description?: string | null;
    isActive?: boolean;
  };

  // Build the updates object, validating each field as we go.
  const updates: {
    name?: string;
    slug?: string;
    description?: string | null;
    isActive?: boolean;
  } = {};

  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "name must be a non-empty string." });
      return;
    }
    if (name.trim().length > NAME_MAX_LENGTH) {
      res.status(400).json({ error: `name is too long (max ${NAME_MAX_LENGTH} characters).` });
      return;
    }
    updates.name = name.trim();
  }

  if (slug !== undefined) {
    if (typeof slug !== "string" || slug.trim().length === 0) {
      res.status(400).json({ error: "slug must be a non-empty string." });
      return;
    }
    if (!SLUG_REGEX.test(slug.trim()) || slug.trim().length > SLUG_MAX_LENGTH) {
      res.status(400).json({
        error: `slug must match ${SLUG_REGEX} and be at most ${SLUG_MAX_LENGTH} characters.`,
      });
      return;
    }
    if (slug.trim().startsWith("-") || slug.trim().endsWith("-")) {
      res.status(400).json({ error: "slug cannot start or end with a hyphen." });
      return;
    }
    updates.slug = slug.trim();
  }

  if (description !== undefined && description !== null) {
    if (typeof description !== "string") {
      res.status(400).json({ error: "description must be a string or null." });
      return;
    }
    if (description.length > DESCRIPTION_MAX_LENGTH) {
      res.status(400).json({ error: `description is too long (max ${DESCRIPTION_MAX_LENGTH} characters).` });
      return;
    }
    updates.description = description.trim() || null;
  } else if (description === null) {
    updates.description = null;
  }

  if (isActive !== undefined) {
    if (typeof isActive !== "boolean") {
      res.status(400).json({ error: "isActive must be a boolean." });
      return;
    }
    updates.isActive = isActive;
  }

  // Reject no-op updates (no fields to update).
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update. Provide name, slug, description, or isActive." });
    return;
  }

  try {
    const updated = await updateKbCategory(id, updates);
    if (!updated) {
      // updateKbCategory returns null on not-found, validation failure,
      // or slug conflict. The route already validated inputs, so the
      // most common cause is not-found (404) or slug conflict (409).
      // We probe the DB to distinguish.
      const existing = await getKbCategory(id);
      if (!existing) {
        res.status(404).json({ error: "KB category not found." });
      } else {
        res.status(409).json({ error: "Slug conflict within parent, or validation error." });
      }
      return;
    }
    logger.info(
      { id, updates, updatedBy: req.dbUser?.email },
      "AI admin: updated KB category",
    );
    res.json({ category: updated });
  } catch (err) {
    logger.error({ err, id, updates }, "AI admin: update KB category failed");
    res.status(500).json({ error: "Failed to update KB category." });
  }
});

// ─── POST /ai/admin/kb/categories/:id/move ──────────────────────────────────
// Moves a category to a new parent. The moved node's path + depth are
// updated, along with all descendants. Cycle-checked (rejects moving a
// node into its own subtree).
//
// Body: { parentId: number | null } — null for root.
router.post("/ai/admin/kb/categories/:id/move", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid category id." });
    return;
  }
  const { parentId } = (req.body ?? {}) as { parentId?: number | null };

  // parentId must be a positive integer, or explicitly null (root).
  // Omitting it is an error — the caller must be explicit.
  if (parentId === undefined) {
    res.status(400).json({ error: "parentId is required (use null for root)." });
    return;
  }
  let normalizedParentId: number | null = null;
  if (parentId !== null) {
    normalizedParentId = Number(parentId);
    if (!Number.isInteger(normalizedParentId) || normalizedParentId <= 0) {
      res.status(400).json({ error: "parentId must be a positive integer or null." });
      return;
    }
    if (normalizedParentId === id) {
      res.status(400).json({ error: "Cannot move a category into itself." });
      return;
    }
  }

  try {
    const ok = await moveKbCategory(id, normalizedParentId);
    if (!ok) {
      // moveKbCategory returns false on not-found, parent-not-found,
      // or cycle. We probe to distinguish 404 from 409.
      const existing = await getKbCategory(id);
      if (!existing) {
        res.status(404).json({ error: "KB category not found." });
        return;
      }
      if (normalizedParentId !== null) {
        const parent = await getKbCategory(normalizedParentId);
        if (!parent) {
          res.status(404).json({ error: "New parent category not found." });
          return;
        }
      }
      // Otherwise it's a cycle.
      res.status(409).json({
        error: "Cannot move a category into its own descendant (cycle).",
      });
      return;
    }
    logger.info(
      { id, newParentId: normalizedParentId, movedBy: req.dbUser?.email },
      "AI admin: moved KB category",
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, id, parentId }, "AI admin: move KB category failed");
    res.status(500).json({ error: "Failed to move KB category." });
  }
});

// ─── DELETE /ai/admin/kb/categories/:id ──────────────────────────────────────
// Deletes a category. Rejects if the category OR any descendant has
// entries (the admin must move or delete them first). On success, the
// DELETE cascades to all descendants (FK has ON DELETE CASCADE).
router.delete("/ai/admin/kb/categories/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid category id." });
    return;
  }
  try {
    const result = await deleteKbCategory(id);
    if (!result.ok) {
      // 404 for not-found, 409 for has-entries, 500 for db error.
      if (result.reason === "not found") {
        res.status(404).json({ error: "KB category not found." });
      } else if (result.reason === "has entries") {
        res.status(409).json({
          error: "Cannot delete a category that has entries. Move or delete the entries first.",
        });
      } else {
        res.status(500).json({ error: "Failed to delete KB category." });
      }
      return;
    }
    logger.info({ id, deletedBy: req.dbUser?.email }, "AI admin: deleted KB category");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, id }, "AI admin: delete KB category failed");
    res.status(500).json({ error: "Failed to delete KB category." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── Phase 2: KB Source + Entry + Creator Management ────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
//
// Admin CRUD for KB creators, sources, and entries. All endpoints inherit
// requireAdmin (mounted at the top of this file).
//
// Creator endpoints:
//   GET    /ai/admin/kb/creators
//   POST   /ai/admin/kb/creators
//   PUT    /ai/admin/kb/creators/:id
//   DELETE /ai/admin/kb/creators/:id
//
// Source endpoints:
//   GET    /ai/admin/kb/sources
//   GET    /ai/admin/kb/sources/:id
//   POST   /ai/admin/kb/sources
//   PUT    /ai/admin/kb/sources/:id
//   DELETE /ai/admin/kb/sources/:id
//   POST   /ai/admin/kb/sources/:id/chunk           (AI chunking, English only)
//   POST   /ai/admin/kb/sources/:id/entries/batch   (create entries from chunks)
//
// Entry endpoints:
//   GET    /ai/admin/kb/entries
//   GET    /ai/admin/kb/entries/:id
//   POST   /ai/admin/kb/entries
//   PUT    /ai/admin/kb/entries/:id
//   POST   /ai/admin/kb/entries/:id/activate
//   POST   /ai/admin/kb/entries/:id/deactivate
//   DELETE /ai/admin/kb/entries/:id

// ─── GET /ai/admin/kb/creators ───────────────────────────────────────────────
router.get("/ai/admin/kb/creators", async (_req: Request, res: Response) => {
  try {
    const creators = await listKbCreators();
    res.json({ creators, count: creators.length });
  } catch (err) {
    logger.error({ err }, "AI admin: list KB creators failed");
    res.status(500).json({ error: "Failed to list KB creators." });
  }
});

// ─── POST /ai/admin/kb/creators ──────────────────────────────────────────────
router.post("/ai/admin/kb/creators", async (req: Request, res: Response) => {
  const { name, slug, sourceType, profileUrl } = (req.body ?? {}) as {
    name?: string;
    slug?: string;
    sourceType?: string;
    profileUrl?: string | null;
  };
  if (typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required (non-empty string)." });
    return;
  }
  if (name.trim().length > CREATOR_NAME_MAX_LENGTH) {
    res.status(400).json({ error: `name is too long (max ${CREATOR_NAME_MAX_LENGTH} characters).` });
    return;
  }
  if (typeof slug !== "string" || slug.trim().length === 0) {
    res.status(400).json({ error: "slug is required (non-empty string)." });
    return;
  }
  if (!CREATOR_SLUG_REGEX.test(slug.trim()) || slug.trim().length > CREATOR_SLUG_MAX_LENGTH) {
    res.status(400).json({
      error: `slug must match ${CREATOR_SLUG_REGEX} and be at most ${CREATOR_SLUG_MAX_LENGTH} characters.`,
    });
    return;
  }
  if (typeof sourceType !== "string" || !VALID_SOURCE_TYPES.includes(sourceType as never)) {
    res.status(400).json({ error: `sourceType must be one of: ${VALID_SOURCE_TYPES.join(", ")}.` });
    return;
  }
  if (profileUrl !== undefined && profileUrl !== null) {
    if (typeof profileUrl !== "string" || profileUrl.length > CREATOR_PROFILE_URL_MAX_LENGTH) {
      res.status(400).json({ error: `profileUrl is too long (max ${CREATOR_PROFILE_URL_MAX_LENGTH} characters).` });
      return;
    }
    try {
      new URL(profileUrl);
    } catch {
      res.status(400).json({ error: "profileUrl must be a valid URL." });
      return;
    }
  }
  try {
    const created = await createKbCreator({
      name: name.trim(),
      slug: slug.trim(),
      sourceType,
      profileUrl: profileUrl ?? null,
    });
    if (!created) {
      res.status(409).json({ error: "Slug conflict or validation error." });
      return;
    }
    logger.info({ id: created.id, slug: created.slug, createdBy: req.dbUser?.email }, "AI admin: created KB creator");
    res.status(201).json({ creator: created });
  } catch (err) {
    logger.error({ err, name, slug }, "AI admin: create KB creator failed");
    res.status(500).json({ error: "Failed to create KB creator." });
  }
});

// ─── PUT /ai/admin/kb/creators/:id ───────────────────────────────────────────
router.put("/ai/admin/kb/creators/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid creator id." });
    return;
  }
  const { name, profileUrl, isActive, isFeatured } = (req.body ?? {}) as {
    name?: string;
    profileUrl?: string | null;
    isActive?: boolean;
    isFeatured?: boolean;
  };
  const updates: { name?: string; profileUrl?: string | null; isActive?: boolean; isFeatured?: boolean } = {};
  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "name must be a non-empty string." });
      return;
    }
    if (name.trim().length > CREATOR_NAME_MAX_LENGTH) {
      res.status(400).json({ error: `name is too long (max ${CREATOR_NAME_MAX_LENGTH} characters).` });
      return;
    }
    updates.name = name.trim();
  }
  if (profileUrl !== undefined) {
    if (profileUrl !== null) {
      if (typeof profileUrl !== "string" || profileUrl.length > CREATOR_PROFILE_URL_MAX_LENGTH) {
        res.status(400).json({ error: `profileUrl is too long (max ${CREATOR_PROFILE_URL_MAX_LENGTH} characters).` });
        return;
      }
      try {
        new URL(profileUrl);
      } catch {
        res.status(400).json({ error: "profileUrl must be a valid URL." });
        return;
      }
    }
    updates.profileUrl = profileUrl;
  }
  if (isActive !== undefined) {
    if (typeof isActive !== "boolean") {
      res.status(400).json({ error: "isActive must be a boolean." });
      return;
    }
    updates.isActive = isActive;
  }
  if (isFeatured !== undefined) {
    if (typeof isFeatured !== "boolean") {
      res.status(400).json({ error: "isFeatured must be a boolean." });
      return;
    }
    updates.isFeatured = isFeatured;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update. Provide name, profileUrl, isActive, or isFeatured." });
    return;
  }
  try {
    const updated = await updateKbCreator(id, updates);
    if (!updated) {
      const existing = await getKbCreator(id);
      if (!existing) {
        res.status(404).json({ error: "KB creator not found." });
      } else {
        res.status(409).json({ error: "Validation error." });
      }
      return;
    }
    logger.info({ id, updates, updatedBy: req.dbUser?.email }, "AI admin: updated KB creator");
    res.json({ creator: updated });
  } catch (err) {
    logger.error({ err, id, updates }, "AI admin: update KB creator failed");
    res.status(500).json({ error: "Failed to update KB creator." });
  }
});

// ─── DELETE /ai/admin/kb/creators/:id ────────────────────────────────────────
router.delete("/ai/admin/kb/creators/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid creator id." });
    return;
  }
  try {
    const result = await deleteKbCreator(id);
    if (!result.ok) {
      if (result.reason === "not found") {
        res.status(404).json({ error: "KB creator not found." });
      } else if (result.reason === "protected") {
        res.status(409).json({ error: "Cannot delete the 'Manual' creator (it's the default for admin-typed content)." });
      } else if (result.reason === "has entries") {
        res.status(409).json({ error: "Cannot delete a creator that has entries. Move or delete the entries first." });
      } else {
        res.status(500).json({ error: "Failed to delete KB creator." });
      }
      return;
    }
    logger.info({ id, deletedBy: req.dbUser?.email }, "AI admin: deleted KB creator");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, id }, "AI admin: delete KB creator failed");
    res.status(500).json({ error: "Failed to delete KB creator." });
  }
});

// ─── GET /ai/admin/kb/sources ────────────────────────────────────────────────
router.get("/ai/admin/kb/sources", async (req: Request, res: Response) => {
  const creatorId = req.query.creatorId !== undefined ? Number(req.query.creatorId) : undefined;
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : 20;
  const offset = req.query.offset !== undefined ? Number(req.query.offset) : 0;
  try {
    const result = await listKbSources({
      creatorId: Number.isInteger(creatorId) ? creatorId : undefined,
      language: typeof req.query.language === "string" ? req.query.language : undefined,
      processingStatus: typeof req.query.processingStatus === "string" ? req.query.processingStatus : undefined,
      limit: Number.isInteger(limit) ? limit : undefined,
      offset: Number.isInteger(offset) ? offset : undefined,
    });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "AI admin: list KB sources failed");
    res.status(500).json({ error: "Failed to list KB sources." });
  }
});

// ─── GET /ai/admin/kb/sources/:id ────────────────────────────────────────────
router.get("/ai/admin/kb/sources/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid source id." });
    return;
  }
  try {
    const source = await getKbSource(id);
    if (!source) {
      res.status(404).json({ error: "KB source not found." });
      return;
    }
    res.json({ source });
  } catch (err) {
    logger.error({ err, id }, "AI admin: get KB source failed");
    res.status(500).json({ error: "Failed to load KB source." });
  }
});

// ─── POST /ai/admin/kb/sources ───────────────────────────────────────────────
router.post("/ai/admin/kb/sources", async (req: Request, res: Response) => {
  const { creatorId, sourceType, sourceUrl, sourceTitle, sourceLanguage, sourcePublishedAt, rawText } =
    (req.body ?? {}) as {
      creatorId?: number | null;
      sourceType?: string;
      sourceUrl?: string | null;
      sourceTitle?: string;
      sourceLanguage?: string;
      sourcePublishedAt?: string | null;
      rawText?: string;
    };
  if (typeof sourceTitle !== "string" || sourceTitle.trim().length === 0) {
    res.status(400).json({ error: "sourceTitle is required (non-empty string)." });
    return;
  }
  if (sourceTitle.trim().length > SOURCE_TITLE_MAX_LENGTH) {
    res.status(400).json({ error: `sourceTitle is too long (max ${SOURCE_TITLE_MAX_LENGTH} characters).` });
    return;
  }
  if (typeof sourceType !== "string" || !VALID_SOURCE_TYPES.includes(sourceType as never)) {
    res.status(400).json({ error: `sourceType must be one of: ${VALID_SOURCE_TYPES.join(", ")}.` });
    return;
  }
  if (typeof sourceLanguage !== "string" || !VALID_LANGUAGES.includes(sourceLanguage as never)) {
    res.status(400).json({ error: `sourceLanguage must be one of: ${VALID_LANGUAGES.join(", ")}.` });
    return;
  }
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    res.status(400).json({ error: "rawText is required (non-empty string)." });
    return;
  }
  if (rawText.length > RAW_TEXT_MAX_LENGTH) {
    res.status(400).json({ error: `rawText is too long (max ${RAW_TEXT_MAX_LENGTH} characters).` });
    return;
  }
  if (sourceUrl !== undefined && sourceUrl !== null && sourceUrl !== "") {
    if (typeof sourceUrl !== "string" || sourceUrl.length > SOURCE_URL_MAX_LENGTH) {
      res.status(400).json({ error: `sourceUrl is too long (max ${SOURCE_URL_MAX_LENGTH} characters).` });
      return;
    }
    try {
      new URL(sourceUrl);
    } catch {
      res.status(400).json({ error: "sourceUrl must be a valid URL." });
      return;
    }
  }
  let normalizedCreatorId: number | null = null;
  if (creatorId !== undefined && creatorId !== null) {
    normalizedCreatorId = Number(creatorId);
    if (!Number.isInteger(normalizedCreatorId) || normalizedCreatorId <= 0) {
      res.status(400).json({ error: "creatorId must be a positive integer or null." });
      return;
    }
  }
  let normalizedPublishedAt: Date | null = null;
  if (sourcePublishedAt !== undefined && sourcePublishedAt !== null && sourcePublishedAt !== "") {
    const parsed = new Date(sourcePublishedAt);
    if (Number.isNaN(parsed.getTime())) {
      res.status(400).json({ error: "sourcePublishedAt must be a valid ISO date string." });
      return;
    }
    normalizedPublishedAt = parsed;
  }
  try {
    const created = await createKbSource({
      creatorId: normalizedCreatorId,
      sourceType,
      sourceUrl: sourceUrl || null,
      sourceTitle: sourceTitle.trim(),
      sourceLanguage,
      sourcePublishedAt: normalizedPublishedAt,
      rawText,
    });
    if (!created) {
      // Most common cause: duplicate source_url.
      res.status(409).json({
        error: sourceUrl
          ? `A source with this URL already exists.`
          : "Failed to create source (validation error or creator not found).",
      });
      return;
    }
    logger.info({ id: created.id, title: created.sourceTitle, createdBy: req.dbUser?.email }, "AI admin: created KB source");
    res.status(201).json({ source: created });
  } catch (err) {
    logger.error({ err, sourceTitle }, "AI admin: create KB source failed");
    res.status(500).json({ error: "Failed to create KB source." });
  }
});

// ─── PUT /ai/admin/kb/sources/:id ────────────────────────────────────────────
router.put("/ai/admin/kb/sources/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid source id." });
    return;
  }
  const { sourceTitle, sourceUrl, creatorId, sourcePublishedAt } = (req.body ?? {}) as {
    sourceTitle?: string;
    sourceUrl?: string | null;
    creatorId?: number | null;
    sourcePublishedAt?: string | null;
  };
  const updates: {
    sourceTitle?: string;
    sourceUrl?: string | null;
    creatorId?: number | null;
    sourcePublishedAt?: Date | null;
  } = {};
  if (sourceTitle !== undefined) {
    if (typeof sourceTitle !== "string" || sourceTitle.trim().length === 0) {
      res.status(400).json({ error: "sourceTitle must be a non-empty string." });
      return;
    }
    if (sourceTitle.trim().length > SOURCE_TITLE_MAX_LENGTH) {
      res.status(400).json({ error: `sourceTitle is too long (max ${SOURCE_TITLE_MAX_LENGTH} characters).` });
      return;
    }
    updates.sourceTitle = sourceTitle.trim();
  }
  if (sourceUrl !== undefined) {
    if (sourceUrl !== null && sourceUrl !== "") {
      if (typeof sourceUrl !== "string" || sourceUrl.length > SOURCE_URL_MAX_LENGTH) {
        res.status(400).json({ error: `sourceUrl is too long (max ${SOURCE_URL_MAX_LENGTH} characters).` });
        return;
      }
      try {
        new URL(sourceUrl);
      } catch {
        res.status(400).json({ error: "sourceUrl must be a valid URL." });
        return;
      }
      updates.sourceUrl = sourceUrl;
    } else {
      updates.sourceUrl = null;
    }
  }
  if (creatorId !== undefined) {
    if (creatorId === null) {
      updates.creatorId = null;
    } else {
      const n = Number(creatorId);
      if (!Number.isInteger(n) || n <= 0) {
        res.status(400).json({ error: "creatorId must be a positive integer or null." });
        return;
      }
      updates.creatorId = n;
    }
  }
  if (sourcePublishedAt !== undefined) {
    if (sourcePublishedAt === null || sourcePublishedAt === "") {
      updates.sourcePublishedAt = null;
    } else {
      const parsed = new Date(sourcePublishedAt);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: "sourcePublishedAt must be a valid ISO date string." });
        return;
      }
      updates.sourcePublishedAt = parsed;
    }
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update." });
    return;
  }
  try {
    const updated = await updateKbSource(id, updates);
    if (!updated) {
      const existing = await getKbSource(id);
      if (!existing) {
        res.status(404).json({ error: "KB source not found." });
      } else {
        res.status(409).json({ error: "Validation error or URL conflict." });
      }
      return;
    }
    logger.info({ id, updatedBy: req.dbUser?.email }, "AI admin: updated KB source");
    res.json({ source: updated });
  } catch (err) {
    logger.error({ err, id }, "AI admin: update KB source failed");
    res.status(500).json({ error: "Failed to update KB source." });
  }
});

// ─── DELETE /ai/admin/kb/sources/:id ─────────────────────────────────────────
router.delete("/ai/admin/kb/sources/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid source id." });
    return;
  }
  try {
    const ok = await deleteKbSource(id);
    if (!ok) {
      res.status(404).json({ error: "KB source not found." });
      return;
    }
    logger.info({ id, deletedBy: req.dbUser?.email }, "AI admin: deleted KB source");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, id }, "AI admin: delete KB source failed");
    res.status(500).json({ error: "Failed to delete KB source." });
  }
});

// ─── POST /ai/admin/kb/sources/:id/chunk ─────────────────────────────────────
// AI-assisted chunking (English only). Returns suggested chunks for the
// admin to review — does NOT create entries.
router.post("/ai/admin/kb/sources/:id/chunk", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid source id." });
    return;
  }
  try {
    const source = await getKbSource(id);
    if (!source) {
      res.status(404).json({ error: "KB source not found." });
      return;
    }
    // Language gate: AI chunking is English only.
    if (source.sourceLanguage !== "en") {
      res.status(422).json({
        error: "AI chunking is only available for English content. Use manual chunking.",
      });
      return;
    }
    // Mark as chunking in-progress (so the admin UI can show a spinner).
    await updateProcessingStatus(id, "chunking");
    const result = await chunkTextWithAI(source.rawText);
    if ("error" in result) {
      // Chunking failed — reset status to 'pending' (or 'failed' with error).
      await updateProcessingStatus(id, "failed", result.error);
      res.status(422).json({ error: result.error });
      return;
    }
    // Record the chunking metadata (method=ai, model=usedModel).
    await updateChunkingMetadata(id, "ai", result.model);
    // Reset status to 'pending' (the source is still pending until entries
    // are created from the chunks).
    await updateProcessingStatus(id, "pending");
    logger.info(
      { id, chunkCount: result.chunks.length, model: result.model, chunkedBy: req.dbUser?.email },
      "AI admin: AI-chunked KB source",
    );
    res.json({ chunks: result.chunks, model: result.model, count: result.chunks.length });
  } catch (err) {
    logger.error({ err, id }, "AI admin: chunk KB source failed");
    res.status(500).json({ error: "Failed to chunk KB source." });
  }
});

// ─── POST /ai/admin/kb/sources/:id/entries/batch ─────────────────────────────
// Creates entries from reviewed chunks. All entries are created with
// is_active = false (admin reviews + activates them in the Entries tab).
router.post("/ai/admin/kb/sources/:id/entries/batch", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid source id." });
    return;
  }
  const { entries, method } = (req.body ?? {}) as {
    entries?: Array<{
      title: string;
      content: string;
      keywords?: string[];
      categoryId?: number | null;
      productId?: number | null;
      priority?: number;
      chunkIndex?: number;
    }>;
    method?: string; // 'ai' | 'manual' — defaults to 'manual' if not set
  };
  if (!Array.isArray(entries) || entries.length === 0) {
    res.status(400).json({ error: "entries must be a non-empty array." });
    return;
  }
  if (entries.length > 50) {
    res.status(400).json({ error: "Too many entries in one batch (max 50). Split into smaller batches." });
    return;
  }
  try {
    const source = await getKbSource(id);
    if (!source) {
      res.status(404).json({ error: "KB source not found." });
      return;
    }
    const createdBy = req.dbUser?.email ?? null;
    const createdIds = await createEntriesBatch(id, entries, createdBy);
    if (createdIds.length === 0) {
      res.status(422).json({ error: "Failed to create entries (validation error or source not found)." });
      return;
    }
    // Record the chunking metadata (method = 'ai' if the admin used AI
    // chunking, 'manual' otherwise).
    await updateChunkingMetadata(id, method === "ai" ? "ai" : "manual", null);
    logger.info(
      { id, count: createdIds.length, createdBy },
      "AI admin: batch-created KB entries",
    );
    res.status(201).json({ createdIds, count: createdIds.length });
  } catch (err) {
    logger.error({ err, id }, "AI admin: batch-create KB entries failed");
    res.status(500).json({ error: "Failed to create KB entries." });
  }
});

// ─── GET /ai/admin/kb/entries ────────────────────────────────────────────────
router.get("/ai/admin/kb/entries", async (req: Request, res: Response) => {
  const sourceId = req.query.sourceId !== undefined ? Number(req.query.sourceId) : undefined;
  const categoryId = req.query.categoryId !== undefined ? Number(req.query.categoryId) : undefined;
  const creatorId = req.query.creatorId !== undefined ? Number(req.query.creatorId) : undefined;
  const productId = req.query.productId !== undefined ? Number(req.query.productId) : undefined;
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : 20;
  const offset = req.query.offset !== undefined ? Number(req.query.offset) : 0;
  const isActive = req.query.isActive !== undefined
    ? req.query.isActive === "true"
    : undefined;
  try {
    const result = await listKbEntries({
      sourceId: Number.isInteger(sourceId) ? sourceId : undefined,
      categoryId: Number.isInteger(categoryId) ? categoryId : undefined,
      creatorId: Number.isInteger(creatorId) ? creatorId : undefined,
      productId: Number.isInteger(productId) ? productId : undefined,
      isActive,
      embeddingStatus: typeof req.query.embeddingStatus === "string" ? req.query.embeddingStatus : undefined,
      limit: Number.isInteger(limit) ? limit : undefined,
      offset: Number.isInteger(offset) ? offset : undefined,
    });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "AI admin: list KB entries failed");
    res.status(500).json({ error: "Failed to list KB entries." });
  }
});

// ─── GET /ai/admin/kb/entries/:id ────────────────────────────────────────────
router.get("/ai/admin/kb/entries/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid entry id." });
    return;
  }
  try {
    const entry = await getKbEntry(id);
    if (!entry) {
      res.status(404).json({ error: "KB entry not found." });
      return;
    }
    res.json({ entry });
  } catch (err) {
    logger.error({ err, id }, "AI admin: get KB entry failed");
    res.status(500).json({ error: "Failed to load KB entry." });
  }
});

// ─── POST /ai/admin/kb/entries ───────────────────────────────────────────────
// Manual entry creation (single entry, is_active defaults to true for
// manually-created content — the admin typed it intentionally).
router.post("/ai/admin/kb/entries", async (req: Request, res: Response) => {
  const { sourceId, title, content, keywords, categoryId, productId, priority, isActive } =
    (req.body ?? {}) as {
      sourceId?: number;
      title?: string;
      content?: string;
      keywords?: string[];
      categoryId?: number | null;
      productId?: number | null;
      priority?: number;
      isActive?: boolean;
    };
  if (typeof sourceId !== "number" || !Number.isInteger(sourceId) || sourceId <= 0) {
    res.status(400).json({ error: "sourceId is required (positive integer)." });
    return;
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    res.status(400).json({ error: "title is required (non-empty string)." });
    return;
  }
  if (title.trim().length > ENTRY_TITLE_MAX_LENGTH) {
    res.status(400).json({ error: `title is too long (max ${ENTRY_TITLE_MAX_LENGTH} characters).` });
    return;
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    res.status(400).json({ error: "content is required (non-empty string)." });
    return;
  }
  if (content.length > ENTRY_CONTENT_MAX_LENGTH) {
    res.status(400).json({ error: `content is too long (max ${ENTRY_CONTENT_MAX_LENGTH} characters).` });
    return;
  }
  if (keywords !== undefined) {
    if (!Array.isArray(keywords) || keywords.length > ENTRY_KEYWORD_MAX_COUNT) {
      res.status(400).json({ error: `keywords must be an array of at most ${ENTRY_KEYWORD_MAX_COUNT} strings.` });
      return;
    }
    for (const k of keywords) {
      if (typeof k !== "string" || k.length > ENTRY_KEYWORD_MAX_LENGTH) {
        res.status(400).json({ error: `Each keyword must be a string of at most ${ENTRY_KEYWORD_MAX_LENGTH} characters.` });
        return;
      }
    }
  }
  if (priority !== undefined) {
    if (!Number.isInteger(priority) || priority < ENTRY_PRIORITY_MIN || priority > ENTRY_PRIORITY_MAX) {
      res.status(400).json({ error: `priority must be an integer between ${ENTRY_PRIORITY_MIN} and ${ENTRY_PRIORITY_MAX}.` });
      return;
    }
  }
  try {
    const created = await createEntry({
      sourceId,
      title: title.trim(),
      content,
      keywords,
      categoryId: categoryId ?? null,
      productId: productId ?? null,
      priority,
      isActive: isActive ?? true, // default true for manual entries
      createdBy: req.dbUser?.email ?? null,
    });
    if (!created) {
      res.status(422).json({ error: "Failed to create entry (validation error or source not found)." });
      return;
    }
    logger.info({ id: created.id, sourceId, createdBy: req.dbUser?.email }, "AI admin: created KB entry");
    res.status(201).json({ entry: created });
  } catch (err) {
    logger.error({ err, sourceId, title }, "AI admin: create KB entry failed");
    res.status(500).json({ error: "Failed to create KB entry." });
  }
});

// ─── PUT /ai/admin/kb/entries/:id ────────────────────────────────────────────
// Updates an entry. If `content` changes, the embedding is cleared
// (status → 'pending') so the background job regenerates it.
router.put("/ai/admin/kb/entries/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid entry id." });
    return;
  }
  const { title, content, keywords, categoryId, productId, priority } = (req.body ?? {}) as {
    title?: string;
    content?: string;
    keywords?: string[];
    categoryId?: number | null;
    productId?: number | null;
    priority?: number;
  };
  const updates: {
    title?: string;
    content?: string;
    keywords?: string[];
    categoryId?: number | null;
    productId?: number | null;
    priority?: number;
  } = {};
  if (title !== undefined) {
    if (typeof title !== "string" || title.trim().length === 0) {
      res.status(400).json({ error: "title must be a non-empty string." });
      return;
    }
    if (title.trim().length > ENTRY_TITLE_MAX_LENGTH) {
      res.status(400).json({ error: `title is too long (max ${ENTRY_TITLE_MAX_LENGTH} characters).` });
      return;
    }
    updates.title = title.trim();
  }
  if (content !== undefined) {
    if (typeof content !== "string" || content.trim().length === 0) {
      res.status(400).json({ error: "content must be a non-empty string." });
      return;
    }
    if (content.length > ENTRY_CONTENT_MAX_LENGTH) {
      res.status(400).json({ error: `content is too long (max ${ENTRY_CONTENT_MAX_LENGTH} characters).` });
      return;
    }
    updates.content = content;
  }
  if (keywords !== undefined) {
    if (!Array.isArray(keywords) || keywords.length > ENTRY_KEYWORD_MAX_COUNT) {
      res.status(400).json({ error: `keywords must be an array of at most ${ENTRY_KEYWORD_MAX_COUNT} strings.` });
      return;
    }
    for (const k of keywords) {
      if (typeof k !== "string" || k.length > ENTRY_KEYWORD_MAX_LENGTH) {
        res.status(400).json({ error: `Each keyword must be a string of at most ${ENTRY_KEYWORD_MAX_LENGTH} characters.` });
        return;
      }
    }
    updates.keywords = keywords;
  }
  if (categoryId !== undefined) {
    if (categoryId !== null && (!Number.isInteger(categoryId) || categoryId <= 0)) {
      res.status(400).json({ error: "categoryId must be a positive integer or null." });
      return;
    }
    updates.categoryId = categoryId;
  }
  if (productId !== undefined) {
    if (productId !== null && (!Number.isInteger(productId) || productId <= 0)) {
      res.status(400).json({ error: "productId must be a positive integer or null." });
      return;
    }
    updates.productId = productId;
  }
  if (priority !== undefined) {
    if (!Number.isInteger(priority) || priority < ENTRY_PRIORITY_MIN || priority > ENTRY_PRIORITY_MAX) {
      res.status(400).json({ error: `priority must be an integer between ${ENTRY_PRIORITY_MIN} and ${ENTRY_PRIORITY_MAX}.` });
      return;
    }
    updates.priority = priority;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update." });
    return;
  }
  try {
    const updated = await updateEntry(id, updates);
    if (!updated) {
      const existing = await getKbEntry(id);
      if (!existing) {
        res.status(404).json({ error: "KB entry not found." });
      } else {
        res.status(422).json({ error: "Validation error." });
      }
      return;
    }
    logger.info({ id, updatedBy: req.dbUser?.email }, "AI admin: updated KB entry");
    res.json({ entry: updated });
  } catch (err) {
    logger.error({ err, id }, "AI admin: update KB entry failed");
    res.status(500).json({ error: "Failed to update KB entry." });
  }
});

// ─── POST /ai/admin/kb/entries/:id/activate ──────────────────────────────────
router.post("/ai/admin/kb/entries/:id/activate", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid entry id." });
    return;
  }
  try {
    const ok = await activateEntry(id);
    if (!ok) {
      res.status(404).json({ error: "KB entry not found." });
      return;
    }
    logger.info({ id, activatedBy: req.dbUser?.email }, "AI admin: activated KB entry");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, id }, "AI admin: activate KB entry failed");
    res.status(500).json({ error: "Failed to activate KB entry." });
  }
});

// ─── POST /ai/admin/kb/entries/:id/deactivate ────────────────────────────────
router.post("/ai/admin/kb/entries/:id/deactivate", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid entry id." });
    return;
  }
  try {
    const ok = await deactivateEntry(id);
    if (!ok) {
      res.status(404).json({ error: "KB entry not found." });
      return;
    }
    logger.info({ id, deactivatedBy: req.dbUser?.email }, "AI admin: deactivated KB entry");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, id }, "AI admin: deactivate KB entry failed");
    res.status(500).json({ error: "Failed to deactivate KB entry." });
  }
});

// ─── DELETE /ai/admin/kb/entries/:id ─────────────────────────────────────────
router.delete("/ai/admin/kb/entries/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid entry id." });
    return;
  }
  try {
    const ok = await deleteEntry(id);
    if (!ok) {
      res.status(404).json({ error: "KB entry not found." });
      return;
    }
    logger.info({ id, deletedBy: req.dbUser?.email }, "AI admin: deleted KB entry");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, id }, "AI admin: delete KB entry failed");
    res.status(500).json({ error: "Failed to delete KB entry." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── Phase 3: KB Insights + Search Tester ──────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
//
// Admin endpoints for monitoring KB usage + testing the search engine.
// Both inherit requireAdmin (mounted at the top of this file).
//
//   GET  /ai/admin/kb/insights — KB stats + hit rate (last 30 days)
//   POST /ai/admin/kb/search   — test the search engine (admin can see
//                                what results the AI would get + the score
//                                breakdown for each result)

// ─── GET /ai/admin/kb/insights ────────────────────────────────────────────────
// Returns KB stats (total/active/embedded entries, entries by category/creator)
// + the KB hit rate over the last 30 days (what % of assistant messages used
// KB context, what % called the search tool, what % had context auto-injected).
router.get("/ai/admin/kb/insights", async (_req: Request, res: Response) => {
  try {
    const stats = await getKbStats();

    // KB hit rate over the last 30 days. Queries ai_chat_messages for the
    // 4 KB usage columns (added by the Phase 3 migration).
    const hitRateResult = await pool.query<{
      total: string;
      kb_hits: string;
      tool_calls: string;
      injected: string;
    }>(`
      SELECT
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE kb_hit = TRUE)::bigint AS kb_hits,
        COUNT(*) FILTER (WHERE kb_search_performed = TRUE)::bigint AS tool_calls,
        COUNT(*) FILTER (WHERE kb_context_injected = TRUE)::bigint AS injected
      FROM ai_chat_messages
      WHERE role = 'assistant'
        AND created_at > NOW() - INTERVAL '30 days'
    `);

    const total = Number(hitRateResult.rows[0]?.total ?? 0);
    const kbHits = Number(hitRateResult.rows[0]?.kb_hits ?? 0);
    const hitRate = total > 0 ? Math.round((kbHits / total) * 1000) / 10 : 0;

    res.json({
      ...stats,
      hitRate: {
        totalAssistantMessages: total,
        kbHits,
        toolCalls: Number(hitRateResult.rows[0]?.tool_calls ?? 0),
        contextInjected: Number(hitRateResult.rows[0]?.injected ?? 0),
        hitRatePercent: hitRate, // e.g. 42.5
      },
    });
  } catch (err) {
    logger.error({ err }, "AI admin: KB insights failed");
    res.status(500).json({ error: "Failed to load KB insights." });
  }
});

// ─── POST /ai/admin/kb/search ────────────────────────────────────────────────
// Tests the KB search engine. Admin can search the KB to see what results
// the AI would get + the score breakdown (semantic/keyword/authority/
// priority/recency) for each result. Uses minScore=0.0 so ALL results are
// returned (even low-relevance ones — admins want to see everything).
router.post("/ai/admin/kb/search", async (req: Request, res: Response) => {
  const { query, categoryId, productSlug, maxResults } = (req.body ?? {}) as {
    query?: string;
    categoryId?: number;
    productSlug?: string;
    maxResults?: number;
  };

  if (typeof query !== "string" || query.trim().length === 0) {
    res.status(400).json({ error: "query is required (non-empty string)." });
    return;
  }

  try {
    const results = await searchKnowledgeBase({
      query: query.trim(),
      categoryId: typeof categoryId === "number" ? categoryId : undefined,
      productSlug: typeof productSlug === "string" ? productSlug : undefined,
      maxResults: Math.min(maxResults ?? 5, 10),
      // Show all results for debugging — admins want to see what the AI
      // would get, including low-relevance ones. The AI's actual search
      // (tool call) uses minScore=0.3; auto-injection uses 0.5.
      minScore: 0.0,
    });

    res.json({
      query: query.trim(),
      results: results.map((r) => ({
        id: r.entry.id,
        title: r.entry.title,
        content: r.entry.content.slice(0, 500) + (r.entry.content.length > 500 ? "…" : ""),
        score: Math.round(r.score * 100) / 100,
        breakdown: {
          semantic: Math.round(r.semanticSimilarity * 100) / 100,
          keyword: Math.round(r.keywordOverlap * 100) / 100,
          authority: Math.round(r.creatorAuthority * 100) / 100,
          priority: Math.round(r.priority * 100) / 100,
          recency: Math.round(r.recency * 100) / 100,
        },
        creator: r.creator?.name ?? null,
        category: r.category?.name ?? null,
        source: r.source?.title ?? null,
        sourceType: r.source?.type ?? null,
        keywords: r.entry.keywords,
      })),
      count: results.length,
    });
  } catch (err) {
    logger.error({ err }, "AI admin: KB search failed");
    res.status(500).json({ error: "Failed to search KB." });
  }
});

export default router;
