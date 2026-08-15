/**
 * Executable unit tests for lib/queryEmbeddingCache.ts.
 *
 * Unlike the source-shape tests elsewhere in this suite, these tests
 * IMPORT the real module and exercise its behavior end-to-end:
 *   - L1 LRU eviction (capacity bound + recency bump)
 *   - L2 Redis round-trip (mocked)
 *   - Single-flight coalescing (concurrent identical queries share one call)
 *   - Negative caching (null results cached with short TTL)
 *   - Stats accounting (hits / misses / generator calls / evictions)
 *   - Cache key normalization (whitespace, case, NFC, model name)
 *   - Clear + invalidate APIs
 *
 * The Gemini SDK is replaced by an injectable `generator` stub — no network
 * calls, no API key required. Redis is mocked via `vi.mock("./redisClient")`
 * with an in-memory Map that simulates Upstash Redis semantics.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/queryEmbeddingCache.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Mock Redis BEFORE importing the module under test ───────────────────────
//
// queryEmbeddingCache.ts calls `getRedis()` from ./redisClient at L2-access
// time. We mock the module to return a fake Redis backed by an in-memory Map.
// The fake implements just the methods used by queryEmbeddingCache: get, set,
// del, scan. TTLs are tracked but not enforced (tests don't wait for expiry).

const _fakeRedisStore = new Map<string, { value: string; expiresAt: number }>();

const fakeRedis = {
  async get<T = string>(key: string): Promise<T | null> {
    const entry = _fakeRedisStore.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      _fakeRedisStore.delete(key);
      return null;
    }
    return entry.value as unknown as T;
  },
  async set(key: string, value: string, opts?: { ex?: number }): Promise<"OK"> {
    const ttl = opts?.ex ?? 3600;
    _fakeRedisStore.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return "OK";
  },
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (_fakeRedisStore.delete(k)) n++;
    }
    return n;
  },
  async scan(
    cursor: string,
    opts?: { match?: string; count?: number },
  ): Promise<[string, string[]]> {
    const pattern = opts?.match ?? "*";
    // Convert glob pattern to regex: `*` → `.*`, escape other regex chars.
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\?/g, ".")
          .replace(/\*/g, ".*") +
        "$",
    );
    const matching: string[] = [];
    for (const key of _fakeRedisStore.keys()) {
      if (regex.test(key)) matching.push(key);
    }
    // Single-batch scan — return all matches at once with cursor "0".
    return ["0", matching];
  },
};

vi.mock("../src/lib/redisClient", () => ({
  getRedis: () => fakeRedis,
}));

// Ensure env vars required by transitively-imported modules are set.
process.env.AI_SESSION_SECRET ??= "dGVzdC1haS1zZXNzaW9uLXNlY3JldC1rZXktZG8tbm90LXVzZS1pbi1wcm9k";

// Now import the module under test.
import {
  getOrCreateQueryEmbedding,
  getQueryEmbeddingCacheStats,
  clearQueryEmbeddingCache,
  invalidateQueryEmbedding,
  __resetForTests,
} from "../src/lib/queryEmbeddingCache";

// ─── Test helpers ────────────────────────────────────────────────────────────

// BUG-E1 fix: updated from "text-embedding-004" (shut down by Google Jan 2026)
// to "gemini-embedding-001" (the current model). The cache is model-agnostic —
// it just uses the model name as part of the cache key. The actual model name
// doesn't matter for these tests; what matters is that the same name produces
// the same cache key + a different name invalidates the cache.
const MODEL = "gemini-embedding-001";

/** A fake embedding vector — 768 floats (matching Gemini gemini-embedding-001 at 768 dims). */
function makeFakeVector(seed: number = 1): number[] {
  const v = new Array(768);
  for (let i = 0; i < 768; i++) v[i] = ((seed * 31 + i * 7) % 1000) / 1000;
  return v;
}

/** A generator stub that returns a deterministic vector per query + counts calls. */
function makeCountingGenerator(): {
  generator: (text: string) => Promise<number[] | null>;
  calls: string[];
  nextResult: number[] | null;
} {
  const calls: string[] = [];
  const nextResult: number[] | null = makeFakeVector(1);
  return {
    calls,
    nextResult,
    generator: async (text: string) => {
      calls.push(text);
      // Use a small delay to simulate real API latency — exercises single-flight.
      await new Promise((r) => setTimeout(r, 10));
      return nextResult;
    },
  };
}

/** A generator stub that always fails — simulates Gemini outage. */
function makeFailingGenerator(errorMsg: string = "429 rate limit"): {
  generator: (text: string) => Promise<number[] | null>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    generator: async (text: string) => {
      calls.push(text);
      await new Promise((r) => setTimeout(r, 10));
      throw new Error(errorMsg);
    },
  };
}

/** A generator stub that returns null — simulates empty Gemini response. */
function makeNullGenerator(): {
  generator: (text: string) => Promise<number[] | null>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    generator: async (text: string) => {
      calls.push(text);
      await new Promise((r) => setTimeout(r, 10));
      return null;
    },
  };
}

// ─── Test setup / teardown ───────────────────────────────────────────────────

beforeEach(() => {
  _fakeRedisStore.clear();
  __resetForTests();
});

afterEach(() => {
  _fakeRedisStore.clear();
  __resetForTests();
  vi.restoreAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("queryEmbeddingCache: L1 (in-process LRU)", () => {
  it("calls the generator on first miss + caches the result in L1", async () => {
    const gen = makeCountingGenerator();
    const q = "how often to water mango?";

    const r1 = await getOrCreateQueryEmbedding(q, MODEL, gen.generator);
    expect(r1).toEqual(makeFakeVector(1));
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0]).toBe("how often to water mango?");

    const stats1 = getQueryEmbeddingCacheStats();
    expect(stats1.generatorCalls).toBe(1);
    expect(stats1.l1Hits).toBe(0);
    expect(stats1.l2Hits).toBe(0);

    // Second call — should hit L1, not call the generator.
    const r2 = await getOrCreateQueryEmbedding(q, MODEL, gen.generator);
    expect(r2).toEqual(makeFakeVector(1));
    expect(gen.calls).toHaveLength(1); // unchanged
    expect(getQueryEmbeddingCacheStats().l1Hits).toBe(1);
  });

  it("normalizes whitespace + case before hashing (semantically identical queries share an entry)", async () => {
    const gen = makeCountingGenerator();

    await getOrCreateQueryEmbedding("How   often to water MANGO?", MODEL, gen.generator);
    await getOrCreateQueryEmbedding("how often to water mango?", MODEL, gen.generator);
    await getOrCreateQueryEmbedding("  HOW OFTEN TO WATER MANGO?  ", MODEL, gen.generator);

    expect(gen.calls).toHaveLength(1); // all 3 normalized to the same key
  });

  it("evicts the oldest entry when L1 is at capacity (LRU)", async () => {
    // Temporarily lower the LRU size for this test.
    const original = process.env.AI_QUERY_EMBEDDING_LRU_SIZE;
    process.env.AI_QUERY_EMBEDDING_LRU_SIZE = "3";
    // Re-import the module so the new env var takes effect.
    vi.resetModules();
    const mod = await import("../src/lib/queryEmbeddingCache");
    mod.__resetForTests();

    const gen = makeCountingGenerator();
    // Sequence: insert q1, q2, q3 (L1 now full at 3).
    await mod.getOrCreateQueryEmbedding("query1", MODEL, gen.generator); // call 1
    await mod.getOrCreateQueryEmbedding("query2", MODEL, gen.generator); // call 2
    await mod.getOrCreateQueryEmbedding("query3", MODEL, gen.generator); // call 3
    // Access q1 to bump it to MRU. LRU order is now: q2, q3, q1.
    await mod.getOrCreateQueryEmbedding("query1", MODEL, gen.generator); // L1 hit — no call
    expect(gen.calls).toHaveLength(3);

    // Insert q4. Capacity is 3, so the LRU (q2) is evicted from L1.
    // NOTE: q2 is still in L2 (Redis), so re-accessing it would be an L2 hit,
    // not a generator call. To test L1 eviction in isolation, we clear L2
    // after the eviction so the next q2 access is a true miss.
    await mod.getOrCreateQueryEmbedding("query4", MODEL, gen.generator); // call 4
    expect(gen.calls).toHaveLength(4);
    expect(mod.getQueryEmbeddingCacheStats().l1Evictions).toBeGreaterThanOrEqual(1);

    // q1 should still be a hit (it was MRU before q4 was inserted).
    await mod.getOrCreateQueryEmbedding("query1", MODEL, gen.generator); // L1 hit
    expect(gen.calls).toHaveLength(4);

    // Clear L2 so q2 is a true miss (not just an L1 eviction backed by L2).
    _fakeRedisStore.clear();

    // q2 should now be a miss → calls the generator again.
    await mod.getOrCreateQueryEmbedding("query2", MODEL, gen.generator); // call 5
    expect(gen.calls).toHaveLength(5);

    // Restore env.
    process.env.AI_QUERY_EMBEDDING_LRU_SIZE = original;
    vi.resetModules();
  });
});

describe("queryEmbeddingCache: L2 (Redis shared cache)", () => {
  it("writes the vector to L2 on generator success (positive cache)", async () => {
    const gen = makeCountingGenerator();
    await getOrCreateQueryEmbedding("test query", MODEL, gen.generator);

    // The L2 store should now have an entry under `ai:qemb:gemini-embedding-001:<hash>`.
    const keys = Array.from(_fakeRedisStore.keys());
    expect(keys.some((k) => k.startsWith("ai:qemb:gemini-embedding-001:"))).toBe(true);

    // The stored value should be a JSON array of 768 floats.
    const stored = Array.from(_fakeRedisStore.values())[0];
    const parsed = JSON.parse(stored.value);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(768);
  });

  it("reads from L2 on L1 miss (and populates L1 for the next call)", async () => {
    const gen = makeCountingGenerator();

    // First call — populates L1 + L2.
    await getOrCreateQueryEmbedding("query A", MODEL, gen.generator);
    expect(gen.calls).toHaveLength(1);

    // Simulate an L1 miss (e.g., process restart) by clearing L1 only.
    // We can't directly clear L1 without clearing stats, so use __resetForTests
    // which clears L1 + stats but NOT the mocked Redis store.
    __resetForTests();

    // Second call — L1 is empty, L2 should hit.
    const r = await getOrCreateQueryEmbedding("query A", MODEL, gen.generator);
    expect(r).toEqual(makeFakeVector(1));
    expect(gen.calls).toHaveLength(1); // generator NOT called — L2 hit
    expect(getQueryEmbeddingCacheStats().l2Hits).toBe(1);

    // Third call — now L1 should be populated from the L2 hit.
    await getOrCreateQueryEmbedding("query A", MODEL, gen.generator);
    expect(gen.calls).toHaveLength(1); // still no generator call
    expect(getQueryEmbeddingCacheStats().l1Hits).toBe(1);
  });

  it("falls back gracefully when Redis is unavailable (L1-only mode)", async () => {
    // Re-mock redisClient to return null (Redis not configured).
    vi.doMock("../src/lib/redisClient", () => ({ getRedis: () => null }));
    vi.resetModules();
    const mod = await import("../src/lib/queryEmbeddingCache");
    mod.__resetForTests();

    const gen = makeCountingGenerator();

    // First call — generator runs, L1 populated (no L2).
    const r1 = await mod.getOrCreateQueryEmbedding("test", MODEL, gen.generator);
    expect(r1).toEqual(makeFakeVector(1));
    expect(gen.calls).toHaveLength(1);

    // Second call — L1 hit.
    const r2 = await mod.getOrCreateQueryEmbedding("test", MODEL, gen.generator);
    expect(r2).toEqual(makeFakeVector(1));
    expect(gen.calls).toHaveLength(1);

    expect(mod.getQueryEmbeddingCacheStats().l2Enabled).toBe(false);

    vi.doUnmock("../src/lib/redisClient");
    vi.resetModules();
  });
});

describe("queryEmbeddingCache: single-flight coalescing", () => {
  it("coalesces concurrent identical queries into ONE generator call", async () => {
    const gen = makeCountingGenerator();
    const q = "watering frequency for mango";

    // Fire 5 concurrent requests for the same query.
    const results = await Promise.all([
      getOrCreateQueryEmbedding(q, MODEL, gen.generator),
      getOrCreateQueryEmbedding(q, MODEL, gen.generator),
      getOrCreateQueryEmbedding(q, MODEL, gen.generator),
      getOrCreateQueryEmbedding(q, MODEL, gen.generator),
      getOrCreateQueryEmbedding(q, MODEL, gen.generator),
    ]);

    // All 5 should return the same vector.
    for (const r of results) {
      expect(r).toEqual(makeFakeVector(1));
    }

    // The generator should have been called exactly ONCE.
    expect(gen.calls).toHaveLength(1);

    // Stats should record 4 coalesced calls.
    const stats = getQueryEmbeddingCacheStats();
    expect(stats.generatorCalls).toBe(1);
    expect(stats.coalescedCalls).toBe(4);
  });

  it("does NOT coalesce different queries (each gets its own generator call)", async () => {
    const gen = makeCountingGenerator();

    await Promise.all([
      getOrCreateQueryEmbedding("query A", MODEL, gen.generator),
      getOrCreateQueryEmbedding("query B", MODEL, gen.generator),
      getOrCreateQueryEmbedding("query C", MODEL, gen.generator),
    ]);

    expect(gen.calls).toHaveLength(3);
    expect(new Set(gen.calls).size).toBe(3); // 3 distinct queries
  });

  it("removes the in-flight entry after resolution (next call hits L1)", async () => {
    const gen = makeCountingGenerator();

    await getOrCreateQueryEmbedding("test query", MODEL, gen.generator);
    expect(gen.calls).toHaveLength(1);

    // Wait a tick to ensure the finally block ran.
    await new Promise((r) => setTimeout(r, 5));

    // Next call should hit L1, not the in-flight Map.
    await getOrCreateQueryEmbedding("test query", MODEL, gen.generator);
    expect(gen.calls).toHaveLength(1);
    expect(getQueryEmbeddingCacheStats().l1Hits).toBe(1);
  });
});

describe("queryEmbeddingCache: negative caching", () => {
  it("caches null results (empty Gemini response) with the negative-cache path", async () => {
    const gen = makeNullGenerator();

    const r1 = await getOrCreateQueryEmbedding("query that returns empty", MODEL, gen.generator);
    expect(r1).toBeNull();
    expect(gen.calls).toHaveLength(1);

    // Second call should hit the negative cache — NOT call the generator.
    const r2 = await getOrCreateQueryEmbedding("query that returns empty", MODEL, gen.generator);
    expect(r2).toBeNull();
    expect(gen.calls).toHaveLength(1); // unchanged

    const stats = getQueryEmbeddingCacheStats();
    expect(stats.generatorFailures).toBe(1); // null counts as a failure
    expect(stats.l1Hits).toBe(1); // negative cache hit on L1
  });

  it("caches null when the generator throws (transient failure)", async () => {
    const gen = makeFailingGenerator("429 quota exceeded");

    const r1 = await getOrCreateQueryEmbedding("rate-limited query", MODEL, gen.generator);
    expect(r1).toBeNull();
    expect(gen.calls).toHaveLength(1);

    // The thrown error should be caught + cached as null.
    const r2 = await getOrCreateQueryEmbedding("rate-limited query", MODEL, gen.generator);
    expect(r2).toBeNull();
    expect(gen.calls).toHaveLength(1); // not called again — negative cache hit

    const stats = getQueryEmbeddingCacheStats();
    expect(stats.generatorFailures).toBe(1);
  });

  it("writes the null sentinel to L2 (not the literal null)", async () => {
    const gen = makeNullGenerator();
    await getOrCreateQueryEmbedding("null query", MODEL, gen.generator);

    const keys = Array.from(_fakeRedisStore.keys()).filter((k) => k.startsWith("ai:qemb:"));
    expect(keys).toHaveLength(1);
    const stored = _fakeRedisStore.get(keys[0]);
    expect(stored?.value).toBe("__null__");
  });
});

describe("queryEmbeddingCache: cache key design", () => {
  it("includes the model name in the key (model upgrade auto-invalidates)", async () => {
    const gen = makeCountingGenerator();

    // BUG-E1 fix: updated model names to reflect the current models.
    await getOrCreateQueryEmbedding("same query", "gemini-embedding-001", gen.generator);
    await getOrCreateQueryEmbedding("same query", "text-embedding-005", gen.generator);

    // Different model = different cache key = 2 generator calls.
    expect(gen.calls).toHaveLength(2);

    // L2 should have 2 entries (one per model).
    const keys = Array.from(_fakeRedisStore.keys()).filter((k) => k.startsWith("ai:qemb:"));
    expect(keys).toHaveLength(2);
    expect(keys.some((k) => k.includes("gemini-embedding-001"))).toBe(true);
    expect(keys.some((k) => k.includes("text-embedding-005"))).toBe(true);
  });

  it("uses the ai:qemb: namespace (separate from ai:cache: response cache)", async () => {
    const gen = makeCountingGenerator();
    await getOrCreateQueryEmbedding("namespace test", MODEL, gen.generator);

    const keys = Array.from(_fakeRedisStore.keys());
    expect(keys.every((k) => k.startsWith("ai:qemb:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("ai:cache:"))).toBe(false);
  });

  it("truncates the query to 2000 chars before hashing (matches Gemini input limit)", async () => {
    const gen = makeCountingGenerator();
    const longQuery = "a".repeat(3000);
    const truncated = "a".repeat(2000);

    await getOrCreateQueryEmbedding(longQuery, MODEL, gen.generator);

    // The generator receives the normalized (truncated) form.
    expect(gen.calls[0]).toBe(truncated);
    expect(gen.calls[0].length).toBe(2000);
  });

  it("NFC-normalizes queries (composed vs decomposed form)", async () => {
    const gen = makeCountingGenerator();

    // Use a string that actually has a difference between NFC and NFD.
    // The Spanish "ñ" (U+00F1) in NFC is one codepoint; in NFD it's "n" + combining tilde (U+0303).
    // Same for "é" (U+00E9) vs "e" + combining acute (U+0301).
    const composed = "niño médico árbol limón";
    const decomposed = composed.normalize("NFD");

    // Sanity check: the two strings are byte-different before normalization.
    expect(composed).not.toBe(decomposed);
    expect(composed.length).not.toBe(decomposed.length);

    await getOrCreateQueryEmbedding(composed, MODEL, gen.generator);
    await getOrCreateQueryEmbedding(decomposed, MODEL, gen.generator);

    // After NFC normalization, both should be cache hits on the same key.
    expect(gen.calls).toHaveLength(1);
  });
});

describe("queryEmbeddingCache: stats + observability", () => {
  it("tracks L1 hits, L2 hits, generator calls, and coalesced calls", async () => {
    const gen = makeCountingGenerator();

    // 1st call: miss → generator → L1 + L2 populated.
    await getOrCreateQueryEmbedding("stats test", MODEL, gen.generator);
    // Snapshot stats after the first call (before reset wipes them).
    const statsAfterFirst = getQueryEmbeddingCacheStats();
    expect(statsAfterFirst.generatorCalls).toBe(1);
    expect(statsAfterFirst.l1Hits).toBe(0);
    expect(statsAfterFirst.l2Hits).toBe(0);

    // 2nd call: L1 hit.
    await getOrCreateQueryEmbedding("stats test", MODEL, gen.generator);
    expect(getQueryEmbeddingCacheStats().l1Hits).toBe(1);

    // Clear L1 (simulating process restart) — note this resets stats too.
    // We'll verify L2 hit by counting generator calls before/after.
    const callsBefore = getQueryEmbeddingCacheStats().generatorCalls; // 1
    __resetForTests();

    // 3rd call: L1 is empty, L2 should hit.
    await getOrCreateQueryEmbedding("stats test", MODEL, gen.generator);
    const statsAfterL2 = getQueryEmbeddingCacheStats();
    expect(statsAfterL2.generatorCalls).toBe(0); // generator NOT called after reset
    expect(statsAfterL2.l2Hits).toBe(1); // L2 hit
    expect(statsAfterL2.l1Hits).toBe(0);
    // The original generatorCalls (1) is preserved across reset only in the
    // external counter, but stats are per-process since reset. We assert on
    // the post-reset snapshot above.
    expect(callsBefore).toBe(1);
  });

  it("tracks generator failures (null results)", async () => {
    const gen = makeNullGenerator();
    await getOrCreateQueryEmbedding("failing query", MODEL, gen.generator);

    const stats = getQueryEmbeddingCacheStats();
    expect(stats.generatorCalls).toBe(1);
    expect(stats.generatorFailures).toBe(1);
  });
});

describe("queryEmbeddingCache: clear + invalidate APIs", () => {
  it("clearQueryEmbeddingCache wipes both L1 and L2", async () => {
    const gen = makeCountingGenerator();
    await getOrCreateQueryEmbedding("clear test 1", MODEL, gen.generator);
    await getOrCreateQueryEmbedding("clear test 2", MODEL, gen.generator);

    // Sanity: L1 + L2 populated.
    expect(getQueryEmbeddingCacheStats().l1Size).toBeGreaterThan(0);
    expect(Array.from(_fakeRedisStore.keys()).filter((k) => k.startsWith("ai:qemb:")).length).toBe(
      2,
    );

    const result = await clearQueryEmbeddingCache();

    expect(result.l1).toBe(2);
    expect(result.l2).toBe(2);
    expect(getQueryEmbeddingCacheStats().l1Size).toBe(0);
    expect(Array.from(_fakeRedisStore.keys()).filter((k) => k.startsWith("ai:qemb:")).length).toBe(
      0,
    );
  });

  it("invalidateQueryEmbedding removes a single query from L1 + L2", async () => {
    const gen = makeCountingGenerator();
    await getOrCreateQueryEmbedding("keep me", MODEL, gen.generator);
    await getOrCreateQueryEmbedding("remove me", MODEL, gen.generator);

    expect(getQueryEmbeddingCacheStats().l1Size).toBe(2);
    expect(Array.from(_fakeRedisStore.keys()).filter((k) => k.startsWith("ai:qemb:")).length).toBe(
      2,
    );

    await invalidateQueryEmbedding("remove me", MODEL);

    // L1 should have 1 entry left ("keep me").
    expect(getQueryEmbeddingCacheStats().l1Size).toBe(1);
    // L2 should have 1 entry left.
    expect(Array.from(_fakeRedisStore.keys()).filter((k) => k.startsWith("ai:qemb:")).length).toBe(
      1,
    );

    // "keep me" should still be a cache hit.
    await getOrCreateQueryEmbedding("keep me", MODEL, gen.generator);
    expect(gen.calls).toHaveLength(2); // unchanged from before invalidate

    // "remove me" should be a miss → generator called again.
    await getOrCreateQueryEmbedding("remove me", MODEL, gen.generator);
    expect(gen.calls).toHaveLength(3);
  });

  it("invalidateQueryEmbedding handles a query that was never cached (no-op)", async () => {
    // Should not throw.
    await invalidateQueryEmbedding("never cached", MODEL);
    expect(getQueryEmbeddingCacheStats().l1Size).toBe(0);
  });
});

describe("queryEmbeddingCache: integration with kbSearch contract", () => {
  it("returns null on persistent generator failure (caller falls back to keyword-only)", async () => {
    // Simulate a sustained Gemini outage — every call fails.
    const gen = makeFailingGenerator("503 service unavailable");

    const r1 = await getOrCreateQueryEmbedding("outage test", MODEL, gen.generator);
    expect(r1).toBeNull();

    // Within the negative-cache window, subsequent calls should also return null
    // WITHOUT calling the generator again.
    const r2 = await getOrCreateQueryEmbedding("outage test", MODEL, gen.generator);
    expect(r2).toBeNull();
    expect(gen.calls).toHaveLength(1); // not retried

    // This matches kbSearch's contract: null → keyword-only search.
    // The negative cache prevents a quota-exhausting retry storm.
  });

  it("preserves vector determinism — same query always returns the same vector", async () => {
    let callCount = 0;
    const gen = async (text: string): Promise<number[] | null> => {
      callCount++;
      // Return a vector derived from the query (deterministic per query).
      const v = new Array(768);
      for (let i = 0; i < 768; i++) v[i] = (text.charCodeAt(i % text.length) + i) / 1000;
      return v;
    };

    const r1 = await getOrCreateQueryEmbedding("determinism test", MODEL, gen);
    const r2 = await getOrCreateQueryEmbedding("determinism test", MODEL, gen);
    const r3 = await getOrCreateQueryEmbedding("determinism test", MODEL, gen);

    expect(callCount).toBe(1); // generator called once, cache hit twice
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });
});
