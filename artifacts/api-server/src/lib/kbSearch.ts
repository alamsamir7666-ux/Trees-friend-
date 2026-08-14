/**
 * KB search + retrieval engine (Phase 3).
 *
 * The core retrieval module that powers Phase 3's AI integration:
 *   1. `searchKnowledgeBase` — hybrid semantic + keyword search with a
 *      composite score (semantic 0.40 + keyword 0.20 + authority 0.20 +
 *      priority 0.10 + recency 0.10). Used by the `search_knowledge_base`
 *      tool (called by the AI on-demand) + by the admin search tester.
 *   2. `getTopKbEntriesForPrompt` — pre-searches the KB for the user's
 *      message + returns the top 3 entries (with a HIGHER threshold of
 *      0.5) for auto-injection into the system prompt. The AI uses
 *      these as its primary source; if no high-confidence match, the AI
 *      can still call the tool on-demand.
 *   3. `formatKbContextForPrompt` — formats the entries as a context
 *      block for the `{{knowledge}}` placeholder in the system prompt.
 *   4. `getKbStats` — aggregates stats for the admin "KB Insights" view.
 *
 * ─── Hybrid search: why both semantic + keyword? ────────────────────────────
 *
 * Semantic (pgvector cosine) catches PARAPHRASES — "how often to water"
 * matches "watering frequency" because the embeddings are close in
 * vector space. But it can MISS exact-term matches (rare plant names,
 * specific chemical names) where the embedding doesn't capture the
 * specificity. Keyword overlap (entry.keywords ∩ query tokens) catches
 * those exact matches.
 *
 * The composite score weights semantic highest (0.40) because it's the
 * best signal for "is this entry about what the user is asking?".
 * Keyword (0.20) is a tie-breaker + catches exact matches. Authority
 * (0.20, based on creator entry_count) prioritizes prolific creators.
 * Priority (0.10) + recency (0.10) are minor tie-breakers.
 *
 * ─── pgvector query pattern ─────────────────────────────────────────────────
 *
 * Same as embeddingCache.ts (the semantic cache): we pass the query
 * embedding as a string `[0.1, 0.2, ...]` and cast it with `$1::vector`.
 * The HNSW index (created in Phase 2) makes the cosine search fast
 * (sub-millisecond on 10K entries).
 *
 * ─── Fallback: keyword-only search ──────────────────────────────────────────
 *
 * If the Gemini embedding API is unavailable (no API key) or rate-limited
 * (429), we fall back to keyword-only search — set `semanticSimilarity = 0`
 * + skip the vector column in the query. The composite score still works
 * (just weighted toward keyword + authority + priority + recency). This
 * ensures the KB is always searchable, even if the embedding API is down.
 */
import { GoogleGenAI } from "@google/genai";
import { pool } from "@workspace/db";
import { logger } from "./logger";

// ─── Constants ───────────────────────────────────────────────────────────────

const EMBEDDING_MODEL = "text-embedding-004";
const MAX_QUERY_CHARS = 2000; // Gemini's embedding token limit
const MAX_RESULTS_DEFAULT = 5;
const MAX_RESULTS_CAP = 10;
const MIN_SCORE_DEFAULT = 0.3; // tool threshold — filter out low-relevance
const MIN_SCORE_AUTO_INJECT = 0.5; // higher bar for prompt injection
const MAX_AUTO_INJECT_ENTRIES = 3;

// Composite scoring weights (must sum to 1.0).
// See file header for the rationale.
const WEIGHT_SEMANTIC = 0.40;
const WEIGHT_KEYWORD = 0.20;
const WEIGHT_AUTHORITY = 0.20;
const WEIGHT_PRIORITY = 0.10;
const WEIGHT_RECENCY = 0.10;

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
  score: number; // composite score (0-1)
  semanticSimilarity: number; // 0-1 (cosine)
  keywordOverlap: number; // 0-1
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
 * Generates an embedding for the user's query (NOT the document — we use
 * RETRIEVAL_QUERY here, asymmetric to the entries' RETRIEVAL_DOCUMENT
 * embeddings from Phase 2). Returns null on failure (no API key, rate
 * limit, etc.) — the caller falls back to keyword-only search.
 */
async function generateQueryEmbedding(query: string): Promise<number[] | null> {
  const client = getEmbeddingClient();
  if (!client) return null;

  try {
    const result = await client.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: query.slice(0, MAX_QUERY_CHARS),
      config: {
        // RETRIEVAL_QUERY — optimized for finding matching documents.
        // The entries were embedded with RETRIEVAL_DOCUMENT (Phase 2).
        // Mixing these up would degrade search quality significantly.
        taskType: "RETRIEVAL_QUERY" as never,
      },
    });

    const values = (result as { embeddings?: Array<{ values?: number[] }> })?.embeddings?.[0]?.values;
    if (!Array.isArray(values) || values.length === 0) {
      logger.warn("KB search: query embedding returned empty values");
      return null;
    }
    return values as number[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("429") || msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("rate limit")) {
      logger.warn("KB search: query embedding rate-limited (falling back to keyword-only)");
    } else {
      logger.warn({ err: msg }, "KB search: query embedding failed (falling back to keyword-only)");
    }
    return null;
  }
}

// ─── Keyword extraction (mirrors aiContext.ts extractSearchTokens) ───────────

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "can", "i", "you", "he",
  "she", "it", "we", "they", "this", "that", "these", "those", "what",
  "which", "who", "when", "where", "why", "how", "of", "in", "on", "at",
  "to", "for", "with", "from", "by", "about", "into", "through", "during",
  "before", "after", "above", "below", "between", "under", "over", "again",
  "further", "then", "once", "here", "there", "all", "any", "both", "each",
  "few", "more", "most", "other", "some", "such", "no", "nor", "not",
  "only", "own", "same", "so", "than", "too", "very", "s", "t", "just",
  "don", "now", "my", "your", "his", "her", "its", "our", "their",
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
  const tokens = query
    .toLowerCase()
    .match(/[a-z]{3,}|[\u0980-\u09ff]{2,}/gi) ?? [];
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
  keyword_overlap: number | string;
  creator_authority_raw: number | string;
  priority_normalized: number | string;
  recency_raw: number | string;
  source_type: string | null;
  source_title: string | null;
  source_url: string | null;
  creator_name: string | null;
  creator_slug: string | null;
  category_name: string | null;
  category_path: string | null;
}

// ─── searchKnowledgeBase ─────────────────────────────────────────────────────

/**
 * Searches the KB for entries matching the query. Combines semantic
 * (pgvector cosine) + keyword (array overlap) search with a composite
 * score, then returns the top N results above `minScore`.
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
 * The post-processing in JS just normalizes the raw values + applies the
 * weighted sum + filters by minScore.
 */
export async function searchKnowledgeBase(params: {
  query: string;
  categoryId?: number;
  productSlug?: string;
  creatorId?: number;
  maxResults?: number;
  minScore?: number;
}): Promise<KbSearchResult[]> {
  const query = (params.query ?? "").trim();
  if (!query) return [];

  const maxResults = Math.min(
    Math.max(params.maxResults ?? MAX_RESULTS_DEFAULT, 1),
    MAX_RESULTS_CAP,
  );
  const minScore = params.minScore ?? MIN_SCORE_DEFAULT;

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
  // We reserve paramIdx 1 for the embedding (it's always first if present).
  let embeddingParamIdx: number | null = null;
  if (queryEmbedding) {
    embeddingParamIdx = paramIdx++;
    sqlParams.push(`[${queryEmbedding.join(",")}]`);
  }

  // Keyword array: pass as a Postgres array literal. Used for the
  // keyword_overlap computation (ARRAY(SELECT unnest(e.keywords) INTERSECT
  // SELECT unnest($n::text[]))).
  let keywordArrayParamIdx: number | null = null;
  if (keywords.length > 0) {
    keywordArrayParamIdx = paramIdx++;
    sqlParams.push(keywords);
  }

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

  // Build the SELECT expressions for semantic similarity + keyword overlap.
  // If no embedding, semantic_similarity = 0 (keyword-only search).
  const semanticSelect = queryEmbedding
    ? `1 - (e.embedding <=> $${embeddingParamIdx}::vector)`
    : `0`;
  const semanticOrderBy = queryEmbedding
    ? `(1 - (e.embedding <=> $${embeddingParamIdx}::vector)) * ${WEIGHT_SEMANTIC}`
    : `0`;

  // Keyword overlap: fraction of the entry's keywords that appear in the
  // query's keyword array. 0 if no query keywords or entry has no keywords.
  // Using COALESCE + NULLIF to avoid division by zero.
  const keywordSelect = keywordArrayParamIdx
    ? `COALESCE(
        array_length(ARRAY(SELECT unnest(e.keywords) INTERSECT SELECT unnest($${keywordArrayParamIdx}::text[])), 1)::float
          / NULLIF(array_length(e.keywords, 1), 0)::float,
        0
      )`
    : `0`;
  const keywordOrderBy = `${keywordSelect} * ${WEIGHT_KEYWORD}`;

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

  // LIMIT parameter.
  const limitParamIdx = paramIdx++;
  sqlParams.push(maxResults);

  try {
    const result = await pool.query<KbSearchRow>(
      `SELECT
         e.id, e.title, e.content, e.keywords,
         e.category_id, e.product_id, e.creator_id,
         e.priority, e.created_at,
         ${semanticSelect} AS semantic_similarity,
         ${keywordSelect} AS keyword_overlap,
         ${authoritySelect} AS creator_authority_raw,
         ${prioritySelect} AS priority_normalized,
         ${recencySelect} AS recency_raw,
         s.source_type, s.source_title, s.source_url,
         c.name AS creator_name, c.slug AS creator_slug,
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

    // Post-process: normalize + filter by minScore.
    const out: KbSearchResult[] = [];
    for (const row of result.rows) {
      const semanticSimilarity = clamp01(Number(row.semantic_similarity) || 0);
      const keywordOverlap = clamp01(Number(row.keyword_overlap) || 0);
      const creatorAuthority = clamp01(Number(row.creator_authority_raw) || 0);
      const priority = clamp01(Number(row.priority_normalized) || 0);
      const recency = clamp01(Number(row.recency_raw) || 0);

      const score =
        semanticSimilarity * WEIGHT_SEMANTIC +
        keywordOverlap * WEIGHT_KEYWORD +
        creatorAuthority * WEIGHT_AUTHORITY +
        priority * WEIGHT_PRIORITY +
        recency * WEIGHT_RECENCY;

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
        score: Math.round(score * 1000) / 1000, // 3 decimal places
        semanticSimilarity: Math.round(semanticSimilarity * 1000) / 1000,
        keywordOverlap: Math.round(keywordOverlap * 1000) / 1000,
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
          ? { name: row.creator_name, slug: row.creator_slug ?? "" }
          : null,
      });
    }

    return out;
  } catch (err) {
    logger.error({ err, query: query.slice(0, 100) }, "KB search: query failed");
    return [];
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ─── getTopKbEntriesForPrompt ────────────────────────────────────────────────

/**
 * Pre-searches the KB for the user's message + returns the top 3 entries
 * (with a HIGHER threshold of 0.5) for auto-injection into the system
 * prompt. Called by the route BEFORE calling the AI.
 *
 * Why a higher threshold? We don't want to inject irrelevant entries
 * into the prompt — that wastes tokens + confuses the AI. If no entry
 * scores above 0.5, we don't inject anything (the AI can still call the
 * search_knowledge_base tool on-demand).
 *
 * Returns `{ entries, injected }`. If `injected` is false, `entries` is
 * empty + the route skips the knowledge block in the prompt.
 */
export async function getTopKbEntriesForPrompt(
  userMessage: string,
  maxEntries: number = MAX_AUTO_INJECT_ENTRIES,
): Promise<{ entries: KbSearchResult[]; injected: boolean }> {
  if (!userMessage || !userMessage.trim()) {
    return { entries: [], injected: false };
  }
  try {
    const entries = await searchKnowledgeBase({
      query: userMessage,
      maxResults: maxEntries,
      minScore: MIN_SCORE_AUTO_INJECT,
    });
    return { entries, injected: entries.length > 0 };
  } catch (err) {
    logger.error({ err }, "KB search: getTopKbEntriesForPrompt failed (non-fatal — AI falls back to training data)");
    return { entries: [], injected: false };
  }
}

// ─── formatKbContextForPrompt ────────────────────────────────────────────────

/**
 * Formats the entries as a context block for the system prompt's
 * `{{knowledge}}` placeholder. The format is:
 *
 * ```
 * KNOWLEDGE BASE CONTEXT (use as PRIMARY source — cite the creator):
 * - "Mango tree watering in summer" (Green Garden BD — YouTube)
 *   During summer (March-June), water mature mango trees once every 7-10 days...
 *   [Keywords: mango, watering, summer]
 *
 * - "Mango pest control guide" (Plant Care BD — Blog)
 *   Common mango pests include hoppers, mealybugs, and fruit flies...
 *   [Keywords: mango, pests, mealybug]
 * ```
 *
 * Each entry is truncated to 500 chars (to keep the prompt reasonable).
 * If no entries, returns "" (the route treats empty as "no KB context").
 */
export function formatKbContextForPrompt(entries: KbSearchResult[]): string {
  if (!entries || entries.length === 0) return "";

  const lines: string[] = [
    "KNOWLEDGE BASE CONTEXT (use as PRIMARY source — cite the creator):",
  ];

  for (const r of entries) {
    const creatorName = r.creator?.name ?? "Unknown";
    const sourceType = r.source?.type ?? "manual";
    const truncatedContent =
      r.entry.content.length > 500
        ? r.entry.content.slice(0, 500) + "…"
        : r.entry.content;
    const keywordsStr = r.entry.keywords.length > 0
      ? `[Keywords: ${r.entry.keywords.join(", ")}]`
      : "";

    lines.push(
      `- "${r.entry.title}" (${creatorName} — ${sourceType})`,
      `  ${truncatedContent}`,
    );
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
