import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * AI assistant chat sessions.
 *
 * Each row represents one anonymous conversation thread between a website
 * visitor and the Gemini-powered TreeBot assistant. Sessions are keyed by a
 * client-generated `sessionToken` (stored in localStorage on the browser)
 * so the same anonymous visitor can resume their conversation across page
 * refreshes and even across devices if they share the token.
 *
 * Design notes:
 *   - `userId` is nullable because v1 of the assistant is anonymous — even
 *     if the visitor happens to be signed in via Clerk, we don't currently
 *     tie AI chats to user accounts. This column is reserved for a future
 *     v2 that adds logged-in context (orders, wishlist, etc.).
 *   - `title` is auto-derived from the first user message (truncated) so
 *     the conversation list (if we ever build one in the UI) has a
 *     readable label instead of just an ID.
 *   - We deliberately do NOT cascade-delete sessions when a user is deleted,
 *     because v1 sessions are anonymous — `userId` will be NULL for all rows.
 */
export const aiChatSessionsTable = pgTable(
  "ai_chat_sessions",
  {
    id: serial("id").primaryKey(),
    // Client-generated opaque token (e.g. crypto.randomUUID()). Uniqueness
    // enforced so concurrent inserts with the same token collapse to one row.
    sessionToken: text("session_token").notNull().unique(),
    // Nullable for v1 (anonymous). Reserved for future logged-in context.
    userId: text("user_id"),
    // Auto-derived from the first user message; updated once on first message.
    title: text("title"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),

    // ─── v3.0 conversation memory ────────────────────────────────────────
    // When a conversation exceeds AI_SUMMARY_THRESHOLD messages, we ask
    // Gemini to summarize the older half. The summary is stored here and
    // injected into the system prompt on subsequent turns so the model
    // retains long-term context without re-sending every old message
    // (which would blow the token budget).
    //
    // NULL = no summary yet (conversation is still short). Non-NULL =
    // summary exists; older messages below the summary cutoff are excluded
    // from the history array sent to Gemini (the summary replaces them).
    summary: text("summary"),
    // The message id at which the summary was last regenerated. Messages
    // with id <= summaryCutoffId are considered "summarized" and excluded
    // from the history array (their content is captured in `summary`).
    // NULL = no cutoff yet.
    summaryCutoffId: integer("summary_cutoff_id"),
    // Count of messages that were summarized into the current summary.
    // Useful for debugging ("did the summary include 5 messages or 10?").
    summarizedCount: integer("summarized_count").default(0).notNull(),
    // Timestamp of the last summary regeneration — lets us re-summarize
    // periodically if the conversation continues long after the first summary.
    summaryUpdatedAt: timestamp("summary_updated_at"),
  },
  (table) => [
    // Lookups by client token are the hot path (every chat request).
    index("ai_chat_sessions_token_idx").on(table.sessionToken),
    // Future-proof: when v1 ships logged-in context, list a user's sessions.
    index("ai_chat_sessions_user_idx").on(table.userId),
    // v3.0: TTL cleanup job queries sessions by updated_at to find stale ones.
    index("ai_chat_sessions_updated_at_idx").on(table.updatedAt),
  ],
);

/**
 * AI assistant chat messages.
 *
 * Stores both sides of the conversation — user messages (`role = 'user'`)
 * and assistant responses (`role = 'assistant'`). Ordered by `created_at`
 * ascending within a session for chronological display.
 *
 * The assistant content is stored exactly as Gemini returned it (post-stream
 * reassembly on the backend), so the frontend can rehydrate a conversation
 * on page load without re-calling the model.
 */
export const aiChatMessagesTable = pgTable(
  "ai_chat_messages",
  {
    id: serial("id").primaryKey(),
    sessionId: serial("session_id")
      .notNull()
      .references(() => aiChatSessionsTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'user' | 'assistant'
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),

    // ─── v2.0 admin insights columns ─────────────────────────────────────
    // off_topic: TRUE when the hard topic gate refused the message.
    // greeting: TRUE when the pure-greeting shortcut fired.
    offTopic: boolean("off_topic").default(false).notNull(),
    greeting: boolean("greeting").default(false).notNull(),

    // ─── v3.0 observability columns ──────────────────────────────────────
    // The Gemini model that produced this assistant response (e.g.
    // "gemini-2.5-flash"). NULL for user messages and for the canned
    // off-topic/greeting short-circuit responses. Used by admin analytics
    // to show model usage distribution.
    model: text("model"),
    // Wall-clock response time in milliseconds, measured from when the
    // request hit POST /ai/chat to when the first SSE delta was sent.
    // NULL for user messages. Used to track latency regressions per model.
    responseMs: integer("response_ms"),
    // Number of tokens consumed (prompt + completion) if Gemini reported
    // it in usage metadata. NULL when not available. Useful for cost
    // tracking and quota management.
    tokenCount: integer("token_count"),
    // TRUE if PII was detected and redacted from this user message before
    // being sent to Gemini. The stored `content` is the REDACTED version
    // (we never persist raw PII in the AI tables). Used by admin to
    // understand how often users expose sensitive info in chat.
    piiRedacted: boolean("pii_redacted").default(false).notNull(),
    // TRUE if this message was excluded from the history array sent to
    // Gemini because it was captured in the session summary. Lets the
    // admin see which messages are "compressed" vs sent verbatim.
    summarized: boolean("summarized").default(false).notNull(),
  },
  (table) => [
    // The hot path is "fetch the last N messages for a session, oldest first"
    // — both for display and for building the conversation history sent to
    // Gemini. This composite index covers that with a single index scan.
    index("ai_chat_messages_session_created_idx").on(table.sessionId, table.createdAt),
    // v2.0: fast refusal-rate queries (partial index — only off_topic rows).
    index("ai_chat_messages_off_topic_idx")
      .on(table.createdAt)
      .where(sql`off_topic = true`),
    // v3.0: model-usage analytics (group by model, count, avg response_ms).
    index("ai_chat_messages_model_idx").on(table.model),
  ],
);

// Useful type exports for the API server to consume via @workspace/db.
export type AiChatSession = typeof aiChatSessionsTable.$inferSelect;
export type AiChatMessage = typeof aiChatMessagesTable.$inferSelect;

/**
 * v3.0 AI event log — append-only audit trail of significant AI events.
 *
 * Used for debugging + admin observability. Events include:
 *   - "summary_generated"  — conversation was summarized
 *   - "piy_redacted"       — PII was detected and stripped
 *   - "retry"              — a Gemini call was retried (transient error)
 *   - "model_fallback"     — model fallback chain kicked in
 *   - "tool_call"          — a function-calling tool was invoked
 *   - "truncated"          — response hit maxOutputTokens limit
 *
 * One row per event. Cascade-deletes with the session. Lightweight — no
 * indexes beyond the FK because we only query this for debugging specific
 * sessions, not for analytics (use the columns on ai_chat_messages for that).
 */
export const aiChatEventsTable = pgTable(
  "ai_chat_events",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => aiChatSessionsTable.id, { onDelete: "cascade" }),
    // Stable event type for filtering. See comment above for the list.
    type: text("type").notNull(),
    // Arbitrary JSON payload (model name, retry count, error message, etc.).
    // Stored as TEXT (JSON-stringified) for cross-Postgres compatibility.
    payload: text("payload"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("ai_chat_events_session_idx").on(table.sessionId, table.createdAt),
    index("ai_chat_events_type_idx").on(table.type, table.createdAt),
  ],
);

export type AiChatEvent = typeof aiChatEventsTable.$inferSelect;

/**
 * Per-message feedback (v1.5). One row per assistant message that the user
 * rated with 👍 or 👎.
 *
 * ─── v3.6 Bug #2 fix: ownership tracking ───────────────────────────────────
 *
 * The original schema had a UNIQUE constraint on `messageId` alone — meaning
 * only ONE user could rate each message, and the (unauthenticated) endpoint
 * let anyone toggle/delete that rating by re-POSTing. The fix:
 *
 *   1. Adds `raterUserId` (TEXT, nullable) — Clerk user id of the rater, if
 *      the requester was authenticated.
 *   2. Adds `raterSessionSid` (TEXT, nullable) — the `sid` from the rater's
 *      signed session token, if the requester was anonymous. Matches
 *      `aiChatSessionsTable.sessionToken`.
 *
 * The UNIQUE constraint is now split into TWO partial unique indexes (see
 * the index list below), enforcing "one rating per (message, rater)":
 *   - Authenticated ratings: UNIQUE (messageId, raterUserId) WHERE raterUserId IS NOT NULL
 *   - Anonymous ratings:     UNIQUE (messageId, raterSessionSid) WHERE raterSessionSid IS NOT NULL
 *
 * This lets multiple users independently rate the same message (every user
 * who receives the same AI response can rate it) while preventing a single
 * rater from spamming the same message.
 *
 * The route additionally verifies that the rater OWNS the message being
 * rated (anonymous = signed token's sid matches the message's session_token;
 * authenticated = user_id matches the session's user_id). This stops
 * messageId-enumeration attacks.
 *
 * Cascade rules: deleting the message OR the session removes the feedback.
 *
 * ─── Legacy rows ──────────────────────────────────────────────────────────────
 *
 * Existing feedback rows (created before this migration) have both
 * `raterUserId` and `raterSessionSid` as NULL. They're kept for analytics
 * but cannot be modified by the new route (the route requires at least one
 * of the two to be set). The SQL migration backfills `raterSessionSid`
 * from the session the message belongs to (only for anonymous sessions,
 * since we can't reliably attribute authenticated-session legacy rows).
 */
export const aiChatFeedbackTable = pgTable(
  "ai_chat_feedback",
  {
    id: serial("id").primaryKey(),
    messageId: integer("message_id")
      .notNull()
      .references(() => aiChatMessagesTable.id, { onDelete: "cascade" }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => aiChatSessionsTable.id, { onDelete: "cascade" }),
    rating: text("rating").notNull(), // "up" | "down"
    comment: text("comment"), // optional free-text feedback
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // ─── v3.6: who left this rating? At least one is required by the route. ──
    // The Clerk user id (if authenticated). NULL for anonymous ratings.
    raterUserId: text("rater_user_id"),
    // The sid from the rater's signed session token (if anonymous). NULL
    // for authenticated ratings. Matches ai_chat_sessions.session_token.
    raterSessionSid: text("rater_session_sid"),
  },
  (table) => [
    // ─── v3.6 Bug #2 fix: scoped unique indexes ─────────────────────────────
    // Authenticated ratings: one per (message, user). Partial — only applies
    // when raterUserId IS NOT NULL, so multiple users can rate the same
    // message independently. Legacy rows (raterUserId NULL) are excluded.
    // Drizzle's .where() builds the partial-index predicate.
    uniqueIndex("ai_chat_feedback_msg_user_unique")
      .on(table.messageId, table.raterUserId)
      .where(sql`rater_user_id IS NOT NULL`),
    // Anonymous ratings: one per (message, anonymous session). Partial —
    // only applies when raterSessionSid IS NOT NULL.
    uniqueIndex("ai_chat_feedback_msg_session_unique")
      .on(table.messageId, table.raterSessionSid)
      .where(sql`rater_session_sid IS NOT NULL`),
    // Lookup index for the route's toggle/update/insert logic. Composite
    // covers "does rater X already have a rating on message Y?".
    index("ai_chat_feedback_rater_lookup_idx")
      .on(table.messageId, table.raterUserId, table.raterSessionSid),
    // "Show me all 👎 ratings from last week" — for the admin panel.
    // (Downgraded from uniqueIndex to index — the v1.5 schema declared it
    // unique but the SQL never was; this matches the actual runtime.)
    index("ai_chat_feedback_rating_idx").on(table.rating, table.createdAt),
  ],
);

export type AiChatFeedback = typeof aiChatFeedbackTable.$inferSelect;

// Mark the module as side-effectful for the schema barrel — drizzle needs
// the table objects to be imported so they're included in the schema bag.
export const __aiChatSchemaMarker = sql`-- ai_chat schema loaded`;
