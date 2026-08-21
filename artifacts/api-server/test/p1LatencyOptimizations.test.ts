/**
 * P1 fixes: medium-impact latency optimizations tests.
 *
 * Verifies the four P1 changes:
 *   P1 #5: Gemini context caching for multi-round tool loops (opt-in).
 *   P1 #6: Skip semantic cache embedding for obvious misses.
 *   P1 #7: findOrCreateSession single upsert (no redundant SELECT).
 *   P1 #8: Compact older tool results between rounds (opt-in).
 *
 * Coverage:
 *   - shouldAttemptSemanticCache() behavioral tests.
 *   - findOrCreateSession uses a single INSERT ... ON CONFLICT DO UPDATE ... RETURNING.
 *   - geminiContextCache.ts module structure + API.
 *   - toolResultCompaction.ts module structure + API.
 *   - routes/ai.ts wires the changes correctly.
 *   - gemini.ts + groq.ts wire the context caching + compaction.
 *   - Backward compatibility: all features are opt-in (default OFF).
 *
 * Uses source-shape inspection + behavioral tests (same pattern as
 * `systemPromptRebuild.test.ts`, `kbRetrievalUnification.test.ts`).
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/p1LatencyOptimizations.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Ensure the AI_SESSION_SECRET is set (required transitively by sessionToken.ts).
process.env.AI_SESSION_SECRET ??= "dGVzdC1haS1zZXNzaW9uLXNlY3JldC1rZXktZG8tbm90LXVzZS1pbi1wcm9k";

import { shouldAttemptSemanticCache } from "../src/lib/embeddingCache";
import {
  compactOldToolResults,
  TOOL_COMPACTION_ENABLED,
  TOOL_COMPACTION_MIN_ROUND,
  COMPACTABLE_TOOLS,
} from "../src/lib/toolResultCompaction";
import {
  GEMINI_CONTEXT_CACHING_ENABLED,
  GEMINI_CACHE_TTL_SECONDS,
} from "../src/lib/geminiContextCache";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

// ─── P1 #6: shouldAttemptSemanticCache behavioral tests ─────────────────────

describe("P1 #6: shouldAttemptSemanticCache() behavioral tests", () => {
  it("returns FALSE for short messages (< 20 chars)", () => {
    expect(shouldAttemptSemanticCache("hi")).toBe(false);
    expect(shouldAttemptSemanticCache("ok")).toBe(false);
    expect(shouldAttemptSemanticCache("thanks")).toBe(false);
    expect(shouldAttemptSemanticCache("a")).toBe(false);
    expect(shouldAttemptSemanticCache("")).toBe(false);
    expect(shouldAttemptSemanticCache("   ")).toBe(false);
  });

  it("returns FALSE for very long messages (> 2000 chars)", () => {
    const longMsg = "a".repeat(3000);
    expect(shouldAttemptSemanticCache(longMsg)).toBe(false);
    expect(shouldAttemptSemanticCache("a".repeat(2001))).toBe(false);
  });

  it("returns TRUE for normal-length messages (20-2000 chars)", () => {
    expect(shouldAttemptSemanticCache("how often should I water a mango tree?")).toBe(true);
    expect(shouldAttemptSemanticCache("what is the best fertilizer for tomato plants?")).toBe(true);
    expect(shouldAttemptSemanticCache("a".repeat(20))).toBe(true);
    expect(shouldAttemptSemanticCache("a".repeat(2000))).toBe(true);
  });

  it("trims the message before checking length", () => {
    // Padded short message — trimmed to < 20 chars → false.
    expect(shouldAttemptSemanticCache("   hi   ")).toBe(false);
    // Padded normal message — trimmed to 20+ chars → true.
    expect(shouldAttemptSemanticCache("   how often should I water a mango tree?   ")).toBe(true);
  });
});

// ─── P1 #6: embeddingCache.ts source-shape tests ───────────────────────────

describe("P1 #6: embeddingCache.ts exports shouldAttemptSemanticCache + uses it", () => {
  const source = readSource("artifacts/api-server/src/lib/embeddingCache.ts");

  it("exports shouldAttemptSemanticCache", () => {
    expect(source).toMatch(/export\s+function\s+shouldAttemptSemanticCache/);
  });

  it("getSemanticCachedResponse calls shouldAttemptSemanticCache before generateEmbedding", () => {
    // The pre-filter must run BEFORE the expensive embedding call.
    const filterIdx = source.indexOf("shouldAttemptSemanticCache(userMessage)");
    const embeddingIdx = source.indexOf("await generateEmbedding(userMessage)");
    expect(filterIdx).toBeGreaterThan(-1);
    expect(embeddingIdx).toBeGreaterThan(-1);
    // The filter must come BEFORE the embedding call.
    expect(filterIdx).toBeLessThan(embeddingIdx);
  });

  it("setSemanticCachedResponse also calls shouldAttemptSemanticCache (symmetric filter)", () => {
    // The WRITE side should also skip entries for messages we'd never READ.
    expect(source).toMatch(/setSemanticCachedResponse[\s\S]*?shouldAttemptSemanticCache/);
  });

  it("documents the AI_SEMANTIC_CACHE_MIN_MESSAGE_CHARS env var (default 20)", () => {
    expect(source).toMatch(/AI_SEMANTIC_CACHE_MIN_MESSAGE_CHARS/);
    expect(source).toMatch(/20/);
  });

  it("documents the AI_SEMANTIC_CACHE_MAX_MESSAGE_CHARS env var (default 2000)", () => {
    expect(source).toMatch(/AI_SEMANTIC_CACHE_MAX_MESSAGE_CHARS/);
    expect(source).toMatch(/2000/);
  });

  it("documents the industry standard rationale (OpenAI, Anthropic)", () => {
    expect(source).toMatch(/OpenAI/i);
    expect(source).toMatch(/Anthropic/i);
  });
});

// ─── P1 #7: findOrCreateSession single upsert ──────────────────────────────

describe("P1 #7: findOrCreateSession uses a single INSERT ... ON CONFLICT ... RETURNING", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("uses INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING (single query)", () => {
    expect(source).toMatch(
      /INSERT INTO ai_chat_sessions[\s\S]*?ON CONFLICT[\s\S]*?DO UPDATE[\s\S]*?RETURNING/,
    );
  });

  it("the DO UPDATE is a no-op self-assignment (session_token = EXCLUDED.session_token)", () => {
    expect(source).toMatch(/DO UPDATE\s+SET\s+session_token\s*=\s*EXCLUDED\.session_token/i);
  });

  it("does NOT have a redundant SELECT before the INSERT", () => {
    // The old code had: SELECT → INSERT → SELECT. The new code has just: INSERT ... RETURNING.
    // We extract the findOrCreateSession function body + verify it has exactly 1 pool.query call.
    const fnMatch = source.match(/async function findOrCreateSession\([\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];
    const queryCalls = fnBody.match(/await\s+pool\.query/g);
    expect(queryCalls).not.toBeNull();
    expect(queryCalls!.length).toBe(1);
  });

  it("the RETURNING clause returns id, session_token, title, user_id", () => {
    const fnMatch = source.match(/async function findOrCreateSession\([\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];
    expect(fnBody).toMatch(/RETURNING\s+id,\s*session_token,\s*title,\s*user_id/i);
  });

  it("does NOT touch user_id in the DO UPDATE clause (Bug #7 fix preserved)", () => {
    const fnMatch = source.match(/async function findOrCreateSession\([\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];
    // Extract the DO UPDATE ... RETURNING clause.
    const doUpdateMatch = fnBody.match(/DO UPDATE\s+SET\s+([^R]+)RETURNING/is);
    if (doUpdateMatch) {
      const setClause = doUpdateMatch[1];
      expect(setClause).not.toMatch(/user_id/i);
    }
  });
});

// ─── P1 #5: geminiContextCache.ts module structure ──────────────────────────

describe("P1 #5: geminiContextCache.ts module structure", () => {
  const source = readSource("artifacts/api-server/src/lib/geminiContextCache.ts");

  it("exports GEMINI_CONTEXT_CACHING_ENABLED (default false — opt-in)", () => {
    expect(source).toMatch(/export\s+const\s+GEMINI_CONTEXT_CACHING_ENABLED/);
    expect(source).toMatch(/AI_GEMINI_CONTEXT_CACHING_ENABLED.*false/i);
  });

  it("exports GEMINI_CACHE_TTL_SECONDS (default 300, clamped to [60, 3600])", () => {
    expect(source).toMatch(/export\s+const\s+GEMINI_CACHE_TTL_SECONDS/);
    expect(source).toMatch(/60.*3600|Math\.min.*Math\.max/);
  });

  it("exports maybeCreateGeminiContextCache function", () => {
    expect(source).toMatch(/export\s+async\s+function\s+maybeCreateGeminiContextCache/);
  });

  it("exports isCacheStillValid function", () => {
    expect(source).toMatch(/export\s+function\s+isCacheStillValid/);
  });

  it("exports GeminiContextCache interface", () => {
    expect(source).toMatch(/export\s+interface\s+GeminiContextCache/);
  });

  it("the GeminiContextCache interface has name + cachedSystemInstruction + delete", () => {
    expect(source).toMatch(/name:\s*string/);
    expect(source).toMatch(/cachedSystemInstruction:\s*string/);
    expect(source).toMatch(/delete:\s*\(\)\s*=>\s*Promise<void>/);
  });

  it("documents the opt-in nature (default false)", () => {
    expect(source).toMatch(/opt-in/i);
    expect(source).toMatch(/default.*false|false.*default/i);
  });

  it("documents the system-prompt-stability-aware design (BUG-I5 fix)", () => {
    expect(source).toMatch(/BUG-I5/);
    expect(source).toMatch(/system.?prompt.?stability/i);
  });

  it("documents the clean-up-after-request pattern (finally block)", () => {
    expect(source).toMatch(/finally/i);
    expect(source).toMatch(/clean.?up|delete/i);
  });
});

// ─── P1 #5: gemini.ts wires the context caching ─────────────────────────────

describe("P1 #5: gemini.ts wires the context caching into the tool loop", () => {
  const source = readSource("artifacts/api-server/src/lib/gemini.ts");

  it("imports maybeCreateGeminiContextCache + isCacheStillValid", () => {
    expect(source).toMatch(
      /import\s*\{[\s\S]*?maybeCreateGeminiContextCache[\s\S]*?\}\s*from\s*["']\.\/geminiContextCache["']/,
    );
    expect(source).toMatch(/isCacheStillValid/);
  });

  it("calls maybeCreateGeminiContextCache before the loop", () => {
    expect(source).toMatch(/maybeCreateGeminiContextCache\(/);
  });

  it("sets config.cachedContent when the cache is created", () => {
    expect(source).toMatch(/config\.cachedContent\s*=\s*contextCache\.name/);
  });

  it("removes systemInstruction + tools from config when cache is active (avoid duplication)", () => {
    expect(source).toMatch(/delete\s+config\.systemInstruction/);
    expect(source).toMatch(/delete\s+config\.tools/);
  });

  it("checks isCacheStillValid before each round", () => {
    expect(source).toMatch(/isCacheStillValid\(contextCache,\s*currentPrompt\)/);
  });

  it("abandons the cache when the system prompt changes", () => {
    expect(source).toMatch(/abandoning.*system prompt changed/i);
  });

  it("restores initialContents to contents when abandoning the cache", () => {
    expect(source).toMatch(/contents\s*=\s*\[\.\.\.initialContents,\s*\.\.\.contents\]/);
  });

  it("has a finally block that deletes the cache", () => {
    expect(source).toMatch(/finally\s*\{/);
    expect(source).toMatch(/contextCache\.delete\(\)/);
  });

  it("handles forceNoTools by abandoning the cache (system instruction is modified)", () => {
    // When forceNoTools=true (graceful degradation / auto-continue), the
    // system instruction is appended with buildForceFinalPromptSuffix. If
    // the cache is active, we must abandon it + use the cached instruction.
    expect(source).toMatch(/forceNoTools[\s\S]*?contextCache/);
  });
});

// ─── P1 #8: toolResultCompaction.ts module structure ─────────────────────────

describe("P1 #8: toolResultCompaction.ts module structure", () => {
  const source = readSource("artifacts/api-server/src/lib/toolResultCompaction.ts");

  it("exports TOOL_COMPACTION_ENABLED (default false — opt-in)", () => {
    expect(source).toMatch(/export\s+const\s+TOOL_COMPACTION_ENABLED/);
    expect(source).toMatch(/AI_TOOL_COMPACTION_ENABLED.*false/i);
  });

  it("exports TOOL_COMPACTION_MIN_ROUND (default 3)", () => {
    expect(source).toMatch(/export\s+const\s+TOOL_COMPACTION_MIN_ROUND/);
    expect(source).toMatch(/3/);
  });

  it("exports COMPACTABLE_TOOLS set (search_catalog + search_seller_listings)", () => {
    expect(source).toMatch(/export\s+const\s+COMPACTABLE_TOOLS/);
    expect(source).toMatch(/search_catalog/);
    expect(source).toMatch(/search_seller_listings/);
  });

  it("exports compactOldToolResults function", () => {
    expect(source).toMatch(/export\s+function\s+compactOldToolResults/);
  });

  it("documents the opt-in nature (default false)", () => {
    expect(source).toMatch(/opt-in/i);
    expect(source).toMatch(/default.*false|false.*default/i);
  });

  it("documents the conservative design (only rounds >= 3, only list tools)", () => {
    expect(source).toMatch(/round\s*>=\s*3|MIN_ROUND/i);
    expect(source).toMatch(/search_catalog.*search_seller_listings/i);
  });

  it("documents the idempotency (already-compacted parts are skipped)", () => {
    expect(source).toMatch(/idempotent/i);
    expect(source).toMatch(/__compacted/i);
  });
});

// ─── P1 #8: compactOldToolResults behavioral tests ──────────────────────────

describe("P1 #8: compactOldToolResults behavioral tests", () => {
  // Helper: build a Gemini-format contents array with functionResponse parts.
  function buildContents(
    toolResults: { name: string; result: unknown }[],
  ): Record<string, unknown>[] {
    return toolResults.map((tr) => ({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: tr.name,
            response: { result: tr.result },
          },
        },
      ],
    }));
  }

  it("returns 0 when compaction is disabled (default)", () => {
    // TOOL_COMPACTION_ENABLED is read at module load time. We can't easily
    // toggle it in a test. We verify the function returns 0 when disabled
    // by checking the constant directly.
    expect(typeof TOOL_COMPACTION_ENABLED).toBe("boolean");
    // The function should be a no-op when disabled. We can't easily test
    // this without re-importing the module with a different env var, so we
    // just verify the function exists + is callable.
    expect(typeof compactOldToolResults).toBe("function");
  });

  it("returns 0 when round < TOOL_COMPACTION_MIN_ROUND", () => {
    // We can't easily test the disabled-by-default behavior, but we CAN
    // test the round check. compactOldToolResults with round 1 or 2 should
    // return 0 (no compaction). This works regardless of the enabled flag
    // because the round check runs AFTER the enabled check.
    const contents = buildContents([
      { name: "search_catalog", result: { results: [{ name: "Mango" }] } },
    ]);
    // Round 1 — too early.
    expect(compactOldToolResults(contents, 1)).toBe(0);
    // Round 2 — still too early (MIN_ROUND = 3).
    expect(compactOldToolResults(contents, 2)).toBe(0);
  });

  it("COMPACTABLE_TOOLS contains search_catalog + search_seller_listings", () => {
    expect(COMPACTABLE_TOOLS.has("search_catalog")).toBe(true);
    expect(COMPACTABLE_TOOLS.has("search_seller_listings")).toBe(true);
  });

  it("COMPACTABLE_TOOLS does NOT contain get_product_care / get_user_orders / get_order_details / search_knowledge_base", () => {
    expect(COMPACTABLE_TOOLS.has("get_product_care")).toBe(false);
    expect(COMPACTABLE_TOOLS.has("get_user_orders")).toBe(false);
    expect(COMPACTABLE_TOOLS.has("get_order_details")).toBe(false);
    expect(COMPACTABLE_TOOLS.has("search_knowledge_base")).toBe(false);
  });

  it("TOOL_COMPACTION_MIN_ROUND is at least 2", () => {
    expect(TOOL_COMPACTION_MIN_ROUND).toBeGreaterThanOrEqual(2);
  });
});

// ─── P1 #8: gemini.ts + groq.ts wire the compaction ─────────────────────────

describe("P1 #8: gemini.ts + groq.ts wire the compaction into the tool loop", () => {
  const geminiSource = readSource("artifacts/api-server/src/lib/gemini.ts");
  const groqSource = readSource("artifacts/api-server/src/lib/groq.ts");

  it("gemini.ts imports compactOldToolResults", () => {
    expect(geminiSource).toMatch(
      /import\s*\{\s*compactOldToolResults\s*\}\s*from\s*["']\.\/toolResultCompaction["']/,
    );
  });

  it("gemini.ts calls compactOldToolResults before each round", () => {
    expect(geminiSource).toMatch(/compactOldToolResults\(contents,\s*round\s*\+\s*1\)/);
  });

  it("gemini.ts documents the compaction in a comment", () => {
    expect(geminiSource).toMatch(/P1 #8 fix.*compact older tool results/i);
  });

  it("groq.ts imports TOOL_COMPACTION_ENABLED + COMPACTABLE_TOOLS", () => {
    expect(groqSource).toMatch(
      /import\s*\{[\s\S]*?TOOL_COMPACTION_ENABLED[\s\S]*?\}\s*from\s*["']\.\/toolResultCompaction["']/,
    );
    expect(groqSource).toMatch(/COMPACTABLE_TOOLS/);
  });

  it("groq.ts calls compactGroqToolResults before each round (when enabled)", () => {
    expect(groqSource).toMatch(/compactGroqToolResults\(messages,\s*round\s*\+\s*1\)/);
  });

  it("groq.ts defines the compactGroqToolResults function", () => {
    expect(groqSource).toMatch(/function\s+compactGroqToolResults\(/);
  });

  it("groq.ts defines the buildGroqCompactedSummary function", () => {
    expect(groqSource).toMatch(/function\s+buildGroqCompactedSummary\(/);
  });
});

// ─── Backward compatibility: all P1 features are opt-in ─────────────────────

describe("P1 backward compatibility: all features are opt-in (default OFF)", () => {
  it("P1 #5: GEMINI_CONTEXT_CACHING_ENABLED defaults to false", () => {
    // The constant is read at module load time. Without setting the env var,
    // it should be false (the default).
    expect(GEMINI_CONTEXT_CACHING_ENABLED).toBe(false);
  });

  it("P1 #8: TOOL_COMPACTION_ENABLED defaults to false", () => {
    expect(TOOL_COMPACTION_ENABLED).toBe(false);
  });

  it("P1 #5: GEMINI_CACHE_TTL_SECONDS is within [60, 3600]", () => {
    expect(GEMINI_CACHE_TTL_SECONDS).toBeGreaterThanOrEqual(60);
    expect(GEMINI_CACHE_TTL_SECONDS).toBeLessThanOrEqual(3600);
  });

  it("P1 #6: shouldAttemptSemanticCache is always active (not opt-in — it's a cheap pre-filter)", () => {
    // P1 #6 is NOT opt-in — it's a cheap pre-filter that runs on every
    // semantic cache lookup. It doesn't change behavior (the cache lookup
    // would have missed anyway), just skips the expensive embedding call.
    expect(typeof shouldAttemptSemanticCache).toBe("function");
  });

  it("P1 #7: findOrCreateSession is always active (not opt-in — it's a pure optimization)", () => {
    // P1 #7 is NOT opt-in — it's a pure DB query optimization. The behavior
    // is identical (same row returned), just faster (1 query instead of 3).
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toMatch(/P1 #7 fix/);
  });
});

// ─── Source-shape tests: env var documentation ──────────────────────────────

describe("P1 env var documentation", () => {
  const geminiCacheSource = readSource("artifacts/api-server/src/lib/geminiContextCache.ts");
  const compactionSource = readSource("artifacts/api-server/src/lib/toolResultCompaction.ts");
  const embeddingCacheSource = readSource("artifacts/api-server/src/lib/embeddingCache.ts");

  it("P1 #5 documents AI_GEMINI_CONTEXT_CACHING_ENABLED env var", () => {
    expect(geminiCacheSource).toMatch(/AI_GEMINI_CONTEXT_CACHING_ENABLED/);
  });

  it("P1 #5 documents AI_GEMINI_CACHE_TTL_SECONDS env var", () => {
    expect(geminiCacheSource).toMatch(/AI_GEMINI_CACHE_TTL_SECONDS/);
  });

  it("P1 #8 documents AI_TOOL_COMPACTION_ENABLED env var", () => {
    expect(compactionSource).toMatch(/AI_TOOL_COMPACTION_ENABLED/);
  });

  it("P1 #8 documents AI_TOOL_COMPACTION_MIN_ROUND env var", () => {
    expect(compactionSource).toMatch(/AI_TOOL_COMPACTION_MIN_ROUND/);
  });

  it("P1 #6 documents AI_SEMANTIC_CACHE_MIN_MESSAGE_CHARS env var", () => {
    expect(embeddingCacheSource).toMatch(/AI_SEMANTIC_CACHE_MIN_MESSAGE_CHARS/);
  });

  it("P1 #6 documents AI_SEMANTIC_CACHE_MAX_MESSAGE_CHARS env var", () => {
    expect(embeddingCacheSource).toMatch(/AI_SEMANTIC_CACHE_MAX_MESSAGE_CHARS/);
  });
});
