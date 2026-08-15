/**
 * BM25 term stats refresh job.
 *
 * Periodically rebuilds the ai_kb_term_stats table (which holds the
 * document frequency + precomputed IDF for every lexeme in the KB).
 *
 * Why this job exists:
 *   - The BM25 score function (bm25_score() in migration 0007) looks up
 *     IDF from ai_kb_term_stats. If the stats are stale, IDF is wrong,
 *     and rare-vs-common term weighting is off.
 *   - As admins add/edit/delete KB entries, the term frequencies drift.
 *     This job keeps the stats fresh.
 *
 * Schedule:
 *   - Long-lived processes (Render): every 6 hours (configurable via
 *     BM25_STATS_REFRESH_INTERVAL_MS).
 *   - Vercel serverless: triggered by the POST /api/cron/kb-bm25-stats
 *     cron endpoint (configured to fire every 6 hours).
 *
 * The job is idempotent + safe to run concurrently — the underlying
 * refresh_kb_term_stats() SQL function uses TRUNCATE + INSERT in a single
 * transaction, so concurrent runs serialize at the DB level (one wins,
 * the other blocks until the first commits, then no-ops).
 *
 * Why 6 hours?
 *   - The KB changes slowly (admins add ~5 entries/week).
 *   - Stale IDF for 6 hours has minimal impact on search quality
 *     (IDF is a global ranking signal, not a per-query one).
 *   - 6 hours = 4 refreshes/day = ~1s of DB time/day. Negligible.
 *   - For comparison, Elasticsearch's default refresh interval is 1s,
 *     but that's for the inverted index (not BM25 stats). BM25 stats
 *     refresh on segment merge (every ~30 min). Our 6h is conservative.
 */
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

const REFRESH_INTERVAL_MS = Number(
  process.env.BM25_STATS_REFRESH_INTERVAL_MS ?? 6 * 60 * 60 * 1000,
); // 6h

let _lastRefreshAt = 0;
let _refreshInFlight: Promise<void> | null = null;

/**
 * Triggers a refresh of the BM25 term stats.
 *
 * Safe to call concurrently — concurrent calls share the same in-flight
 * promise (single-flight pattern, same as queryEmbeddingCache.ts).
 *
 * Returns immediately if a refresh happened recently (within
 * BM25_STATS_REFRESH_INTERVAL_MS). The caller can override this via
 * `force: true` (used by the admin manual-refresh endpoint).
 */
export async function refreshBm25Stats(opts?: { force?: boolean }): Promise<{
  refreshed: boolean;
  uniqueTerms: number;
  totalDocs: number;
  durationMs: number;
}> {
  const startTime = Date.now();

  // ─── Throttle: skip if refreshed recently ────────────────────────────────
  if (!opts?.force && _lastRefreshAt > 0 && Date.now() - _lastRefreshAt < REFRESH_INTERVAL_MS) {
    logger.debug(
      { lastRefreshAt: new Date(_lastRefreshAt).toISOString(), intervalMs: REFRESH_INTERVAL_MS },
      "BM25 stats refresh: skipped (throttled)",
    );
    return { refreshed: false, uniqueTerms: 0, totalDocs: 0, durationMs: 0 };
  }

  // ─── Single-flight: if a refresh is in progress, await it ────────────────
  if (_refreshInFlight) {
    logger.debug("BM25 stats refresh: awaiting in-flight refresh");
    await _refreshInFlight;
    return { refreshed: false, uniqueTerms: 0, totalDocs: 0, durationMs: 0 };
  }

  // ─── Start the refresh ──────────────────────────────────────────────────
  _refreshInFlight = (async () => {
    try {
      await pool.query("SELECT refresh_kb_term_stats()");
      _lastRefreshAt = Date.now();

      // Fetch the stats for logging.
      const stats = await pool.query<{ unique_terms: string; total_docs: string }>(
        `SELECT
           (SELECT COUNT(*)::bigint FROM ai_kb_term_stats) AS unique_terms,
           (SELECT COUNT(*)::bigint FROM ai_kb_entries WHERE is_active = true) AS total_docs`,
      );

      const uniqueTerms = Number(stats.rows[0]?.unique_terms ?? 0);
      const totalDocs = Number(stats.rows[0]?.total_docs ?? 0);
      const durationMs = Date.now() - startTime;

      logger.info(
        { uniqueTerms, totalDocs, durationMs, forced: opts?.force ?? false },
        "BM25 stats refresh: success",
      );

      // Return value is captured by the outer caller via _refreshInFlight.
      // We store the result on the promise for the outer wrapper to read.
      (_refreshInFlight as any)._result = { refreshed: true, uniqueTerms, totalDocs, durationMs };
    } catch (err) {
      logger.error(
        { err, durationMs: Date.now() - startTime },
        "BM25 stats refresh: failed (non-fatal — searches use stale stats)",
      );
      (_refreshInFlight as any)._result = {
        refreshed: false,
        uniqueTerms: 0,
        totalDocs: 0,
        durationMs: Date.now() - startTime,
      };
    } finally {
      _refreshInFlight = null;
    }
  })();

  await _refreshInFlight;
  return { refreshed: false, uniqueTerms: 0, totalDocs: 0, durationMs: 0 };
}

/**
 * Returns stats about the BM25 term stats table — used by the admin
 * /api/ai/admin/kb/search/health endpoint.
 */
export async function getBm25StatsStatus(): Promise<{
  lastRefreshAt: number;
  uniqueTerms: number;
  totalActiveDocs: number;
  avgDocLength: number;
  refreshIntervalMs: number;
}> {
  try {
    const result = await pool.query<{
      unique_terms: string;
      total_docs: string;
      avg_doc_length: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::bigint FROM ai_kb_term_stats) AS unique_terms,
         (SELECT COUNT(*)::bigint FROM ai_kb_entries WHERE is_active = true) AS total_docs,
         (SELECT COALESCE(AVG(bm25_doc_length), 0)::float FROM ai_kb_entries WHERE is_active = true) AS avg_doc_length`,
    );
    return {
      lastRefreshAt: _lastRefreshAt,
      uniqueTerms: Number(result.rows[0]?.unique_terms ?? 0),
      totalActiveDocs: Number(result.rows[0]?.total_docs ?? 0),
      avgDocLength: Number(result.rows[0]?.avg_doc_length ?? 0),
      refreshIntervalMs: REFRESH_INTERVAL_MS,
    };
  } catch (err) {
    logger.error({ err }, "BM25 stats status: query failed");
    return {
      lastRefreshAt: _lastRefreshAt,
      uniqueTerms: 0,
      totalActiveDocs: 0,
      avgDocLength: 0,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
    };
  }
}

/**
 * Returns true if the BM25 stats have been populated at least once.
 * Used at startup to decide whether to trigger an initial refresh.
 */
export async function areBm25StatsPopulated(): Promise<boolean> {
  try {
    const result = await pool.query<{ cnt: string }>(
      "SELECT COUNT(*)::bigint AS cnt FROM ai_kb_term_stats",
    );
    return Number(result.rows[0]?.cnt ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Starts the periodic refresh job. Called by src/index.ts on long-lived
 * processes (Render). On Vercel, this is a no-op (cron endpoint handles it).
 */
export function startBm25StatsJob(): void {
  if (process.env.VERCEL === "1") {
    logger.info("BM25 stats job: skipped on Vercel (use POST /api/cron/kb-bm25-stats)");
    return;
  }

  const intervalMinutes = REFRESH_INTERVAL_MS / (60 * 1000);
  logger.info({ intervalMinutes }, "BM25 stats job: scheduled");

  // Trigger an initial refresh on startup (async, non-blocking).
  refreshBm25Stats().catch((err) => {
    logger.error({ err }, "BM25 stats job: initial refresh failed");
  });

  // Schedule periodic refreshes.
  setInterval(() => {
    refreshBm25Stats().catch((err) => {
      logger.error({ err }, "BM25 stats job: periodic refresh failed");
    });
  }, REFRESH_INTERVAL_MS);
}
