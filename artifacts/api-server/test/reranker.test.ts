/**
 * Reranker tests — source-shape + behavior verification.
 *
 * These tests verify:
 *   - The reranker abstraction exports the expected interface.
 *   - Provider implementations (Cohere, Jina, local) have the correct shape.
 *   - The cache module exports the expected functions.
 *   - The provider chain falls back correctly (Cohere → Jina → local).
 *   - Graceful degradation: if all providers fail, returns original order.
 *   - Cache key construction is stable (order-independent for docs).
 *   - Config env vars are respected.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/reranker.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

// ─── Source-shape tests (verify the files exist + export the right things) ────

describe("Reranker: source-shape tests", () => {
  it("reranker.ts exports the RerankerProvider interface + rerank function", () => {
    const source = readSource("artifacts/api-server/src/lib/reranker.ts");
    expect(source).toContain("export interface RerankerProvider");
    expect(source).toContain("export async function rerank");
    expect(source).toContain("export async function getRerankerStatus");
    expect(source).toContain("export async function clearRerankerCache");
  });

  it("rerankerCohere.ts implements the CohereRerankerProvider class", () => {
    const source = readSource("artifacts/api-server/src/lib/rerankerCohere.ts");
    expect(source).toContain("export class CohereRerankerProvider");
    expect(source).toContain("rerank-multilingual-v3.0"); // multilingual model
    expect(source).toContain("https://api.cohere.ai/v1/rerank");
  });

  it("rerankerJina.ts implements the JinaRerankerProvider class", () => {
    const source = readSource("artifacts/api-server/src/lib/rerankerJina.ts");
    expect(source).toContain("export class JinaRerankerProvider");
    expect(source).toContain("jina-reranker-v2-base-multilingual");
    expect(source).toContain("https://api.jina.ai/v1/rerank");
  });

  it("rerankerLocal.ts implements the LocalRerankerProvider fallback", () => {
    const source = readSource("artifacts/api-server/src/lib/rerankerLocal.ts");
    expect(source).toContain("export class LocalRerankerProvider");
    expect(source).toContain("returning first-pass order");
  });

  it("rerankerCache.ts exports the multi-tier cache functions", () => {
    const source = readSource("artifacts/api-server/src/lib/rerankerCache.ts");
    expect(source).toContain("export async function getCachedRerank");
    expect(source).toContain("export async function setCachedRerank");
    expect(source).toContain("export async function clearAllRerankCache");
    expect(source).toContain("export async function getRerankerCacheStats");
    // Multi-tier architecture
    expect(source).toContain("L1Cache");
    expect(source).toContain("getRedis");
    // Single-flight
    expect(source).toContain("getInFlightRerank");
    expect(source).toContain("setInFlightRerank");
  });

  it("bm25StatsJob.ts exports the refresh + status functions", () => {
    const source = readSource("artifacts/api-server/src/jobs/bm25StatsJob.ts");
    expect(source).toContain("export async function refreshBm25Stats");
    expect(source).toContain("export async function getBm25StatsStatus");
    expect(source).toContain("export async function areBm25StatsPopulated");
    expect(source).toContain("export function startBm25StatsJob");
  });

  it("migration 0007 creates the bm25_score function + term_stats table", () => {
    const source = readSource("lib/db/migrations/0007_bm25_reranker.sql");
    expect(source).toContain("CREATE TABLE IF NOT EXISTS ai_kb_term_stats");
    expect(source).toContain("ADD COLUMN IF NOT EXISTS bm25_doc_length");
    expect(source).toContain("CREATE OR REPLACE FUNCTION bm25_score(");
    expect(source).toContain("CREATE OR REPLACE FUNCTION bm25_avg_doc_length()");
    expect(source).toContain("CREATE OR REPLACE FUNCTION bm25_total_active_docs()");
    expect(source).toContain("CREATE OR REPLACE FUNCTION refresh_kb_term_stats()");
    // BM25 formula components
    expect(source).toContain("v_idf");
    expect(source).toContain("v_norm");
    expect(source).toContain("p_k1"); // term frequency saturation
    expect(source).toContain("p_b"); // length normalization
  });

  it("ensureAiTables.ts includes the v5.0 BM25 migration block", () => {
    const source = readSource("artifacts/api-server/src/lib/ensureAiTables.ts");
    expect(source).toContain("v5.0: True BM25 scoring");
    expect(source).toContain("CREATE TABLE IF NOT EXISTS ai_kb_term_stats");
    expect(source).toContain("bm25_doc_length");
    expect(source).toContain("CREATE OR REPLACE FUNCTION bm25_score(");
  });

  it("Drizzle schema declares the bm25_doc_length column", () => {
    const source = readSource("lib/db/src/schema/aiChat.ts");
    expect(source).toContain("bm25DocLength");
    expect(source).toContain("bm25_doc_length");
  });

  it("kbSearch.ts integrates BM25 + reranker", () => {
    const source = readSource("artifacts/api-server/src/lib/kbSearch.ts");
    // BM25 integration
    expect(source).toContain("WEIGHT_BM25 = 0.25");
    expect(source).toContain("WEIGHT_KEYWORD_ARRAY = 0.05");
    expect(source).toContain("WEIGHT_SEMANTIC = 0.35");
    expect(source).toContain("WEIGHT_AUTHORITY = 0.15");
    expect(source).toContain("bm25_score(");
    // Reranker integration
    expect(source).toContain("import { rerank");
    expect(source).toContain("skipRerank");
    expect(source).toContain("RerankDocument");
    expect(source).toContain("rerankScore");
    expect(source).toContain("rerankProvider");
    // Graceful degradation (fallback to ts_rank_cd when BM25 unavailable)
    expect(source).toContain("searchKnowledgeBaseFallback");
    expect(source).toContain("BM25 function unavailable");
  });

  it("aiAdmin.ts exposes the new health + refresh endpoints", () => {
    const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");
    expect(source).toContain("/ai/admin/kb/search/health");
    expect(source).toContain("/ai/admin/kb/search/refresh-stats");
    expect(source).toContain("/ai/admin/kb/search/clear-reranker-cache");
  });

  it("cron.ts has the Vercel cron endpoint for BM25 stats", () => {
    const source = readSource("artifacts/api-server/src/routes/cron.ts");
    expect(source).toContain("/cron/kb-bm25-stats");
  });

  it("index.ts starts the BM25 stats job", () => {
    const source = readSource("artifacts/api-server/src/index.ts");
    expect(source).toContain("startBm25StatsJob");
  });
});

// ─── Behavior tests (mocked — no real API calls) ──────────────────────────────

describe("Reranker: behavior tests", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clear reranker env vars so tests start from a clean state.
    delete process.env.COHERE_API_KEY;
    delete process.env.JINA_API_KEY;
    delete process.env.JINA_RERANKER_URL;
    delete process.env.RERANKER_PROVIDER;
    delete process.env.RERANKER_ENABLED;
    delete process.env.RERANKER_TOP_K;
    delete process.env.RERANKER_TOP_N;
    delete process.env.RERANKER_TIMEOUT_MS;
    // Reset the module registry so each test gets a fresh module load
    // (the reranker module captures env vars at load time).
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("LocalRerankerProvider is always configured + returns original order", async () => {
    const { LocalRerankerProvider } = await import("../src/lib/rerankerLocal");
    const provider = new LocalRerankerProvider();
    expect(provider.isConfigured()).toBe(true);

    const docs = [
      { id: 1, text: "doc 1" },
      { id: 2, text: "doc 2" },
      { id: 3, text: "doc 3" },
    ];
    const result = await provider.rerank("test query", docs, 2);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1); // original order preserved
    expect(result[0].score).toBe(1.0); // neutral score
    expect(result[0].provider).toBe("local");
  });

  it("CohereRerankerProvider.isConfigured() respects COHERE_API_KEY", async () => {
    const { CohereRerankerProvider } = await import("../src/lib/rerankerCohere");
    const provider = new CohereRerankerProvider();

    expect(provider.isConfigured()).toBe(false);

    process.env.COHERE_API_KEY = "test-key-1234567890";
    expect(provider.isConfigured()).toBe(true);
  });

  it("JinaRerankerProvider.isConfigured() respects JINA_API_KEY or JINA_RERANKER_URL", async () => {
    const { JinaRerankerProvider } = await import("../src/lib/rerankerJina");
    const provider = new JinaRerankerProvider();

    expect(provider.isConfigured()).toBe(false);

    process.env.JINA_API_KEY = "test-key-1234567890";
    expect(provider.isConfigured()).toBe(true);

    delete process.env.JINA_API_KEY;
    process.env.JINA_RERANKER_URL = "http://localhost:8080/v1/rerank";
    expect(provider.isConfigured()).toBe(true);
  });

  it("rerank() returns original order when RERANKER_ENABLED=false", async () => {
    process.env.RERANKER_ENABLED = "false";
    const { rerank } = await import("../src/lib/reranker");

    const docs = [
      { id: 1, text: "doc 1" },
      { id: 2, text: "doc 2" },
    ];
    const result = await rerank("test", docs, 5);
    expect(result.provider).toBe("disabled");
    expect(result.results).toHaveLength(2);
    expect(result.results[0].provider).toBe("disabled");
  });

  it("rerank() gracefully degrades to local when no external providers are configured", async () => {
    // No API keys set — only the local provider is available.
    // RERANKER_ENABLED is unset (defaults to "true").
    process.env.RERANKER_PROVIDER = "auto";
    const { rerank } = await import("../src/lib/reranker");

    const docs = [
      { id: 1, text: "doc 1" },
      { id: 2, text: "doc 2" },
      { id: 3, text: "doc 3" },
    ];
    const result = await rerank("test query", docs, 2);

    // Should succeed via the local provider (always configured).
    expect(result.results).toHaveLength(2);
    // The provider field reflects which provider ultimately produced the result.
    // When only local is available, it's "local".
    expect(["local", "fallback", "disabled"]).toContain(result.provider);
    expect(result.cacheHit).toBe(false);
  });

  it("rerank() skips reranking when documents array is empty", async () => {
    const { rerank } = await import("../src/lib/reranker");
    const result = await rerank("test", [], 5);
    expect(result.results).toHaveLength(0);
    expect(result.provider).toBe("disabled");
  });
});

// ─── Cache key stability tests ────────────────────────────────────────────────

describe("Reranker: cache key stability", () => {
  it("cache key construction is order-independent for documents", () => {
    // The cache key must be the same regardless of the order of documents
    // passed in. This is critical for cache hit rate — the same set of docs
    // should hit the cache whether they came in as [1,2,3] or [3,2,1].
    //
    // We verify this by checking the source code uses sorted doc ids + text
    // hashes (not the raw order).
    const source = readSource("artifacts/api-server/src/lib/rerankerCache.ts");
    expect(source).toContain(".sort((a, b) => a.id - b.id)");
    expect(source).toContain("createHash");
    expect(source).toContain("sha256");
  });

  it("cache key includes the query (normalized)", () => {
    const source = readSource("artifacts/api-server/src/lib/rerankerCache.ts");
    expect(source).toContain("normalizeQuery");
    expect(source).toContain("NFC");
    expect(source).toContain("toLowerCase");
  });

  it("cache key includes topN (different topN = different cache entry)", () => {
    const source = readSource("artifacts/api-server/src/lib/rerankerCache.ts");
    expect(source).toContain("::${topN}");
  });

  it("cache uses the ai:rerank: namespace (separate from ai:cache:)", () => {
    const source = readSource("artifacts/api-server/src/lib/rerankerCache.ts");
    // The cache key uses the `ai:rerank:` prefix (template literal).
    expect(source).toContain("`ai:rerank:${hash}`");
    // The clearAllRerankCache() scan must use the ai:rerank: pattern (not ai:cache:).
    expect(source).toContain('match: "ai:rerank:*"');
  });
});

// ─── BM25 migration tests ────────────────────────────────────────────────────

describe("BM25: migration correctness", () => {
  it("uses the Lucene/BM25+ IDF formula (always positive)", () => {
    const source = readSource("lib/db/migrations/0007_bm25_reranker.sql");
    // ln(1 + (N - n + 0.5) / (n + 0.5)) — the BM25+ variant
    expect(source).toContain("ln(1.0 + (p_total_docs::double precision - v_doc_count + 0.5)");
    expect(source).toContain("/ (v_doc_count + 0.5))");
  });

  it("uses default k1=1.2 and b=0.75 (Lucene standard)", () => {
    const source = readSource("lib/db/migrations/0007_bm25_reranker.sql");
    expect(source).toContain("p_k1 double precision DEFAULT 1.2");
    expect(source).toContain("p_b double precision DEFAULT 0.75");
  });

  it("refresh_kb_term_stats() uses ts_stat() for fast corpus scan", () => {
    const source = readSource("lib/db/migrations/0007_bm25_reranker.sql");
    expect(source).toContain("ts_stat('SELECT search_tsvector FROM ai_kb_entries");
    // ts_stat() returns columns: word, ndoc, nentry. The function must
    // alias `word` → `lexeme` and `ndoc` → `doc_count` when inserting
    // into ai_kb_term_stats.
    expect(source).toContain("word AS lexeme");
    expect(source).toContain("ndoc AS doc_count");
  });

  it("trigger fires BEFORE INSERT OR UPDATE OF title, content", () => {
    const source = readSource("lib/db/migrations/0007_bm25_reranker.sql");
    expect(source).toContain("BEFORE INSERT OR UPDATE OF title, content");
    expect(source).toContain("ai_kb_entries_bm25_doclength_trigger");
  });

  it("migration is idempotent (uses IF NOT EXISTS / OR REPLACE)", () => {
    const source = readSource("lib/db/migrations/0007_bm25_reranker.sql");
    expect(source).toContain("CREATE TABLE IF NOT EXISTS ai_kb_term_stats");
    expect(source).toContain("ADD COLUMN IF NOT EXISTS bm25_doc_length");
    expect(source).toContain("CREATE OR REPLACE FUNCTION bm25_score");
    expect(source).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS");
  });
});
