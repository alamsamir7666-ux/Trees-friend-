/**
 * Phase 3: KB search + AI integration — source-shape tests.
 *
 * Verifies:
 *   - `kbSearch.ts` exports searchKnowledgeBase, getTopKbEntriesForPrompt,
 *     formatKbContextForPrompt, getKbStats.
 *   - The composite scoring weights are present in the SQL (0.40 + 0.20 +
 *     0.20 + 0.10 + 0.10).
 *   - searchKnowledgeBase accepts the correct params (query, categoryId,
 *     productSlug, creatorId, maxResults, minScore).
 *   - getTopKbEntriesForPrompt uses minScore = 0.5 (higher threshold for
 *     auto-injection).
 *   - formatKbContextForPrompt includes "KNOWLEDGE BASE CONTEXT" header.
 *   - aiTools.ts has search_knowledge_base in AI_TOOL_DECLARATIONS (5th tool).
 *   - aiTools.ts has search_knowledge_base in CATALOG_TOOLS (cacheable with
 *     short TTL).
 *   - aiTools.ts executeTool switch has case "search_knowledge_base".
 *   - aiContext.ts SYSTEM_PROMPT_TEMPLATE_V1 contains {{knowledge}} placeholder.
 *   - aiContext.ts renderPromptTemplate handles {{knowledge}}.
 *   - aiContext.ts buildSystemPrompt accepts knowledgeBlock parameter.
 *   - ai.ts route calls getTopKbEntriesForPrompt + passes knowledgeBlock to
 *     buildSystemPrompt.
 *   - ai.ts persistMessage accepts + writes kb_hit, kb_entries_used,
 *     kb_search_performed, kb_context_injected.
 *   - aiAdmin.ts has GET /ai/admin/kb/insights endpoint.
 *   - aiAdmin.ts has POST /ai/admin/kb/search endpoint.
 *   - ensureAiTables.ts has the Phase 3 migration block (4 new columns +
 *     index).
 *   - Drizzle schema has the 4 new columns on aiChatMessagesTable.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/kbSearch.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

const REPO_ROOT = "/home/z/my-project/Trees-friend-";

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

// ─── kbSearch.ts ──────────────────────────────────────────────────────────────

describe("Phase 3: kbSearch.ts lib module", () => {
  const source = readSource("artifacts/api-server/src/lib/kbSearch.ts");

  it("exports searchKnowledgeBase", () => {
    expect(source).toContain("export async function searchKnowledgeBase");
  });

  it("exports getTopKbEntriesForPrompt", () => {
    expect(source).toContain("export async function getTopKbEntriesForPrompt");
  });

  it("exports formatKbContextForPrompt", () => {
    expect(source).toContain("export function formatKbContextForPrompt");
  });

  it("exports getKbStats", () => {
    expect(source).toContain("export async function getKbStats");
  });

  it("exports the KbSearchResult type", () => {
    expect(source).toContain("export interface KbSearchResult");
  });

  it("v5.0: has the composite scoring weights (0.35 + 0.25 + 0.05 + 0.15 + 0.10 + 0.10)", () => {
    // v5.0 weights (changed from v3.10's 0.40/0.20/0.20/0.10/0.10 to make
    // room for true BM25 + reduced keyword-array overlap).
    // Legacy WEIGHT_KEYWORD = 0.20 is preserved as a documentation marker
    // (see the comment in kbSearch.ts).
    expect(source).toContain("WEIGHT_SEMANTIC = 0.35");
    expect(source).toContain("WEIGHT_BM25 = 0.25");
    expect(source).toContain("WEIGHT_KEYWORD_ARRAY = 0.05");
    expect(source).toContain("WEIGHT_AUTHORITY = 0.15");
    expect(source).toContain("WEIGHT_PRIORITY = 0.10");
    expect(source).toContain("WEIGHT_RECENCY = 0.10");
    // Legacy constant preserved for back-compat
    expect(source).toContain("WEIGHT_KEYWORD = 0.20");
  });

  it("uses Gemini text-embedding-004 for query embeddings", () => {
    expect(source).toContain("text-embedding-004");
  });

  it("uses RETRIEVAL_QUERY task type (asymmetric to entries' RETRIEVAL_DOCUMENT)", () => {
    expect(source).toContain("RETRIEVAL_QUERY");
  });

  it("truncates query to 2000 chars (embedding token limit)", () => {
    expect(source).toContain("MAX_QUERY_CHARS");
    expect(source).toContain("2000");
  });

  it("falls back to keyword-only search when embedding generation fails", () => {
    expect(source).toContain("generateQueryEmbedding");
    expect(source).toContain("falling back to keyword-only");
  });

  it("uses pgvector cosine similarity (1 - (embedding <=> query))", () => {
    expect(source).toContain("e.embedding <=> $");
    expect(source).toContain("::vector");
  });

  it("searchKnowledgeBase accepts the documented params", () => {
    expect(source).toContain("query:");
    expect(source).toContain("categoryId?:");
    expect(source).toContain("productSlug?:");
    expect(source).toContain("creatorId?:");
    expect(source).toContain("maxResults?:");
    expect(source).toContain("minScore?:");
  });

  it("default minScore is 0.3 (tool threshold)", () => {
    expect(source).toContain("MIN_SCORE_DEFAULT = 0.3");
  });

  it("getTopKbEntriesForPrompt uses minScore = 0.5 (higher threshold for auto-injection)", () => {
    expect(source).toContain("MIN_SCORE_AUTO_INJECT = 0.5");
  });

  it("getTopKbEntriesForPrompt defaults to 3 entries (keeps prompt reasonable)", () => {
    expect(source).toContain("MAX_AUTO_INJECT_ENTRIES = 3");
  });

  it("formatKbContextForPrompt includes 'KNOWLEDGE BASE CONTEXT' header", () => {
    expect(source).toContain("KNOWLEDGE BASE CONTEXT");
    expect(source).toContain("cite the creator");
  });

  it("formatKbContextForPrompt truncates content to 500 chars", () => {
    expect(source).toContain("500");
  });

  it("getKbStats returns total/active/embedded + byCategory + byCreator", () => {
    expect(source).toContain("totalEntries");
    expect(source).toContain("activeEntries");
    expect(source).toContain("entriesWithEmbeddings");
    expect(source).toContain("entriesByCategory");
    expect(source).toContain("entriesByCreator");
  });

  it("authority is capped at 50 entries (min(entry_count / 50, 1.0))", () => {
    expect(source).toContain("AUTHORITY_CAP = 50");
  });

  it("recency decays over 2 years (730 days)", () => {
    expect(source).toContain("730");
  });

  it("extractKeywords handles English + Bengali (\\u0980-\\u09ff)", () => {
    expect(source).toContain("\\u0980-\\u09ff");
  });

  it("extractKeywords removes English stop words", () => {
    expect(source).toContain("STOP_WORDS");
  });

  it("never throws (returns empty array on DB error — route relies on this)", () => {
    expect(source).toContain("return []");
  });

  // ─── v5.0: BM25 + reranker integration ──────────────────────────────────

  it("v5.0: has WEIGHT_BM25 constant (true BM25 score weight)", () => {
    expect(source).toContain("WEIGHT_BM25 = 0.25");
  });

  it("v5.0: has WEIGHT_KEYWORD_ARRAY constant (curated keywords[] overlap)", () => {
    expect(source).toContain("WEIGHT_KEYWORD_ARRAY = 0.05");
  });

  it("v5.0: weights sum to 1.0 (0.35 + 0.25 + 0.05 + 0.15 + 0.10 + 0.10)", () => {
    expect(source).toContain("WEIGHT_SEMANTIC = 0.35");
    expect(source).toContain("WEIGHT_BM25 = 0.25");
    expect(source).toContain("WEIGHT_KEYWORD_ARRAY = 0.05");
    expect(source).toContain("WEIGHT_AUTHORITY = 0.15");
    expect(source).toContain("WEIGHT_PRIORITY = 0.10");
    expect(source).toContain("WEIGHT_RECENCY = 0.10");
    // Sanity comment
    expect(source).toContain("0.35 + 0.25 + 0.05 + 0.15 + 0.10 + 0.10 = 1.00");
  });

  it("v5.0: imports rerank + RerankDocument from reranker module", () => {
    expect(source).toContain("import { rerank");
    expect(source).toContain("RerankDocument");
    expect(source).toContain('"./reranker"');
  });

  it("v5.0: calls bm25_score() PL/pgSQL function in the SQL query", () => {
    expect(source).toContain("bm25_score(");
    expect(source).toContain("e.search_tsvector");
    expect(source).toContain("e.bm25_doc_length");
    expect(source).toContain("bm25_avg_doc_length()");
    expect(source).toContain("bm25_total_active_docs()");
  });

  it("v5.0: KbSearchResult type has bm25Score + rerankScore + rerankProvider", () => {
    expect(source).toContain("bm25Score:");
    expect(source).toContain("keywordArrayOverlap:");
    expect(source).toContain("rerankScore:");
    expect(source).toContain("rerankProvider:");
  });

  it("v5.0: searchKnowledgeBase accepts skipRerank param", () => {
    expect(source).toContain("skipRerank?:");
  });

  it("v5.0: getTopKbEntriesForPrompt passes skipRerank: true (high threshold, no rerank latency)", () => {
    expect(source).toContain("skipRerank: true");
  });

  it("v5.0: has a fallback function for when BM25 function is unavailable", () => {
    expect(source).toContain("searchKnowledgeBaseFallback");
    expect(source).toContain("ts_rank_cd"); // fallback uses ts_rank_cd
  });

  it("v5.0: fallback uses legacy weights (0.40/0.20/0.20/0.10/0.10)", () => {
    expect(source).toContain("semanticSimilarity * 0.4");
    expect(source).toContain("keywordOverlap * 0.2");
    expect(source).toContain("creatorAuthority * 0.2");
  });

  it("v5.0: invokes the reranker after first-pass composite scoring", () => {
    expect(source).toContain("rerank(query, rerankDocs, maxResults)");
    expect(source).toContain("candidatesForRerank");
  });

  it("v5.0: logs rerank outcome for observability", () => {
    expect(source).toContain("rerankProvider");
    expect(source).toContain("rerankCacheHit");
    expect(source).toContain("rerankLatencyMs");
  });
});

// ─── aiTools.ts ──────────────────────────────────────────────────────────────

describe("Phase 3: aiTools.ts search_knowledge_base tool", () => {
  const source = readSource("artifacts/api-server/src/lib/aiTools.ts");

  it("imports searchKnowledgeBase from kbSearch", () => {
    expect(source).toContain("searchKnowledgeBase");
    expect(source).toContain("kbSearch");
  });

  it("declares search_knowledge_base in AI_TOOL_DECLARATIONS (5th tool)", () => {
    expect(source).toContain('name: "search_knowledge_base"');
  });

  it("the tool description mentions it's the PRIMARY source", () => {
    expect(source).toContain("PRIMARY source");
    expect(source).toContain("cite the creator");
  });

  it("the tool has the required 'query' parameter", () => {
    expect(source).toContain("query:");
    expect(source).toContain('required: ["query"]');
  });

  it("the tool has optional category_slug, product_slug, max_results params", () => {
    expect(source).toContain("category_slug");
    expect(source).toContain("product_slug");
    expect(source).toContain("max_results");
  });

  it("executeTool switch has case 'search_knowledge_base'", () => {
    expect(source).toContain('case "search_knowledge_base"');
    expect(source).toContain("searchKb(args)");
  });

  it("CATALOG_TOOLS includes search_knowledge_base (cacheable with short TTL)", () => {
    expect(source).toContain('"search_knowledge_base"');
    // The CATALOG_TOOLS set should include the new tool.
    const catalogToolsBlock = source.match(/CATALOG_TOOLS[^[]*\[([\s\S]*?)\]/);
    expect(catalogToolsBlock).not.toBeNull();
    expect(catalogToolsBlock![1]).toContain("search_knowledge_base");
  });

  it("the searchKb implementation resolves category_slug to categoryId", () => {
    expect(source).toContain("SELECT id FROM ai_kb_categories WHERE slug = $1");
  });

  it("the searchKb implementation uses minScore = 0.3 (tool threshold)", () => {
    expect(source).toContain("minScore: 0.3");
  });

  it("the searchKb implementation caps max_results at 10", () => {
    expect(source).toContain("Math.min(Number(args.max_results");
    expect(source).toContain("10");
  });
});

// ─── aiContext.ts ────────────────────────────────────────────────────────────

describe("Phase 3: aiContext.ts {{knowledge}} placeholder + rules", () => {
  const source = readSource("artifacts/api-server/src/lib/aiContext.ts");

  it("SYSTEM_PROMPT_TEMPLATE_V1 contains {{knowledge}} placeholder", () => {
    expect(source).toContain("{{knowledge}}");
  });

  it("placeholder order is {{summary}}{{knowledge}}{{catalog}} (knowledge before catalog)", () => {
    expect(source).toContain("{{summary}}{{knowledge}}{{catalog}}");
  });

  it("SYSTEM_PROMPT_TEMPLATE_V1 has a KNOWLEDGE BASE rules section", () => {
    expect(source).toContain("KNOWLEDGE BASE");
    expect(source).toContain("cite the creator");
    expect(source).toContain("search_knowledge_base tool");
  });

  it("the TOOLS section mentions search_knowledge_base (5th tool)", () => {
    expect(source).toContain("search_knowledge_base(query");
  });

  it("renderPromptTemplate accepts a knowledgeBlock parameter", () => {
    expect(source).toMatch(/renderPromptTemplate\([\s\S]*?knowledgeBlock[\s\S]*?: string/);
  });

  it("renderPromptTemplate replaces {{knowledge}} placeholder", () => {
    expect(source).toContain("{{knowledge}}");
    expect(source).toContain('replaceAll("{{knowledge}}"');
  });

  it("renderPromptTemplate inserts knowledge BEFORE catalog when no placeholder", () => {
    expect(source).toContain(/(\n\nCATALOG CONTEXT)/);
    expect(source).toContain("insert before the catalog");
  });

  it("buildSystemPrompt accepts a knowledgeBlock parameter", () => {
    expect(source).toMatch(/buildSystemPrompt\([\s\S]*?knowledgeBlock[\s\S]*?: string/);
  });

  it("buildSystemPrompt passes knowledgeBlock to renderPromptTemplate", () => {
    expect(source).toContain("knowledgeBlock");
  });
});

// ─── routes/ai.ts ────────────────────────────────────────────────────────────

describe("Phase 3: routes/ai.ts KB integration", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("imports getTopKbEntriesForPrompt + formatKbContextForPrompt from kbSearch", () => {
    expect(source).toContain("getTopKbEntriesForPrompt");
    expect(source).toContain("formatKbContextForPrompt");
    expect(source).toContain("kbSearch");
  });

  it("calls getTopKbEntriesForPrompt(safeMessage, 3) to build KB context", () => {
    expect(source).toContain("getTopKbEntriesForPrompt(safeMessage, 3)");
  });

  it("passes knowledgeBlock to renderPromptTemplate (DB path)", () => {
    expect(source).toContain("knowledgeBlock");
    expect(source).toMatch(/renderPromptTemplate\([^)]*knowledgeBlock/);
  });

  it("passes knowledgeBlock to buildSystemPrompt (fallback path)", () => {
    expect(source).toMatch(/buildSystemPrompt\([^)]*knowledgeBlock/);
  });

  it("logs KB context injection when injected", () => {
    expect(source).toContain("kbContext.injected");
    expect(source).toContain("KB context injected into prompt");
  });

  it("persistMessage accepts kbHit, kbEntriesUsed, kbSearchPerformed, kbContextInjected", () => {
    expect(source).toContain("kbHit?:");
    expect(source).toContain("kbEntriesUsed?:");
    expect(source).toContain("kbSearchPerformed?:");
    expect(source).toContain("kbContextInjected?:");
  });

  it("persistMessage INSERT includes the 4 KB columns", () => {
    expect(source).toContain("kb_hit");
    expect(source).toContain("kb_entries_used");
    expect(source).toContain("kb_search_performed");
    expect(source).toContain("kb_context_injected");
  });

  it("tracks kbSearchPerformed via metaHolder toolCalls", () => {
    expect(source).toContain("metaHolder.value?.toolCalls");
    expect(source).toContain('"search_knowledge_base"');
  });

  it("sets kbHit = injected || kbSearchPerformed", () => {
    expect(source).toContain("kbContext.injected || kbSearchPerformed");
  });
});

// ─── routes/aiAdmin.ts ───────────────────────────────────────────────────────

describe("Phase 3: aiAdmin.ts KB insights + search endpoints", () => {
  const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");

  it("imports searchKnowledgeBase + getKbStats from kbSearch", () => {
    expect(source).toContain("searchKnowledgeBase");
    expect(source).toContain("getKbStats");
    expect(source).toContain("kbSearch");
  });

  it("registers GET /ai/admin/kb/insights", () => {
    expect(source).toMatch(/router\.get\(\s*["']\/ai\/admin\/kb\/insights["']/);
  });

  it("registers POST /ai/admin/kb/search", () => {
    expect(source).toMatch(/router\.post\(\s*["']\/ai\/admin\/kb\/search["']/);
  });

  it("NO insights/search route uses the double /api/ prefix", () => {
    const brokenPattern =
      /router\.(get|post|put|delete|patch)\(\s*["']\/api\/ai\/admin\/kb\/(insights|search)/;
    expect(brokenPattern.test(source)).toBe(false);
  });

  it("GET /ai/admin/kb/insights queries ai_chat_messages for KB hit rate (30 days)", () => {
    expect(source).toContain("kb_hit = TRUE");
    expect(source).toContain("kb_search_performed = TRUE");
    expect(source).toContain("kb_context_injected = TRUE");
    expect(source).toContain("INTERVAL '30 days'");
  });

  it("POST /ai/admin/kb/search uses minScore = 0.0 (show all for debugging)", () => {
    expect(source).toContain("minScore: 0.0");
  });

  it("POST /ai/admin/kb/search returns score breakdown per result", () => {
    expect(source).toContain("breakdown");
    expect(source).toContain("semantic");
    expect(source).toContain("keyword");
    expect(source).toContain("authority");
    expect(source).toContain("priority");
    expect(source).toContain("recency");
  });
});

// ─── ensureAiTables.ts ───────────────────────────────────────────────────────

describe("Phase 3: ensureAiTables.ts migration block", () => {
  const source = readSource("artifacts/api-server/src/lib/ensureAiTables.ts");

  it("has a Phase 3 migration block header", () => {
    expect(source).toContain("Phase 3: KB usage logging on assistant messages");
  });

  it("adds kb_hit column to ai_chat_messages", () => {
    expect(source).toContain("ADD COLUMN IF NOT EXISTS kb_hit BOOLEAN");
  });

  it("adds kb_entries_used INTEGER[] column", () => {
    expect(source).toContain("ADD COLUMN IF NOT EXISTS kb_entries_used INTEGER[]");
  });

  it("adds kb_search_performed BOOLEAN column", () => {
    expect(source).toContain("ADD COLUMN IF NOT EXISTS kb_search_performed BOOLEAN");
  });

  it("adds kb_context_injected BOOLEAN column", () => {
    expect(source).toContain("ADD COLUMN IF NOT EXISTS kb_context_injected BOOLEAN");
  });

  it("creates the partial index ai_chat_messages_kb_hit_idx (WHERE kb_hit = TRUE)", () => {
    expect(source).toContain("ai_chat_messages_kb_hit_idx");
    expect(source).toContain("WHERE kb_hit = TRUE");
  });
});

// ─── Drizzle schema (aiChat.ts) ──────────────────────────────────────────────

describe("Phase 3: Drizzle schema (aiChat.ts) KB usage columns", () => {
  const source = readSource("lib/db/src/schema/aiChat.ts");

  it("aiChatMessagesTable has kbHit column", () => {
    expect(source).toContain('kbHit: boolean("kb_hit")');
  });

  it("aiChatMessagesTable has kbEntriesUsed column (integer array)", () => {
    expect(source).toContain('kbEntriesUsed: integer("kb_entries_used").array()');
  });

  it("aiChatMessagesTable has kbSearchPerformed column", () => {
    expect(source).toContain('kbSearchPerformed: boolean("kb_search_performed")');
  });

  it("aiChatMessagesTable has kbContextInjected column", () => {
    expect(source).toContain('kbContextInjected: boolean("kb_context_injected")');
  });

  it("declares the partial index ai_chat_messages_kb_hit_idx", () => {
    expect(source).toContain("ai_chat_messages_kb_hit_idx");
    expect(source).toContain("kb_hit = true");
  });
});

// ─── Frontend wiring ─────────────────────────────────────────────────────────

describe("Phase 3: frontend wiring", () => {
  it("kbApi.ts exports fetchKbInsights + testKbSearch + types", () => {
    const source = readSource("artifacts/tree-friend/src/lib/kbApi.ts");
    expect(source).toContain("export async function fetchKbInsights");
    expect(source).toContain("export async function testKbSearch");
    expect(source).toContain("export interface KbInsights");
    expect(source).toContain("export interface KbSearchTestResponse");
  });

  it("KbTab.tsx registers the 'insights' sub-tab", () => {
    const source = readSource("artifacts/tree-friend/src/components/admin/tabs/KbTab.tsx");
    expect(source).toContain('"categories" | "sources" | "entries" | "insights"');
    expect(source).toContain('id === "insights" && "Insights"');
    expect(source).toContain('activeSubTab === "insights" && <KbInsightsView');
  });

  it("KbTab.tsx defines KbInsightsView with stat cards + bar charts + search tester", () => {
    const source = readSource("artifacts/tree-friend/src/components/admin/tabs/KbTab.tsx");
    expect(source).toContain("function KbInsightsView");
    expect(source).toContain("fetchKbInsights");
    expect(source).toContain("testKbSearch");
    // Stat cards.
    expect(source).toContain("Total Entries");
    expect(source).toContain("Active Entries");
    expect(source).toContain("With Embeddings");
    expect(source).toContain("KB Hit Rate");
    // Bar charts.
    expect(source).toContain("Entries by Category");
    expect(source).toContain("Entries by Creator");
    // Search tester.
    expect(source).toContain("Search Tester");
    expect(source).toContain("breakdown");
  });
});
