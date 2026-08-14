/**
 * KB tone profile background job (Phase 4).
 *
 * Runs on an interval (every 5 minutes on long-lived Render processes)
 * to generate + regenerate creator tone profiles. On Vercel serverless,
 * the same logic is triggered by the `POST /api/cron/kb-tone-profiles`
 * cron endpoint (see routes/cron.ts).
 *
 * Pattern: same as jobs/kbEmbeddingJob.ts — export a single
 * `runKbToneProfileJob` function that does one batch, and let the
 * scheduler (src/index.ts) call it on an interval.
 *
 * Why 5 minutes?
 *   - Tone profiles aren't urgent (they affect response tone, not
 *     correctness). 5 min latency is fine.
 *   - Long enough to avoid hammering Gemini's free-tier rate limit
 *     (1500 RPD = ~1 per minute average; 5 min interval with 3 creators
 *     per run = ~1 call per minute peak, well within budget).
 *
 * Why max 3 creators per run?
 *   - Avoids Gemini rate limits. Each profile generation is one
 *     `generateContent` call (~2-5 seconds). 3 calls per 5 min = ~1
 *     call per 100 seconds — very conservative.
 *   - If more than 3 creators need profiles, they're processed on the
 *     next run (5 min later). Creators are ordered by entry_count DESC,
 *     so the most prolific (most impactful) creators are processed first.
 *
 * Rate limit handling:
 *   - If Gemini returns 429 (quota exhausted), `generateToneProfile`
 *     returns `{ success: false, reason: "Gemini rate limit hit" }`.
 *     The job stops processing further creators this run + logs a warning.
 *     The next run (5 min later) will retry.
 *
 * Concurrency:
 *   - The job is idempotent + safe to run concurrently. If a profile is
 *     generated twice (e.g., interval + cron fire at the same time), the
 *     second UPDATE overwrites the first with the same value (the entries
 *     haven't changed). Acceptable.
 */
import { getCreatorsNeedingToneProfiles, generateToneProfile } from "../lib/kbToneProfiles";
import { logger } from "../lib/logger";

const MAX_CREATORS_PER_RUN = 3;

/**
 * Processes up to 3 creators needing new/regenerated tone profiles.
 *
 * Logs the result for observability. Errors are caught + logged (the
 * job never throws — it's called from a setInterval that doesn't have
 * a try/catch wrapper).
 *
 * Returns counts for the cron endpoint to report.
 */
export async function runKbToneProfileJob(): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
  rateLimited: boolean;
}> {
  try {
    const creators = await getCreatorsNeedingToneProfiles();
    if (creators.length === 0) {
      return { processed: 0, succeeded: 0, failed: 0, rateLimited: false };
    }

    // Process up to MAX_CREATORS_PER_RUN (most prolific first — they're
    // ordered by entry_count DESC in the SQL query).
    const toProcess = creators.slice(0, MAX_CREATORS_PER_RUN);
    logger.info(
      { totalNeeding: creators.length, processing: toProcess.length },
      "KB tone job: starting batch",
    );

    let succeeded = 0;
    let failed = 0;
    let rateLimited = false;

    for (const creator of toProcess) {
      const result = await generateToneProfile(creator.id);
      if (result.success) {
        succeeded++;
        logger.info(
          { creatorId: creator.id, creatorName: creator.name, entryCount: creator.entryCount },
          "KB tone job: profile generated",
        );
      } else {
        failed++;
        // Check if it was a rate limit — if so, stop processing further
        // creators this run (no point hammering Gemini).
        if (result.reason === "Gemini rate limit hit") {
          rateLimited = true;
          logger.warn(
            { creatorId: creator.id, creatorName: creator.name },
            "KB tone job: rate limited, stopping batch",
          );
          break;
        }
        logger.warn(
          { creatorId: creator.id, creatorName: creator.name, reason: result.reason },
          "KB tone job: generation failed (continuing)",
        );
      }
    }

    logger.info(
      { processed: succeeded + failed, succeeded, failed, rateLimited },
      "KB tone job: batch complete",
    );

    return {
      processed: succeeded + failed,
      succeeded,
      failed,
      rateLimited,
    };
  } catch (err) {
    logger.error({ err }, "KB tone job: unexpected error");
    return { processed: 0, succeeded: 0, failed: 0, rateLimited: false };
  }
}
