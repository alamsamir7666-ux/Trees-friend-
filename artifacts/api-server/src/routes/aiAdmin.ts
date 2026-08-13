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
router.get("/api/ai/admin/timeseries", async (req: Request, res: Response) => {
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
router.get("/api/ai/admin/top-questions", async (req: Request, res: Response) => {
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
router.get("/api/ai/admin/top-products", async (req: Request, res: Response) => {
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
router.get("/api/ai/admin/feedback", async (req: Request, res: Response) => {
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
router.get("/api/ai/admin/pii-stats", async (_req: Request, res: Response) => {
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
router.get("/api/ai/admin/top-questions-v2", async (req: Request, res: Response) => {
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

export default router;
