/**
 * KB embedding background job (Phase 2).
 *
 * Runs on an interval (every 30 seconds on long-lived Render processes)
 * to generate embeddings for entries with `embedding_status = 'pending'`.
 * On Vercel serverless, the same logic is triggered by the
 * `POST /api/cron/kb-embeddings` cron endpoint (see routes/cron.ts).
 *
 * Pattern: same as jobs/lowStockJob.ts + jobs/paymentExpirationJob.ts —
 * export a single `runKbEmbeddingJob` function that does one batch, and
 * let the scheduler (src/index.ts) call it on an interval.
 *
 * Why 30 seconds?
 *   - Short enough that entries get embedded quickly after creation
 *     (admin uploads a source, chunks it, creates entries — within
 *     30s the embeddings are ready for activation).
 *   - Long enough to avoid hammering Gemini's free-tier rate limit
 *     (1500 RPD = ~1 per minute average; 30s interval = 2 per minute
 *     peak, well within budget).
 *
 * Rate limit handling:
 *   If Gemini returns 429 (quota exhausted), the batch function stops
 *   processing further entries this run + returns `rateLimited: true`.
 *   The next run (30s later) will retry. Pending entries stay pending
 *   (they didn't fail, they just didn't get a chance).
 *
 * Concurrency:
 *   The job is designed to be idempotent + safe to run concurrently
 *   (e.g., if the cron endpoint fires while the interval job is mid-run).
 *   The `WHERE embedding_status = 'pending'` filter ensures each entry
 *   is processed at most once — once it's 'generated' or 'failed', the
 *   next run skips it. There's a small race window where two runs could
 *   fetch the same pending entries, but the second UPDATE is a no-op
 *   (it overwrites the same embedding with the same value). Acceptable.
 */
import { generateEmbeddingsForPendingEntries } from "../lib/kbEmbeddings";
import { logger } from "../lib/logger";

/**
 * Processes up to 10 pending entries per run.
 *
 * Logs the result for observability. Errors are caught + logged (the
 * job never throws — it's called from a setInterval that doesn't have
 * a try/catch wrapper).
 */
export async function runKbEmbeddingJob(): Promise<void> {
  try {
    const result = await generateEmbeddingsForPendingEntries(10);
    if (result.processed > 0) {
      logger.info(
        {
          processed: result.processed,
          succeeded: result.succeeded,
          failed: result.failed,
          rateLimited: result.rateLimited,
        },
        "KB embedding job: batch processed",
      );
    }
    if (result.rateLimited) {
      logger.warn("KB embedding job: rate limited by Gemini — will retry next run");
    }
  } catch (err) {
    logger.error({ err }, "KB embedding job: unexpected error");
  }
}
