/**
 * v3.0 AI session TTL cleanup job.
 *
 * Problem:
 *   Anonymous chat sessions accumulate forever. A user who chats once and
 *   never returns leaves a session row + N message rows + (optionally)
 *   feedback rows in the database. Over months/years, this bloats the
 *   ai_chat_* tables and slows down admin queries.
 *
 * Solution:
 *   Delete anonymous sessions (user_id IS NULL) whose updated_at is older
 *   than AI_SESSION_TTL_DAYS (default: 30). CASCADE deletes the associated
 *   messages, feedback, and events.
 *
 * We DO NOT delete sessions tied to a user_id -- those are part of the
 * user's history and should persist (they may be referenced in future
 * logged-in features like "your past conversations").
 *
 * Idempotent + safe to run concurrently:
 *   - DELETE is idempotent (running twice does the same thing as once).
 *   - Postgres row-level locking prevents concurrent deletes from
 *     conflicting -- if two cron instances run at the same time, one
 *     deletes a batch and the other finds nothing to delete.
 *
 * Scheduling:
 *   Runs daily via the /api/cron/ai-session-cleanup endpoint. Configured
 *   in vercel.json. On Render (long-lived process), wired into the
 *   setInterval scheduler in src/index.ts.
 *
 * Config:
 *   AI_SESSION_TTL_DAYS -- env var, default 30. Sessions older than this
 *     (by updated_at) are eligible for deletion.
 *   AI_SESSION_CLEANUP_BATCH_SIZE -- env var, default 500. Max sessions
 *     deleted per run (prevents long-running transactions on large tables).
 */
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

const TTL_DAYS = Number(process.env.AI_SESSION_TTL_DAYS ?? 30);
const BATCH_SIZE = Number(process.env.AI_SESSION_CLEANUP_BATCH_SIZE ?? 500);

/**
 * Deletes stale anonymous AI chat sessions.
 *
 * @returns { deletedCount, cutoffDate } -- summary for logging/cron response.
 */
export async function runAiSessionCleanup(): Promise<{
  deletedCount: number;
  cutoffDate: string;
}> {
  try {
    // Compute the cutoff timestamp once.
    const cutoffResult = await pool.query<{ cutoff: Date }>(
      `SELECT NOW() - ($1 || ' days')::INTERVAL AS cutoff`,
      [String(TTL_DAYS)],
    );
    const cutoffDate = cutoffResult.rows[0].cutoff;

    // Delete anonymous sessions older than the cutoff.
    // user_id IS NULL = anonymous (we never delete logged-in users' sessions).
    // updated_at < cutoff = inactive for TTL_DAYS days.
    // ORDER BY updated_at LIMIT BATCH_SIZE = prevent long-running tx on huge tables.
    const result = await pool.query<{ id: number }>(
      `DELETE FROM ai_chat_sessions
       WHERE id IN (
         SELECT id FROM ai_chat_sessions
         WHERE user_id IS NULL
           AND updated_at < $1
         ORDER BY updated_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id`,
      [cutoffDate, BATCH_SIZE],
    );

    const deletedCount = result.rows.length;

    if (deletedCount > 0) {
      logger.info(
        { deletedCount, cutoffDate, ttlDays: TTL_DAYS, batchSize: BATCH_SIZE },
        "AI session cleanup: deleted stale anonymous sessions",
      );
    } else {
      logger.debug(
        { cutoffDate, ttlDays: TTL_DAYS },
        "AI session cleanup: no stale sessions to delete",
      );
    }

    return {
      deletedCount,
      cutoffDate: cutoffDate instanceof Date ? cutoffDate.toISOString() : String(cutoffDate),
    };
  } catch (err) {
    logger.error({ err }, "AI session cleanup job failed");
    return { deletedCount: 0, cutoffDate: "(error)" };
  }
}
