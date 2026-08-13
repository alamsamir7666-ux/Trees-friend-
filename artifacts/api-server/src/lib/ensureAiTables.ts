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
CREATE TABLE IF NOT EXISTS ai_prompt_versions (
  id SERIAL PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,  -- semver: "1.0.0"
  prompt_text TEXT NOT NULL,
  change_log TEXT,               -- what changed in this version
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT,               -- admin email or "system"
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Seed v1.0.0 if the table is empty (the actual prompt text is loaded
-- by promptVersioning.ts from aiContext.ts's buildSystemPrompt fallback).
-- We insert a minimal row so getActivePrompt() has something to find.
INSERT INTO ai_prompt_versions (version, prompt_text, change_log, is_active, created_by)
SELECT '1.0.0', 'Use aiContext.ts buildSystemPrompt() fallback', 'Initial version (hardcoded in aiContext.ts)', TRUE, 'system'
WHERE NOT EXISTS (SELECT 1 FROM ai_prompt_versions WHERE version = '1.0.0');

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
`;

export async function ensureAiTables(): Promise<void> {
  try {
    await pool.query(MIGRATION_SQL);
    logger.info(
      "AI chat tables ensured (ai_chat_sessions, ai_chat_messages, ai_chat_events, v3.0 columns)",
    );
  } catch (err) {
    logger.error({ err }, "Failed to ensure AI chat tables");
    // Do NOT throw — same rationale as ensureConversationsTables: it's
    // better for the server to start and serve non-AI routes than to
    // crash entirely. The AI route will 500 on individual requests until
    // the DB issue is resolved.
  }
}
