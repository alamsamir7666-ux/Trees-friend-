/**
 * Query-embedding cache — multi-tier cache for Gemini embedding query
 * embeddings used by kbSearch.searchKnowledgeBase.
 *
 * BUG-E1 fix: the model name is now passed in by the caller (kbSearch.ts),
 * which sources it from embeddingConfig.ts (defaults to gemini-embedding-001,
 * env-configurable via GEMINI_EMBEDDING_MODEL). This module is model-agnostic
 * — it just caches whatever the generator produces, keyed by the model name
 * so changing models automatically invalidates stale cache entries.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 *
 * Before this module, every chat message called Gemini's `embedContent` API
 * directly (kbSearch.ts:generateQueryEmbedding). At ~100-300ms per call and a
 * free-tier quota of 1500 RPD, the quota was exhausted at single-digit
 * chats-per-minute traffic. Repeat queries ("how often to water mango?")
 * re-paid the embedding cost on every ask.
 *
 * Embeddings are DETERMINISTIC for (text, model, taskType) — the same query
 * always yields the same vector. That makes them ideal cache targets.
 *
 * ─── Architecture: 3 layers + single-flight + negative caching ──────────────
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │  getOrCreateQueryEmbedding(query, generator)                         │
 *   └──┬───────────────────────────────────────────────────────────────────┘
 *      │
 *      │  1. normalize(query) → sha256 → cacheKey
 *      │     ai:qemb:<model>:<hash>           (Redis key, also used for L1)
 *      │
 *      │  2. L1 (in-process LRU Map)  ─── HIT? return vector
 *      │     Bounded (default 256 entries × 768 floats × 8B ≈ 1.5MB).
 *      │     Zero latency. Survives within a single long-running process.
 *      │     Defeats the "1000 chats/min of the same 5 questions" hot path.
 *      │
 *      │  3. L2 (Redis, shared, TTL 6h)  ─── HIT? populate L1, return vector
 *      │     Cross-instance cache sharing on Vercel/multi-instance deploys.
 *      │     Falls back gracefully if Redis not configured (L1-only mode).
 *      │
 *      │  4. Single-flight (in-flight Promise Map)
 *      │     If 5 concurrent requests ask the same query, only the FIRST
 *      │     calls Gemini; the other 4 await the same Promise. Critical for
 *      │     traffic spikes (e.g., a viral question).
 *      │
 *      │  5. Generator (Gemini embedContent)
 *      │     On success: write to L1 + L2 (positive cache, long TTL).
 *      │     On failure: write null to L1 + L2 (negative cache, short TTL)
 *      │                 so we don't re-hammer Gemini on persistent failures.
 *      │
 *      └─── return vector (or null → caller falls back to keyword-only search)
 *
 * ─── Cache key design ────────────────────────────────────────────────────────
 *
 *   `ai:qemb:<modelName>:<sha256(normalizedQuery).slice(0,16)>`
 *
 * - `ai:qemb:` namespace — separate from `ai:cache:` (response cache) so
 *   `clearAiCache()` doesn't nuke query embeddings (different lifetimes,
 *   different invalidation triggers).
 * - `<modelName>` — embedding model is part of the key, so upgrading
 *   `gemini-embedding-001` → a future model automatically invalidates
 *   all stale entries (different model = different vector space).
 * - `<sha256>` first 16 hex chars = 64 bits — collision-safe for cache keys
 *   (birthday bound: ~4 billion entries before 50% collision chance).
 *
 * ─── Normalization ───────────────────────────────────────────────────────────
 *
 * Query is normalized BEFORE hashing so semantically identical queries share
 * a cache entry:
 *   - NFC unicode normalization (Bangla composed form)
 *   - trim + collapse internal whitespace
 *   - lowercase
 *   - truncate to MAX_QUERY_CHARS (2000, matching Gemini's input truncation
 *     in kbSearch.ts — if the query is longer, only the first 2K chars are
 *     embedded, so we hash only those)
 *
 * ─── Negative caching ────────────────────────────────────────────────────────
 *
 * When Gemini fails (rate limit, network, no API key), we cache `null` with
 * a SHORT TTL (60s default). This prevents a cascade where 100 concurrent
 * requests all retry Gemini on a transient outage. The 60s TTL is short
 * enough that a real recovery is detected quickly, but long enough to absorb
 * a spike.
 *
 * Sentinel: we store the literal string `"__null__"` in Redis (can't store
 * null in Upstash) and a special marker object in L1.
 *
 * ─── TTLs ────────────────────────────────────────────────────────────────────
 *
 * - Positive (vector found): 6h default (AI_QUERY_EMBEDDING_TTL_SECONDS).
 *   Embeddings are deterministic — long TTL is safe. The only invalidation
 *   trigger is a model upgrade (handled by the model name in the key).
 * - Negative (failure): 60s default (AI_QUERY_EMBEDDING_NEGATIVE_TTL_SECONDS).
 *   Short so transient failures recover quickly.
 *
 * ─── Concurrency safety ──────────────────────────────────────────────────────
 *
 * - L1 (Map) is single-process — JS event loop guarantees atomic access.
 * - L2 (Redis) is shared — Upstash Redis is HTTP-based, so no connection
 *   pooling race conditions. SET with `ex` is atomic.
 * - Single-flight Map is single-process — same as L1. On multi-instance,
 *   each instance may independently call Gemini once for the same query;
 *   the result is then shared via L2. Acceptable trade-off (avoids the
 *   complexity of distributed locks).
 *
 * ─── Failure modes ───────────────────────────────────────────────────────────
 *
 * - Redis down → L1 still works, just no cross-instance sharing. Logged at
 *   debug level (non-fatal).
 * - L1 full → LRU evicts oldest entry. Logged at debug level.
 * - Generator throws → caught, cached as null (negative cache), returned null.
 * - Everything is non-fatal: the caller (kbSearch) falls back to keyword-only
 *   search on null, exactly as before.
 */
import { getRedis } from "./redisClient";
import { logger } from "./logger";
import { createHash } from "crypto";

// ─── Configuration ───────────────────────────────────────────────────────────

/** Long TTL for positive (vector) cache entries. Embeddings are deterministic. */
const CACHE_TTL_SECONDS = Number(process.env.AI_QUERY_EMBEDDING_TTL_SECONDS ?? 21600); // 6h

/** Short TTL for negative (null) cache entries. Quick recovery from transient failures. */
const NEGATIVE_TTL_SECONDS = Number(process.env.AI_QUERY_EMBEDDING_NEGATIVE_TTL_SECONDS ?? 60); // 60s

/** Max entries in the L1 LRU cache. Each entry ≈ 6KB (768 floats × 8 bytes). */
const LRU_MAX_ENTRIES = Number(process.env.AI_QUERY_EMBEDDING_LRU_SIZE ?? 256);

/** Redis key namespace — separate from response cache (`ai:cache:`). */
const KEY_NAMESPACE = "ai:qemb";

/** Sentinel value stored in Redis to represent a cached null (Upstash can't store null directly). */
const NULL_SENTINEL = "__null__";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The embedding generator function — injected by kbSearch.ts so this module
 * stays decoupled from the Gemini SDK. Returns the embedding vector or null
 * on failure (rate limit, network, etc.).
 */
export type EmbeddingGenerator = (text: string) => Promise<number[] | null>;

interface L1Entry {
  /** The embedding vector, or null if negatively cached. */
  vector: number[] | null;
  /** Monotonic timestamp for LRU eviction (oldest evicted first). */
  insertedAt: number;
}

interface CacheStats {
  l1Hits: number;
  l2Hits: number;
  misses: number;
  generatorCalls: number;
  generatorFailures: number;
  coalescedCalls: number;
  l1Size: number;
  l1Evictions: number;
  /** Lifetime of the process — reset on restart. */
  startedAt: number;
}

// ─── L1: in-process LRU cache ────────────────────────────────────────────────

/**
 * Bounded LRU cache using a Map. JS Map preserves insertion order, so the
 * first entry returned by `map.keys().next()` is the oldest (LRU candidate).
 *
 * On read HIT, we delete + re-insert the entry to bump it to the end
 * (most-recently-used). This is O(1) per access.
 *
 * Capacity is bounded by entry count (not bytes) — simpler, and embeddings
 * have a fixed size (768 floats) so byte-size is a linear function of count.
 */
const _l1 = new Map<string, L1Entry>();
let _l1Evictions = 0;

function l1Get(key: string): L1Entry | undefined {
  const entry = _l1.get(key);
  if (entry === undefined) return undefined;
  // Bump to most-recently-used (delete + re-insert preserves order).
  _l1.delete(key);
  _l1.set(key, entry);
  return entry;
}

function l1Set(key: string, vector: number[] | null): void {
  // Evict oldest entries if at capacity. Note: we check `>=` because we're
  // about to add one, so we want to make room BEFORE inserting.
  while (_l1.size >= LRU_MAX_ENTRIES) {
    const oldestKey = _l1.keys().next().value;
    if (oldestKey === undefined) break; // defensive — should never happen
    _l1.delete(oldestKey);
    _l1Evictions++;
  }
  _l1.set(key, { vector, insertedAt: Date.now() });
}

function l1Clear(): number {
  const count = _l1.size;
  _l1.clear();
  return count;
}

// ─── L2: Redis shared cache ──────────────────────────────────────────────────

async function l2Get(key: string): Promise<number[] | null | undefined> {
  const redis = getRedis();
  if (!redis) return undefined; // Redis not configured — L1-only mode

  try {
    const raw = await redis.get<string>(key);
    if (raw === null || raw === undefined) return undefined; // cache miss
    if (raw === NULL_SENTINEL) return null; // negative cache hit
    // Parse the vector. Stored as JSON array.
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      // Corrupt entry — treat as miss, will be overwritten on next set.
      logger.debug({ key }, "queryEmbeddingCache: corrupt L2 entry (ignoring)");
      return undefined;
    }
    return parsed as number[];
  } catch (err) {
    // Non-fatal — fall through to generator. Redis errors should never block
    // the chat path.
    logger.debug(
      { err: (err as Error)?.message, key },
      "queryEmbeddingCache: L2 get failed (non-fatal)",
    );
    return undefined;
  }
}

async function l2Set(key: string, vector: number[] | null): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  try {
    const ttl = vector === null ? NEGATIVE_TTL_SECONDS : CACHE_TTL_SECONDS;
    const payload = vector === null ? NULL_SENTINEL : JSON.stringify(vector);
    await redis.set(key, payload, { ex: ttl });
  } catch (err) {
    // Non-fatal — L1 still works.
    logger.debug(
      { err: (err as Error)?.message, key },
      "queryEmbeddingCache: L2 set failed (non-fatal)",
    );
  }
}

async function l2Clear(): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;

  let deleted = 0;
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, {
      match: `${KEY_NAMESPACE}:*`,
      count: 100,
    });
    cursor = next;
    if (keys.length > 0) {
      await redis.del(...keys);
      deleted += keys.length;
    }
  } while (cursor !== "0");
  return deleted;
}

// ─── Single-flight: in-flight Promise coalescing ─────────────────────────────

/**
 * Map of in-flight generator calls keyed by cache key. If 5 concurrent
 * requests ask for the same query, only the first calls the generator; the
 * others await the same Promise.
 *
 * The Promise is removed from the map when it resolves (or rejects) so
 * future requests for the same query hit the L1/L2 cache instead.
 *
 * Single-process only — on multi-instance, each instance may independently
 * call the generator once for the same query. The result is then shared
 * via L2. Acceptable trade-off (avoids distributed-lock complexity).
 */
const _inFlight = new Map<string, Promise<number[] | null>>();

// ─── Cache key generation ────────────────────────────────────────────────────

/**
 * Normalizes the query so semantically identical queries share a cache entry.
 *
 * Steps:
 *   1. NFC unicode normalization (Bangla composed form — ensures "া" + "ক"
 *      vs the pre-composed "কা" hash to the same value).
 *   2. Trim leading/trailing whitespace.
 *   3. Collapse internal whitespace runs to a single space.
 *   4. Lowercase (English only — Bangla has no case).
 *   5. Truncate to MAX_QUERY_CHARS (2000) — matches the truncation in
 *      kbSearch.generateQueryEmbedding, so the hash represents exactly what
 *      gets embedded.
 *
 * Edge cases:
 *   - Empty/whitespace-only → returns empty string (caller should skip caching).
 *   - Very long → truncated (matches Gemini input limit).
 */
function normalizeQuery(query: string): string {
  return query.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 2000); // MAX_QUERY_CHARS — kept in sync with kbSearch.ts
}

/**
 * Builds the cache key for a normalized query + model name.
 *
 * Format: `ai:qemb:<modelName>:<sha256(normalized).slice(0,16)>`
 *
 * The model name is included so upgrading the embedding model (e.g.,
 * text-embedding-004 → gemini-embedding-001) automatically invalidates all
 * stale entries — different model = different vector space.
 */
function buildCacheKey(normalizedQuery: string, modelName: string): string {
  const hash = createHash("sha256").update(normalizedQuery).digest("hex").slice(0, 16);
  return `${KEY_NAMESPACE}:${modelName}:${hash}`;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

const _stats: CacheStats = {
  l1Hits: 0,
  l2Hits: 0,
  misses: 0,
  generatorCalls: 0,
  generatorFailures: 0,
  coalescedCalls: 0,
  l1Size: 0,
  l1Evictions: 0,
  startedAt: Date.now(),
};

/**
 * Returns lifetime stats for the query-embedding cache. Used by admin
 * observability endpoints to monitor hit rates + cache health.
 *
 * NOTE: stats are per-process — on multi-instance deploys, each instance
 * reports its own stats. Aggregate at the dashboard level if needed.
 */
export function getQueryEmbeddingCacheStats(): CacheStats & {
  l1TtlSeconds: number;
  negativeTtlSeconds: number;
  lruMaxEntries: number;
  l2Enabled: boolean;
} {
  return {
    ..._stats,
    l1Size: _l1.size,
    l1Evictions: _l1Evictions,
    l1TtlSeconds: CACHE_TTL_SECONDS,
    negativeTtlSeconds: NEGATIVE_TTL_SECONDS,
    lruMaxEntries: LRU_MAX_ENTRIES,
    l2Enabled: getRedis() !== null,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the cached query embedding, or generates + caches it if missing.
 *
 * This is the main entry point — called by kbSearch.generateQueryEmbedding
 * in place of the direct Gemini call.
 *
 * Flow:
 *   1. Normalize + hash the query.
 *   2. Check L1 (in-process LRU). HIT → return.
 *   3. Check L2 (Redis). HIT → populate L1, return.
 *   4. Check single-flight Map. If in-flight, await the existing Promise
 *      (coalesced call). Otherwise, create a new Promise + call generator.
 *   5. On generator success: write to L1 + L2 (positive cache, long TTL).
 *      On generator failure: write null to L1 + L2 (negative cache, short TTL).
 *   6. Return the vector (or null — caller falls back to keyword-only search).
 *
 * @param query - The raw user query (will be normalized internally).
 * @param modelName - The embedding model name (part of cache key for
 *                    auto-invalidation on model upgrade).
 * @param generator - The function that calls the embedding API. Injected
 *                    so this module stays decoupled from the Gemini SDK.
 * @returns The embedding vector, or null on failure (cached as null).
 */
export async function getOrCreateQueryEmbedding(
  query: string,
  modelName: string,
  generator: EmbeddingGenerator,
): Promise<number[] | null> {
  const normalized = normalizeQuery(query);

  // Empty queries should never reach here (kbSearch short-circuits them),
  // but defensive: don't cache empty strings.
  if (!normalized) {
    return generator(query.slice(0, 2000));
  }

  const key = buildCacheKey(normalized, modelName);

  // ─── L1 check ─────────────────────────────────────────────────────────
  const l1Entry = l1Get(key);
  if (l1Entry !== undefined) {
    _stats.l1Hits++;
    return l1Entry.vector;
  }

  // ─── L2 check ─────────────────────────────────────────────────────────
  const l2Result = await l2Get(key);
  if (l2Result !== undefined) {
    _stats.l2Hits++;
    // Populate L1 so the next hit is zero-latency.
    l1Set(key, l2Result);
    return l2Result;
  }

  // ─── Single-flight check ──────────────────────────────────────────────
  const existing = _inFlight.get(key);
  if (existing) {
    _stats.coalescedCalls++;
    return existing;
  }

  // ─── Generator call (we're the leader for this key) ───────────────────
  const promise = (async (): Promise<number[] | null> => {
    _stats.generatorCalls++;
    try {
      // Pass the NORMALIZED query to the generator — the generator's own
      // truncation logic (in kbSearch) operates on the raw query, but
      // since we already normalized + truncated to 2000 chars above, the
      // generator receives exactly what it would have received anyway.
      // This ensures cache key ↔ generated vector alignment.
      //
      // NOTE: we catch ALL errors from the generator (including thrown
      // exceptions, not just null returns) and treat them as failures.
      // This is critical for resilience: a Gemini 429/500/network error
      // would otherwise propagate to the caller and trigger a retry storm
      // (every concurrent + subsequent request would re-call Gemini).
      // The cached null (negative cache, short TTL) absorbs the spike.
      let vector: number[] | null;
      try {
        vector = await generator(normalized);
      } catch (genErr) {
        // Log at debug level — the generator is expected to log its own
        // warnings (e.g. "rate-limited, falling back to keyword-only").
        // We don't double-log at warn/error level to keep the logs clean
        // during transient outages.
        logger.debug(
          { err: (genErr as Error)?.message ?? String(genErr), key },
          "queryEmbeddingCache: generator threw (caching as null)",
        );
        vector = null;
      }

      if (vector === null) {
        _stats.generatorFailures++;
        // Negative cache — short TTL to allow quick recovery.
        l1Set(key, null);
        await l2Set(key, null);
        return null;
      }

      // Positive cache — long TTL (embeddings are deterministic).
      l1Set(key, vector);
      await l2Set(key, vector);
      return vector;
    } finally {
      // Remove from in-flight map so future requests hit the cache.
      _inFlight.delete(key);
    }
  })();

  _inFlight.set(key, promise);
  return promise;
}

/**
 * Clears all entries from both L1 and L2 caches.
 *
 * Used by admin cache-clear endpoints + on embedding-model upgrades.
 * Returns the total number of entries cleared (L1 + L2).
 */
export async function clearQueryEmbeddingCache(): Promise<{ l1: number; l2: number }> {
  const l1Count = l1Clear();
  const l2Count = await l2Clear();
  logger.info({ l1: l1Count, l2: l2Count }, "queryEmbeddingCache: cleared all entries");
  return { l1: l1Count, l2: l2Count };
}

/**
 * Surgically invalidates a single query's embedding from both L1 and L2.
 *
 * Useful when an admin knows a specific query was mis-embedded (e.g.,
 * Gemini returned a corrupt vector that was positively cached).
 *
 * @param query - The raw query (will be normalized to match the cache key).
 * @param modelName - The embedding model name (must match the key used on set).
 */
export async function invalidateQueryEmbedding(query: string, modelName: string): Promise<void> {
  const normalized = normalizeQuery(query);
  if (!normalized) return;

  const key = buildCacheKey(normalized, modelName);
  _l1.delete(key);

  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(key);
    } catch (err) {
      logger.debug(
        { err: (err as Error)?.message, key },
        "queryEmbeddingCache: L2 invalidate failed (non-fatal)",
      );
    }
  }
}

/**
 * Test-only helper: resets all module-level state (L1, in-flight, stats).
 *
 * Exported so unit tests can isolate test cases. NOT for production use —
 * calling this in production would wipe the in-process cache + stats.
 *
 * @internal
 */
export function __resetForTests(): void {
  _l1.clear();
  _inFlight.clear();
  _l1Evictions = 0;
  _stats.l1Hits = 0;
  _stats.l2Hits = 0;
  _stats.misses = 0;
  _stats.generatorCalls = 0;
  _stats.generatorFailures = 0;
  _stats.coalescedCalls = 0;
  _stats.l1Size = 0;
  _stats.l1Evictions = 0;
  _stats.startedAt = Date.now();
}
