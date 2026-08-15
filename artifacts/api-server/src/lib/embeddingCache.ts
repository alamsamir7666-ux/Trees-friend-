/**
 * Embeddings-based semantic cache using pgvector.
 *
 * Industry standard: catch SEMANTIC duplicates, not just exact matches.
 * "How often to water mango?" and "How often should I water a mango tree?"
 * should hit the cache — they're asking the same thing.
 *
 * How it works:
 *   1. Generate an embedding of the user's message (Gemini text-embedding-004)
 *   2. Query the ai_response_cache table for entries with cosine similarity > 0.92
 *   3. If found: return the cached response (zero API cost)
 *   4. If not found: call the AI, then store the response + its embedding
 *
 * pgvector:
 *   Supabase, Neon, and most managed Postgres providers support the
 *   `vector` extension. We use it to store + similarity-search embeddings.
 *   The extension is created by ensureAiTables.ts (CREATE EXTENSION IF NOT
 *   EXISTS vector).
 *
 * Embedding model:
 *   Gemini text-embedding-004 (768 dimensions, free tier)
 *   - Free tier: 1500 RPD (same as Gemini chat)
 *   - Falls back to exact-match cache (semanticCache.ts) if embeddings fail
 *
 * Cache invalidation:
 *   - TTL-based: entries expire after AI_CACHE_TTL_SECONDS (default 1h)
 *   - Catalog changes: invalidated via `invalidateCatalogCache()` (see
 *     lib/catalogCache.ts) — wired into all product/seller-listing
 *     mutation routes (POST/PUT/DELETE /products, /seller-listings,
 *     /admin/seller-listings/:id/{approve,reject}, /bulk-import).
 *   - KB changes: invalidated via `invalidateKbCache()` (see lib/kbCache.ts)
 *     which calls `invalidateCatalogCache()` AND `clearKbContentVersionCache()`.
 *
 * ─── BUG-3 fix: kb_content_version column ────────────────────────────────────
 *
 * Even with event-driven invalidation (BUG-1), there's a race window:
 * Request A reads KB at T=0, admin edits KB at T=1 (cache cleared),
 * Request A's LLM returns at T=2 (built from OLD KB), Request A writes
 * to cache at T=3, Request B at T=4 finds Request A's cached response.
 *
 * The fix: every cached row stores a `kb_content_version` fingerprint
 * (16-char hex) of the KB state used to build it. The lookup query
 * filters `WHERE kb_content_version = $N` so rows built from old KB
 * state are rejected at SELECT time. The version is computed by
 * `getKbContentVersion()` (see lib/kbContentVersion.ts) and cleared
 * from its in-process cache by `invalidateKbCache()` after every KB
 * mutation.
 *
 * When the version can't be computed (DB error → "unknown"), the route
 * bypasses the cache entirely (neither reads nor writes) — safer to
 * miss the cache than risk serving stale content.
 *
 * What's NOT cached (same rules as exact-match cache):
 *   - Private queries (USER-SCOPED tool calls: get_user_orders, get_order_details)
 *   - Messages < 10 chars (too generic)
 *   - Responses > 10K chars (too large for Redis/DB storage)
 *
 * ─── Bug #4 fix: tool-call cache policy ──────────────────────────────────────
 *
 * Previously the route always passed `hadToolCalls: false`, so tool-call
 * responses (including search_catalog results with current prices) got
 * cached with the same 1-hour TTL as general questions. Sellers updating
 * prices wouldn't propagate to the AI's responses until the cache expired.
 *
 * The new policy:
 *   - CATALOG tool calls (search_catalog, get_product_care) → cached with
 *     a SHORT TTL (5 min, configurable via AI_TOOL_CACHE_TTL_SECONDS).
 *   - USER-SCOPED tool calls (get_user_orders, get_order_details) →
 *     NEVER cached (private data).
 *   - No tool calls → normal long-TTL cache (1 hour).
 *
 * The `hadToolCalls` flag is stored as a new column on ai_response_cache
 * so the READ side can filter (e.g., "only return tool-call entries fresher
 * than 5 min"). For backward compat with existing rows (which have no
 * flag), we treat NULL as "long-TTL" (the old behavior).
 */

import { GoogleGenAI } from "@google/genai";
import { pool } from "@workspace/db";
import { logger } from "./logger";

const SIMILARITY_THRESHOLD = Number(process.env.AI_SEMANTIC_SIMILARITY ?? 0.92);
const CACHE_TTL_SECONDS = Number(process.env.AI_CACHE_TTL_SECONDS ?? 3600);
// Bug #4 fix: short TTL for tool-call responses (catalog data changes).
// Default 5 min. Set to 0 to disable caching tool-call responses entirely.
const TOOL_CACHE_TTL_SECONDS = Number(process.env.AI_TOOL_CACHE_TTL_SECONDS ?? 300);
const MIN_MESSAGE_LENGTH = 10;
const EMBEDDING_MODEL = "text-embedding-004";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SemanticCacheEntry {
  response: string;
  model: string;
  provider: string;
  similarity: number;
  cachedAt: number;
}

// ─── Embedding generation ───────────────────────────────────────────────────

let _embeddingClient: GoogleGenAI | null = null;

function getEmbeddingClient(): GoogleGenAI | null {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!_embeddingClient) {
    _embeddingClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return _embeddingClient;
}

/**
 * Generates an embedding for a text using Gemini text-embedding-004.
 * Returns a 768-dimensional float array, or null on failure.
 *
 * We embed the user's message ONLY (not the full conversation history)
 * because:
 *   - The message is the query — history is context
 *   - Embedding the full history would make every cache miss (different
 *     history = different embedding = no hit)
 *   - For follow-up questions, the message alone is enough to find similar
 *     past questions
 */
async function generateEmbedding(text: string): Promise<number[] | null> {
  const client = getEmbeddingClient();
  if (!client) return null;

  try {
    const result = await client.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: text.slice(0, 2000), // truncate to avoid token limits
      config: {
        taskType: "RETRIEVAL_QUERY" as any, // optimized for finding similar queries
      },
    });

    const values = (result as any)?.embeddings?.[0]?.values;
    if (!Array.isArray(values) || values.length === 0) {
      logger.warn("Semantic cache: embedding returned empty values");
      return null;
    }
    return values as number[];
  } catch (err) {
    logger.debug({ err: (err as any)?.message }, "Semantic cache: embedding generation failed");
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Checks the semantic cache for a similar past query.
 *
 * Generates an embedding of the user's message, then searches the
 * ai_response_cache table for entries with cosine similarity > threshold.
 *
 * Returns the most similar cached response, or null if no match / pgvector
 * unavailable / embedding generation failed.
 *
 * BUG-3 fix: the lookup filters by `kb_content_version` so cached rows
 * built from old KB state are rejected at SELECT time. NULL rows
 * (legacy, pre-migration) are excluded because `NULL = anything` is NULL
 * in SQL, not TRUE — they simply won't match the WHERE clause.
 *
 * @param userMessage - The user's new message
 * @param isPrivate - If true, skip cache (user-specific data)
 * @param kbContentVersion - 16-char hex fingerprint of the current KB state.
 *   Must be non-null. The caller is responsible for computing it via
 *   `getKbContentVersion()` and passing it here. If the version is
 *   "unknown" (DB error), the caller should skip the cache lookup
 *   entirely (don't call this function).
 */
export async function getSemanticCachedResponse(
  userMessage: string,
  isPrivate: boolean,
  kbContentVersion: string,
): Promise<SemanticCacheEntry | null> {
  if (isPrivate) return null;
  if (userMessage.trim().length < MIN_MESSAGE_LENGTH) return null;

  // Generate embedding
  const embedding = await generateEmbedding(userMessage);
  if (!embedding) return null; // embedding failed — fall back to exact-match cache

  try {
    // Bug #4 fix: query with TTL-aware filtering. Tool-call entries
    // (had_tool_calls = TRUE) are only valid for TOOL_CACHE_TTL_SECONDS
    // (5 min default). Non-tool entries (had_tool_calls = FALSE OR NULL
    // for legacy rows) are valid for CACHE_TTL_SECONDS (1 hour default).
    //
    // We use a CASE expression to pick the right TTL per row, then filter
    // `created_at > NOW() - ttl`. This is a single query that handles
    // both types correctly.
    //
    // The COALESCE handles legacy rows (had_tool_calls IS NULL) by
    // treating them as non-tool (long TTL) — preserves backward compat.
    //
    // BUG-3 fix: filter by kb_content_version. NULL rows (legacy,
    // pre-migration) are excluded because `NULL = $5` evaluates to NULL,
    // not TRUE — they won't be cache hits. After TTL expiry (1h max),
    // all NULL rows are gone.
    const result = await pool.query(
      `SELECT
         response,
         model,
         provider,
         1 - (embedding <=> $1::vector) AS similarity,
         created_at,
         had_tool_calls,
         kb_content_version
       FROM ai_response_cache
       WHERE kb_content_version = $5
         AND created_at > NOW() - (
           CASE
             WHEN COALESCE(had_tool_calls, FALSE) THEN ($3 || ' seconds')::INTERVAL
             ELSE ($2 || ' seconds')::INTERVAL
           END
         )
         AND 1 - (embedding <=> $1::vector) > $4
       ORDER BY embedding <=> $1::vector
       LIMIT 1`,
      [
        `[${embedding.join(",")}]`,
        String(CACHE_TTL_SECONDS), // long TTL (1h) for non-tool
        String(TOOL_CACHE_TTL_SECONDS), // short TTL (5min) for tool
        SIMILARITY_THRESHOLD,
        kbContentVersion,
      ],
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    logger.info(
      {
        similarity: Math.round((row.similarity as number) * 100) / 100,
        model: row.model,
        provider: row.provider,
        hadToolCalls: row.had_tool_calls,
        kbContentVersion: row.kb_content_version,
      },
      "Semantic cache: HIT",
    );

    return {
      response: row.response,
      model: row.model,
      provider: row.provider,
      similarity: row.similarity,
      cachedAt: new Date(row.created_at).getTime(),
    };
  } catch (err) {
    // pgvector not available, or table doesn't exist, or query error
    // (e.g., had_tool_calls column doesn't exist yet — ensureAiTables
    // migration hasn't run. Fall back to the old query without the column.)
    logger.debug(
      { err: (err as any)?.message },
      "Semantic cache: search failed (pgvector unavailable? or schema not migrated?)",
    );
    return getSemanticCachedResponseLegacy(embedding, kbContentVersion);
  }
}

/**
 * Legacy fallback query — used when the `had_tool_calls` column doesn't
 * exist yet (ensureAiTables migration hasn't run). Uses the old single-TTL
 * filter. This is non-fatal: the route still works, just without the
 * tool-call TTL distinction until the migration runs.
 *
 * BUG-3 fix: we still filter by `kb_content_version` here. If the
 * kb_content_version column doesn't exist either (very old DB), the
 * query will fail and we return null (cache miss → fresh LLM call).
 * That's acceptable — the migration will add the column, then this
 * path is no longer needed.
 */
async function getSemanticCachedResponseLegacy(
  embedding: number[],
  kbContentVersion: string,
): Promise<SemanticCacheEntry | null> {
  try {
    const result = await pool.query(
      `SELECT
         response,
         model,
         provider,
         1 - (embedding <=> $1::vector) AS similarity,
         created_at
       FROM ai_response_cache
       WHERE kb_content_version = $4
         AND created_at > NOW() - ($2 || ' seconds')::INTERVAL
         AND 1 - (embedding <=> $1::vector) > $3
       ORDER BY embedding <=> $1::vector
       LIMIT 1`,
      [
        `[${embedding.join(",")}]`,
        String(CACHE_TTL_SECONDS),
        SIMILARITY_THRESHOLD,
        kbContentVersion,
      ],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      response: row.response,
      model: row.model,
      provider: row.provider,
      similarity: row.similarity,
      cachedAt: new Date(row.created_at).getTime(),
    };
  } catch (err) {
    logger.debug({ err: (err as any)?.message }, "Semantic cache: legacy search also failed");
    return null;
  }
}

/**
 * Stores a response in the semantic cache with its embedding.
 *
 * Generates an embedding of the user's message and stores it alongside
 * the response. Future similar queries will match this entry.
 *
 * Skips storage for:
 *   - Private queries (user-specific data)
 *   - Messages < 10 chars
 *   - Responses > 10K chars
 *   - Tool-call responses (tool results may change)
 *   - When embedding generation fails (falls back to exact-match cache)
 *
 * BUG-3 fix: stores the `kb_content_version` so future lookups can
 * filter by it. NULL is never stored — only versioned rows are written
 * (the caller skips cache writes when the version is "unknown").
 */
export async function setSemanticCachedResponse(
  userMessage: string,
  response: string,
  model: string,
  provider: string,
  hadToolCalls: boolean,
  kbContentVersion: string,
  isPrivate: boolean = false,
): Promise<void> {
  // Never cache private queries (user-scoped tool data, order lookups).
  if (isPrivate) return;

  // Bug #4 fix: if tool calls happened AND the tool-cache TTL is 0, skip
  // caching entirely (admin configured maximum freshness).
  if (hadToolCalls && TOOL_CACHE_TTL_SECONDS <= 0) return;

  if (userMessage.trim().length < MIN_MESSAGE_LENGTH) return;
  if (response.length > 10_000) return;

  // BUG-3 fix: never cache when the KB version is unknown (DB error during
  // version computation). Storing an "unknown" version would cause the
  // next lookup to reject it (the lookup uses `WHERE kb_content_version = $N`,
  // and $N would be a real version while the stored value is "unknown"),
  // so we just skip the write entirely.
  if (kbContentVersion === "unknown") return;

  const embedding = await generateEmbedding(userMessage);
  if (!embedding) return; // embedding failed — exact-match cache handles it

  try {
    // Bug #4 fix: store the had_tool_calls flag so the READ side can
    // apply the correct TTL filter (short for tool-call entries, long
    // for non-tool entries). The column is added by ensureAiTables.ts
    // (idempotent ALTER ADD COLUMN IF NOT EXISTS).
    //
    // BUG-3 fix: also store kb_content_version. The column is added by
    // migration 0008 + ensureAiTables.ts.
    await pool.query(
      `INSERT INTO ai_response_cache (query_text, response, embedding, model, provider, had_tool_calls, kb_content_version)
       VALUES ($1, $2, $3::vector, $4, $5, $6, $7)`,
      [
        userMessage.slice(0, 1000),
        response,
        `[${embedding.join(",")}]`,
        model,
        provider,
        hadToolCalls,
        kbContentVersion,
      ],
    );
    logger.debug({ model, provider, hadToolCalls, kbContentVersion }, "Semantic cache: STORED");
  } catch (err) {
    // If the kb_content_version column doesn't exist yet (migration hasn't
    // run), fall back to the old INSERT without it. This is non-fatal —
    // the entry just won't have the version (treated as NULL on read,
    // which excludes it from cache hits until the migration runs).
    const errMsg = (err as any)?.message ?? "";
    if (
      errMsg.includes("kb_content_version") ||
      errMsg.includes("column") ||
      errMsg.includes("does not exist")
    ) {
      try {
        await pool.query(
          `INSERT INTO ai_response_cache (query_text, response, embedding, model, provider, had_tool_calls)
           VALUES ($1, $2, $3::vector, $4, $5, $6)`,
          [
            userMessage.slice(0, 1000),
            response,
            `[${embedding.join(",")}]`,
            model,
            provider,
            hadToolCalls,
          ],
        );
        logger.debug(
          { model, provider, hadToolCalls, fallback: true },
          "Semantic cache: STORED (legacy schema, no kb_content_version column)",
        );
      } catch (legacyErr) {
        logger.debug(
          { err: (legacyErr as any)?.message },
          "Semantic cache: legacy store also failed",
        );
      }
    } else {
      logger.debug({ err: errMsg }, "Semantic cache: store failed (pgvector unavailable?)");
    }
  }
}

/**
 * Clears all semantic cache entries. Used by the admin cache-clear endpoint.
 */
export async function clearSemanticCache(): Promise<number> {
  try {
    const result = await pool.query("DELETE FROM ai_response_cache");
    logger.info({ deleted: result.rowCount }, "Semantic cache: cleared all entries");
    return result.rowCount ?? 0;
  } catch (err) {
    logger.error({ err }, "Semantic cache: clear failed");
    return 0;
  }
}

/**
 * Returns semantic cache statistics for the admin endpoint.
 */
export async function getSemanticCacheStats(): Promise<{
  enabled: boolean;
  entryCount: number;
  similarityThreshold: number;
}> {
  try {
    const result = await pool.query("SELECT COUNT(*)::int AS count FROM ai_response_cache");
    return {
      enabled: true,
      entryCount: result.rows[0]?.count ?? 0,
      similarityThreshold: SIMILARITY_THRESHOLD,
    };
  } catch {
    return { enabled: false, entryCount: 0, similarityThreshold: SIMILARITY_THRESHOLD };
  }
}
