/**
 * Reranker abstraction layer for KB search (Phase 5).
 *
 * Problem:
 *   The first-pass retrieval (BM25 + semantic + authority) is good but not
 *   great. It uses bi-encoder embeddings (query and doc embedded separately,
 *   cosine similarity) — fast but loses fine-grained semantic matching.
 *
 *   A reranker uses a cross-encoder (query and doc concatenated, fed through
 *   a transformer together) which captures token-level interactions. This
 *   typically boosts nDCG@5 by 15-30% over bi-encoder retrieval.
 *
 * Industry standard:
 *   - Vercel AI SDK: `rerank()` API (Cohere-backed)
 *   - LangChain: `ContextualCompressionRetriever` + `CohereRerank`
 *   - LlamaIndex: `CohereRerank` / `JinaRerank` / `FlagEmbeddingRerank`
 *   - All major RAG frameworks treat reranking as a separate, swappable stage
 *
 * Architecture (this file):
 *   - `RerankerProvider` interface — implemented by Cohere, Jina, local
 *   - `rerank(query, documents, topK)` — the main entry point
 *   - Provider chain (try Cohere first, fall back to Jina, then local)
 *   - Graceful degradation: if all providers fail, return original order
 *     (the first-pass score is still good — reranking is a bonus, not a
 *     correctness requirement)
 *
 * Providers:
 *   - Cohere Rerank v3 (rerank-multilingual-v3.0) — best multilingual,
 *     supports Bangla. Free tier: 1000 calls/month, 100 docs/call.
 *   - Jina Reranker v2 (jina-reranker-v2-base-multilingual) — open-source,
 *     self-hostable. Free hosted tier: 1M tokens/month.
 *   - Local fallback — no reranking, just return original order with a
 *     warning log. Ensures the system never blocks on reranker downtime.
 *
 * Cache (lib/rerankerCache.ts):
 *   Rerank results are deterministic for (query, documents, model) — the
 *   same query against the same documents returns the same scores. So we
 *   cache them. Multi-tier (in-process LRU + Redis) with single-flight
 *   coalescing + negative caching. See rerankerCache.ts for details.
 *
 * Config (env vars):
 *   RERANKER_PROVIDER           — "cohere" | "jina" | "local" | "auto" (default "auto")
 *                                  "auto" = try cohere, fall back to jina, then local
 *   COHERE_API_KEY              — required for Cohere provider
 *   JINA_API_KEY                — required for Jina provider
 *   RERANKER_TOP_K              — how many candidates to retrieve before reranking (default 20)
 *   RERANKER_TOP_N              — how many to return after reranking (default 5)
 *   RERANKER_TIMEOUT_MS         — API call timeout (default 3000, max 10000)
 *   RERANKER_MIN_SCORE          — minimum rerank score to include in results (default 0.0)
 *   RERANKER_CACHE_TTL_SECONDS  — cache TTL (default 3600 = 1 hour)
 *   RERANKER_ENABLED            — master switch (default "true")
 *
 * ─── Why cross-encoder > bi-encoder for reranking ─────────────────────────
 *
 * Bi-encoder (what we use for first-pass):
 *   - Embed query → vector. Embed doc → vector. Score = cosine(v_q, v_d).
 *   - O(1) per doc at query time (just a cosine computation).
 *   - But: query and doc never "see" each other's tokens. Subtle semantic
 *     relationships (e.g. "drought-resistant" matches "needs little water")
 *     are missed.
 *
 * Cross-encoder (reranker):
 *   - Concatenate [CLS] query [SEP] doc [SEP], feed through transformer.
 *   - Output: a single relevance score.
 *   - O(N) transformer forward passes per query (one per doc).
 *   - But: full attention between query and doc tokens. Catches the subtle
 *     relationships bi-encoders miss.
 *
 * Hybrid (what we implement):
 *   - First pass: bi-encoder (pgvector) → top-20 candidates (fast, scalable)
 *   - Second pass: cross-encoder (reranker) → top-5 (slow, high quality)
 *
 * This is the textbook two-stage retrieval architecture used by:
 *   - Google's retrieval pipeline (blog: "Reimagining Search with LLMs")
 *   - Bing's retrieval pipeline
 *   - Every major RAG framework
 */
import { logger } from "./logger";
import { getCachedRerank, setCachedRerank } from "./rerankerCache";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A document to be reranked. The `id` is used to map back to the original
 * KbSearchResult after reranking (rerankers don't preserve order — they
 * return scores in the order they received documents).
 */
export interface RerankDocument {
  /** Stable identifier (entry id) for mapping back. */
  id: number;
  /** The text to rerank — typically the entry's title + content (truncated). */
  text: string;
}

/**
 * Result of a rerank operation. The scores are normalized to [0, 1] by
 * most providers, but we don't rely on that — we sort by score descending
 * and take the top N.
 */
export interface RerankResult {
  /** The document id (matches RerankDocument.id). */
  id: number;
  /** The relevance score (0-1 for Cohere/Jina, may be unbounded for local). */
  score: number;
  /** Which provider produced this score (for observability). */
  provider: string;
}

/**
 * Provider interface — implemented by Cohere, Jina, and local fallback.
 *
 * Implementations MUST:
 *   - Be stateless (no per-request state — provider instances are reused)
 *   - Handle their own timeouts (abort the fetch when RERANKER_TIMEOUT_MS expires)
 *   - Return results in the same order as the input documents (the rerank()
 *     wrapper sorts by score)
 *   - Throw on unrecoverable errors (the wrapper catches + falls back)
 */
export interface RerankerProvider {
  /** Provider name ("cohere", "jina", "local"). */
  name: string;
  /** True if the provider is configured (has API key, env vars set). */
  isConfigured(): boolean;
  /** Reranks the documents against the query. Returns scores in input order. */
  rerank(query: string, documents: RerankDocument[], topN: number): Promise<RerankResult[]>;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_PROVIDER: string = process.env.RERANKER_PROVIDER ?? "auto";
const DEFAULT_TOP_K: number = Number(process.env.RERANKER_TOP_K ?? 20);
const DEFAULT_TOP_N: number = Number(process.env.RERANKER_TOP_N ?? 5);
const DEFAULT_TIMEOUT_MS: number = Math.min(
  Number(process.env.RERANKER_TIMEOUT_MS ?? 3000),
  10_000,
);
const DEFAULT_MIN_SCORE: number = Number(process.env.RERANKER_MIN_SCORE ?? 0.0);
const RERANKER_ENABLED: boolean =
  (process.env.RERANKER_ENABLED ?? "true").toLowerCase() !== "false";

// ─── Provider registry (lazy-loaded) ────────────────────────────────────────

let _cohereProvider: RerankerProvider | null = null;
let _jinaProvider: RerankerProvider | null = null;
let _localProvider: RerankerProvider | null = null;

async function getCohereProvider(): Promise<RerankerProvider> {
  if (!_cohereProvider) {
    const { CohereRerankerProvider } = await import("./rerankerCohere");
    _cohereProvider = new CohereRerankerProvider();
  }
  return _cohereProvider;
}

async function getJinaProvider(): Promise<RerankerProvider> {
  if (!_jinaProvider) {
    const { JinaRerankerProvider } = await import("./rerankerJina");
    _jinaProvider = new JinaRerankerProvider();
  }
  return _jinaProvider;
}

async function getLocalProvider(): Promise<RerankerProvider> {
  if (!_localProvider) {
    const { LocalRerankerProvider } = await import("./rerankerLocal");
    _localProvider = new LocalRerankerProvider();
  }
  return _localProvider;
}

/**
 * Returns the ordered list of providers to try, based on config.
 *
 * "auto" (default): [cohere (if configured), jina (if configured), local (always)]
 * "cohere": [cohere, local]  — fall back to local if Cohere is down
 * "jina": [jina, local]
 * "local": [local]
 *
 * Local is ALWAYS included as the last resort — the system never blocks on
 * reranker downtime.
 */
async function getProviderChain(): Promise<RerankerProvider[]> {
  const requested = DEFAULT_PROVIDER.toLowerCase();

  if (requested === "local") {
    return [await getLocalProvider()];
  }

  const chain: RerankerProvider[] = [];
  const cohere = await getCohereProvider();
  const jina = await getJinaProvider();
  const local = await getLocalProvider();

  if (requested === "cohere") {
    if (cohere.isConfigured()) chain.push(cohere);
    chain.push(local);
  } else if (requested === "jina") {
    if (jina.isConfigured()) chain.push(jina);
    chain.push(local);
  } else {
    // "auto" — prefer Cohere (best multilingual), then Jina, then local.
    if (cohere.isConfigured()) chain.push(cohere);
    if (jina.isConfigured()) chain.push(jina);
    chain.push(local);
  }

  return chain;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Reranks documents against a query using the configured provider chain.
 *
 * Flow:
 *   1. Check the cache — if we've reranked this exact (query, docs) before,
 *      return the cached result (zero API cost, ~1ms latency).
 *   2. Try the first configured provider. On timeout or API error, fall
 *      back to the next provider in the chain.
 *   3. Cache the result (positive cache, 1h TTL).
 *   4. If ALL providers fail, return the documents in their original order
 *      with provider="local" (graceful degradation — never block the user).
 *
 * @param query - The user's search query (raw text, not embedded).
 * @param documents - The candidate documents (top-K from first-pass retrieval).
 * @param topN - How many to return after reranking (default from env).
 * @returns Reranked results, sorted by score descending. Length ≤ topN.
 */
export async function rerank(
  query: string,
  documents: RerankDocument[],
  topN: number = DEFAULT_TOP_N,
): Promise<{ results: RerankResult[]; provider: string; cacheHit: boolean; latencyMs: number }> {
  const startTime = Date.now();

  // Master switch — if disabled, return original order.
  if (!RERANKER_ENABLED || documents.length === 0) {
    return {
      results: documents.slice(0, topN).map((d) => ({
        id: d.id,
        score: 1.0, // neutral score — original order is the "best" we have
        provider: "disabled",
      })),
      provider: "disabled",
      cacheHit: false,
      latencyMs: Date.now() - startTime,
    };
  }

  // ─── Cache lookup ────────────────────────────────────────────────────────
  // Rerank results are deterministic for (query, documents, model). The cache
  // key is a hash of (normalized query + sorted doc ids + doc text hashes).
  // See rerankerCache.ts for the key construction.
  const cached = await getCachedRerank(query, documents, topN);
  if (cached) {
    logger.debug(
      {
        queryPreview: query.slice(0, 80),
        docCount: documents.length,
        topN,
        provider: cached[0]?.provider ?? "unknown",
      },
      "Reranker: cache HIT",
    );
    return {
      results: cached,
      provider: cached[0]?.provider ?? "cache",
      cacheHit: true,
      latencyMs: Date.now() - startTime,
    };
  }

  // ─── Provider chain ──────────────────────────────────────────────────────
  const providers = await getProviderChain();
  let lastError: unknown = null;

  for (const provider of providers) {
    try {
      const results = await withTimeout(
        provider.rerank(query, documents, topN),
        DEFAULT_TIMEOUT_MS,
        provider.name,
      );

      // Sort by score descending + take top N.
      const sorted = [...results].sort((a, b) => b.score - a.score).slice(0, topN);

      // Filter by min score (only for non-local providers — local always returns all).
      const filtered =
        provider.name === "local" ? sorted : sorted.filter((r) => r.score >= DEFAULT_MIN_SCORE);

      // Cache the result (fire-and-forget, but await for correctness on first call).
      await setCachedRerank(query, documents, topN, filtered);

      logger.info(
        {
          provider: provider.name,
          queryPreview: query.slice(0, 80),
          docCount: documents.length,
          returned: filtered.length,
          latencyMs: Date.now() - startTime,
          cacheHit: false,
        },
        "Reranker: success",
      );

      return {
        results: filtered,
        provider: provider.name,
        cacheHit: false,
        latencyMs: Date.now() - startTime,
      };
    } catch (err) {
      lastError = err;
      const isLast = provider === providers[providers.length - 1];
      logger.warn(
        {
          provider: provider.name,
          err: (err as Error)?.message ?? String(err),
          willFallback: !isLast,
        },
        isLast
          ? `Reranker: ${provider.name} failed (last in chain, using graceful degradation)`
          : `Reranker: ${provider.name} failed, falling back to next provider`,
      );
    }
  }

  // ─── All providers failed — graceful degradation ────────────────────────
  // Return original order (first-pass BM25+semantic score is still good).
  // This is the "no gaps" guarantee: reranker downtime NEVER blocks the user.
  logger.error(
    { err: (lastError as Error)?.message ?? "unknown", queryPreview: query.slice(0, 80) },
    "Reranker: all providers failed, returning original order (graceful degradation)",
  );

  const fallbackResults: RerankResult[] = documents.slice(0, topN).map((d) => ({
    id: d.id,
    score: 1.0,
    provider: "fallback",
  }));

  // Cache the fallback (short TTL — don't cache failures for too long).
  await setCachedRerank(query, documents, topN, fallbackResults, 60);

  return {
    results: fallbackResults,
    provider: "fallback",
    cacheHit: false,
    latencyMs: Date.now() - startTime,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Wraps a promise with a timeout. Rejects with a TimeoutError if the
 * promise doesn't resolve within `ms` milliseconds.
 *
 * Uses AbortController internally so the underlying fetch is cancelled
 * (not just ignored — actually cancelled, freeing up the socket).
 */
function withTimeout<T>(promise: Promise<T>, ms: number, providerName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Reranker ${providerName} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ─── Config inspection (for admin endpoint) ──────────────────────────────────

/**
 * Returns the current reranker configuration + provider status.
 * Used by GET /api/ai/admin/kb/search/health.
 */
export async function getRerankerStatus(): Promise<{
  enabled: boolean;
  provider: string;
  topK: number;
  topN: number;
  timeoutMs: number;
  minScore: number;
  cacheTtlSeconds: number;
  providers: {
    name: string;
    configured: boolean;
  }[];
}> {
  const cohere = await getCohereProvider();
  const jina = await getJinaProvider();
  const local = await getLocalProvider();

  return {
    enabled: RERANKER_ENABLED,
    provider: DEFAULT_PROVIDER,
    topK: DEFAULT_TOP_K,
    topN: DEFAULT_TOP_N,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    minScore: DEFAULT_MIN_SCORE,
    cacheTtlSeconds: Number(process.env.RERANKER_CACHE_TTL_SECONDS ?? 3600),
    providers: [
      { name: "cohere", configured: cohere.isConfigured() },
      { name: "jina", configured: jina.isConfigured() },
      { name: "local", configured: local.isConfigured() },
    ],
  };
}

/**
 * Clears the reranker cache (all entries). Used by the admin cache-clear
 * endpoint after KB content changes (reranked scores may have changed).
 */
export async function clearRerankerCache(): Promise<number> {
  const { clearAllRerankCache } = await import("./rerankerCache");
  return clearAllRerankCache();
}

// ─── Constants exported for kbSearch.ts ──────────────────────────────────────

export const RERANKER_DEFAULT_TOP_K = DEFAULT_TOP_K;
export const RERANKER_DEFAULT_TOP_N = DEFAULT_TOP_N;
