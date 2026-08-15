/**
 * Reranker result cache — multi-tier, single-flight, negative caching.
 *
 * Mirrors the architecture of queryEmbeddingCache.ts (the proven pattern
 * already in production). Rerank results are deterministic for
 * (query, documents, model) — the same query against the same documents
 * returns the same scores. So we cache them.
 *
 * ─── Architecture ────────────────────────────────────────────────────────────
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │  getCachedRerank(query, docs, topN)                                  │
 *   └──┬───────────────────────────────────────────────────────────────────┘
 *      │
 *      │  1. cacheKey = sha256(normalize(query) + docIds + docTextHashes + topN)
 *      │
 *      │  2. L1 (in-process LRU Map)  ─── HIT? return parsed results
 *      │     Bounded (default 128 entries × ~1KB each ≈ 128KB).
 *      │     Zero latency. Survives within a single long-running process.
 *      │     Defeats the "1000 chats/min of the same 5 questions" hot path.
 *      │
 *      │  3. L2 (Redis, shared, TTL 1h)  ─── HIT? populate L1, return
 *      │     Cross-instance cache sharing on Vercel/multi-instance deploys.
 *      │     Falls back gracefully if Redis not configured (L1-only mode).
 *      │
 *      │  4. Single-flight (in-flight Promise Map)
 *      │     If 5 concurrent requests ask the same (query, docs), only the
 *      │     FIRST calls the reranker; the other 4 await the same Promise.
 *      │     Critical for traffic spikes (e.g. a viral question).
 *      │
 *      │  5. On success: write to L1 + L2 (positive cache, long TTL).
 *      │     On failure: write null to L1 + L2 (negative cache, short TTL)
 *      │                 so we don't re-hammer the reranker API on
 *      │                 persistent failures.
 *      │
 *      └─── return results (or null → caller calls the reranker)
 *
 * ─── Cache key design ────────────────────────────────────────────────────────
 *
 *   `ai:rerank:<sha256(normalizedQuery + sortedDocIds + docTextHashes + topN)>`
 *
 * - `ai:rerank:` namespace — separate from `ai:cache:` (response cache) and
 *   `ai:qemb:` (query embedding cache) so each can be cleared independently.
 * - `<normalizedQuery>` — trim + lowercase + collapse whitespace. So
 *   "How often to water?" and "how often to water?" share a cache entry.
 * - `<sortedDocIds>` — sorted ascending. So [3,1,2] and [1,2,3] share an
 *   entry (the order doesn't affect rerank scores, only the set matters).
 * - `<docTextHashes>` — sha256 of each doc's text, sorted. So if a doc's
 *   content changes (admin edits the KB), the cache key changes → fresh
 *   rerank. This is critical for correctness.
 * - `<topN>` — different topN values produce different rerank results
 *   (rerankers may score differently when asked for top-5 vs top-10).
 *
 * ─── Negative caching ────────────────────────────────────────────────────────
 *
 * When ALL reranker providers fail, we cache the fallback result (original
 * order) with a SHORT TTL (60s default). This prevents a cascade where
 * 100 concurrent requests all retry the failed reranker. The 60s TTL is
 * short enough that a real recovery is detected quickly, but long enough
 * to absorb a spike.
 *
 * Sentinel: we store the literal string `"__fallback__"` to distinguish
 * "cached fallback" from "cached successful rerank with score 1.0".
 *
 * ─── TTLs ────────────────────────────────────────────────────────────────────
 *
 * - Positive (successful rerank): 1h default (RERANKER_CACHE_TTL_SECONDS).
 *   Rerank scores don't change for the same (query, docs) — long TTL is safe.
 *   The only invalidation trigger is KB content change (handled by the
 *   docTextHashes in the cache key).
 * - Negative (fallback): 60s default (RERANKER_CACHE_NEGATIVE_TTL_SECONDS).
 *   Short so transient failures recover quickly.
 *
 * ─── Concurrency safety ──────────────────────────────────────────────────────
 *
 * - L1 (Map) is single-process — JS event loop guarantees atomic access.
 * - L2 (Redis) is shared — Upstash Redis is HTTP-based, so no connection
 *   pooling race conditions. SET with `ex` is atomic.
 * - Single-flight Map is single-process — same as L1. On multi-instance,
 *   each instance may independently call the reranker once for the same
 *   query; the result is then shared via L2. Acceptable trade-off.
 */
import { getRedis } from "./redisClient";
import { logger } from "./logger";
import { createHash } from "crypto";
import type { RerankDocument, RerankResult } from "./reranker";

// ─── Config ──────────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = Number(process.env.RERANKER_CACHE_TTL_SECONDS ?? 3600); // 1h
const NEGATIVE_TTL_SECONDS = Number(process.env.RERANKER_CACHE_NEGATIVE_TTL_SECONDS ?? 60); // 60s
const L1_MAX_ENTRIES = Number(process.env.RERANKER_CACHE_L1_MAX ?? 128);

// ─── Types ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  results: RerankResult[];
  /** True if this is a cached fallback (all providers failed). */
  isFallback: boolean;
  cachedAt: number;
  hitCount: number;
}

// ─── L1 cache (in-process LRU Map) ──────────────────────────────────────────

class L1Cache {
  private map = new Map<string, CacheEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  get(key: string): CacheEntry | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    // LRU: move to end (most recently used).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    // Evict oldest if at capacity.
    if (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey) this.map.delete(oldestKey);
    }
    this.map.set(key, entry);
  }

  clear(): number {
    const count = this.map.size;
    this.map.clear();
    return count;
  }

  get size(): number {
    return this.map.size;
  }
}

const _l1 = new L1Cache(L1_MAX_ENTRIES);

// ─── Single-flight (in-flight Promise memoization) ──────────────────────────

const _inFlight = new Map<string, Promise<RerankResult[] | null>>();

// ─── Cache key construction ─────────────────────────────────────────────────

/**
 * Normalizes the query for cache key construction.
 * - NFC unicode normalization (Bangla composed form)
 * - trim + collapse internal whitespace
 * - lowercase
 * - truncate to 2000 chars (matches the reranker API input truncation)
 */
function normalizeQuery(query: string): string {
  return query.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 2000);
}

/**
 * Builds a stable cache key from (query, documents, topN).
 *
 * See file header for the design rationale. The key includes:
 *   - normalized query
 *   - sorted doc ids
 *   - sorted doc text hashes (so content changes invalidate the cache)
 *   - topN (different topN → different rerank result)
 */
function buildCacheKey(query: string, documents: RerankDocument[], topN: number): string {
  const normalizedQuery = normalizeQuery(query);

  // Sort doc ids + text hashes so cache hits are order-independent.
  const docIdHashes = documents
    .map((d) => ({
      id: d.id,
      textHash: createHash("sha256").update(d.text).digest("hex").slice(0, 16),
    }))
    .sort((a, b) => a.id - b.id);

  const docPart = docIdHashes.map((d) => `${d.id}:${d.textHash}`).join("|");

  const keyMaterial = `${normalizedQuery}::${docPart}::${topN}`;
  const hash = createHash("sha256").update(keyMaterial).digest("hex").slice(0, 32);
  return `ai:rerank:${hash}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Checks the cache for a matching rerank result.
 *
 * Returns the cached results if found, or null if not cached / cache
 * is disabled. Never throws.
 *
 * @param query - The user's search query (raw text).
 * @param documents - The candidate documents (top-K from first-pass).
 * @param topN - The topN value used in the rerank call.
 */
export async function getCachedRerank(
  query: string,
  documents: RerankDocument[],
  topN: number,
): Promise<RerankResult[] | null> {
  if (documents.length === 0) return null;

  const key = buildCacheKey(query, documents, topN);

  // ─── L1 lookup ─────────────────────────────────────────────────────────
  const l1Entry = _l1.get(key);
  if (l1Entry) {
    // Increment hit count (fire-and-forget — mutate the object in place).
    l1Entry.hitCount++;
    logger.debug(
      { key: key.slice(0, 24), hitCount: l1Entry.hitCount, isFallback: l1Entry.isFallback },
      "Reranker cache: L1 HIT",
    );
    return l1Entry.results;
  }

  // ─── L2 lookup (Redis) ─────────────────────────────────────────────────
  const redis = getRedis();
  if (!redis) return null; // cache disabled in dev

  try {
    const raw = await redis.get<string>(key);
    if (!raw) return null;

    const entry = JSON.parse(raw) as CacheEntry;
    // Populate L1 so subsequent reads are zero-latency.
    _l1.set(key, entry);
    entry.hitCount++;
    // Fire-and-forget the hit-count update to Redis.
    redis.set(key, JSON.stringify(entry), { ex: CACHE_TTL_SECONDS }).catch(() => {});

    logger.debug(
      { key: key.slice(0, 24), hitCount: entry.hitCount, isFallback: entry.isFallback },
      "Reranker cache: L2 HIT",
    );
    return entry.results;
  } catch (err) {
    logger.debug({ err }, "Reranker cache: L2 get failed (non-fatal)");
    return null;
  }
}

/**
 * Stores a rerank result in the cache.
 *
 * @param query - The user's search query (raw text).
 * @param documents - The candidate documents (must match what was passed to getCachedRerank).
 * @param topN - The topN value used in the rerank call.
 * @param results - The rerank results to cache.
 * @param ttlSeconds - Optional TTL override (used for negative caching).
 */
export async function setCachedRerank(
  query: string,
  documents: RerankDocument[],
  topN: number,
  results: RerankResult[],
  ttlSeconds?: number,
): Promise<void> {
  if (documents.length === 0) return;

  const key = buildCacheKey(query, documents, topN);

  // Detect if this is a fallback (all providers failed).
  const isFallback = results.length > 0 && results.every((r) => r.provider === "fallback");
  const ttl = ttlSeconds ?? (isFallback ? NEGATIVE_TTL_SECONDS : CACHE_TTL_SECONDS);

  const entry: CacheEntry = {
    results,
    isFallback,
    cachedAt: Date.now(),
    hitCount: 0,
  };

  // ─── L1 write ──────────────────────────────────────────────────────────
  _l1.set(key, entry);

  // ─── L2 write (Redis) ──────────────────────────────────────────────────
  const redis = getRedis();
  if (!redis) return;

  try {
    await redis.set(key, JSON.stringify(entry), { ex: ttl });
    logger.debug(
      { key: key.slice(0, 24), ttl, isFallback, resultCount: results.length },
      "Reranker cache: SET",
    );
  } catch (err) {
    logger.debug({ err }, "Reranker cache: L2 set failed (non-fatal)");
  }
}

/**
 * Clears all reranker cache entries. Used by the admin cache-clear endpoint
 * after KB content changes (reranked scores may have changed).
 *
 * Returns the number of entries cleared (best-effort — may be 0 if Redis
 * is unavailable).
 */
export async function clearAllRerankCache(): Promise<number> {
  // Clear L1.
  const l1Count = _l1.clear();

  // Clear L2 (Redis) — scan + delete all ai:rerank:* keys.
  const redis = getRedis();
  if (!redis) return l1Count;

  try {
    let cursor = "0";
    let deleted = 0;
    do {
      const [next, keys] = await redis.scan(cursor, { match: "ai:rerank:*", count: 100 });
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== "0");

    logger.info({ l1Cleared: l1Count, l2Cleared: deleted }, "Reranker cache: cleared all entries");
    return Math.max(l1Count, deleted);
  } catch (err) {
    logger.error({ err }, "Reranker cache: clear failed");
    return l1Count;
  }
}

/**
 * Returns cache statistics for the admin endpoint.
 */
export async function getRerankerCacheStats(): Promise<{
  enabled: boolean;
  l1Entries: number;
  l1MaxEntries: number;
  l2Entries: number;
  ttlSeconds: number;
  negativeTtlSeconds: number;
}> {
  const redis = getRedis();
  let l2Entries = 0;
  if (redis) {
    try {
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(cursor, { match: "ai:rerank:*", count: 100 });
        cursor = next;
        l2Entries += keys.length;
      } while (cursor !== "0");
    } catch {
      // ignore — return what we have
    }
  }

  return {
    enabled: !!redis,
    l1Entries: _l1.size,
    l1MaxEntries: L1_MAX_ENTRIES,
    l2Entries,
    ttlSeconds: CACHE_TTL_SECONDS,
    negativeTtlSeconds: NEGATIVE_TTL_SECONDS,
  };
}

// ─── Single-flight wrapper (used internally by reranker.ts via the cache) ────

/**
 * Returns the in-flight promise for a cache key, if one exists.
 * Used by reranker.ts to coalesce concurrent requests for the same (query, docs).
 *
 * NOTE: This is a lightweight single-flight — it only coalesces within a
 * single process. For multi-instance coalescing, the L2 cache provides
 * eventual consistency (the first instance to complete writes the result,
 * other instances read it on their next attempt).
 */
export function getInFlightRerank(
  query: string,
  documents: RerankDocument[],
  topN: number,
): Promise<RerankResult[] | null> | null {
  const key = buildCacheKey(query, documents, topN);
  return _inFlight.get(key) ?? null;
}

export function setInFlightRerank(
  query: string,
  documents: RerankDocument[],
  topN: number,
  promise: Promise<RerankResult[] | null>,
): void {
  const key = buildCacheKey(query, documents, topN);
  _inFlight.set(key, promise);
  // Clear the in-flight entry when the promise settles (success or failure).
  promise.finally(() => _inFlight.delete(key)).catch(() => {});
}
