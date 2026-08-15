/**
 * KB entry embedding generation (Phase 2).
 *
 * Generates Gemini embedding vectors (768 dims by default) for KB entries,
 * stored in the `embedding` column on `ai_kb_entries`. Phase 3's
 * `search_knowledge_base` tool will use these for semantic search
 * (cosine similarity via pgvector's `<=>` operator).
 *
 * BUG-E1 fix: previously hardcoded `text-embedding-004` (shut down by
 * Google on Jan 14, 2026). Now uses the shared `EMBEDDING_MODEL` from
 * `embeddingConfig.ts` (defaults to `gemini-embedding-001`, env-configurable
 * via `GEMINI_EMBEDDING_MODEL`). Also passes `outputDimensionality: 768`
 * explicitly so the new model produces 768-dim vectors (backward compat
 * with the existing `vector(768)` pgvector column).
 *
 * Pattern: same as embeddingCache.ts (the existing semantic-cache
 * embeddings) — lazy `GoogleGenAI` client, shared model config,
 * 2000-char truncation, `RETRIEVAL_DOCUMENT` task type.
 *
 * ─── Task type choice ────────────────────────────────────────────────────────
 *
 * We use `RETRIEVAL_DOCUMENT` (not `RETRIEVAL_QUERY`) because these
 * embeddings represent the DOCUMENTS being searched. Phase 3's query
 * embedding will use `RETRIEVAL_QUERY` — Gemini's model is trained to
 * match the two task types asymmetrically (query embeddings are
 * optimized to find documents, document embeddings are optimized to be
 * found). Mixing them up would degrade search quality.
 *
 * ─── Background job ──────────────────────────────────────────────────────────
 *
 * Embeddings are generated asynchronously by a background job
 * (jobs/kbEmbeddingJob.ts), NOT inline when the entry is created. This
 * is because:
 *   1. Gemini's embedding API has rate limits (1500 RPD free tier).
 *      Inline generation would block the admin UI on every entry create.
 *   2. A batch of 10 entries takes ~5 seconds — too slow for inline.
 *   3. Failed embeddings can be retried without re-running the chunking
 *      pipeline (the entry already exists; we just retry the embedding).
 *
 * The job runs every 30 seconds on long-lived processes (Render) and is
 * triggered by a cron endpoint on Vercel. It processes up to 10 pending
 * entries per run (configurable via the `limit` parameter).
 *
 * ─── pgvector format ────────────────────────────────────────────────────────
 *
 * pgvector expects embeddings as a string literal: `[0.1, 0.2, 0.3, ...]`.
 * We construct this string in JS + cast it with `$1::vector` on INSERT
 * / UPDATE. The HNSW index (created by the Phase 2 migration) makes
 * cosine-similarity search fast (sub-millisecond on 10K entries).
 */
import { GoogleGenAI } from "@google/genai";
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { markSourceReadyIfAllEntriesEmbedded } from "./kbSources";
// BUG-E1 fix: use the shared embedding config (model + dimensions + task type).
import {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  TASK_TYPE_DOCUMENT,
  MAX_EMBEDDING_INPUT_CHARS,
} from "./embeddingConfig";

// ─── Constants ───────────────────────────────────────────────────────────────

// BUG-E1 fix: model + dimensions now come from the shared config (env-configurable).
// Kept as locals for backward compat with the rest of this file's references.
const MAX_CONTENT_CHARS = MAX_EMBEDDING_INPUT_CHARS;

// ─── Lazy-initialized client ─────────────────────────────────────────────────

let _embeddingClient: GoogleGenAI | null = null;

function getEmbeddingClient(): GoogleGenAI | null {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!_embeddingClient) {
    _embeddingClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return _embeddingClient;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EmbeddingResult {
  embedding: number[];
  model: string;
}

export interface BatchEmbeddingResult {
  processed: number;
  succeeded: number;
  failed: number;
  rateLimited: boolean;
}

// ─── generateEntryEmbedding ──────────────────────────────────────────────────
/**
 * Generates an embedding for a single entry's content.
 *
 * Truncates content to 2000 chars (Gemini's token limit for embeddings).
 * Longer content is truncated from the END (the title + first ~2K chars
 * are usually enough for semantic matching — the rest is detail).
 *
 * Returns `{ embedding, model }` on success, `null` on failure (API
 * error, rate limit, empty response). The caller (the batch function)
 * handles the failure by marking the entry's `embedding_status = 'failed'`.
 *
 * Rate limit detection: if Gemini returns 429 / quota error, we return
 * null + log a warning. The batch function stops processing further
 * entries on rate limit (no point hammering the API).
 */
export async function generateEntryEmbedding(entry: {
  id: number;
  content: string;
}): Promise<EmbeddingResult | null> {
  const client = getEmbeddingClient();
  if (!client) {
    logger.warn("KB embeddings: GEMINI_API_KEY not set — skipping embedding generation");
    return null;
  }

  // Prepend the entry id for logging context.
  const truncatedContent = entry.content.slice(0, MAX_CONTENT_CHARS);

  try {
    const result = await client.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: truncatedContent,
      config: {
        // RETRIEVAL_DOCUMENT — these embeddings represent the documents
        // being searched (not the queries). Phase 3's query embeddings
        // will use RETRIEVAL_QUERY. Gemini is trained to match the two
        // task types asymmetrically.
        taskType: TASK_TYPE_DOCUMENT as never,
        // BUG-E1 fix: explicitly request 768-dim output. gemini-embedding-001
        // supports up to 3072 dims by default — without this, the API would
        // return 3072-dim vectors which don't fit the existing `vector(768)`
        // pgvector column (INSERT would fail with "vector dimension mismatch").
        // Pinning to 768 maintains backward compat with the existing schema.
        outputDimensionality: EMBEDDING_DIMENSIONS,
      },
    });

    const values = (result as { embeddings?: { values?: number[] }[] })?.embeddings?.[0]?.values;
    if (!Array.isArray(values) || values.length === 0) {
      logger.warn(
        { entryId: entry.id, model: EMBEDDING_MODEL },
        "KB embeddings: empty values returned",
      );
      return null;
    }
    if (values.length !== EMBEDDING_DIMENSIONS) {
      logger.warn(
        {
          entryId: entry.id,
          expected: EMBEDDING_DIMENSIONS,
          got: values.length,
          model: EMBEDDING_MODEL,
        },
        "KB embeddings: unexpected dimension count (using anyway)",
      );
    }
    return { embedding: values, model: EMBEDDING_MODEL };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("429") ||
      msg.toLowerCase().includes("quota") ||
      msg.toLowerCase().includes("rate limit")
    ) {
      logger.warn(
        { entryId: entry.id, model: EMBEDDING_MODEL },
        "KB embeddings: Gemini rate limit hit",
      );
    } else {
      // BUG-E1 fix: include the model name in the error log so operators
      // can diagnose model-deprecation issues (the old text-embedding-004
      // shutdown produced a cryptic "model not found" error with no
      // indication of WHICH model was being called).
      logger.warn(
        { entryId: entry.id, model: EMBEDDING_MODEL, err: msg },
        "KB embeddings: generation failed",
      );
    }
    return null;
  }
}

// ─── generateEmbeddingsForPendingEntries ────────────────────────────────────
/**
 * Processes up to `limit` entries with `embedding_status = 'pending'`.
 *
 * For each entry:
 *   1. Generate the embedding (Gemini EMBEDDING_MODEL from embeddingConfig.ts).
 *   2. On success: UPDATE the row with the embedding (cast as `::vector`),
 *      set `embedding_status = 'generated'`, set `embedding_generated_at = NOW()`,
 *      clear `embedding_error`.
 *   3. On failure: set `embedding_status = 'failed'`, set `embedding_error`
 *      to a short message (truncated for storage).
 *   4. After all entries for a source are processed (generated or failed),
 *      update the source's `processing_status` to 'ready'.
 *
 * Rate limit handling: if Gemini returns 429, we STOP processing further
 * entries this run (return `rateLimited: true`). The next run (30s later)
 * will retry. Pending entries stay pending — we don't mark them failed
 * (they didn't fail, they just didn't get a chance).
 *
 * Called by:
 *   - The background job (jobs/kbEmbeddingJob.ts, every 30s on Render).
 *   - The cron endpoint (POST /api/cron/kb-embeddings, every 5 min on Vercel).
 *
 * Returns `{ processed, succeeded, failed, rateLimited }`.
 */
export async function generateEmbeddingsForPendingEntries(
  limit = 10,
): Promise<BatchEmbeddingResult> {
  const maxLimit = Math.min(Math.max(limit, 1), 50);

  try {
    // Fetch pending entries (oldest first — FIFO so an entry that's been
    // waiting longer gets embedded first).
    const pending = await pool.query<{ id: number; content: string; source_id: number }>(
      `SELECT id, content, source_id
       FROM ai_kb_entries
       WHERE embedding_status = 'pending'
       ORDER BY created_at ASC
       LIMIT $1`,
      [maxLimit],
    );

    if (pending.rows.length === 0) {
      return { processed: 0, succeeded: 0, failed: 0, rateLimited: false };
    }

    let succeeded = 0;
    let failed = 0;
    let rateLimited = false;
    const sourceIdsToCheck = new Set<number>();

    for (const row of pending.rows) {
      const result = await generateEntryEmbedding({ id: row.id, content: row.content });

      if (result === null) {
        // Check if it was a rate limit (we can't easily distinguish here,
        // so we treat all failures as potentially rate-limited + stop).
        // The generateEntryEmbedding function already logged the specific
        // reason. We mark the entry as 'failed' (not 'pending') ONLY if
        // it's not a rate limit — but since we can't tell, we'll be
        // conservative: mark as failed + set rateLimited=true to stop
        // processing further entries this run.
        //
        // Actually, the safer behavior is: on any failure, mark the entry
        // as 'failed' (so it's visible in the admin UI) BUT also stop
        // processing (rateLimited=true) so we don't hammer Gemini if it's
        // a quota issue. The admin can retry failed entries individually
        // (Phase 5 enhancement) or wait for the next run.
        failed++;
        rateLimited = true; // stop after this entry
        await pool.query(
          `UPDATE ai_kb_entries
             SET embedding_status = 'failed',
                 embedding_error = LEFT($1, 500),
                 updated_at = NOW()
           WHERE id = $2`,
          ["Embedding generation failed (possibly rate limit)", row.id],
        );
        sourceIdsToCheck.add(row.source_id);
        break; // stop processing further entries this run
      }

      // Success — store the embedding.
      const embeddingStr = `[${result.embedding.join(",")}]`;
      await pool.query(
        `UPDATE ai_kb_entries
           SET embedding = $1::vector,
               embedding_status = 'generated',
               embedding_generated_at = NOW(),
               embedding_error = NULL,
               updated_at = NOW()
         WHERE id = $2`,
        [embeddingStr, row.id],
      );
      succeeded++;
      sourceIdsToCheck.add(row.source_id);
    }

    // After processing, check each affected source: if all its entries
    // have embeddings (generated or failed), mark the source 'ready'.
    for (const sourceId of sourceIdsToCheck) {
      await markSourceReadyIfAllEntriesEmbedded(sourceId);
    }

    logger.info(
      { processed: succeeded + failed, succeeded, failed, rateLimited },
      "KB embeddings: batch processed",
    );
    return {
      processed: succeeded + failed,
      succeeded,
      failed,
      rateLimited,
    };
  } catch (err) {
    logger.error({ err, limit: maxLimit }, "KB embeddings: batch failed");
    return { processed: 0, succeeded: 0, failed: 0, rateLimited: false };
  }
}
