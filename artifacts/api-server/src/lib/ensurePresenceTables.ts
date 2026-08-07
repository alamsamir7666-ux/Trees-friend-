/**
 * Ensures the `users` table has the `last_seen_at` column needed for
 * presence tracking (online/offline/last-seen status in chat).
 *
 * This is a startup migration that runs automatically when the API server
 * starts (and on Vercel cold start — see app.ts). It uses
 * `ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` so it is
 * safe to run multiple times (idempotent).
 *
 * Kept separate from ensureConversationsTables.ts because presence is a
 * users-table concern, not a conversations-table concern — but follows
 * the same self-bootstrapping pattern: the server should not depend on
 * a separate manual migration step for core features.
 *
 * The SQL here is intentionally identical to the one in
 * lib/db/src/schema/migration.sql — kept in code rather than read from
 * file so the bundled production build (esbuild) doesn't need to ship
 * .sql files.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";

const MIGRATION_SQL = `
-- ─── Presence tracking (online/offline/last seen) ─────────────────────────
-- Adds last_seen_at to the users table so the chat can show "Online" or
-- "last seen at <time>" next to each participant's name. Idempotent
-- (IF NOT EXISTS) so it's safe to run on every startup.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP;

-- Index for efficient "who is online" queries. Without this, any query
-- filtering on last_seen_at would scan the entire users table.
CREATE INDEX IF NOT EXISTS idx_users_last_seen_at
  ON users (last_seen_at DESC);
`;

export async function ensurePresenceTables(): Promise<void> {
  try {
    await pool.query(MIGRATION_SQL);
    logger.info("Users.last_seen_at column ensured (presence tracking)");
  } catch (err) {
    logger.error({ err }, "Failed to ensure presence tables");
    // Do NOT throw — the server should still start even if the migration
    // fails (e.g. the users table might not exist yet in a fresh DB).
    // The presence route will return 500 for individual requests, which
    // is better than the entire server crashing.
  }
}
