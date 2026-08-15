import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  index,
  uniqueIndex,
  type AnyPgColumn,
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

    // ─── Phase 3: KB usage logging ──────────────────────────────────────────
    // Tracks which KB entries were used for each assistant response. All
    // four columns are nullable (NULL for user messages + legacy rows
    // created before Phase 3). See ensureAiTables.ts for the full docs.
    //
    //   kbHit              — TRUE if KB context was injected OR the tool was called.
    //   kbEntriesUsed      — array of ai_kb_entries.id values injected into the prompt.
    //   kbSearchPerformed  — TRUE if the AI called search_knowledge_base.
    //   kbContextInjected  — TRUE if KB context was auto-injected (pre-search).
    kbHit: boolean("kb_hit"),
    kbEntriesUsed: integer("kb_entries_used").array(),
    kbSearchPerformed: boolean("kb_search_performed"),
    kbContextInjected: boolean("kb_context_injected"),
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
    // Phase 3: KB hit-rate dashboard (queries last 30 days of assistant
    // messages where kb_hit = TRUE). Partial index keeps it small.
    index("ai_chat_messages_kb_hit_idx")
      .on(table.createdAt)
      .where(sql`kb_hit = true`),
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
    index("ai_chat_feedback_rater_lookup_idx").on(
      table.messageId,
      table.raterUserId,
      table.raterSessionSid,
    ),
    // "Show me all 👎 ratings from last week" — for the admin panel.
    // (Downgraded from uniqueIndex to index — the v1.5 schema declared it
    // unique but the SQL never was; this matches the actual runtime.)
    index("ai_chat_feedback_rating_idx").on(table.rating, table.createdAt),
  ],
);

export type AiChatFeedback = typeof aiChatFeedbackTable.$inferSelect;

// ─── v5.1: Conversation sharing ─────────────────────────────────────────────
/**
 * Read-only share links for AI chat sessions.
 *
 * Users can generate a share link to send their conversation to someone
 * else (e.g. for support, or to share plant care advice). The link is
 * read-only + can optionally expire.
 *
 * Industry standard: ChatGPT shared links, Claude artifacts.
 *
 *   - `shareToken` is a random 32-char hex string (128 bits of entropy),
 *     generated server-side via `crypto.randomBytes(16).toString("hex")`.
 *   - `expiresAt` is optional (NULL = never expires).
 *   - `viewCount` is incremented on each view (analytics + abuse detection).
 *   - CASCADE on `sessionId` so deleting the session removes its share links.
 */
export const aiChatSharedLinksTable = pgTable(
  "ai_chat_shared_links",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => aiChatSessionsTable.id, { onDelete: "cascade" }),
    shareToken: text("share_token").notNull().unique(),
    title: text("title"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
    viewCount: integer("view_count").default(0).notNull(),
    lastViewedAt: timestamp("last_viewed_at"),
    createdBy: text("created_by"),
  },
  (table) => [
    index("ai_chat_shared_links_session_idx").on(table.sessionId),
    index("ai_chat_shared_links_token_idx").on(table.shareToken),
  ],
);

export type AiChatSharedLink = typeof aiChatSharedLinksTable.$inferSelect;

// Mark the module as side-effectful for the schema barrel — drizzle needs
// the table objects to be imported so they're included in the schema bag.
export const __aiChatSchemaMarker = sql`-- ai_chat schema loaded`;

// ═══════════════════════════════════════════════════════════════════════════
// ─── Phase 1: Knowledge Base tables ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
//
// These four tables back the TreeBot Knowledge Base — curated plant-care
// content (from YouTube transcripts, blog posts, manual writing) that the
// AI uses as its primary information source before falling back to its
// own training data.
//
// Phase 1 ships only the schema + category admin (no entries, no sources
// UI, no AI integration). Phase 2 will populate ai_kb_entries + add the
// `embedding` vector column + HNSW index. Phase 3 wires the search tool
// into the AI route. Phase 4 adds tone matching via ai_kb_creators.
//
// The Drizzle definitions below mirror the SQL in ensureAiTables.ts so
// they stay in sync for documentation + future drizzle-kit migration
// generation. The routes use raw `pool.query` (not drizzle's query
// builder) for these tables — the Drizzle definitions are decorative
// but must stay accurate.

/**
 * KB content creators — YouTube channels, blog authors, or "Manual" for
 * admin-typed content. Created in Phase 1 so ai_kb_sources can FK to it
 * from day one; the admin UI for managing creators ships in Phase 4
 * (along with tone matching).
 *
 *   - `slug` is globally unique (one "garden-with-arif" channel, not two).
 *   - `entryCount` is a denormalized count maintained by Phase 2 logic
 *     (increment on entry insert, decrement on delete). Read here for
 *     fast admin listing without a JOIN.
 *   - `toneProfile` is a JSON-serialized object stored as TEXT for
 *     cross-Postgres compatibility (avoids jsonb vs json differences).
 *     Phase 4 populates it; Phase 1 leaves it NULL.
 *   - `toneMatchPercentage` overrides the global tone-match threshold
 *     per creator (NULL = use global default). Phase 4 reads it.
 */
export const aiKbCreatorsTable = pgTable(
  "ai_kb_creators",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    sourceType: text("source_type").default("manual").notNull(), // youtube | blog | facebook | manual
    profileUrl: text("profile_url"),
    entryCount: integer("entry_count").default(0).notNull(),
    toneProfile: text("tone_profile"),
    toneProfileUpdatedAt: timestamp("tone_profile_updated_at"),
    toneMatchPercentage: integer("tone_match_percentage"),
    // ─── Phase 4: tone matching tracking ────────────────────────────────
    // Tracks when the profile was last generated + how many entries it was
    // based on. The background job uses these to decide when to regenerate
    // (auto-regenerate when the creator adds 5+ new entries since the last
    // profile generation).
    toneProfileEntryCount: integer("tone_profile_entry_count"),
    toneProfileModel: text("tone_profile_model"),
    isFeatured: boolean("is_featured").default(false).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("ai_kb_creators_slug_idx").on(table.slug),
    index("ai_kb_creators_active_idx").on(table.isActive),
    index("ai_kb_creators_entry_count_idx").on(table.entryCount),
  ],
);

export type AiKbCreator = typeof aiKbCreatorsTable.$inferSelect;

/**
 * KB category tree — N-level hierarchy via `parentId` + a materialized
 * `path` (e.g. '/1/3/7/') for fast subtree queries.
 *
 *   - `path` is `'/<root_id>/.../<self_id>/'`. A root has `path = '/<id>/'`.
 *     Maintained by the kbCategories lib module (INSERT then UPDATE path
 *     once the SERIAL id is known; UPDATE descendants on move).
 *   - `depth` is 0 for root, 1 for child, 2 for grandchild, etc.
 *   - `UNIQUE(parent_id, slug)` enforces sibling-slug uniqueness (two
 *     roots can share a slug, but two children of the same parent cannot).
 *     Postgres treats NULL parent_ids as distinct, so the UNIQUE
 *     constraint doesn't merge root slugs — we add an app-level check
 *     in the lib module to keep root slugs globally unique too.
 *   - `parent_id` REFERENCES ai_kb_categories(id) ON DELETE CASCADE —
 *     deleting a node cascades to all descendants.
 */
export const aiKbCategoriesTable = pgTable(
  "ai_kb_categories",
  {
    id: serial("id").primaryKey(),
    parentId: integer("parent_id").references((): AnyPgColumn => aiKbCategoriesTable.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    path: text("path").default("/").notNull(),
    depth: integer("depth").default(0).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("ai_kb_categories_parent_slug_unique").on(table.parentId, table.slug),
    index("ai_kb_categories_path_idx").on(table.path),
    index("ai_kb_categories_parent_idx").on(table.parentId),
    index("ai_kb_categories_active_idx").on(table.isActive),
  ],
);

export type AiKbCategory = typeof aiKbCategoriesTable.$inferSelect;

/**
 * Raw ingested KB content — one row per YouTube video, blog post, or
 * manual upload. Phase 1 creates the table (empty); Phase 2 populates
 * it via the chunking/embedding pipeline.
 *
 *   - `sourceUrl` is nullable (manual content has no URL). When present,
 *     a partial UNIQUE index enforces no duplicates (NULLs are not
 *     considered duplicates by default in Postgres).
 *   - `processingStatus` tracks the ingestion pipeline: pending →
 *     chunking → embedding → ready (or failed). Phase 2 reads/updates
 *     this; Phase 1 leaves it at the default 'pending'.
 *   - `rawMetadata` is JSON-serialized text (cross-PG compat).
 */
export const aiKbSourcesTable = pgTable(
  "ai_kb_sources",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id").references(() => aiKbCreatorsTable.id, {
      onDelete: "set null",
    }),
    sourceType: text("source_type").default("manual").notNull(),
    sourceUrl: text("source_url"),
    sourceTitle: text("source_title").notNull(),
    sourceLanguage: text("source_language").default("en").notNull(),
    sourcePublishedAt: timestamp("source_published_at"),
    rawText: text("raw_text").notNull(),
    rawMetadata: text("raw_metadata"),
    processingStatus: text("processing_status").default("pending").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),

    // ─── Phase 2: chunking metadata ──────────────────────────────────────
    // Tracks the chunking process so the admin can see how a source was
    // chunked (AI vs manual, which model, when, any error).
    chunkingMethod: text("chunking_method"), // 'ai' | 'manual'
    chunkingModel: text("chunking_model"), // which Gemini model was used
    chunkedAt: timestamp("chunked_at"),
    chunkingError: text("chunking_error"),
  },
  (table) => [
    // Partial unique index — only applies when sourceUrl IS NOT NULL.
    uniqueIndex("ai_kb_sources_url_unique")
      .on(table.sourceUrl)
      .where(sql`source_url IS NOT NULL`),
    index("ai_kb_sources_creator_idx").on(table.creatorId),
    index("ai_kb_sources_status_idx").on(table.processingStatus),
  ],
);

export type AiKbSource = typeof aiKbSourcesTable.$inferSelect;

/**
 * Searchable KB chunks — the rows the AI's `search_knowledge_base` tool
 * will return. Phase 1 creates the table empty; Phase 2 populates it
 * (chunking source text, generating embeddings, writing rows).
 *
 *   - `creatorId` is denormalized from ai_kb_sources for fast filtering
 *     by creator without a JOIN.
 *   - `categoryId` is nullable + ON DELETE SET NULL — deleting a
 *     category leaves its entries orphaned (rather than cascading) so
 *     admins can re-categorize them. The kbCategories.deleteKbCategory
 *     lib function rejects deletion if any descendant has entries, so
 *     this ON DELETE SET NULL is a safety net, not the main path.
 *   - `productId` is an FK to products.id in spirit, but we don't add
 *     the FK constraint (the products table may not exist in all envs).
 *   - `keywords` is a TEXT[] array with a GIN index for fast
 *     array-overlap queries (WHERE keywords && ARRAY['mango','fungus']).
 *   - `embedding` column + HNSW index are added in Phase 2 (not here).
 */
export const aiKbEntriesTable = pgTable(
  "ai_kb_entries",
  {
    id: serial("id").primaryKey(),
    sourceId: integer("source_id").references(() => aiKbSourcesTable.id, {
      onDelete: "cascade",
    }),
    creatorId: integer("creator_id").references(() => aiKbCreatorsTable.id, {
      onDelete: "set null",
    }),
    categoryId: integer("category_id").references(() => aiKbCategoriesTable.id, {
      onDelete: "set null",
    }),
    productId: integer("product_id"),
    title: text("title").notNull(),
    content: text("content").notNull(),
    contentSummary: text("content_summary"),
    keywords: text("keywords").default("{}").notNull(),
    chunkIndex: integer("chunk_index").default(0).notNull(),
    chunkStartOffset: integer("chunk_start_offset"),
    chunkEndOffset: integer("chunk_end_offset"),
    priority: integer("priority").default(0).notNull(),
    isActive: boolean("is_active").default(false).notNull(),
    versionNumber: integer("version_number").default(1).notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),

    // ─── Phase 2: embedding columns ─────────────────────────────────────
    // The embedding column stores a 768-dim float vector (Gemini
    // gemini-embedding-001 — BUG-E1 fix, was text-embedding-004). Drizzle
    // doesn't have a native vector type, so we declare it as text — the
    // actual SQL column is vector(768) (created by the Phase 2 migration
    // in ensureAiTables.ts). The model + dimensions are configurable via
    // embeddingConfig.ts (GEMINI_EMBEDDING_MODEL + GEMINI_EMBEDDING_DIMENSIONS
    // env vars).
    // route code constructs the embedding string `[0.1, 0.2, ...]` and
    // casts it with `$1::vector` on INSERT/UPDATE.
    embedding: text("embedding"),
    embeddingStatus: text("embedding_status").default("pending").notNull(),
    embeddingError: text("embedding_error"),
    embeddingGeneratedAt: timestamp("embedding_generated_at"),

    // ─── v5.0: BM25 support columns ─────────────────────────────────────
    // bm25_doc_length: precomputed |D| (number of lexemes in search_tsvector).
    // Maintained by a trigger (migration 0007) so it's always in sync with
    // search_tsvector. Used by the bm25_score() PL/pgSQL function for
    // document length normalization in the BM25 formula.
    // Declared as integer (default 0) — the trigger populates it on
    // INSERT/UPDATE of title or content.
    bm25DocLength: integer("bm25_doc_length").default(0).notNull(),
  },
  (table) => [
    index("ai_kb_entries_category_idx").on(table.categoryId, table.isActive, table.priority),
    index("ai_kb_entries_creator_idx").on(table.creatorId),
    index("ai_kb_entries_product_idx").on(table.productId),
    // Partial index — only active entries (the rows the search tool queries).
    index("ai_kb_entries_active_idx")
      .on(table.isActive)
      .where(sql`is_active = true`),
    // GIN index for keyword array overlap queries.
    index("ai_kb_entries_keywords_idx").using("gin", table.keywords),
    // Note: HNSW index on embedding — declared in the SQL migration only
    // (Drizzle doesn't support vector indexes natively). The migration
    // creates it idempotently with CREATE INDEX IF NOT EXISTS.
  ],
);

export type AiKbEntry = typeof aiKbEntriesTable.$inferSelect;

/**
 * Embeddings-based semantic cache (pgvector).
 *
 * NOTE: this table is created by `ensureAiTables.ts` (raw SQL) and is
 * NOT created by Drizzle Kit migrations. The Drizzle declaration here
 * exists for type-safety in any code that wants to SELECT from the
 * table via Drizzle's query builder. The actual schema (column types,
 * HNSW vector index, etc.) lives in ensureAiTables.ts.
 *
 * ─── BUG-3 fix: kb_content_version column ────────────────────────────────────
 *
 * `kbContentVersion` is a 16-char hex fingerprint of the KB state at the
 * time the cached response was built (sha1 of all active KB entry IDs +
 * updated_at + is_active). It changes whenever any active entry is
 * created, updated, deleted, activated, or deactivated.
 *
 * The lookup query filters `WHERE kb_content_version = $N` so cached
 * rows built from old KB state are rejected at SELECT time. This
 * eliminates the race window between event-driven invalidation (BUG-1)
 * and concurrent in-flight requests that may re-cache stale content.
 *
 * Nullable: existing rows have NULL. NULL is treated as "version
 * unknown" and is excluded from cache hits (NULL = anything is NULL,
 * not TRUE). After TTL expiry (1h max) all NULL rows are gone.
 *
 * The column is added by migration `0008_kb_content_version.sql` (for
 * existing DBs) and by `ensureAiTables.ts` (for fresh DBs without
 * migration history).
 */
export const aiResponseCacheTable = pgTable(
  "ai_response_cache",
  {
    id: serial("id").primaryKey(),
    queryText: text("query_text").notNull(),
    response: text("response").notNull(),
    // Drizzle doesn't have a native vector type — declared as text.
    // The actual column is `vector(768)` (created by ensureAiTables.ts).
    embedding: text("embedding"),
    model: text("model"),
    provider: text("provider"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // Bug #4 fix: tracks whether the response involved tool calls
    // (controls TTL: tool-call = 5min, non-tool = 1h).
    hadToolCalls: boolean("had_tool_calls"),
    // BUG-3 fix: KB content version fingerprint (16-char hex).
    // Nullable for back-compat — NULL rows are excluded from cache hits.
    kbContentVersion: text("kb_content_version"),
  },
  (table) => [
    // Note: the HNSW vector index, the created_at index, the tool_calls
    // partial index, and the kb_content_version partial index are all
    // declared in ensureAiTables.ts (raw SQL) — Drizzle doesn't support
    // vector indexes or partial indexes with WHERE clauses in the
    // schema definition. They're idempotent CREATE INDEX IF NOT EXISTS
    // statements there.
    index("ai_response_cache_created_at_idx").on(table.createdAt),
  ],
);

export type AiResponseCacheEntry = typeof aiResponseCacheTable.$inferSelect;
