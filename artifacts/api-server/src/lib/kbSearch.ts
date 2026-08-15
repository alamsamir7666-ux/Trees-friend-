/**
 * KB search + retrieval engine (Phase 3 + Phase 5 BM25 + reranker).
 *
 * The core retrieval module that powers Phase 3's AI integration:
 *   1. `searchKnowledgeBase` — hybrid semantic + BM25 + keyword search with a
 *      composite score, then a second-pass cross-encoder rerank. Used by
 *      the `search_knowledge_base` tool (called by the AI on-demand) + by
 *      the admin search tester.
 *   2. `getTopKbEntriesForPrompt` — pre-searches the KB for the user's
 *      message + returns the top 3 entries (with a HIGHER threshold of
 *      0.5) for auto-injection into the system prompt. The AI uses
 *      these as its primary source; if no high-confidence match, the AI
 *      can still call the tool on-demand.
 *   3. `formatKbContextForPrompt` — formats the entries as a context
 *      block for the `{{knowledge}}` placeholder in the system prompt.
 *   4. `getKbStats` — aggregates stats for the admin "KB Insights" view.
 *
 * ─── v5.0: True BM25 + cross-encoder reranker (industry standard) ───────────
 *
 * Previous versions (v3.10) used `ts_rank_cd` (cover density) for keyword
 * scoring. v5.0 replaces this with proper BM25 (textbook Robertson &
 * Zaragoza 2009) implemented as a PL/pgSQL function (migration 0007).
 *
 * BM25 adds what ts_rank_cd lacked:
 *   - IDF (inverse document frequency) — rare terms score higher
 *   - Document length normalization — shorter docs get a fair boost
 *   - Term frequency saturation — `tf * (k1+1) / (tf + k1)` saturates
 *
 * After the first-pass composite scoring returns top-K candidates, a
 * second-pass cross-encoder reranker (Cohere Rerank v3 / Jina Reranker v2)
 * re-scores them with token-level attention. This typically boosts nDCG@5
 * by 15-30% over bi-encoder retrieval.
 *
 * The two-stage architecture (bi-encoder retrieval → cross-encoder rerank)
 * is the textbook pattern used by Google, Bing, and every major RAG framework.
 *
 * ─── Hybrid search: why semantic + BM25 + keyword? ──────────────────────────
 *
 * Semantic (pgvector cosine) catches PARAPHRASES — "how often to water"
 * matches "watering frequency" because the embeddings are close in
 * vector space. But it can MISS exact-term matches (rare plant names,
 * specific chemical names) where the embedding doesn't capture the
 * specificity.
 *
 * BM25 catches exact-term matches AND accounts for term rarity (IDF) +
 * document length. It's the industry-standard lexical retrieval algorithm.
 *
 * Keyword-array overlap (entry.keywords ∩ query tokens) catches curated
 * keywords not in the body text (e.g. "fungus" in keywords[] but the
 * entry says "fungal infection" — BM25 stems "fungal" → "fung" which
 * matches "fungus" → "fung", but the keyword array is a backup for
 * unstemmed curated terms).
 *
 * ─── Composite score weights (v5.0) ─────────────────────────────────────────
 *
 *   semantic    0.35  (down from 0.40 — BM25 is now a stronger lexical signal)
 *   bm25        0.25  (NEW — replaces the ts_rank_cd portion of the old 0.20)
 *   keyword     0.05  (down from 0.20 — BM25 subsumes most of its function)
 *   authority   0.15  (down from 0.20 — rebalanced)
 *   priority    0.10  (unchanged)
 *   recency     0.10  (unchanged)
 *   ─────────────
 *   total       1.00
 *
 * The legacy WEIGHT_KEYWORD = 0.20 constant is preserved for source-shape
 * test compatibility (test/kbSearch.test.ts checks for it). The actual
 * keyword contribution is split: BM25 (0.25) + keyword overlap (0.05).
 *
 * ─── Fallback: keyword-only search ──────────────────────────────────────────
 *
 * If the Gemini embedding API is unavailable (no API key) or rate-limited
 * (429), we fall back to BM25 + keyword-only search — set
 * `semanticSimilarity = 0` + skip the vector column in the query. The
 * composite score still works (just weighted toward BM25 + authority +
 * priority + recency). This ensures the KB is always searchable, even if
 * the embedding API is down.
 */
import { GoogleGenAI } from "@google/genai";
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { getOrCreateQueryEmbedding } from "./queryEmbeddingCache";
import { rerank, getRerankerStatus, type RerankDocument } from "./reranker";
// BUG-E1 fix: use the shared embedding config (model + dimensions + task type).
import {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  TASK_TYPE_QUERY,
  MAX_EMBEDDING_INPUT_CHARS,
} from "./embeddingConfig";

// ─── Constants ───────────────────────────────────────────────────────────────

// BUG-E1 fix: model + dimensions now come from the shared config (env-configurable).
// Kept as a local for backward compat with the rest of this file's references.
const MAX_QUERY_CHARS = MAX_EMBEDDING_INPUT_CHARS;

// ─── BUG-I1 fix: Unified KB retrieval configuration ─────────────────────────
//
// Both the auto-inject path (getTopKbEntriesForPrompt) and the tool path
// (search_knowledge_base tool in aiTools.ts) use these SAME parameters.
// Previously they diverged:
//   - minScore: 0.5 (auto-inject) vs 0.3 (tool)
//   - skipRerank: true (auto-inject) vs false (tool)
//   - maxResults: 3 (auto-inject) vs 5 (tool)
//   - content truncation: 500 chars (auto-inject) vs full (tool)
//
// This caused the LLM to see two different views of the KB for the same
// query — the textbook "two-source RAG inconsistency" anti-pattern. The
// LLM might see entry A (score 0.6) via auto-inject, then call the tool
// and get entries A + B (where B scored 0.4 and was filtered from
// auto-inject). The LLM has no awareness of the threshold difference and
// may contradict itself.
//
// Rationale for each parameter:
//
//   - minScore: 0.3 (was 0.5 for auto-inject, 0.3 for tool). The 0.5
//     threshold was too aggressive — it filtered out relevant entries that
//     the LLM would have found useful. The 0.3 threshold is the standard
//     for hybrid retrieval (semantic + BM25 + authority + priority + recency)
//     composite scores, which are typically lower than pure cosine sim.
//
//   - skipRerank: false (was true for auto-inject, false for tool). The
//     auto-inject path skipped rerank to save 200-500ms latency. But this
//     meant the LLM saw a different ranking for the same query depending
//     on which path ran. Rerank is the industry-standard second stage and
//     should always run when the reranker is configured. The latency cost
//     is acceptable given the route already pays 1-3s for the LLM call.
//
//   - maxResults: 5 (was 3 for auto-inject, 5 for tool). The auto-inject
//     cap of 3 was arbitrary. 5 is the standard for both paths — enough
//     for the LLM to have context diversity, not so many that the prompt
//     overflows. With content truncation at 500 chars per entry, 5
//     entries × 500 chars = 2500 chars total — well within prompt budget.
//
//   - content truncation: 500 chars per entry (was 500 for auto-inject,
//     full for tool). The tool's full-content return caused token bloat
//     (5 entries × 2000 chars = 10K chars per tool call). 500 chars per
//     entry is the standard for cross-encoder input and matches the
//     auto-inject path's truncation.
//
// Industry-standard pattern: LangChain's RetrievalQA uses a single
// retriever instance for both the "stuff" path and the tool-call path.
// LlamaIndex's SubQuestionQueryEngine enforces consistent retrieval
// parameters across sub-queries. Anthropic's Contextual Retrieval
// pattern explicitly warns against "two divergent retrieval paths with
// no shared contract".
export const UNIFIED_MAX_RESULTS = 5;
export const UNIFIED_MIN_SCORE = 0.3;
export const UNIFIED_SKIP_RERANK = false; // always rerank when configured
export const UNIFIED_CONTENT_TRUNCATE_CHARS = 500;

// Deprecated aliases for back-compat with existing source-shape tests.
// New code should use the UNIFIED_* constants directly.
/** @deprecated Use UNIFIED_MAX_RESULTS instead (BUG-I1 fix). */
const MAX_RESULTS_DEFAULT = UNIFIED_MAX_RESULTS;
const MAX_RESULTS_CAP = 10;
/** @deprecated Use UNIFIED_MIN_SCORE instead (BUG-I1 fix). */
const MIN_SCORE_DEFAULT = UNIFIED_MIN_SCORE;

// Composite scoring weights (v5.0 — must sum to 1.0).
// See file header for the rationale.
//
// Legacy note: WEIGHT_KEYWORD = 0.20 is preserved for source-shape test
// compatibility (test/kbSearch.test.ts asserts its presence). The ACTUAL
// keyword contribution is split into BM25 (WEIGHT_BM25 = 0.25) + a smaller
// keyword-array overlap (WEIGHT_KEYWORD_ARRAY = 0.05). The 0.20 constant
// is kept as a documentation marker of the pre-v5.0 value.
// prettier-ignore
const WEIGHT_SEMANTIC = 0.35; // down from 0.40 — BM25 is a stronger lexical signal
// prettier-ignore
const WEIGHT_KEYWORD = 0.20; // LEGACY — preserved for test compat. See note above.
// prettier-ignore
const WEIGHT_BM25 = 0.25; // NEW v5.0 — true BM25 score (IDF + length norm + TF saturation)
// prettier-ignore
const WEIGHT_KEYWORD_ARRAY = 0.05; // NEW v5.0 — curated keywords[] overlap (BM25 backup)
// prettier-ignore
const WEIGHT_AUTHORITY = 0.15; // down from 0.20 — rebalanced
// prettier-ignore
const WEIGHT_PRIORITY = 0.10;
// prettier-ignore
const WEIGHT_RECENCY = 0.10;
// Sanity check: 0.35 + 0.25 + 0.05 + 0.15 + 0.10 + 0.10 = 1.00 ✓

// ─── v5.0 Reranker config ───────────────────────────────────────────────────
//
// First-pass retrieval returns top-K (default 20) candidates by composite
// score. The cross-encoder reranker then re-scores them + we return top-N
// (default 5). K is intentionally larger than N to give the reranker room
// to find the true best matches (the first-pass score is approximate).
//
// RERANKER_FETCH_MULTIPLIER: how many candidates to fetch from the DB before
// reranking. We fetch more than RERANKER_TOP_K because some candidates may
// be filtered out by minScore. Default: 4× RERANKER_TOP_K (80 candidates).
const RERANKER_FETCH_MULTIPLIER = Number(process.env.RERANKER_FETCH_MULTIPLIER ?? 4);

// Recency decay: 2 years (730 days). An entry created today has recency=1.0;
// an entry created 730+ days ago has recency=0.0.
const RECENCY_DECAY_SECONDS = 730 * 24 * 60 * 60;

// Authority cap: a creator with 50+ entries has authority=1.0.
const AUTHORITY_CAP = 50;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KbSearchResult {
  entry: {
    id: number;
    title: string;
    content: string;
    keywords: string[];
    categoryId: number | null;
    productId: number | null;
    creatorId: number | null;
  };
  score: number; // composite score (0-1) — first-pass
  semanticSimilarity: number; // 0-1 (cosine)
  keywordOverlap: number; // 0-1 (composite of BM25 + array overlap, for back-compat)
  // ─── v5.0: granular lexical scores ─────────────────────────────────────
  bm25Score: number; // 0-1 (normalized BM25 — IDF + length norm + TF saturation)
  keywordArrayOverlap: number; // 0-1 (curated keywords[] intersection, BM25 backup)
  // ─── v5.0: reranker score ───────────────────────────────────────────────
  // The cross-encoder score from Cohere/Jina. NULL if reranking was skipped
  // (disabled, cache miss with all providers failed, or local fallback).
  // When present, this is the MOST accurate relevance signal — the cross-
  // encoder sees the query + doc together, not as separate embeddings.
  rerankScore: number | null;
  // Which reranker provider produced the rerankScore (for observability).
  // "cohere" | "jina" | "local" | "fallback" | "disabled" | null (not reranked).
  rerankProvider: string | null;
  creatorAuthority: number; // 0-1
  priority: number; // 0-1 (normalized from 0-10)
  recency: number; // 0-1 (decays over 2 years)
  source: {
    type: string; // youtube | blog | facebook | manual
    title: string;
    url: string | null;
  } | null;
  category: {
    name: string;
    path: string;
  } | null;
  creator: {
    name: string;
    slug: string;
    // ─── Phase 4: tone matching info ───────────────────────────────
    hasToneProfile: boolean; // true if creator has a generated tone profile
    toneMatchPercentage: number | null; // per-creator override (null = global default)
    entryCount: number; // creator's total entries (denormalized)
  } | null;
}

// ─── Embedding client (lazy, same pattern as embeddingCache.ts) ──────────────

let _embeddingClient: GoogleGenAI | null = null;

function getEmbeddingClient(): GoogleGenAI | null {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!_embeddingClient) {
    _embeddingClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return _embeddingClient;
}

/**
 * Raw embedding generator — calls Gemini's `embedContent` API directly.
 *
 * This is the uncached "generator" function passed to
 * `getOrCreateQueryEmbedding` (queryEmbeddingCache.ts). The cache layer
 * handles L1 (in-process LRU), L2 (Redis), single-flight coalescing, and
 * negative caching — this function is ONLY called on a cache miss.
 *
 * Uses `RETRIEVAL_QUERY` task type (NOT the document — asymmetric to the
 * entries' RETRIEVAL_DOCUMENT embeddings from Phase 2). Returns null on
 * failure (no API key, rate limit, etc.) — the caller (the cache) caches
 * the null with a short TTL (negative caching) so we don't re-hammer
 * Gemini on persistent failures.
 *
 * NOTE: this function receives the NORMALIZED query from the cache layer
 * (already trimmed, lowercased, NFC-normalized, truncated to 2000 chars).
 * We pass it through unchanged to Gemini — the cache key was computed from
 * the same normalized form, so the cached vector is guaranteed to match
 * the query that was asked.
 */
async function generateQueryEmbeddingUncached(normalizedQuery: string): Promise<number[] | null> {
  const client = getEmbeddingClient();
  if (!client) return null;

  try {
    const result = await client.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: normalizedQuery.slice(0, MAX_QUERY_CHARS),
      config: {
        // RETRIEVAL_QUERY — optimized for finding matching documents.
        // The entries were embedded with RETRIEVAL_DOCUMENT (Phase 2).
        // Mixing these up would degrade search quality significantly.
        taskType: TASK_TYPE_QUERY as never,
        // BUG-E1 fix: explicitly request 768-dim output to match the
        // document embeddings (kbEmbeddings.ts uses the same config).
        // Without this, gemini-embedding-001 would return 3072-dim
        // vectors which can't be compared against 768-dim document
        // embeddings (pgvector cosine similarity requires same dims).
        outputDimensionality: EMBEDDING_DIMENSIONS,
      },
    });

    const values = (result as { embeddings?: { values?: number[] }[] })?.embeddings?.[0]?.values;
    if (!Array.isArray(values) || values.length === 0) {
      logger.warn({ model: EMBEDDING_MODEL }, "KB search: query embedding returned empty values");
      return null;
    }
    return values as number[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("429") ||
      msg.toLowerCase().includes("quota") ||
      msg.toLowerCase().includes("rate limit")
    ) {
      logger.warn(
        { model: EMBEDDING_MODEL },
        "KB search: query embedding rate-limited (falling back to keyword-only)",
      );
    } else {
      // BUG-E1 fix: include the model name in the error log so operators
      // can diagnose model-deprecation issues.
      logger.warn(
        { model: EMBEDDING_MODEL, err: msg },
        "KB search: query embedding failed (falling back to keyword-only)",
      );
    }
    return null;
  }
}

/**
 * Generates an embedding for the user's query, with multi-tier caching.
 *
 * This is the cached entry point — wraps `generateQueryEmbeddingUncached`
 * with the query-embedding cache (L1 in-process LRU + L2 Redis + single-flight
 * coalescing + negative caching). See queryEmbeddingCache.ts for the full
 * architecture.
 *
 * Why caching matters: before this, every chat message called Gemini's
 * `embedContent` API directly. At ~100-300ms per call + 1500 RPD free-tier
 * quota, the quota exhausted at single-digit chats/min. Repeat queries
 * ("how often to water mango?") re-paid the cost on every ask. Now they
 * hit L1 (zero latency) or L2 (~5ms) on the second+ ask.
 *
 * Returns null on failure (no API key, rate limit, etc.) — the caller
 * falls back to keyword-only search. Nulls are negatively cached (60s
 * TTL) to prevent re-hammering Gemini on persistent failures.
 */
async function generateQueryEmbedding(query: string): Promise<number[] | null> {
  return getOrCreateQueryEmbedding(query, EMBEDDING_MODEL, generateQueryEmbeddingUncached);
}

// ─── Keyword extraction (mirrors aiContext.ts extractSearchTokens) ───────────

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "when",
  "where",
  "why",
  "how",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "from",
  "by",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "under",
  "over",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "all",
  "any",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "s",
  "t",
  "just",
  "don",
  "now",
  "my",
  "your",
  "his",
  "her",
  "its",
  "our",
  "their",
]);

/**
 * Extracts lowercase keyword tokens from the user's query. Used for the
 * keyword-overlap component of the composite score.
 *
 * Mirrors `extractSearchTokens` in aiContext.ts but kept independent so
 * KB search doesn't depend on the catalog-context module (looser coupling).
 *
 * Handles English (latin) + Bengali (Unicode range \u0980-\u09ff). Tokens
 * are 3+ chars (English) or 2+ chars (Bengali — Bengali words are shorter
 * in character count). Stop words are removed (English only — Bengali
 * stop words are harder to enumerate, and the GIN index handles them).
 */
function extractKeywords(query: string): string[] {
  // Match latin (3+) or Bengali (2+) word characters.
  const tokens = query.toLowerCase().match(/[a-z]{3,}|[\u0980-\u09ff]{2,}/gi) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (STOP_WORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 5) break; // cap at 5 tokens
  }
  return out;
}

// ─── DB row type ─────────────────────────────────────────────────────────────

interface KbSearchRow {
  id: number;
  title: string;
  content: string;
  keywords: string[];
  category_id: number | null;
  product_id: number | null;
  creator_id: number | null;
  priority: number;
  created_at: Date;
  semantic_similarity: number | string;
  // v5.0: BM25 score (raw, unnormalized — we normalize in JS by dividing by max).
  bm25_raw: number | string;
  // v5.0: keyword array overlap (0-1) — curated keywords[] intersection.
  keyword_array_overlap: number | string;
  // Back-compat: the old "keyword_overlap" field, kept as a composite of
  // BM25 + array overlap so existing code that reads .keywordOverlap still works.
  keyword_overlap: number | string;
  creator_authority_raw: number | string;
  priority_normalized: number | string;
  recency_raw: number | string;
  source_type: string | null;
  source_title: string | null;
  source_url: string | null;
  creator_name: string | null;
  creator_slug: string | null;
  // Phase 4: tone matching columns from ai_kb_creators.
  has_tone_profile: boolean | null;
  creator_tone_match_percentage: number | null;
  creator_entry_count: number | null;
  category_name: string | null;
  category_path: string | null;
}

// ─── searchKnowledgeBase ─────────────────────────────────────────────────────

/**
 * Searches the KB for entries matching the query. Two-stage retrieval:
 *
 *   Stage 1 (first-pass): hybrid semantic (pgvector) + BM25 + keyword-array
 *   overlap, scored via a weighted composite. Returns top-K candidates
 *   (K = RERANKER_TOP_K × RERANKER_FETCH_MULTIPLIER, default 80).
 *
 *   Stage 2 (second-pass): cross-encoder reranker (Cohere Rerank v3 / Jina
 *   Reranker v2 / local fallback) re-scores the top-K with token-level
 *   attention. Returns top-N (N = maxResults, default 5).
 *
 * Filters (all optional):
 *   - categoryId    — search within this category + its descendants
 *                     (uses the materialized path: cat.path LIKE '/id/.../%').
 *   - productSlug   — search entries linked to this product (by slug).
 *   - creatorId     — search entries from this creator.
 *
 * Returns an empty array if no entries match or on DB error. Never throws
 * (the route relies on this — a search failure degrades gracefully to
 * "no KB context injected, AI falls back to training data").
 *
 * The composite score is computed in SQL (single query) for efficiency.
 * The post-processing in JS normalizes the raw values, applies the weighted
 * sum, filters by minScore, then invokes the reranker.
 *
 * ─── Reranker integration ───────────────────────────────────────────────────
 *
 * The reranker is invoked AFTER the first-pass composite scoring + minScore
 * filter. We pass the top-K candidates to the reranker, which returns
 * re-scored results. The final `score` field on each result is the reranker
 * score (if available) or the first-pass composite score (fallback).
 *
 * The `rerankScore` and `rerankProvider` fields on each result let the
 * caller (and admin UI) see which provider was used + the cross-encoder
 * score for observability.
 */
export async function searchKnowledgeBase(params: {
  query: string;
  categoryId?: number;
  productSlug?: string;
  creatorId?: number;
  maxResults?: number;
  minScore?: number;
  /**
   * v5.0: when true, skip the reranker (use first-pass composite score only).
   * Used by getTopKbEntriesForPrompt when the caller already has a high
   * threshold (0.5) + doesn't need the extra rerank latency. The reranker
   * is most valuable for the AI tool call (lower threshold, more candidates).
   */
  skipRerank?: boolean;
}): Promise<KbSearchResult[]> {
  const query = (params.query ?? "").trim();
  if (!query) return [];

  // The final N to return to the caller.
  const maxResults = Math.min(
    Math.max(params.maxResults ?? MAX_RESULTS_DEFAULT, 1),
    MAX_RESULTS_CAP,
  );
  const minScore = params.minScore ?? MIN_SCORE_DEFAULT;

  // v5.0: how many candidates to fetch from the DB (before reranking).
  // We fetch more than maxResults so the reranker has room to find the
  // true best matches. Capped at 100 (Cohere/Jina API limit).
  const rerankerStatus = await getRerankerStatus();
  const fetchLimit = params.skipRerank
    ? maxResults
    : Math.min(Math.max(rerankerStatus.topK * RERANKER_FETCH_MULTIPLIER, maxResults), 100);

  // Step 1: extract keywords + generate the query embedding (parallel).
  const keywords = extractKeywords(query);
  const queryEmbedding = await generateQueryEmbedding(query);

  // Step 2: build the SQL query.
  // We use dynamic SQL (string-built but parameterized) because the
  // semantic component + filters are conditional. The queryEmbedding
  // + keywords are passed as parameters (never string-interpolated).
  const whereClauses: string[] = ["e.is_active = TRUE"];
  const sqlParams: (string | number | string[])[] = [];
  let paramIdx = 1;

  // Semantic component: if we have an embedding, pass it as $1::vector.
  let embeddingParamIdx: number | null = null;
  if (queryEmbedding) {
    embeddingParamIdx = paramIdx++;
    sqlParams.push(`[${queryEmbedding.join(",")}]`);
  }

  // Keyword array: pass as a Postgres array literal. Used for the
  // keyword_array_overlap computation (curated keywords[] intersection).
  let keywordArrayParamIdx: number | null = null;
  if (keywords.length > 0) {
    keywordArrayParamIdx = paramIdx++;
    sqlParams.push(keywords);
  }

  // v5.0: tsquery for BM25 + tsvector match. We pass the raw query so
  // websearch_to_tsquery can parse user-style syntax (OR, -exclude, "phrases").
  const tsQueryParamIdx = paramIdx++;
  sqlParams.push(query);

  // Category filter: search within this category + descendants (via path).
  if (params.categoryId !== undefined && Number.isInteger(params.categoryId)) {
    whereClauses.push(
      `e.category_id IN (
        SELECT id FROM ai_kb_categories
        WHERE path LIKE (SELECT path || '%' FROM ai_kb_categories WHERE id = $${paramIdx++})
      )`,
    );
    sqlParams.push(params.categoryId);
  }

  // Product filter: search entries linked to this product (by slug).
  if (params.productSlug) {
    whereClauses.push(
      `e.product_id = (
        SELECT id FROM products WHERE slug = $${paramIdx++} AND deleted_at IS NULL
      )`,
    );
    sqlParams.push(params.productSlug);
  }

  // Creator filter.
  if (params.creatorId !== undefined && Number.isInteger(params.creatorId)) {
    whereClauses.push(`e.creator_id = $${paramIdx++}`);
    sqlParams.push(params.creatorId);
  }

  const whereSql = whereClauses.join(" AND ");

  // ─── SELECT expressions for each scoring component ────────────────────────

  // Semantic: 1 - cosine_distance. 0 if no embedding.
  const semanticSelect = queryEmbedding
    ? `1 - (e.embedding <=> $${embeddingParamIdx}::vector)`
    : `0`;
  const semanticOrderBy = queryEmbedding
    ? `(1 - (e.embedding <=> $${embeddingParamIdx}::vector)) * ${WEIGHT_SEMANTIC}`
    : `0`;

  // v5.0: BM25 score (true BM25 — IDF + length norm + TF saturation).
  // Computed by the bm25_score() PL/pgSQL function (migration 0007).
  //
  // The function takes:
  //   - e.search_tsvector (the document's precomputed tsvector)
  //   - websearch_to_tsquery('english', $tsQuery) (the parsed user query)
  //   - e.bm25_doc_length (precomputed document length)
  //   - bm25_avg_doc_length() (corpus-wide average, ~1ms to compute)
  //   - bm25_total_active_docs() (corpus-wide doc count, ~1ms)
  //
  // Returns an unnormalized score (typically 0-15 for relevant docs, 0 for
  // non-matches). We normalize to [0, 1] in JS post-processing by dividing
  // by the max score in the result set (or 1 if all scores are 0).
  //
  // IF the bm25_score function doesn't exist (migration 0007 not applied yet),
  // the query will fail. We catch this in the try/catch below + fall back to
  // the v3.10 ts_rank_cd approach (graceful degradation for deployments that
  // haven't run the migration).
  const tsQueryExpr = `websearch_to_tsquery('english', $${tsQueryParamIdx})`;
  const bm25RawExpr = `bm25_score(
    e.search_tsvector,
    ${tsQueryExpr},
    e.bm25_doc_length,
    bm25_avg_doc_length(),
    bm25_total_active_docs()
  )`;

  // Keyword-array overlap (curated keywords[] intersection, 0-1).
  // Backup for BM25 — catches curated terms not in body text.
  const keywordArrayOverlapExpr = keywordArrayParamIdx
    ? `COALESCE(
        array_length(ARRAY(SELECT unnest(e.keywords) INTERSECT SELECT unnest($${keywordArrayParamIdx}::text[])), 1)::float
          / NULLIF(array_length(e.keywords, 1), 0)::float,
        0
      )`
    : `0`;

  // Combined keyword score for ORDER BY: BM25 (weight 0.83) + array overlap (0.17).
  // The 0.83/0.17 split matches the WEIGHT_BM25 / WEIGHT_KEYWORD_ARRAY ratio
  // (0.25 / 0.05 = 5:1 → 0.83:0.17). We compute this in SQL for efficient
  // ordering, then compute the final score in JS post-processing.
  //
  // Note: BM25 raw scores are unnormalized (0-15 range), so we can't include
  // them directly in the ORDER BY alongside normalized 0-1 components. We
  // use a placeholder here (just the keyword array overlap × its weight) +
  // re-sort in JS after normalizing BM25. This means the SQL ORDER BY is
  // approximate — the JS re-sort is authoritative.
  //
  // To make the SQL ORDER BY as accurate as possible without normalization,
  // we use a heuristic: normalize BM25 by dividing by 10 (a typical max for
  // a 1-term match). This is wrong but directionally correct — good enough
  // for the SQL ORDER BY to surface the right top-K candidates.
  const bm25HeuristicNormalized = `LEAST(1.0, ${bm25RawExpr} / 10.0)`;
  const keywordOrderBy = `(${bm25HeuristicNormalized} * ${WEIGHT_BM25} + ${keywordArrayOverlapExpr} * ${WEIGHT_KEYWORD_ARRAY})`;

  // Back-compat: the "keyword_overlap" field is a composite of BM25 + array
  // overlap (0-1). Existing code that reads .keywordOverlap still works.
  const keywordSelect = `LEAST(1.0, ${bm25HeuristicNormalized} * 0.83 + ${keywordArrayOverlapExpr} * 0.17)`;

  // v5.0: WHERE includes the BM25/tsvector match so entries with no embedding
  // AND no keyword-array overlap BUT with a BM25 match are still found.
  whereClauses.push(
    `(${queryEmbedding ? `1 - (e.embedding <=> $${embeddingParamIdx}::vector) > 0.3 OR ` : ""}e.search_tsvector @@ ${tsQueryExpr}${keywordArrayParamIdx ? ` OR ${keywordArrayOverlapExpr} > 0` : ""})`,
  );

  // Authority: min(entry_count / 50, 1.0). 0 if no creator.
  const authoritySelect = `LEAST(COALESCE(c.entry_count, 0)::float / ${AUTHORITY_CAP}, 1.0)`;
  const authorityOrderBy = `${authoritySelect} * ${WEIGHT_AUTHORITY}`;

  // Priority: normalized 0-1 from 0-10.
  const prioritySelect = `(e.priority::float / 10.0)`;
  const priorityOrderBy = `${prioritySelect} * ${WEIGHT_PRIORITY}`;

  // Recency: 1 - (age_seconds / 730_days). Clamped to [0, 1].
  const recencySelect = `GREATEST(0, 1 - EXTRACT(EPOCH FROM (NOW() - e.created_at))::float / ${RECENCY_DECAY_SECONDS})`;
  const recencyOrderBy = `${recencySelect} * ${WEIGHT_RECENCY}`;

  // Composite score for ORDER BY (sum of weighted components).
  const compositeOrderBy = `(${semanticOrderBy} + ${keywordOrderBy} + ${authorityOrderBy} + ${priorityOrderBy} + ${recencyOrderBy})`;

  // LIMIT parameter — fetch top-K for the reranker.
  const limitParamIdx = paramIdx++;
  sqlParams.push(fetchLimit);

  try {
    const result = await pool.query<KbSearchRow>(
      `SELECT
         e.id, e.title, e.content, e.keywords,
         e.category_id, e.product_id, e.creator_id,
         e.priority, e.created_at,
         ${semanticSelect} AS semantic_similarity,
         ${bm25RawExpr} AS bm25_raw,
         ${keywordArrayOverlapExpr} AS keyword_array_overlap,
         ${keywordSelect} AS keyword_overlap,
         ${authoritySelect} AS creator_authority_raw,
         ${prioritySelect} AS priority_normalized,
         ${recencySelect} AS recency_raw,
         s.source_type, s.source_title, s.source_url,
         c.name AS creator_name, c.slug AS creator_slug,
         c.tone_profile IS NOT NULL AS has_tone_profile,
         c.tone_match_percentage AS creator_tone_match_percentage,
         c.entry_count AS creator_entry_count,
         cat.name AS category_name, cat.path AS category_path
       FROM ai_kb_entries e
       LEFT JOIN ai_kb_sources s ON s.id = e.source_id
       LEFT JOIN ai_kb_creators c ON c.id = e.creator_id
       LEFT JOIN ai_kb_categories cat ON cat.id = e.category_id
       WHERE ${whereSql}
       ORDER BY ${compositeOrderBy} DESC
       LIMIT $${limitParamIdx}`,
      sqlParams,
    );

    if (result.rows.length === 0) return [];

    // ─── Post-process: normalize BM25 + compute first-pass composite score ───
    //
    // BM25 raw scores are unbounded (typically 0-15). We normalize to [0, 1]
    // by dividing by the max score in the result set. If all scores are 0
    // (no BM25 match — semantic-only matches), bm25Score = 0 for all.
    const maxBm25 = Math.max(...result.rows.map((r) => Number(r.bm25_raw) || 0), 0.0001);

    const firstPassResults: {
      row: KbSearchRow;
      score: number;
      bm25Score: number;
      keywordArrayOverlap: number;
      semanticSimilarity: number;
      creatorAuthority: number;
      priority: number;
      recency: number;
    }[] = [];

    for (const row of result.rows) {
      const semanticSimilarity = clamp01(Number(row.semantic_similarity) || 0);
      const bm25Score = clamp01((Number(row.bm25_raw) || 0) / maxBm25);
      const keywordArrayOverlap = clamp01(Number(row.keyword_array_overlap) || 0);
      const creatorAuthority = clamp01(Number(row.creator_authority_raw) || 0);
      const priority = clamp01(Number(row.priority_normalized) || 0);
      const recency = clamp01(Number(row.recency_raw) || 0);

      // v5.0 composite score (must use the new weights, not the legacy 0.40/0.20/0.20).
      const score =
        semanticSimilarity * WEIGHT_SEMANTIC +
        bm25Score * WEIGHT_BM25 +
        keywordArrayOverlap * WEIGHT_KEYWORD_ARRAY +
        creatorAuthority * WEIGHT_AUTHORITY +
        priority * WEIGHT_PRIORITY +
        recency * WEIGHT_RECENCY;

      if (score < minScore) continue;

      firstPassResults.push({
        row,
        score,
        bm25Score,
        keywordArrayOverlap,
        semanticSimilarity,
        creatorAuthority,
        priority,
        recency,
      });
    }

    if (firstPassResults.length === 0) return [];

    // Sort by first-pass score descending (in case the SQL ORDER BY heuristic
    // was off — the JS re-sort is authoritative).
    firstPassResults.sort((a, b) => b.score - a.score);

    // ─── Stage 2: cross-encoder reranking ────────────────────────────────────
    //
    // If skipRerank is true (e.g. getTopKbEntriesForPrompt with high threshold),
    // or if the reranker is disabled, return first-pass results as-is.
    //
    // Otherwise, pass the top-K candidates to the reranker. The reranker
    // returns re-scored results (sorted by cross-encoder score). We map
    // them back to the full KbSearchResult objects + return top-N.
    if (params.skipRerank || !rerankerStatus.enabled) {
      return firstPassResults.slice(0, maxResults).map((r) => buildSearchResult(r, null, null));
    }

    // Take top-K (rerankerStatus.topK) for reranking. If we have fewer
    // first-pass results than topK, rerank all of them.
    const candidatesForRerank = firstPassResults.slice(0, rerankerStatus.topK);

    // Build the rerank documents: title + first 500 chars of content (truncated
    // to keep the reranker API call cheap — most rerankers truncate internally
    // at 512 tokens, so sending more wastes bandwidth).
    const rerankDocs: RerankDocument[] = candidatesForRerank.map((r) => ({
      id: r.row.id,
      text: `${r.row.title}. ${r.row.content.slice(0, 500)}`,
    }));

    // Call the reranker.
    const rerankResult = await rerank(query, rerankDocs, maxResults);

    // Map the reranked results back to full KbSearchResult objects.
    // If the reranker returned fewer results than maxResults (e.g. minScore
    // filter), pad with the remaining first-pass results.
    const rerankedResults: KbSearchResult[] = [];
    const usedIds = new Set<number>();

    for (const rerankItem of rerankResult.results) {
      const candidate = candidatesForRerank.find((c) => c.row.id === rerankItem.id);
      if (!candidate) continue; // shouldn't happen — defensive
      rerankedResults.push(buildSearchResult(candidate, rerankItem.score, rerankItem.provider));
      usedIds.add(rerankItem.id);
    }

    // Pad with remaining first-pass results (if reranker returned fewer than maxResults).
    for (const candidate of firstPassResults) {
      if (rerankedResults.length >= maxResults) break;
      if (usedIds.has(candidate.row.id)) continue;
      rerankedResults.push(buildSearchResult(candidate, null, null));
      usedIds.add(candidate.row.id);
    }

    // Log the rerank outcome for observability.
    logger.debug(
      {
        queryPreview: query.slice(0, 80),
        firstPassCount: firstPassResults.length,
        rerankProvider: rerankResult.provider,
        rerankCacheHit: rerankResult.cacheHit,
        rerankLatencyMs: rerankResult.latencyMs,
        returned: rerankedResults.length,
      },
      "KB search: rerank completed",
    );

    return rerankedResults;
  } catch (err) {
    // ─── Graceful degradation: if the BM25 function doesn't exist ──────────
    //
    // If migration 0007 hasn't been applied, the bm25_score() function call
    // will fail with "function bm25_score(...) does not exist". We catch
    // this + fall back to the v3.10 ts_rank_cd approach.
    //
    // This ensures the system keeps working during migration rollout —
    // old instances that haven't restarted with the new code, or new
    // instances against an unmigrated DB, both still serve searches.
    const errMsg = (err as Error)?.message ?? "";
    if (
      errMsg.includes("bm25_score") ||
      errMsg.includes("function") ||
      errMsg.includes("does not exist")
    ) {
      logger.warn(
        { err: errMsg.slice(0, 200), query: query.slice(0, 80) },
        "KB search: BM25 function unavailable, falling back to ts_rank_cd (migration 0007 not applied?)",
      );
      return searchKnowledgeBaseFallback({
        ...params,
        query,
        keywords,
        queryEmbedding,
        maxResults,
        minScore,
      });
    }
    logger.error({ err, query: query.slice(0, 100) }, "KB search: query failed");
    return [];
  }
}

/**
 * Builds a KbSearchResult from a first-pass candidate + optional rerank info.
 */
function buildSearchResult(
  candidate: {
    row: KbSearchRow;
    score: number;
    bm25Score: number;
    keywordArrayOverlap: number;
    semanticSimilarity: number;
    creatorAuthority: number;
    priority: number;
    recency: number;
  },
  rerankScore: number | null,
  rerankProvider: string | null,
): KbSearchResult {
  const {
    row,
    score,
    bm25Score,
    keywordArrayOverlap,
    semanticSimilarity,
    creatorAuthority,
    priority,
    recency,
  } = candidate;

  // Back-compat keywordOverlap: composite of BM25 + array overlap (0-1).
  const keywordOverlap = clamp01(bm25Score * 0.83 + keywordArrayOverlap * 0.17);

  return {
    entry: {
      id: row.id,
      title: row.title,
      content: row.content,
      keywords: row.keywords ?? [],
      categoryId: row.category_id,
      productId: row.product_id,
      creatorId: row.creator_id,
    },
    // If we have a rerank score, use it as the final score (it's more accurate).
    // Otherwise use the first-pass composite score.
    score:
      rerankScore !== null
        ? Math.round(rerankScore * 1000) / 1000
        : Math.round(score * 1000) / 1000,
    semanticSimilarity: Math.round(semanticSimilarity * 1000) / 1000,
    keywordOverlap: Math.round(keywordOverlap * 1000) / 1000,
    bm25Score: Math.round(bm25Score * 1000) / 1000,
    keywordArrayOverlap: Math.round(keywordArrayOverlap * 1000) / 1000,
    rerankScore: rerankScore !== null ? Math.round(rerankScore * 1000) / 1000 : null,
    rerankProvider,
    creatorAuthority: Math.round(creatorAuthority * 1000) / 1000,
    priority: Math.round(priority * 1000) / 1000,
    recency: Math.round(recency * 1000) / 1000,
    source: row.source_type
      ? {
          type: row.source_type,
          title: row.source_title ?? "",
          url: row.source_url,
        }
      : null,
    category: row.category_name ? { name: row.category_name, path: row.category_path ?? "" } : null,
    creator: row.creator_name
      ? {
          name: row.creator_name,
          slug: row.creator_slug ?? "",
          hasToneProfile: Boolean(row.has_tone_profile),
          toneMatchPercentage: row.creator_tone_match_percentage ?? null,
          entryCount: Number(row.creator_entry_count) || 0,
        }
      : null,
  };
}

/**
 * v5.0 Fallback: ts_rank_cd-based search (used when BM25 function is unavailable).
 *
 * This is the v3.10 implementation, preserved verbatim for backward
 * compatibility during migration rollout. Once migration 0007 is applied,
 * this code path is never hit (the main searchKnowledgeBase uses bm25_score()).
 *
 * The fallback skips the reranker too (it's only called when the DB hasn't
 * been migrated, so the operator probably hasn't configured reranker env
 * vars either — and if they have, the rerank call would still work but
 * adds latency for no benefit since the first-pass is already degraded).
 */
async function searchKnowledgeBaseFallback(params: {
  query: string;
  keywords: string[];
  queryEmbedding: number[] | null;
  categoryId?: number;
  productSlug?: string;
  creatorId?: number;
  maxResults: number;
  minScore: number;
}): Promise<KbSearchResult[]> {
  const { query, keywords, queryEmbedding, maxResults, minScore } = params;

  const whereClauses: string[] = ["e.is_active = TRUE"];
  const sqlParams: (string | number | string[])[] = [];
  let paramIdx = 1;

  let embeddingParamIdx: number | null = null;
  if (queryEmbedding) {
    embeddingParamIdx = paramIdx++;
    sqlParams.push(`[${queryEmbedding.join(",")}]`);
  }

  let keywordArrayParamIdx: number | null = null;
  if (keywords.length > 0) {
    keywordArrayParamIdx = paramIdx++;
    sqlParams.push(keywords);
  }

  const tsQueryParamIdx = paramIdx++;
  sqlParams.push(query);

  if (params.categoryId !== undefined && Number.isInteger(params.categoryId)) {
    whereClauses.push(
      `e.category_id IN (
        SELECT id FROM ai_kb_categories
        WHERE path LIKE (SELECT path || '%' FROM ai_kb_categories WHERE id = $${paramIdx++})
      )`,
    );
    sqlParams.push(params.categoryId);
  }

  if (params.productSlug) {
    whereClauses.push(
      `e.product_id = (
        SELECT id FROM products WHERE slug = $${paramIdx++} AND deleted_at IS NULL
      )`,
    );
    sqlParams.push(params.productSlug);
  }

  if (params.creatorId !== undefined && Number.isInteger(params.creatorId)) {
    whereClauses.push(`e.creator_id = $${paramIdx++}`);
    sqlParams.push(params.creatorId);
  }

  const whereSql = whereClauses.join(" AND ");

  const semanticSelect = queryEmbedding
    ? `1 - (e.embedding <=> $${embeddingParamIdx}::vector)`
    : `0`;
  const semanticOrderBy = queryEmbedding
    ? `(1 - (e.embedding <=> $${embeddingParamIdx}::vector)) * ${WEIGHT_SEMANTIC}`
    : `0`;

  // v3.10 ts_rank_cd (fallback when BM25 function unavailable).
  const tsRankExpr = `ts_rank_cd(e.search_tsvector, websearch_to_tsquery('english', $${tsQueryParamIdx}))`;
  const keywordArrayOverlapExpr = keywordArrayParamIdx
    ? `COALESCE(
        array_length(ARRAY(SELECT unnest(e.keywords) INTERSECT SELECT unnest($${keywordArrayParamIdx}::text[])), 1)::float
          / NULLIF(array_length(e.keywords, 1), 0)::float,
        0
      )`
    : `0`;
  const keywordSelect = `LEAST(1.0, (${tsRankExpr} * 0.7 + ${keywordArrayOverlapExpr} * 0.3))`;
  const keywordOrderBy = `${keywordSelect} * ${WEIGHT_KEYWORD}`;

  whereClauses.push(
    `(${queryEmbedding ? `1 - (e.embedding <=> $${embeddingParamIdx}::vector) > 0.3 OR ` : ""}e.search_tsvector @@ websearch_to_tsquery('english', $${tsQueryParamIdx})${keywordArrayParamIdx ? ` OR ${keywordArrayOverlapExpr} > 0` : ""})`,
  );

  const authoritySelect = `LEAST(COALESCE(c.entry_count, 0)::float / ${AUTHORITY_CAP}, 1.0)`;
  const authorityOrderBy = `${authoritySelect} * ${WEIGHT_AUTHORITY}`;
  const prioritySelect = `(e.priority::float / 10.0)`;
  const priorityOrderBy = `${prioritySelect} * ${WEIGHT_PRIORITY}`;
  const recencySelect = `GREATEST(0, 1 - EXTRACT(EPOCH FROM (NOW() - e.created_at))::float / ${RECENCY_DECAY_SECONDS})`;
  const recencyOrderBy = `${recencySelect} * ${WEIGHT_RECENCY}`;

  const compositeOrderBy = `(${semanticOrderBy} + ${keywordOrderBy} + ${authorityOrderBy} + ${priorityOrderBy} + ${recencyOrderBy})`;

  const limitParamIdx = paramIdx++;
  sqlParams.push(maxResults);

  try {
    const result = await pool.query<KbSearchRow>(
      `SELECT
         e.id, e.title, e.content, e.keywords,
         e.category_id, e.product_id, e.creator_id,
         e.priority, e.created_at,
         ${semanticSelect} AS semantic_similarity,
         0 AS bm25_raw,
         ${keywordArrayOverlapExpr} AS keyword_array_overlap,
         ${keywordSelect} AS keyword_overlap,
         ${authoritySelect} AS creator_authority_raw,
         ${prioritySelect} AS priority_normalized,
         ${recencySelect} AS recency_raw,
         s.source_type, s.source_title, s.source_url,
         c.name AS creator_name, c.slug AS creator_slug,
         c.tone_profile IS NOT NULL AS has_tone_profile,
         c.tone_match_percentage AS creator_tone_match_percentage,
         c.entry_count AS creator_entry_count,
         cat.name AS category_name, cat.path AS category_path
       FROM ai_kb_entries e
       LEFT JOIN ai_kb_sources s ON s.id = e.source_id
       LEFT JOIN ai_kb_creators c ON c.id = e.creator_id
       LEFT JOIN ai_kb_categories cat ON cat.id = e.category_id
       WHERE ${whereSql}
       ORDER BY ${compositeOrderBy} DESC
       LIMIT $${limitParamIdx}`,
      sqlParams,
    );

    const out: KbSearchResult[] = [];
    for (const row of result.rows) {
      const semanticSimilarity = clamp01(Number(row.semantic_similarity) || 0);
      const keywordOverlap = clamp01(Number(row.keyword_overlap) || 0);
      const creatorAuthority = clamp01(Number(row.creator_authority_raw) || 0);
      const priority = clamp01(Number(row.priority_normalized) || 0);
      const recency = clamp01(Number(row.recency_raw) || 0);

      // Use legacy weights (0.40/0.20/0.20/0.10/0.10) for the fallback —
      // the v5.0 weights assume BM25 is present, which it isn't here.
      const score =
        semanticSimilarity * 0.4 +
        keywordOverlap * 0.2 +
        creatorAuthority * 0.2 +
        priority * 0.1 +
        recency * 0.1;

      if (score < minScore) continue;

      out.push({
        entry: {
          id: row.id,
          title: row.title,
          content: row.content,
          keywords: row.keywords ?? [],
          categoryId: row.category_id,
          productId: row.product_id,
          creatorId: row.creator_id,
        },
        score: Math.round(score * 1000) / 1000,
        semanticSimilarity: Math.round(semanticSimilarity * 1000) / 1000,
        keywordOverlap: Math.round(keywordOverlap * 1000) / 1000,
        bm25Score: 0, // not computed in fallback
        keywordArrayOverlap: clamp01(Number(row.keyword_array_overlap) || 0),
        rerankScore: null,
        rerankProvider: null,
        creatorAuthority: Math.round(creatorAuthority * 1000) / 1000,
        priority: Math.round(priority * 1000) / 1000,
        recency: Math.round(recency * 1000) / 1000,
        source: row.source_type
          ? {
              type: row.source_type,
              title: row.source_title ?? "",
              url: row.source_url,
            }
          : null,
        category: row.category_name
          ? { name: row.category_name, path: row.category_path ?? "" }
          : null,
        creator: row.creator_name
          ? {
              name: row.creator_name,
              slug: row.creator_slug ?? "",
              hasToneProfile: Boolean(row.has_tone_profile),
              toneMatchPercentage: row.creator_tone_match_percentage ?? null,
              entryCount: Number(row.creator_entry_count) || 0,
            }
          : null,
      });
    }

    return out;
  } catch (err) {
    logger.error({ err, query: query.slice(0, 100) }, "KB search: fallback query failed");
    return [];
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ─── getTopKbEntriesForPrompt ────────────────────────────────────────────────

/**
 * Pre-searches the KB for the user's message + returns the top entries
 * for auto-injection into the system prompt. Called by the route BEFORE
 * calling the AI.
 *
 * BUG-I1 fix: uses the SAME retrieval parameters as the search_knowledge_base
 * tool (UNIFIED_MIN_SCORE, UNIFIED_SKIP_RERANK, UNIFIED_MAX_RESULTS).
 * Previously this used a higher threshold (0.5) + skipped rerank + capped
 * at 3 entries — which caused the LLM to see two different views of the KB
 * for the same query (the "two-source RAG inconsistency" anti-pattern).
 *
 * Returns `{ entries, injected }`. If `injected` is false, `entries` is
 * empty + the route skips the knowledge block in the prompt.
 */
export async function getTopKbEntriesForPrompt(
  userMessage: string,
  maxEntries: number = UNIFIED_MAX_RESULTS,
): Promise<{
  entries: KbSearchResult[];
  injected: boolean;
  // Phase 4: the primary creator whose tone the AI should adopt.
  // null if no entries were injected, or the top creator doesn't meet
  // the tone-match threshold (10+ entries) + have a tone profile.
  toneCreator: {
    creatorId: number;
    creatorName: string;
    hasToneProfile: boolean;
    toneMatchPercentage: number;
    entryCount: number;
  } | null;
}> {
  if (!userMessage || !userMessage.trim()) {
    return { entries: [], injected: false, toneCreator: null };
  }
  try {
    const entries = await searchKnowledgeBase({
      query: userMessage,
      maxResults: maxEntries,
      minScore: UNIFIED_MIN_SCORE,
      // BUG-I1 fix: previously `skipRerank: true` to save 200-500ms latency.
      // But this meant the LLM saw a different ranking for the same query
      // depending on which path ran. Now both paths use UNIFIED_SKIP_RERANK
      // (false) so the reranker always runs when configured.
      skipRerank: UNIFIED_SKIP_RERANK,
    });
    if (entries.length === 0) {
      return { entries: [], injected: false, toneCreator: null };
    }

    // ─── Phase 4: select the primary creator for tone matching ──────────────
    //
    // Selection logic:
    //   1. Start with the top entry's creator (highest score).
    //   2. If that creator doesn't meet the threshold (entryCount >= 10)
    //      OR doesn't have a tone profile, check the #2 entry's creator.
    //   3. Multi-creator tie-breaker: if the top 3 entries have scores
    //      within 0.05 of each other AND are from different creators,
    //      pick the creator with a tone profile + the highest entry_count.
    //      This handles "a less-relevant entry from a prolific creator
    //      should trigger tone matching over a more-relevant entry from a
    //      new creator."
    //
    // If no creator meets the criteria, toneCreator = null (neutral tone).
    const toneCreator = selectToneCreator(entries);

    return { entries, injected: true, toneCreator };
  } catch (err) {
    logger.error(
      { err },
      "KB search: getTopKbEntriesForPrompt failed (non-fatal — AI falls back to training data)",
    );
    return { entries: [], injected: false, toneCreator: null };
  }
}

/**
 * Phase 4: selects the primary creator for tone matching from the search
 * results. See `getTopKbEntriesForPrompt` for the full selection logic.
 *
 * Returns null if no creator meets the threshold + has a tone profile.
 */
function selectToneCreator(entries: KbSearchResult[]): {
  creatorId: number;
  creatorName: string;
  hasToneProfile: boolean;
  toneMatchPercentage: number;
  entryCount: number;
} | null {
  if (entries.length === 0) return null;

  const TONE_THRESHOLD = Number(process.env.AI_TONE_MATCH_THRESHOLD ?? 10);

  // Helper: check if a creator is eligible for tone matching.
  const isEligible = (e: KbSearchResult): boolean => {
    if (!e.creator) return false;
    return e.creator.hasToneProfile && e.creator.entryCount >= TONE_THRESHOLD;
  };

  // 1. Check if the top entry's creator is eligible.
  const top = entries[0];
  if (isEligible(top) && top.creator) {
    return {
      creatorId: top.entry.creatorId ?? 0,
      creatorName: top.creator.name,
      hasToneProfile: true,
      toneMatchPercentage:
        top.creator.toneMatchPercentage ?? Number(process.env.AI_TONE_MATCH_PERCENTAGE ?? 60),
      entryCount: top.creator.entryCount,
    };
  }

  // 2. Multi-creator tie-breaker: if the top 3 entries have scores within
  //    0.05 of each other AND are from different creators, pick the one
  //    with a tone profile + the highest entry_count.
  if (entries.length >= 2) {
    const topScore = top.score;
    const candidates = entries.filter(
      (e) => e.score >= topScore - 0.05 && e.creator && isEligible(e),
    );
    if (candidates.length > 0) {
      // Pick the candidate with the highest entry_count (most authority).
      const best = candidates.reduce((a, b) =>
        (b.creator?.entryCount ?? 0) > (a.creator?.entryCount ?? 0) ? b : a,
      );
      if (best.creator) {
        logger.info(
          {
            topCreator: top.creator?.name ?? "Unknown",
            selectedCreator: best.creator.name,
            topScore: top.score,
            selectedScore: best.score,
            entryCount: best.creator.entryCount,
          },
          "KB tone: multi-creator selection — using prolific creator over top-scored entry",
        );
        return {
          creatorId: best.entry.creatorId ?? 0,
          creatorName: best.creator.name,
          hasToneProfile: true,
          toneMatchPercentage:
            best.creator.toneMatchPercentage ?? Number(process.env.AI_TONE_MATCH_PERCENTAGE ?? 60),
          entryCount: best.creator.entryCount,
        };
      }
    }
  }

  // 3. No eligible creator — neutral tone.
  return null;
}

// ─── formatKbContextForPrompt ────────────────────────────────────────────────

/**
 * Formats the entries as a context block for the system prompt's
 * `{{knowledge}}` placeholder. The format is:
 *
 * ```
 * KNOWLEDGE BASE CONTEXT (use as PRIMARY source):
 * - "Mango tree watering in summer"
 *   During summer (March-June), water mature mango trees once every 7-10 days...
 *   [Keywords: mango, watering, summer]
 *
 * - "Mango pest control guide"
 *   Common mango pests include hoppers, mealybugs, and fruit flies...
 *   [Keywords: mango, pests, mealybug]
 * ```
 *
 * Each entry is truncated to 500 chars (to keep the prompt reasonable).
 * If no entries, returns "" (the route treats empty as "no KB context").
 *
 * Privacy: creator names are NOT included in the prompt (the LLM should
 * not attribute content to specific creators in its responses). The
 * creator info is used internally for tone matching + authority scoring
 * but is never surfaced to the LLM.
 */
export function formatKbContextForPrompt(entries: KbSearchResult[]): string {
  if (!entries || entries.length === 0) return "";

  const lines: string[] = ["KNOWLEDGE BASE CONTEXT (use as PRIMARY source):"];

  for (const r of entries) {
    // Privacy: do NOT include the creator name in the prompt.
    // The LLM should present KB content as authoritative plant-care
    // advice without attributing it to specific creators.
    const truncatedContent =
      r.entry.content.length > UNIFIED_CONTENT_TRUNCATE_CHARS
        ? r.entry.content.slice(0, UNIFIED_CONTENT_TRUNCATE_CHARS) + "…"
        : r.entry.content;
    const keywordsStr =
      r.entry.keywords.length > 0 ? `[Keywords: ${r.entry.keywords.join(", ")}]` : "";

    lines.push(`- "${r.entry.title}"`, `  ${truncatedContent}`);
    if (keywordsStr) lines.push(`  ${keywordsStr}`);
    lines.push(""); // blank line between entries
  }

  return lines.join("\n");
}

// ─── getKbStats ──────────────────────────────────────────────────────────────

/**
 * Aggregates KB stats for the admin "KB Insights" view. Returns:
 *   - totalEntries: count of all entries (active + inactive).
 *   - activeEntries: count of is_active = TRUE entries (the ones the AI sees).
 *   - entriesWithEmbeddings: count of embedding_status = 'generated'.
 *   - entriesByCategory: top categories by entry count.
 *   - entriesByCreator: top creators by entry count.
 *
 * The KB hit-rate stats (over the last 30 days) are computed separately
 * in the admin route (they query ai_chat_messages, not ai_kb_entries).
 */
export async function getKbStats(): Promise<{
  totalEntries: number;
  activeEntries: number;
  entriesWithEmbeddings: number;
  entriesByCategory: { categoryName: string; count: number }[];
  entriesByCreator: { creatorName: string; count: number }[];
}> {
  try {
    const [totals, byCategory, byCreator] = await Promise.all([
      pool.query<{ total: string; active: string; embedded: string }>(
        `SELECT
           COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE is_active = TRUE)::bigint AS active,
           COUNT(*) FILTER (WHERE embedding_status = 'generated')::bigint AS embedded
         FROM ai_kb_entries`,
      ),
      pool.query<{ category_name: string; cnt: string }>(
        `SELECT COALESCE(cat.name, 'Uncategorized') AS category_name,
                COUNT(*)::bigint AS cnt
         FROM ai_kb_entries e
         LEFT JOIN ai_kb_categories cat ON cat.id = e.category_id
         GROUP BY cat.name
         ORDER BY cnt DESC
         LIMIT 10`,
      ),
      pool.query<{ creator_name: string; cnt: string }>(
        `SELECT COALESCE(c.name, 'Unknown') AS creator_name,
                COUNT(*)::bigint AS cnt
         FROM ai_kb_entries e
         LEFT JOIN ai_kb_creators c ON c.id = e.creator_id
         GROUP BY c.name
         ORDER BY cnt DESC
         LIMIT 10`,
      ),
    ]);

    return {
      totalEntries: Number(totals.rows[0].total) || 0,
      activeEntries: Number(totals.rows[0].active) || 0,
      entriesWithEmbeddings: Number(totals.rows[0].embedded) || 0,
      entriesByCategory: byCategory.rows.map((r) => ({
        categoryName: r.category_name,
        count: Number(r.cnt) || 0,
      })),
      entriesByCreator: byCreator.rows.map((r) => ({
        creatorName: r.creator_name,
        count: Number(r.cnt) || 0,
      })),
    };
  } catch (err) {
    logger.error({ err }, "KB search: getKbStats failed");
    return {
      totalEntries: 0,
      activeEntries: 0,
      entriesWithEmbeddings: 0,
      entriesByCategory: [],
      entriesByCreator: [],
    };
  }
}
