/**
 * Shared embedding configuration — single source of truth for the Gemini
 * embedding model name, dimensions, and task types.
 *
 * ─── Why this file exists (BUG-E1 fix) ──────────────────────────────────────
 *
 * Previously, every file that called Gemini's `embedContent` API hardcoded
 * `text-embedding-004` as the model name. Google shut down that model on
 * January 14, 2026, breaking all KB embedding generation + semantic cache
 * lookups + query embeddings.
 *
 * The fix centralizes the model name (and dimensions + task types) in ONE
 * place so future deprecations require a single edit (or just an env var
 * change, no redeploy needed).
 *
 * ─── Current model: gemini-embedding-001 ────────────────────────────────────
 *
 * `gemini-embedding-001` is Google's current production embedding model
 * (the successor to text-embedding-004). Key properties:
 *
 *   - Default output dimensionality: 3072 (configurable down to 768).
 *   - We use `outputDimensionality: 768` for backward compatibility with
 *     the existing pgvector columns (`embedding vector(768)` on
 *     `ai_kb_entries` and `ai_response_cache`). Changing the dimensionality
 *     would require a migration + re-embedding every row.
 *   - Supports the same task types as text-embedding-004
 *     (RETRIEVAL_QUERY, RETRIEVAL_DOCUMENT, etc.).
 *   - Free tier: 1500 RPD (same as text-embedding-004).
 *
 * ─── Env-var configurability ────────────────────────────────────────────────
 *
 * The model name is configurable via `GEMINI_EMBEDDING_MODEL` so operators
 * can swap to a different model (e.g. text-embedding-005 when it launches,
 * or a third-party model via a proxy) without a code change. The dimensions
 * are configurable via `GEMINI_EMBEDDING_DIMENSIONS` — but changing
 * dimensions requires a DB migration (the pgvector column is fixed at 768).
 *
 * Industry-standard pattern: OpenAI's `text-embedding-3-small` lets callers
 * specify `dimensions` per call. Google's gemini-embedding-001 follows the
 * same pattern via `outputDimensionality`. We pin it to 768 for backward
 * compat, but the env var lets operators override if they've migrated the
 * column to a different size.
 *
 * ─── Task type asymmetry ────────────────────────────────────────────────────
 *
 * Gemini's embedding model is trained to match two task types asymmetrically:
 *
 *   - RETRIEVAL_QUERY: optimized for SHORT search queries (the user's
 *     message). Used by kbSearch.ts (query embedding) + embeddingCache.ts
 *     (semantic cache lookup — the user's message is the "query" against
 *     the cached responses which are the "documents").
 *
 *   - RETRIEVAL_DOCUMENT: optimized for LONGER content to be indexed
 *     (the KB entries, the cached AI responses). Used by kbEmbeddings.ts
 *     (KB entry embeddings) + embeddingCache.ts (cache write — the AI
 *     response is the "document" to be found).
 *
 * Mixing these up degrades search quality significantly (the model is
 * explicitly trained on the asymmetry).
 */

/**
 * The Gemini embedding model name.
 *
 * Configurable via `GEMINI_EMBEDDING_MODEL` env var. Defaults to
 * `gemini-embedding-001` (the current production model as of Feb 2026).
 *
 * Previous values:
 *   - `text-embedding-004` (shut down Jan 14, 2026 — caused BUG-E1)
 *
 * When Google deprecates `gemini-embedding-001`, operators can set
 * `GEMINI_EMBEDDING_MODEL=text-embedding-005` (or whatever the new model
 * is) without a code change. The model name is part of the query-embedding
 * cache key (see queryEmbeddingCache.ts), so changing it automatically
 * invalidates all stale cache entries.
 */
export const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-001";

/**
 * The output dimensionality of the embedding vectors.
 *
 * Configurable via `GEMINI_EMBEDDING_DIMENSIONS` env var. Defaults to 768
 * for backward compatibility with the existing pgvector columns
 * (`embedding vector(768)` on ai_kb_entries + ai_response_cache).
 *
 * WARNING: changing this requires a DB migration to alter the vector
 * column size + re-embedding every row. Don't change it unless you've
 * planned the migration.
 *
 * `gemini-embedding-001` supports up to 3072 dimensions. We pin to 768
 * to match the existing schema. If you want higher-quality embeddings,
 * migrate the column to `vector(1536)` or `vector(3072)` + set this env
 * var to match + re-embed all entries.
 */
export const EMBEDDING_DIMENSIONS = Number(process.env.GEMINI_EMBEDDING_DIMENSIONS ?? 768);

/**
 * The task type for embedding user queries (short search queries).
 *
 * Used by:
 *   - kbSearch.ts (the user's chat message → query embedding for KB search)
 *   - embeddingCache.ts (the user's chat message → query embedding for
 *     semantic cache lookup)
 *
 * Gemini's model is trained to match RETRIEVAL_QUERY embeddings against
 * RETRIEVAL_DOCUMENT embeddings (asymmetric similarity). Don't use
 * RETRIEVAL_QUERY for the documents — search quality degrades.
 */
export const TASK_TYPE_QUERY = "RETRIEVAL_QUERY" as const;

/**
 * The task type for embedding documents (longer content to be indexed).
 *
 * Used by:
 *   - kbEmbeddings.ts (KB entry content → document embedding for KB search)
 *   - embeddingCache.ts (AI response → document embedding for semantic cache)
 *
 * The asymmetric counterpart to TASK_TYPE_QUERY.
 */
export const TASK_TYPE_DOCUMENT = "RETRIEVAL_DOCUMENT" as const;

/**
 * Maximum input character count for the embedding API.
 *
 * Gemini truncates inputs longer than ~2048 tokens (~2K-4K chars depending
 * on language). We truncate to 2000 chars on our side to stay safely under
 * the limit + avoid paying for tokens that won't affect the embedding.
 *
 * Bangla text uses multi-byte UTF-8 (3 bytes per char), so 2000 chars ≈
 * 6000 bytes ≈ ~1500-2000 tokens depending on the tokenizer. Safe.
 */
export const MAX_EMBEDDING_INPUT_CHARS = 2000;
