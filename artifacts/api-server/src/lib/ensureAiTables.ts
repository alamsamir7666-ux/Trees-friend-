/**
 * Ensures the `ai_chat_sessions` and `ai_chat_messages` tables exist in the
 * database, mirroring lib/db/src/schema/aiChat.ts.
 *
 * Same self-bootstrapping pattern as ensureConversationsTables.ts / ensurePresenceTables.ts:
 *   - runs on every cold start (both long-lived `index.ts` AND Vercel serverless)
 *   - fully idempotent (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS)
 *   - safe to run concurrently (Postgres serializes DDL per statement)
 *   - failures are logged but never crash the server
 *
 * We intentionally do NOT block the server from starting — if these tables
 * can't be created for some reason (e.g. transient DB issue), the AI route
 * will return a 503 for individual requests, which is preferable to taking
 * down the entire API.
 *
 * v3.0 additions:
 *   - `summary`, `summary_cutoff_id`, `summarized_count`, `summary_updated_at`
 *     columns on ai_chat_sessions (for conversation summarization)
 *   - `model`, `response_ms`, `token_count`, `pii_redacted`, `summarized`
 *     columns on ai_chat_messages (for observability)
 *   - New `ai_chat_events` table (append-only audit trail)
 *   - pg_trgm extension + GIN index on products (for fuzzy semantic search)
 *   - `ai_chat_sessions_updated_at_idx` index (for TTL cleanup job)
 *   - `ai_chat_messages_model_idx` index (for model-usage analytics)
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";

const MIGRATION_SQL = `
-- ─── AI Assistant Chat (anonymous v1) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id SERIAL PRIMARY KEY,
  session_token TEXT NOT NULL UNIQUE,
  user_id TEXT,
  title TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_chat_sessions_token_idx
  ON ai_chat_sessions (session_token);
CREATE INDEX IF NOT EXISTS ai_chat_sessions_user_idx
  ON ai_chat_sessions (user_id);

CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_chat_messages_session_created_idx
  ON ai_chat_messages (session_id, created_at);

-- ─── AI Chat Feedback (v1.5) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_chat_feedback (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  rating TEXT NOT NULL,
  comment TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_feedback_message_unique
  ON ai_chat_feedback (message_id);
CREATE INDEX IF NOT EXISTS ai_chat_feedback_rating_idx
  ON ai_chat_feedback (rating, created_at DESC);

-- ─── v2.0 admin insights columns ────────────────────────────────────────────
-- off_topic: TRUE when the hard topic gate refused the message (no botanical
--   keyword matched). Used by the admin insights endpoint to compute the
--   "refusal rate" metric — what % of questions are off-topic?
-- greeting: TRUE when the pure-greeting shortcut fired. Excluded from
--   refusal-rate calculations (a greeting isn't a refusal).
-- Idempotent ALTER so existing rows just default to false.
ALTER TABLE ai_chat_messages
  ADD COLUMN IF NOT EXISTS off_topic BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS greeting BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill not needed — ALTER DEFAULT only affects new rows. Existing rows
-- get the default value (false) for the new columns automatically.

-- Index for fast refusal-rate queries ("how many of last 1000 msgs were
-- refusals?"). Partial index keeps it small (only off_topic rows).
CREATE INDEX IF NOT EXISTS ai_chat_messages_off_topic_idx
  ON ai_chat_messages (created_at DESC)
  WHERE off_topic = TRUE;

-- ─── v3.0 conversation memory + observability ────────────────────────────────
-- These columns power:
--   - Conversation summarization (summary, summary_cutoff_id, summarized_count,
--     summary_updated_at on sessions)
--   - Observability (model, response_ms, token_count on messages)
--   - PII redaction tracking (pii_redacted on messages)
--   - Summary compression tracking (summarized on messages)

ALTER TABLE ai_chat_sessions
  ADD COLUMN IF NOT EXISTS summary TEXT,
  ADD COLUMN IF NOT EXISTS summary_cutoff_id INTEGER,
  ADD COLUMN IF NOT EXISTS summarized_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS summary_updated_at TIMESTAMP;

-- Index for the TTL cleanup job (queries WHERE updated_at < NOW() - INTERVAL).
CREATE INDEX IF NOT EXISTS ai_chat_sessions_updated_at_idx
  ON ai_chat_sessions (updated_at);

ALTER TABLE ai_chat_messages
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS response_ms INTEGER,
  ADD COLUMN IF NOT EXISTS token_count INTEGER,
  ADD COLUMN IF NOT EXISTS pii_redacted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS summarized BOOLEAN NOT NULL DEFAULT FALSE;

-- v3.2: cost tracking (USD per request) + provider + prompt version
ALTER TABLE ai_chat_messages
  ADD COLUMN IF NOT EXISTS cost_usd REAL,
  ADD COLUMN IF NOT EXISTS provider TEXT,
  ADD COLUMN IF NOT EXISTS prompt_version TEXT;

-- Index for model-usage analytics (GROUP BY model, COUNT, AVG(response_ms)).
CREATE INDEX IF NOT EXISTS ai_chat_messages_model_idx
  ON ai_chat_messages (model);

-- ─── v3.0 AI event log (append-only audit trail) ────────────────────────────
-- Stores events like "summary_generated", "pii_redacted", "retry",
-- "model_fallback", "tool_call", "truncated". Used for debugging + admin
-- observability. Cascade-deletes with the session.
CREATE TABLE IF NOT EXISTS ai_chat_events (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_chat_events_session_idx
  ON ai_chat_events (session_id, created_at);
CREATE INDEX IF NOT EXISTS ai_chat_events_type_idx
  ON ai_chat_events (type, created_at);

-- ─── v3.0 pg_trgm extension for fuzzy search ────────────────────────────────
-- Enables trigram-based similarity matching (e.g. "mangoo" → "mango") as a
-- fallback when ILIKE finds nothing. Available on Supabase, Neon, RDS, and
-- vanilla Postgres 9.1+. CREATE EXTENSION requires superuser on some
-- providers — if it fails, we catch it and the search_catalog tool falls
-- back to ILIKE-only (the route already has try/catch fallbacks).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN index on products.name + description for fast trigram similarity
-- queries. IF NOT EXISTS so this is idempotent.
CREATE INDEX IF NOT EXISTS products_name_trgm_idx
  ON products USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS products_description_trgm_idx
  ON products USING gin (description gin_trgm_ops);

-- ─── v3.2: Prompt versioning ────────────────────────────────────────────────
-- Stores versioned system prompts so admins can A/B test + roll back
-- without a code deploy. The "active" version is controlled by the
-- is_active flag (only one row should have is_active = TRUE at a time).
--
-- ─── Bug #3 fix: the route now USES the prompt_text ─────────────────────────
--
-- Previously the seed row had a placeholder string ('Use aiContext.ts
-- buildSystemPrompt() fallback') and the route ignored prompt_text
-- entirely, always using the hardcoded buildSystemPrompt(). Now the
-- route uses prompt_text as the PRIMARY source, with the hardcoded
-- template as fallback. The seed is now injected via a separate
-- parameterized query (see ensureAiTables() below) using the
-- SYSTEM_PROMPT_TEMPLATE_V1 constant from aiContext.ts — so the DB
-- and the fallback always stay in sync. The {{summary}} and {{catalog}}
-- placeholders are replaced at runtime by renderPromptTemplate().
CREATE TABLE IF NOT EXISTS ai_prompt_versions (
  id SERIAL PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,  -- semver: "1.0.0"
  prompt_text TEXT NOT NULL,
  change_log TEXT,               -- what changed in this version
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT,               -- admin email or "system"
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ─── v3.2: Evaluation harness tables ────────────────────────────────────────
-- Golden Q&A dataset + historical eval results. Used by the eval harness
-- to test prompt/model changes before deploying.
CREATE TABLE IF NOT EXISTS ai_eval_cases (
  id SERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  expected_keywords TEXT[] NOT NULL DEFAULT '{}',
  expected_refusal BOOLEAN NOT NULL DEFAULT FALSE,
  category TEXT NOT NULL DEFAULT 'general',
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_eval_results (
  id SERIAL PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES ai_eval_cases(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  question TEXT NOT NULL,
  response TEXT NOT NULL,
  keyword_overlap REAL NOT NULL,
  refused BOOLEAN NOT NULL,
  response_length INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  passed BOOLEAN NOT NULL,
  model TEXT,
  provider TEXT,
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_eval_results_run_idx
  ON ai_eval_results (run_id);
CREATE INDEX IF NOT EXISTS ai_eval_results_case_idx
  ON ai_eval_results (case_id, created_at DESC);

-- ─── v3.4: Embeddings-based semantic cache (pgvector) ──────────────────────
-- Stores user queries + their embeddings + the AI response, so future
-- similar queries can hit the cache (cosine similarity > threshold).
-- Requires the pgvector extension (CREATE EXTENSION vector).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS ai_response_cache (
  id SERIAL PRIMARY KEY,
  query_text TEXT NOT NULL,
  response TEXT NOT NULL,
  embedding vector(768),  -- Gemini text-embedding-004 = 768 dimensions
  model TEXT,
  provider TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- HNSW index for fast approximate nearest neighbor search.
-- This is the index type recommended by pgvector for production use
-- (faster than IVFFlat for similarity search at scale).
CREATE INDEX IF NOT EXISTS ai_response_cache_embedding_idx
  ON ai_response_cache USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Index for TTL-based cleanup (DELETE WHERE created_at < ...)
CREATE INDEX IF NOT EXISTS ai_response_cache_created_at_idx
  ON ai_response_cache (created_at);

-- ─── Bug #4 fix: track tool-call responses for TTL-aware caching ───────────
-- The "had_tool_calls" column lets the semantic cache apply different TTLs:
--   - FALSE (or NULL for legacy rows) -> long TTL (1 hour, AI_CACHE_TTL_SECONDS)
--     for general plant-care questions with no tool calls.
--   - TRUE -> short TTL (5 min, AI_TOOL_CACHE_TTL_SECONDS) for search_catalog /
--     get_product_care responses where the data is public but changes (prices,
--     availability).
--
-- User-scoped tool calls (get_user_orders, get_order_details) are NEVER cached
-- (the route passes isPrivate=true, which skips both cache writes).
ALTER TABLE ai_response_cache
  ADD COLUMN IF NOT EXISTS had_tool_calls BOOLEAN;

-- Backfill legacy rows (had_tool_calls IS NULL) to FALSE so they use the
-- long TTL (the old behavior). New rows always have a non-NULL value.
UPDATE ai_response_cache
  SET had_tool_calls = FALSE
  WHERE had_tool_calls IS NULL;

-- Partial index for fast filtering on tool-call entries (the short-TTL
-- cleanup job would query WHERE had_tool_calls = TRUE AND created_at < ...).
CREATE INDEX IF NOT EXISTS ai_response_cache_tool_calls_idx
  ON ai_response_cache (created_at)
  WHERE had_tool_calls = TRUE;

-- ─── v3.6: Feedback ownership (Bug #2 fix) ─────────────────────────────────
-- The original ai_chat_feedback schema had ONLY (message_id) as a unique
-- constraint, which meant:
--   1. Only ONE user could rate each message (anyone clicking rating
--      toggled/deleted the existing row regardless of who left it).
--   2. The endpoint was unauthenticated + had no ownership check, so
--      an attacker iterating messageIds (sequential SERIAL ints: 1, 2, 3,
--      ...) could:
--        - Erase legitimate user feedback (toggle-off via re-POST).
--        - Flood the table with arbitrary ratings, corrupting admin
--          insights (refusal-rate, satisfaction metrics).
--        - Spam 200 feedback entries per 15 min per IP (only the global
--          apiLimiter applied).
--
-- The fix adds TWO columns to track WHO left each rating, and replaces
-- the unique index with TWO partial unique indexes (one per rater type):
--   - rater_user_id      TEXT NULL — Clerk user id (if authenticated)
--   - rater_session_sid   TEXT NULL — sid of the signed session token
--                                     (if anonymous; matches
--                                     ai_chat_sessions.session_token)
--
-- At least one of the two is required (enforced by the route, not by a
-- CHECK constraint — legacy rows with both NULL are kept for analytics
-- but cannot be modified by the new route). The partial unique indexes
-- only apply when the relevant column is non-NULL, so:
--   - Multiple authenticated users can independently rate the same message.
--   - Multiple anonymous sessions can independently rate the same message.
--   - Legacy rows (both NULL) don't conflict with new ones.
--
-- The route enforces that the rater actually OWNS the message being rated
-- (anonymous = signed token's sid matches the message's session_token;
-- authenticated = user_id matches the session's user_id). This means an
-- attacker can only rate messages FROM THEIR OWN SESSIONS — they cannot
-- iterate messageIds and rate messages from other users' conversations.
ALTER TABLE ai_chat_feedback
  ADD COLUMN IF NOT EXISTS rater_user_id TEXT,
  ADD COLUMN IF NOT EXISTS rater_session_sid TEXT;

-- Drop the old "one rating per message" unique index. The new model is
-- "one rating per (message, rater)" — enforced by the two partial
-- unique indexes below. IF EXISTS so this is idempotent on re-runs.
DROP INDEX IF EXISTS ai_chat_feedback_message_unique;

-- Authenticated ratings: one per (message, user).
-- Partial index — only applies when rater_user_id IS NOT NULL. Multiple
-- users can rate the same message independently (the use case: every
-- user who receives the same AI response can rate it).
CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_feedback_msg_user_unique
  ON ai_chat_feedback (message_id, rater_user_id)
  WHERE rater_user_id IS NOT NULL;

-- Anonymous ratings: one per (message, anonymous session).
-- Partial index — only applies when rater_session_sid IS NOT NULL.
-- This stops a single anonymous session from rating the same message
-- multiple times (the toggle behavior is scoped to the session).
CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_feedback_msg_session_unique
  ON ai_chat_feedback (message_id, rater_session_sid)
  WHERE rater_session_sid IS NOT NULL;

-- Index for fast lookup of a single rater's existing feedback on a
-- message (used by the route's toggle/update/insert logic). Composite
-- index covers the most common query: "does user X already have a
-- rating on message Y?"
CREATE INDEX IF NOT EXISTS ai_chat_feedback_rater_lookup_idx
  ON ai_chat_feedback (message_id, rater_user_id, rater_session_sid);

-- Backfill the existing (legacy) feedback rows' rater_session_sid from
-- the session they belong to. This is a best-effort migration: legacy
-- rows had no rater tracking, so we attribute them to the session that
-- contains the rated message. This is imperfect (the rater might have
-- been a different anonymous session, or an authenticated user) but
-- it's better than leaving both columns NULL — at least the data is
-- attributed to SOMETHING, and the partial unique indexes will start
-- applying to them.
--
-- We only backfill rows where BOTH rater columns are NULL (truly legacy)
-- AND the message's session is anonymous (user_id IS NULL). For legacy
-- rows on authenticated sessions, we can't know which user left the
-- feedback, so we leave them NULL (they'll show in analytics but won't
-- be toggleable by anyone).
UPDATE ai_chat_feedback f
  SET rater_session_sid = s.session_token
  FROM ai_chat_sessions s, ai_chat_messages m
  WHERE f.message_id = m.id
    AND m.session_id = s.id
    AND s.user_id IS NULL
    AND f.rater_user_id IS NULL
    AND f.rater_session_sid IS NULL;

-- ─── Phase 1: Knowledge Base schema ─────────────────────────────────────────
-- Four tables that back the TreeBot Knowledge Base:
--   ai_kb_creators     — content creators (YouTube channels, blog authors)
--   ai_kb_categories   — N-level category tree (materialized path)
--   ai_kb_sources      — raw ingested content (videos, blog posts, manual)
--   ai_kb_entries      — searchable chunks (empty in Phase 1; Phase 2 fills)
--
-- Phase 1 only ships the schema + category admin. The entries/sources
-- tables exist so the FK graph is in place from day one; Phase 2 will
-- populate them + add the embedding column + HNSW index.
--
-- All statements are idempotent (IF NOT EXISTS) so this block is safe to
-- re-run on every cold start. The seed inserts at the bottom use
-- WHERE NOT EXISTS so they only fire on the first run.

CREATE TABLE IF NOT EXISTS ai_kb_creators (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL DEFAULT 'manual',  -- youtube | blog | facebook | manual
  profile_url TEXT,
  entry_count INTEGER NOT NULL DEFAULT 0,       -- denormalized count
  tone_profile TEXT,                              -- jsonb stored as text (cross-PG compat)
  tone_profile_updated_at TIMESTAMP,
  tone_match_percentage INTEGER,                  -- NULL = use global default
  is_featured BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_kb_creators_slug_idx ON ai_kb_creators (slug);
CREATE INDEX IF NOT EXISTS ai_kb_creators_active_idx ON ai_kb_creators (is_active);
CREATE INDEX IF NOT EXISTS ai_kb_creators_entry_count_idx ON ai_kb_creators (entry_count DESC);

CREATE TABLE IF NOT EXISTS ai_kb_categories (
  id SERIAL PRIMARY KEY,
  parent_id INTEGER REFERENCES ai_kb_categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  path TEXT NOT NULL DEFAULT '/',        -- materialized path, e.g. '/1/3/7/'
  depth INTEGER NOT NULL DEFAULT 0,      -- 0 = root, 1 = child, 2 = grandchild
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(parent_id, slug)               -- siblings can't share a slug
);

CREATE INDEX IF NOT EXISTS ai_kb_categories_path_idx ON ai_kb_categories (path);
CREATE INDEX IF NOT EXISTS ai_kb_categories_parent_idx ON ai_kb_categories (parent_id);
CREATE INDEX IF NOT EXISTS ai_kb_categories_active_idx ON ai_kb_categories (is_active);

CREATE TABLE IF NOT EXISTS ai_kb_sources (
  id SERIAL PRIMARY KEY,
  creator_id INTEGER REFERENCES ai_kb_creators(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL DEFAULT 'manual',     -- youtube | blog | facebook | manual
  source_url TEXT,                                 -- nullable for manual content; UNIQUE when present
  source_title TEXT NOT NULL,
  source_language TEXT NOT NULL DEFAULT 'en',      -- en | bn | banglish
  source_published_at TIMESTAMP,
  raw_text TEXT NOT NULL,
  raw_metadata TEXT,                                -- jsonb as text
  processing_status TEXT NOT NULL DEFAULT 'pending', -- pending | chunking | embedding | ready | failed
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Dedup: reject duplicate source_url (NULLs allowed, NULLs not considered duplicates by default)
CREATE UNIQUE INDEX IF NOT EXISTS ai_kb_sources_url_unique
  ON ai_kb_sources (source_url)
  WHERE source_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_kb_sources_creator_idx ON ai_kb_sources (creator_id);
CREATE INDEX IF NOT EXISTS ai_kb_sources_status_idx ON ai_kb_sources (processing_status);

CREATE TABLE IF NOT EXISTS ai_kb_entries (
  id SERIAL PRIMARY KEY,
  source_id INTEGER REFERENCES ai_kb_sources(id) ON DELETE CASCADE,
  creator_id INTEGER REFERENCES ai_kb_creators(id) ON DELETE SET NULL,  -- denormalized for fast filtering
  category_id INTEGER REFERENCES ai_kb_categories(id) ON DELETE SET NULL,
  product_id INTEGER,                              -- FK to products.id, nullable; no FK constraint to avoid coupling
  title TEXT NOT NULL,
  content TEXT NOT NULL,                            -- markdown, 200-500 words ideal
  content_summary TEXT,                             -- AI-generated 1-sentence summary (Phase 2)
  keywords TEXT[] NOT NULL DEFAULT '{}',
  chunk_index INTEGER NOT NULL DEFAULT 0,
  chunk_start_offset INTEGER,
  chunk_end_offset INTEGER,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  version_number INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_kb_entries_category_idx ON ai_kb_entries (category_id, is_active, priority DESC);
CREATE INDEX IF NOT EXISTS ai_kb_entries_creator_idx ON ai_kb_entries (creator_id);
CREATE INDEX IF NOT EXISTS ai_kb_entries_product_idx ON ai_kb_entries (product_id);
CREATE INDEX IF NOT EXISTS ai_kb_entries_active_idx ON ai_kb_entries (is_active) WHERE is_active = TRUE;
-- GIN index for keyword array search
CREATE INDEX IF NOT EXISTS ai_kb_entries_keywords_idx ON ai_kb_entries USING gin (keywords);
-- Note: the embedding column + HNSW index is added in Phase 2, not Phase 1

-- ─── Phase 2: KB entries embedding + source chunking metadata ──────────────
-- Phase 2 builds the content ingestion pipeline:
--   1. Admins upload raw text (YouTube transcripts, blog posts, manual).
--   2. The system chunks it (AI-assisted for English, manual for others).
--   3. Each chunk becomes an ai_kb_entries row with is_active=false (admin
--      reviews before activation).
--   4. A background job generates embeddings (Gemini text-embedding-004,
--      768 dims) for each entry, storing them in the new embedding column.
--   5. Phase 3 will use these embeddings for semantic search in the
--      AI chat route.
--
-- All statements are idempotent (ADD COLUMN IF NOT EXISTS, CREATE INDEX
-- IF NOT EXISTS) so this block is safe to re-run on every cold start.

-- Phase 2: add embedding column for semantic search.
-- Gemini text-embedding-004 = 768 dimensions (same as ai_response_cache).
ALTER TABLE ai_kb_entries
  ADD COLUMN IF NOT EXISTS embedding vector(768);

-- HNSW index for fast approximate nearest neighbor search.
-- Same index type as ai_response_cache (already proven to work on Supabase).
CREATE INDEX IF NOT EXISTS ai_kb_entries_embedding_idx
  ON ai_kb_entries USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Track embedding generation status per entry:
--   pending   — not yet embedded (waiting for the background job)
--   generated — embedding successfully stored
--   failed    — embedding generation failed (see embedding_error)
ALTER TABLE ai_kb_entries
  ADD COLUMN IF NOT EXISTS embedding_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS embedding_error TEXT,
  ADD COLUMN IF NOT EXISTS embedding_generated_at TIMESTAMP;

-- Phase 2: track the chunking process per source.
--   chunking_method  — 'ai' (Gemini chunked it) | 'manual' (admin chunked it)
--   chunking_model   — which Gemini model was used (for reproducibility)
--   chunked_at       — when chunking completed
--   chunking_error   — if chunking failed, the error message
ALTER TABLE ai_kb_sources
  ADD COLUMN IF NOT EXISTS chunking_method TEXT,
  ADD COLUMN IF NOT EXISTS chunking_model TEXT,
  ADD COLUMN IF NOT EXISTS chunked_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS chunking_error TEXT;

-- ─── Phase 3: KB usage logging on assistant messages ────────────────────────
-- Tracks which KB entries were used for each assistant response. This lets
-- admins see "80% of answers used KB, 20% used AI training data" and which
-- specific entries were referenced (for analytics + debugging).
--
--   kb_hit               — TRUE if KB context was injected OR the search_knowledge_base
--                          tool was called. The headline "KB hit rate" metric.
--   kb_entries_used      — array of ai_kb_entries.id values that were injected
--                          into the prompt (NULL if none). Doesn't include
--                          entries returned by the tool call (those go back
--                          to the AI, not the route — we only log the tool
--                          was called via kb_search_performed).
--   kb_search_performed  — TRUE if the AI called the search_knowledge_base tool.
--   kb_context_injected  — TRUE if KB context was auto-injected into the prompt
--                          (pre-search, before the AI decides to call the tool).
--
-- The partial index on kb_hit = TRUE powers the admin "KB hit rate" dashboard
-- (queries the last 30 days of assistant messages).
ALTER TABLE ai_chat_messages
  ADD COLUMN IF NOT EXISTS kb_hit BOOLEAN,
  ADD COLUMN IF NOT EXISTS kb_entries_used INTEGER[],
  ADD COLUMN IF NOT EXISTS kb_search_performed BOOLEAN,
  ADD COLUMN IF NOT EXISTS kb_context_injected BOOLEAN;

-- Index for fast "KB hit rate" queries (admin dashboard). Partial index
-- keeps it small (only kb_hit = TRUE rows).
CREATE INDEX IF NOT EXISTS ai_chat_messages_kb_hit_idx
  ON ai_chat_messages (created_at DESC)
  WHERE kb_hit = TRUE;
`;

export async function ensureAiTables(): Promise<void> {
  try {
    await pool.query(MIGRATION_SQL);
    logger.info(
      "AI chat tables ensured (ai_chat_sessions, ai_chat_messages, ai_chat_events, v3.0 columns)",
    );

    // ─── Bug #3 fix: seed the v1.0.0 prompt with the ACTUAL prompt text ───
    // Previously the seed had a placeholder string and the route ignored
    // prompt_text. Now the route uses prompt_text as the PRIMARY source,
    // so the seed must contain the real template. We inject it via a
    // parameterized query (the MIGRATION_SQL template literal can't
    // safely contain the prompt text due to apostrophes + JS template
    // literal escaping). Using the SYSTEM_PROMPT_TEMPLATE_V1 constant
    // ensures the DB seed and the fallback always stay in sync — if
    // someone updates the constant in aiContext.ts, they should also
    // create a new DB version (v1.1.0) rather than mutating v1.0.0.
    try {
      const { SYSTEM_PROMPT_TEMPLATE_V1 } = await import("./aiContext");
      await pool.query(
        `INSERT INTO ai_prompt_versions (version, prompt_text, change_log, is_active, created_by)
         SELECT $1, $2, $3, TRUE, $4
         WHERE NOT EXISTS (SELECT 1 FROM ai_prompt_versions WHERE version = $1)`,
        [
          "1.0.0",
          SYSTEM_PROMPT_TEMPLATE_V1,
          "Initial version (mirrors SYSTEM_PROMPT_TEMPLATE_V1 from aiContext.ts). " +
            "Supports {{summary}} and {{catalog}} placeholders rendered by renderPromptTemplate().",
          "system",
        ],
      );
    } catch (seedErr) {
      // Non-fatal: the route will fall back to the hardcoded template
      // if the seed fails. Log for investigation.
      logger.warn({ err: seedErr }, "AI: failed to seed prompt v1.0.0 text (route will use fallback)");
    }

    // ─── Phase 1: Knowledge Base seed data ────────────────────────────────
    // Seed one default creator ("Manual") + three root categories so the
    // admin UI has something to show on first load. Idempotent via
    // WHERE NOT EXISTS — safe to re-run on every cold start. Wrap in a
    // try/catch so a seed failure never blocks server startup (the admin
    // can manually seed via the UI later).
    try {
      // Default "Manual" creator — used as the FK target for admin-typed
      // KB content that has no upstream source.
      await pool.query(
        `INSERT INTO ai_kb_creators (name, slug, source_type, profile_url)
         SELECT 'Manual', 'manual', 'manual', NULL
         WHERE NOT EXISTS (SELECT 1 FROM ai_kb_creators WHERE slug = 'manual')`,
      );

      // Root category: "Plant Care" (depth 0, path '/<id>/').
      await pool.query(
        `INSERT INTO ai_kb_categories (name, slug, description, path, depth)
         SELECT 'Plant Care', 'plant-care', 'General plant care guides', '/', 0
         WHERE NOT EXISTS (
           SELECT 1 FROM ai_kb_categories WHERE slug = 'plant-care' AND parent_id IS NULL
         )`,
      );

      // After the root insert, backfill its path to '/<id>/' (the INSERT
      // above uses a placeholder '/' because the id isn't known until
      // after the row exists). Idempotent — only touches rows whose path
      // is still the placeholder '/'.
      await pool.query(
        `UPDATE ai_kb_categories
           SET path = '/' || id || '/'
         WHERE parent_id IS NULL
           AND path = '/'`,
      );

      // Two child categories under "Plant Care" — "Pests & Diseases" and
      // "Gardening Tips". We look up the parent by slug+NULL parent_id
      // (the uniqueness invariant for roots), then build the child path
      // as '<parent.path><parent.id>/<child.id>/'. The INSERT uses a
      // placeholder path of '<parent.path><parent.id>/' (without the
      // child id); the backfill UPDATE below fixes it.
      await pool.query(
        `INSERT INTO ai_kb_categories (parent_id, name, slug, description, path, depth)
         SELECT
           p.id,
           'Pests & Diseases',
           'pests-diseases',
           'Common pests and diseases',
           p.path || p.id || '/',
           1
         FROM ai_kb_categories p
         WHERE p.slug = 'plant-care' AND p.parent_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM ai_kb_categories WHERE slug = 'pests-diseases'
           )`,
      );
      await pool.query(
        `INSERT INTO ai_kb_categories (parent_id, name, slug, description, path, depth)
         SELECT
           p.id,
           'Gardening Tips',
           'gardening-tips',
           'General gardening advice',
           p.path || p.id || '/',
           1
         FROM ai_kb_categories p
         WHERE p.slug = 'plant-care' AND p.parent_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM ai_kb_categories WHERE slug = 'gardening-tips'
           )`,
      );

      // Backfill child paths: append the child id + '/' to the parent's
      // path. The formula is `p.path || c.id || '/'` (NOT `p.path ||
      // p.id || '/' || c.id || '/'` — the parent's id is ALREADY the
      // last segment of p.path, so appending it again would double-count
      // and produce paths like `/1/1/2/` instead of `/1/2/`).
      //
      // The WHERE clause `c.path NOT LIKE '%/' || c.id || '/'` only
      // touches rows whose path doesn't end with `/<c.id>/` — i.e. the
      // placeholder path from the INSERT. Already-correct rows (whether
      // from a previous backfill or from createKbCategory) are skipped.
      // This makes the backfill idempotent + safe to re-run on every
      // cold start.
      await pool.query(
        `UPDATE ai_kb_categories c
           SET path = p.path || c.id || '/'
         FROM ai_kb_categories p
         WHERE c.parent_id = p.id
           AND c.depth = 1
           AND c.path NOT LIKE '%/' || c.id || '/'`,
      );
    } catch (kbSeedErr) {
      // Non-fatal — the admin can create categories manually via the UI.
      logger.warn({ err: kbSeedErr }, "AI: failed to seed KB default categories (admin can create them manually)");
    }
  } catch (err) {
    logger.error({ err }, "Failed to ensure AI chat tables");
    // Do NOT throw — same rationale as ensureConversationsTables: it's
    // better for the server to start and serve non-AI routes than to
    // crash entirely. The AI route will 500 on individual requests until
    // the DB issue is resolved.
  }
}
