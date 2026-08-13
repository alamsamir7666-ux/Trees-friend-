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
 *   - Catalog changes: should invalidate (not implemented — would need a
 *     webhook from product update routes)
 *
 * What's NOT cached (same rules as exact-match cache):
 *   - Private queries (order lookups, user-specific data)
 *   - Messages < 10 chars (too generic)
 *   - Responses > 10K chars (too large for Redis/DB storage)
 *   - Tool-call responses (tool results may have changed)
 */

import { GoogleGenAI } from "@google/genai";
import { pool } from "@workspace/db";
import { logger } from "./logger";

const SIMILARITY_THRESHOLD = Number(process.env.AI_SEMANTIC_SIMILARITY ?? 0.92);
const CACHE_TTL_SECONDS = Number(process.env.AI_CACHE_TTL_SECONDS ?? 3600);
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
 * @param userMessage - The user's new message
 * @param isPrivate - If true, skip cache (user-specific data)
 */
export async function getSemanticCachedResponse(
  userMessage: string,
  isPrivate: boolean = false,
): Promise<SemanticCacheEntry | null> {
  if (isPrivate) return null;
  if (userMessage.trim().length < MIN_MESSAGE_LENGTH) return null;

  // Generate embedding
  const embedding = await generateEmbedding(userMessage);
  if (!embedding) return null; // embedding failed — fall back to exact-match cache

  try {
    // Query pgvector for similar entries (cosine similarity)
    // <=> operator = cosine distance (1 - similarity)
    // We want similarity > threshold, so we filter on 1 - (embedding <=> $1) > threshold
    const result = await pool.query(
      `SELECT
         response,
         model,
         provider,
         1 - (embedding <=> $1::vector) AS similarity,
         created_at
       FROM ai_response_cache
       WHERE created_at > NOW() - ($2 || ' seconds')::INTERVAL
         AND 1 - (embedding <=> $1::vector) > $3
       ORDER BY embedding <=> $1::vector
       LIMIT 1`,
      [`[${embedding.join(",")}]`, String(CACHE_TTL_SECONDS), SIMILARITY_THRESHOLD],
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
    logger.debug({ err: (err as any)?.message }, "Semantic cache: search failed (pgvector unavailable?)");
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
 */
export async function setSemanticCachedResponse(
  userMessage: string,
  response: string,
  model: string,
  provider: string,
  hadToolCalls: boolean = false,
  isPrivate: boolean = false,
): Promise<void> {
  if (hadToolCalls || isPrivate) return;
  if (userMessage.trim().length < MIN_MESSAGE_LENGTH) return;
  if (response.length > 10_000) return;

  const embedding = await generateEmbedding(userMessage);
  if (!embedding) return; // embedding failed — exact-match cache handles it

  try {
    await pool.query(
      `INSERT INTO ai_response_cache (query_text, response, embedding, model, provider)
       VALUES ($1, $2, $3::vector, $4, $5)`,
      [
        userMessage.slice(0, 1000),
        response,
        `[${embedding.join(",")}]`,
        model,
        provider,
      ],
    );
    logger.debug({ model, provider }, "Semantic cache: STORED");
  } catch (err) {
    logger.debug({ err: (err as any)?.message }, "Semantic cache: store failed (pgvector unavailable?)");
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
