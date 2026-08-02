/**
 * Ensures the `conversations` and `messages` tables exist in the database
 * AND that the `messages` table has all attachment-related columns.
 *
 * This is a startup migration that runs automatically when the API server
 * starts (and on Vercel cold start — see app.ts). It uses `CREATE TABLE IF
 * NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `ADD COLUMN IF NOT EXISTS`
 * so it is safe to run multiple times (idempotent).
 *
 * Industry-standard pattern: the server should be self-bootstrapping and not
 * depend on a separate manual migration step for core features. This is the
 * same approach used by large-scale apps (Shopify, Stripe) where each service
 * owns its schema and ensures it on startup.
 *
 * The SQL here is intentionally identical to the one in
 * lib/db/src/schema/migration.sql — kept in code rather than read from file
 * so the bundled production build (esbuild) doesn't need to ship .sql files.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";

const MIGRATION_SQL = `
-- ─── Buyer-Seller Messaging ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  buyer_id TEXT NOT NULL,
  seller_id INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  seller_listing_id INTEGER,
  last_message_at TIMESTAMP NOT NULL DEFAULT NOW(),
  buyer_archived BOOLEAN NOT NULL DEFAULT FALSE,
  seller_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS conversations_buyer_seller_unique
  ON conversations (buyer_id, seller_id);

CREATE INDEX IF NOT EXISTS conversations_buyer_last_msg_idx
  ON conversations (buyer_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversations_seller_last_msg_idx
  ON conversations (seller_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  image_url TEXT,
  read_by_buyer BOOLEAN NOT NULL DEFAULT FALSE,
  read_by_seller BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_conversation_id_idx
  ON messages (conversation_id, created_at);

-- ─── Attachment columns (emoji + file attachment phase) ───────────────────
-- These ALTER statements are idempotent (IF NOT EXISTS) so they're safe to
-- run on every startup, regardless of whether the columns already exist.
-- This is what fixes the production "500 on GET /conversations" bug — the
-- base CREATE TABLE above only creates the original schema, but the route
-- code SELECTs these new columns. Without this ALTER, Postgres throws
-- "column \"file_url\" does not exist" → 500.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS file_url TEXT,
  ADD COLUMN IF NOT EXISTS file_name TEXT,
  ADD COLUMN IF NOT EXISTS file_size BIGINT,
  ADD COLUMN IF NOT EXISTS file_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS attachment_type TEXT;

-- Backfill attachment_type for legacy image messages so the new UI renders
-- them as inline images instead of text bubbles. Idempotent — the
-- attachment_type IS NULL guard ensures it only updates each row once.
UPDATE messages
  SET attachment_type = 'image',
      file_url = image_url
  WHERE message_type = 'image'
    AND image_url IS NOT NULL
    AND attachment_type IS NULL;

-- Index for efficient pagination/sorting by conversation.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
  ON messages (conversation_id, created_at DESC);
`;

export async function ensureConversationsTables(): Promise<void> {
  try {
    await pool.query(MIGRATION_SQL);
    logger.info("Conversations & messages tables ensured (incl. attachment columns)");
  } catch (err) {
    logger.error({ err }, "Failed to ensure conversations tables");
    // Do NOT throw — the server should still start even if the migration
    // fails (e.g. the sellers table might not exist yet in a fresh DB).
    // The conversations route will return 500 for individual requests,
    // which is better than the entire server crashing.
  }
}
