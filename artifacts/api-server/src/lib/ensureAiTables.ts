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
`;

export async function ensureAiTables(): Promise<void> {
  try {
    await pool.query(MIGRATION_SQL);
    logger.info("AI chat tables ensured (ai_chat_sessions, ai_chat_messages)");
  } catch (err) {
    logger.error({ err }, "Failed to ensure AI chat tables");
    // Do NOT throw — same rationale as ensureConversationsTables: it's
    // better for the server to start and serve non-AI routes than to
    // crash entirely. The AI route will 500 on individual requests until
    // the DB issue is resolved.
  }
}
