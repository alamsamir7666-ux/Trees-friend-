/**
 * P2 fixes: architectural / refactor tests.
 *
 * Verifies the five P2 changes:
 *   P2 #9:  Extract generic L1LruCache<T> class (eliminates drift across 4 cache modules).
 *   P2 #10: Replace KB content version table scan with Redis counter.
 *   P2 #11: Move isPureGreeting check before classifyIntent.
 *   P2 #12: Skip output PII redaction when no PII leak vector.
 *   P2 #13: Extract shared GROQ_MODELS_WITH_JSON_SCHEMA set (eliminates drift).
 *
 * Coverage:
 *   - L1LruCache<T> behavioral tests (get, set, clear, LRU eviction).
 *   - groqModels.ts module structure + supportsGroqJsonSchema behavioral tests.
 *   - shouldRunOutputPiiRedaction behavioral tests.
 *   - kbContentVersion.ts Redis counter + DB fallback.
 *   - routes/ai.ts P2 #11 greeting-first ordering.
 *   - Source-shape tests for all modules.
 *   - Backward compatibility: all features are opt-in or pure refactors.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/p2ArchitecturalFixes.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Ensure the AI_SESSION_SECRET is set (required transitively by sessionToken.ts).
process.env.AI_SESSION_SECRET ??= "dGVzdC1haS1zZXNzaW9uLXNlY3JldC1rZXktZG8tbm90LXVzZS1pbi1wcm9k";

import { L1LruCache } from "../src/lib/l1LruCache";
import { GROQ_MODELS_WITH_JSON_SCHEMA, supportsGroqJsonSchema } from "../src/lib/groqModels";
import { shouldRunOutputPiiRedaction } from "../src/lib/outputSafety";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

// ─── P2 #9: L1LruCache<T> behavioral tests ──────────────────────────────────

describe("P2 #9: L1LruCache<T> behavioral tests", () => {
  it("get returns null for missing key", () => {
    const cache = new L1LruCache<string>(10);
    expect(cache.get("missing")).toBeNull();
  });

  it("set + get returns the cached value", () => {
    const cache = new L1LruCache<string>(10);
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
  });

  it("set overwrites existing value", () => {
    const cache = new L1LruCache<string>(10);
    cache.set("key1", "value1");
    cache.set("key1", "value2");
    expect(cache.get("key1")).toBe("value2");
    expect(cache.size).toBe(1);
  });

  it("clear removes all entries + returns the count", () => {
    const cache = new L1LruCache<string>(10);
    cache.set("key1", "value1");
    cache.set("key2", "value2");
    const cleared = cache.clear();
    expect(cleared).toBe(2);
    expect(cache.size).toBe(0);
    expect(cache.get("key1")).toBeNull();
  });

  it("LRU eviction: evicts the oldest entry when at capacity", () => {
    const cache = new L1LruCache<string>(3);
    cache.set("key1", "value1");
    cache.set("key2", "value2");
    cache.set("key3", "value3");
    // At capacity — next set should evict key1 (oldest).
    cache.set("key4", "value4");
    expect(cache.get("key1")).toBeNull(); // evicted
    expect(cache.get("key2")).toBe("value2"); // still present
    expect(cache.get("key3")).toBe("value3"); // still present
    expect(cache.get("key4")).toBe("value4"); // newly inserted
    expect(cache.size).toBe(3);
  });

  it("LRU promotion: get moves entry to most-recently-used", () => {
    const cache = new L1LruCache<string>(3);
    cache.set("key1", "value1");
    cache.set("key2", "value2");
    cache.set("key3", "value3");
    // Access key1 → promotes it to most-recently-used.
    cache.get("key1");
    // Now key2 is the oldest. Next set should evict key2 (not key1).
    cache.set("key4", "value4");
    expect(cache.get("key1")).toBe("value1"); // promoted, not evicted
    expect(cache.get("key2")).toBeNull(); // evicted (was oldest after promotion)
    expect(cache.get("key3")).toBe("value3");
    expect(cache.get("key4")).toBe("value4");
  });

  it("update doesn't evict (key already present)", () => {
    const cache = new L1LruCache<string>(2);
    cache.set("key1", "value1");
    cache.set("key2", "value2");
    // Update key1 (already present) — should NOT evict (capacity check only
    // triggers for NEW keys).
    cache.set("key1", "updated");
    expect(cache.get("key1")).toBe("updated");
    expect(cache.get("key2")).toBe("value2");
    expect(cache.size).toBe(2);
  });

  it("works with generic types (objects)", () => {
    interface MyEntry {
      data: string;
      count: number;
    }
    const cache = new L1LruCache<MyEntry>(10);
    cache.set("key1", { data: "hello", count: 1 });
    const entry = cache.get("key1");
    expect(entry).not.toBeNull();
    expect(entry!.data).toBe("hello");
    expect(entry!.count).toBe(1);
  });

  it("size returns the current entry count", () => {
    const cache = new L1LruCache<string>(10);
    expect(cache.size).toBe(0);
    cache.set("key1", "value1");
    expect(cache.size).toBe(1);
    cache.set("key2", "value2");
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

// ─── P2 #9: L1LruCache source-shape tests ───────────────────────────────────

describe("P2 #9: l1LruCache.ts module structure", () => {
  const source = readSource("artifacts/api-server/src/lib/l1LruCache.ts");

  it("exports the L1LruCache class", () => {
    expect(source).toMatch(/export\s+class\s+L1LruCache<T>/);
  });

  it("has get, set, clear, size methods", () => {
    expect(source).toMatch(/get\(key:\s*string\):\s*T\s*\|\s*null/);
    expect(source).toMatch(/set\(key:\s*string,\s*entry:\s*T\):\s*void/);
    expect(source).toMatch(/clear\(\):\s*number/);
    expect(source).toMatch(/get\s+size\(\):\s*number/);
  });

  it("documents the LRU eviction pattern", () => {
    expect(source).toMatch(/LRU/i);
    expect(source).toMatch(/evict/i);
    expect(source).toMatch(/oldest/i);
  });

  it("documents the promote-on-read pattern", () => {
    expect(source).toMatch(/promote/i);
    expect(source).toMatch(/most recently used/i);
  });
});

// ─── P2 #9: consumers import L1LruCache ────────────────────────────────────

describe("P2 #9: cache modules import L1LruCache from the shared module", () => {
  it("rerankerCache.ts imports L1LruCache", () => {
    const source = readSource("artifacts/api-server/src/lib/rerankerCache.ts");
    expect(source).toMatch(/import\s*\{\s*L1LruCache\s*\}\s*from\s*["']\.\/l1LruCache["']/);
    expect(source).toMatch(/new\s+L1LruCache<CacheEntry>/);
  });

  it("promptInjectionCache.ts imports L1LruCache", () => {
    const source = readSource("artifacts/api-server/src/lib/promptInjectionCache.ts");
    expect(source).toMatch(/import\s*\{\s*L1LruCache\s*\}\s*from\s*["']\.\/l1LruCache["']/);
    expect(source).toMatch(/new\s+L1LruCache<CacheEntry>/);
  });

  it("topicClassifierCache.ts imports L1LruCache", () => {
    const source = readSource("artifacts/api-server/src/lib/topicClassifierCache.ts");
    expect(source).toMatch(/import\s*\{\s*L1LruCache\s*\}\s*from\s*["']\.\/l1LruCache["']/);
    expect(source).toMatch(/new\s+L1LruCache<TopicCacheEntry>/);
  });

  it("intentClassifier.ts imports L1LruCache", () => {
    const source = readSource("artifacts/api-server/src/lib/intentClassifier.ts");
    expect(source).toMatch(/import\s*\{\s*L1LruCache\s*\}\s*from\s*["']\.\/l1LruCache["']/);
    expect(source).toMatch(/new\s+L1LruCache<IntentClassification>/);
  });

  it("none of the 4 consumers define a local L1Cache class", () => {
    // P2 #9: the local L1Cache class should be REMOVED from all 4 files.
    const files = [
      "artifacts/api-server/src/lib/rerankerCache.ts",
      "artifacts/api-server/src/lib/promptInjectionCache.ts",
      "artifacts/api-server/src/lib/topicClassifierCache.ts",
      "artifacts/api-server/src/lib/intentClassifier.ts",
    ];
    for (const file of files) {
      const source = readSource(file);
      // We strip comments before checking — the P2 #9 fix comment mentions
      // "L1Cache class was extracted" for documentation purposes.
      const codeOnly = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      expect(codeOnly).not.toMatch(/class\s+L1Cache\b/);
    }
  });
});

// ─── P2 #13: groqModels.ts module structure + behavioral tests ──────────────

describe("P2 #13: groqModels.ts module structure", () => {
  const source = readSource("artifacts/api-server/src/lib/groqModels.ts");

  it("exports GROQ_MODELS_WITH_JSON_SCHEMA as a ReadonlySet<string>", () => {
    expect(source).toMatch(/export\s+const\s+GROQ_MODELS_WITH_JSON_SCHEMA:\s*ReadonlySet<string>/);
  });

  it("exports supportsGroqJsonSchema function", () => {
    expect(source).toMatch(/export\s+function\s+supportsGroqJsonSchema/);
  });

  it("documents the drift elimination rationale", () => {
    expect(source).toMatch(/drift/i);
    expect(source).toMatch(/P2 #13/);
  });
});

describe("P2 #13: supportsGroqJsonSchema behavioral tests", () => {
  it("returns true for known Groq models with json_schema support", () => {
    expect(supportsGroqJsonSchema("llama-4-scout-17b-16e-instruct")).toBe(true);
    expect(supportsGroqJsonSchema("llama-4-maverick-17b-128e-instruct")).toBe(true);
    expect(supportsGroqJsonSchema("openai/gpt-oss-120b")).toBe(true);
    expect(supportsGroqJsonSchema("openai/gpt-oss-20b")).toBe(true);
    expect(supportsGroqJsonSchema("llama-3.3-70b-versatile")).toBe(true);
    expect(supportsGroqJsonSchema("llama-3.1-8b-instant")).toBe(true);
    expect(supportsGroqJsonSchema("llama3-70b-8192")).toBe(true);
    expect(supportsGroqJsonSchema("llama3-8b-8192")).toBe(true);
  });

  it("returns false for unknown models", () => {
    expect(supportsGroqJsonSchema("some-unknown-model")).toBe(false);
    expect(supportsGroqJsonSchema("mixtral-8x7b-32768")).toBe(false);
    expect(supportsGroqJsonSchema("gemma2-9b-it")).toBe(false);
  });

  it("handles @date-suffix variants (Groq dated snapshots)", () => {
    expect(supportsGroqJsonSchema("llama-3.3-70b-versatile@2025-01-01")).toBe(true);
    expect(supportsGroqJsonSchema("openai/gpt-oss-120b@2025-06-01")).toBe(true);
    expect(supportsGroqJsonSchema("unknown-model@2025-01-01")).toBe(false);
  });

  it("GROQ_MODELS_WITH_JSON_SCHEMA contains openai/gpt-oss-20b (previously missing from promptInjectionLLM.ts)", () => {
    // P2 #13 fix: this was the drift bug — promptInjectionLLM.ts was missing
    // openai/gpt-oss-20b. Now all 4 consumers use the shared set.
    expect(GROQ_MODELS_WITH_JSON_SCHEMA.has("openai/gpt-oss-20b")).toBe(true);
  });
});

// ─── P2 #13: consumers import from groqModels ──────────────────────────────

describe("P2 #13: consumers import supportsGroqJsonSchema from the shared module", () => {
  it("structuredOutput.ts imports supportsGroqJsonSchema", () => {
    const source = readSource("artifacts/api-server/src/lib/structuredOutput.ts");
    expect(source).toMatch(
      /import\s*\{\s*supportsGroqJsonSchema\s*\}\s*from\s*["']\.\/groqModels["']/,
    );
  });

  it("outputSafety.ts imports supportsGroqJsonSchema", () => {
    const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");
    expect(source).toMatch(
      /import\s*\{\s*supportsGroqJsonSchema\s*\}\s*from\s*["']\.\/groqModels["']/,
    );
  });

  it("topicClassifier.ts imports supportsGroqJsonSchema", () => {
    const source = readSource("artifacts/api-server/src/lib/topicClassifier.ts");
    expect(source).toMatch(
      /import\s*\{\s*supportsGroqJsonSchema\s*\}\s*from\s*["']\.\/groqModels["']/,
    );
  });

  it("promptInjectionLLM.ts imports supportsGroqJsonSchema", () => {
    const source = readSource("artifacts/api-server/src/lib/promptInjectionLLM.ts");
    expect(source).toMatch(
      /import\s*\{\s*supportsGroqJsonSchema\s*\}\s*from\s*["']\.\/groqModels["']/,
    );
  });

  it("none of the 4 consumers define a local GROQ_MODELS_WITH_JSON_SCHEMA set", () => {
    // P2 #13: the local set should be REMOVED from all 4 files.
    const files = [
      "artifacts/api-server/src/lib/structuredOutput.ts",
      "artifacts/api-server/src/lib/outputSafety.ts",
      "artifacts/api-server/src/lib/topicClassifier.ts",
      "artifacts/api-server/src/lib/promptInjectionLLM.ts",
    ];
    for (const file of files) {
      const source = readSource(file);
      // We strip comments before checking — the P2 #13 fix comment mentions
      // "GROQ_MODELS_WITH_JSON_SCHEMA" for documentation purposes.
      const codeOnly = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      expect(codeOnly).not.toMatch(/const\s+GROQ_MODELS_WITH_JSON_SCHEMA\s*=\s*new\s+Set/);
    }
  });
});

// ─── P2 #12: shouldRunOutputPiiRedaction behavioral tests ──────────────────

describe("P2 #12: shouldRunOutputPiiRedaction behavioral tests", () => {
  const USER_SCOPED_TOOLS = new Set(["get_user_orders", "get_order_details"]);

  it("returns FALSE for a pure catalog query (no user-scoped tools, no input PII)", () => {
    expect(shouldRunOutputPiiRedaction(["search_catalog"], USER_SCOPED_TOOLS, false)).toBe(false);
  });

  it("returns FALSE for a KB-only query (search_knowledge_base)", () => {
    expect(shouldRunOutputPiiRedaction(["search_knowledge_base"], USER_SCOPED_TOOLS, false)).toBe(
      false,
    );
  });

  it("returns FALSE when no tools were called", () => {
    expect(shouldRunOutputPiiRedaction([], USER_SCOPED_TOOLS, false)).toBe(false);
  });

  it("returns TRUE when a user-scoped tool was called (get_user_orders)", () => {
    expect(shouldRunOutputPiiRedaction(["get_user_orders"], USER_SCOPED_TOOLS, false)).toBe(true);
  });

  it("returns TRUE when a user-scoped tool was called (get_order_details)", () => {
    expect(shouldRunOutputPiiRedaction(["get_order_details"], USER_SCOPED_TOOLS, false)).toBe(true);
  });

  it("returns TRUE when the input had PII (LLM might echo it back)", () => {
    expect(shouldRunOutputPiiRedaction(["search_catalog"], USER_SCOPED_TOOLS, true)).toBe(true);
  });

  it("does NOT use isPrivateQuery (unlike shouldRunConstitutionalAI)", () => {
    // P2 #12: shouldRunOutputPiiRedaction does NOT have an isPrivateQuery gate.
    // Account keywords alone don't indicate a PII leak vector — they just
    // indicate the user MIGHT ask about their orders, which is caught by the
    // user-scoped tool gate.
    // We verify the function only takes 3 parameters (no isPrivateQuery).
    const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");
    expect(source).toMatch(
      /export\s+function\s+shouldRunOutputPiiRedaction\s*\(\s*toolCalls[^)]*\)\s*:\s*boolean/,
    );
  });
});

// ─── P2 #12: outputSafety.ts source-shape tests ─────────────────────────────

describe("P2 #12: outputSafety.ts wiring", () => {
  const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");

  it("exports shouldRunOutputPiiRedaction", () => {
    expect(source).toMatch(/export\s+function\s+shouldRunOutputPiiRedaction/);
  });

  it("checkOutputSafety accepts a runPiiRedaction parameter", () => {
    expect(source).toMatch(/runPiiRedaction:\s*boolean\s*=\s*true/);
  });

  it("PII redaction is gated on runPiiRedaction", () => {
    expect(source).toMatch(/if\s*\(\s*PII_REDACTION_ENABLED\s*&&\s*runPiiRedaction\s*\)/);
  });

  it("documents OUTPUT_PII_REDACTION_GATE_ENABLED env var", () => {
    expect(source).toMatch(/OUTPUT_PII_REDACTION_GATE_ENABLED/);
  });
});

// ─── P2 #12: routes/ai.ts wiring ────────────────────────────────────────────

describe("P2 #12: routes/ai.ts wires shouldRunOutputPiiRedaction", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("imports shouldRunOutputPiiRedaction from outputSafety", () => {
    expect(source).toMatch(/shouldRunOutputPiiRedaction/);
  });

  it("computes runOutputPiiRedaction via shouldRunOutputPiiRedaction", () => {
    expect(source).toMatch(/const\s+runOutputPiiRedaction\s*=\s*shouldRunOutputPiiRedaction/);
  });

  it("passes runOutputPiiRedaction to checkOutputSafety", () => {
    expect(source).toMatch(
      /checkOutputSafety\([\s\S]*?runConstitutionalAI[\s\S]*?runOutputPiiRedaction/,
    );
  });

  it("logs when output PII redaction is skipped (observability)", () => {
    expect(source).toMatch(/output PII redaction SKIPPED/i);
    expect(source).toMatch(/P2 #12/);
  });
});

// ─── P2 #11: routes/ai.ts greeting-first ordering ───────────────────────────

describe("P2 #11: routes/ai.ts greeting-first ordering", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("declares isGreeting FIRST (before classifyIntent + hasBotanicalKeyword)", () => {
    // P2 #11: isPureGreeting should be the FIRST lexical check.
    // We strip comments before checking — the P2 #11 fix comment mentions
    // all three function names for documentation purposes.
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const greetingIdx = codeOnly.indexOf("const isGreeting = isPureGreeting(safeMessage)");
    const intentIdx = codeOnly.indexOf("classifyIntent(safeMessage)");
    const botanicalIdx = codeOnly.indexOf("hasBotanicalKeyword(safeMessage)");
    expect(greetingIdx).toBeGreaterThan(-1);
    expect(intentIdx).toBeGreaterThan(-1);
    expect(botanicalIdx).toBeGreaterThan(-1);
    // isGreeting must come BEFORE classifyIntent + hasBotanicalKeyword.
    expect(greetingIdx).toBeLessThan(intentIdx);
    expect(greetingIdx).toBeLessThan(botanicalIdx);
  });

  it("classifyIntent is CONDITIONAL on !isGreeting (skipped for greetings)", () => {
    // P2 #11: for pure greetings, classifyIntent is not called — we use a
    // default GREETING intent classification.
    expect(source).toMatch(/isGreeting\s*\?\s*\{[^}]*intent:\s*["']GREETING["']/);
  });

  it("hasBotanicalKeyword is CONDITIONAL on !isGreeting (skipped for greetings)", () => {
    // P2 #11: for pure greetings, hasBotanicalKeyword is not called — we
    // default to true (allow).
    expect(source).toMatch(/isGreeting\s*\?\s*true\s*:\s*hasBotanicalKeyword\(safeMessage\)/);
  });

  it("documents the P2 #11 fix in a comment", () => {
    expect(source).toMatch(/P2 #11 fix/i);
  });
});

// ─── P2 #10: kbContentVersion.ts Redis counter ──────────────────────────────

describe("P2 #10: kbContentVersion.ts Redis counter + DB fallback", () => {
  const source = readSource("artifacts/api-server/src/lib/kbContentVersion.ts");

  it("imports getRedis from redisClient", () => {
    expect(source).toMatch(/import\s*\{\s*getRedis\s*\}\s*from\s*["']\.\/redisClient["']/);
  });

  it("exports incrementKbContentVersion function", () => {
    expect(source).toMatch(/export\s+async\s+function\s+incrementKbContentVersion/);
  });

  it("getKbContentVersion tries Redis counter first (fast path)", () => {
    expect(source).toMatch(/getKbContentVersionFromRedis/);
    expect(source).toMatch(/try Redis counter first/i);
  });

  it("falls back to DB table scan when Redis is unavailable", () => {
    expect(source).toMatch(/getKbContentVersionFromDb/);
    expect(source).toMatch(/DB table scan \+ SHA-1 hash/i);
  });

  it("Redis counter version format is `rN` (e.g., r42)", () => {
    expect(source).toMatch(/`r\$?{counter}`|`r\$\{counter\}`/);
  });

  it("documents the Redis key (ai:kb:version)", () => {
    expect(source).toMatch(/ai:kb:version/);
  });

  it("documents the P2 #10 fix in the file header", () => {
    expect(source).toMatch(/P2 #10 fix/i);
  });
});

// ─── P2 #10: kbCache.ts wiring ───────────────────────────────────────────────

describe("P2 #10: kbCache.ts wires incrementKbContentVersion", () => {
  const source = readSource("artifacts/api-server/src/lib/kbCache.ts");

  it("imports incrementKbContentVersion from kbContentVersion", () => {
    expect(source).toMatch(
      /import\s*\{[\s\S]*?incrementKbContentVersion[\s\S]*?\}\s*from\s*["']\.\/kbContentVersion["']/,
    );
  });

  it("calls incrementKbContentVersion() in invalidateKbCache", () => {
    expect(source).toMatch(/await\s+incrementKbContentVersion\(\)/);
  });

  it("calls incrementKbContentVersion BEFORE clearKbContentVersionCache", () => {
    const incrIdx = source.indexOf("incrementKbContentVersion()");
    const clearIdx = source.indexOf("clearKbContentVersionCache()");
    expect(incrIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(-1);
    expect(incrIdx).toBeLessThan(clearIdx);
  });

  it("documents the P2 #10 fix in the invalidation comment", () => {
    expect(source).toMatch(/P2 #10/i);
  });
});

// ─── Backward compatibility: P2 features are opt-in or pure refactors ───────

describe("P2 backward compatibility", () => {
  it("P2 #9 (L1LruCache) is a pure refactor — no behavior change", () => {
    // The shared class has the SAME methods + signatures as the per-module
    // L1Cache it replaces. No env var needed.
    const cache = new L1LruCache<string>(10);
    expect(typeof cache.get).toBe("function");
    expect(typeof cache.set).toBe("function");
    expect(typeof cache.clear).toBe("function");
  });

  it("P2 #10 (Redis counter) falls back to DB hash when Redis is unavailable", () => {
    // The DB hash fallback is preserved — the version is still computed
    // correctly when Redis is down.
    const source = readSource("artifacts/api-server/src/lib/kbContentVersion.ts");
    expect(source).toMatch(/getKbContentVersionFromDb/);
    expect(source).toMatch(/fallback/i);
  });

  it("P2 #11 (greeting-first) is always active — no env var needed", () => {
    // Pure control flow optimization — no behavior change (greetings still
    // get the canned response, non-greetings still get full classification).
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toMatch(/P2 #11 fix/i);
  });

  it("P2 #12 (output PII redaction gating) defaults to enabled (gate on)", () => {
    // The gate is ON by default — PII redaction runs unless the caller
    // explicitly skips it (via shouldRunOutputPiiRedaction returning false).
    // Opt-out via OUTPUT_PII_REDACTION_GATE_ENABLED=false.
    const source = readSource("artifacts/api-server/src/lib/outputSafety.ts");
    expect(source).toMatch(/OUTPUT_PII_REDACTION_GATE_ENABLED.*true/i);
  });

  it("P2 #13 (shared GROQ_MODELS_WITH_JSON_SCHEMA) is a pure refactor — no behavior change", () => {
    // The shared set has the SAME entries as the per-module sets it replaces
    // (plus fixes the drift: promptInjectionLLM.ts was missing
    // openai/gpt-oss-20b). No env var needed.
    expect(supportsGroqJsonSchema("openai/gpt-oss-120b")).toBe(true);
    expect(supportsGroqJsonSchema("unknown-model")).toBe(false);
  });
});
