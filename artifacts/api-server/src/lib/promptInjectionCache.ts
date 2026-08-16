/**
 * Prompt-injection classification cache (v5.2.1).
 *
 * Caches LLM classification results so repeat attacks ("ignore previous
 * instructions" sent 100x) cost 1 LLM call, not 100. Mirrors the
 * rerankerCache.ts + queryEmbeddingCache.ts patterns.
 *
 * ─── Architecture ────────────────────────────────────────────────────────────
 *
 *   1. L1 (in-process LRU Map) — 512 entries, ~0.5MB, zero latency
 *   2. L2 (Redis, shared, 24h TTL) — cross-instance cache sharing
 *   3. Single-flight — concurrent identical messages share one LLM call
 *
 * ─── Cache key ───────────────────────────────────────────────────────────────
 *
 *   `ai:inj:<sha256(normalizedMessage)>`
 *
 * Normalization: NFC + trim + lowercase + collapse whitespace + truncate
 * to 2000 chars (matches the LLM classifier's input truncation).
 *
 * ─── TTL ─────────────────────────────────────────────────────────────────────
 *
 *   - Positive (injection detected): 24h — the classification won't change
 *   - Negative (safe): 24h — same message = same result
 *   - Failed (LLM error): 60s — short, so transient failures recover
 *
 * Classifications are deterministic for a given message (temperature=0.1),
 * so long TTLs are safe.
 */
import { getRedis } from "./redisClient";
import { logger } from "./logger";
import { createHash } from "crypto";
import type { LLMClassificationResult } from "./promptInjectionLLM";

// ─── Config ──────────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = Number(process.env.PROMPT_INJECTION_CACHE_TTL_SECONDS ?? 24 * 60 * 60); // 24h
const NEGATIVE_TTL_SECONDS = Number(process.env.PROMPT_INJECTION_CACHE_NEGATIVE_TTL_SECONDS ?? 60); // 60s
const L1_MAX_ENTRIES = Number(process.env.PROMPT_INJECTION_CACHE_L1_MAX ?? 512);

// ─── Types ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: LLMClassificationResult;
  isFailure: boolean; // true if the LLM call failed (cached null)
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

// ─── Single-flight ──────────────────────────────────────────────────────────

const _inFlight = new Map<string, Promise<LLMClassificationResult | null>>();

// ─── Cache key construction ─────────────────────────────────────────────────

function normalizeMessage(message: string): string {
  return message.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 2000);
}

function buildCacheKey(message: string): string {
  const hash = createHash("sha256").update(normalizeMessage(message)).digest("hex").slice(0, 32);
  return `ai:inj:${hash}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Checks the cache for a matching classification.
 * Returns the cached result if found, or null if not cached.
 */
export async function getCachedClassification(
  message: string,
): Promise<LLMClassificationResult | null> {
  const key = buildCacheKey(message);

  // L1
  const l1Entry = _l1.get(key);
  if (l1Entry) {
    l1Entry.hitCount++;
    logger.debug({ key: key.slice(0, 24), hitCount: l1Entry.hitCount }, "Injection cache: L1 HIT");
    return l1Entry.result;
  }

  // L2 (Redis)
  const redis = getRedis();
  if (!redis) return null;

  try {
    const raw = await redis.get<string>(key);
    if (!raw) return null;

    const entry = JSON.parse(raw) as CacheEntry;
    _l1.set(key, entry);
    entry.hitCount++;
    redis.set(key, JSON.stringify(entry), { ex: CACHE_TTL_SECONDS }).catch(() => {});

    logger.debug({ key: key.slice(0, 24), hitCount: entry.hitCount }, "Injection cache: L2 HIT");
    return entry.result;
  } catch (err) {
    logger.debug({ err }, "Injection cache: L2 get failed (non-fatal)");
    return null;
  }
}

/**
 * Stores a classification result in the cache.
 */
export async function setCachedClassification(
  message: string,
  result: LLMClassificationResult,
  isFailure = false,
): Promise<void> {
  const key = buildCacheKey(message);
  const ttl = isFailure ? NEGATIVE_TTL_SECONDS : CACHE_TTL_SECONDS;

  const entry: CacheEntry = {
    result,
    isFailure,
    cachedAt: Date.now(),
    hitCount: 0,
  };

  _l1.set(key, entry);

  const redis = getRedis();
  if (!redis) return;

  try {
    await redis.set(key, JSON.stringify(entry), { ex: ttl });
  } catch (err) {
    logger.debug({ err }, "Injection cache: L2 set failed (non-fatal)");
  }
}

/**
 * Clears all injection-classification cache entries.
 */
export async function clearAllInjectionCache(): Promise<number> {
  const l1Count = _l1.clear();

  const redis = getRedis();
  if (!redis) return l1Count;

  try {
    let cursor = "0";
    let deleted = 0;
    do {
      const [next, keys] = await redis.scan(cursor, { match: "ai:inj:*", count: 100 });
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== "0");

    logger.info({ l1Cleared: l1Count, l2Cleared: deleted }, "Injection cache: cleared all entries");
    return Math.max(l1Count, deleted);
  } catch (err) {
    logger.error({ err }, "Injection cache: clear failed");
    return l1Count;
  }
}

/**
 * Returns cache statistics for the admin endpoint.
 */
export async function getInjectionCacheStats(): Promise<{
  enabled: boolean;
  l1Entries: number;
  l1MaxEntries: number;
  l2Entries: number;
  ttlSeconds: number;
}> {
  const redis = getRedis();
  let l2Entries = 0;
  if (redis) {
    try {
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(cursor, { match: "ai:inj:*", count: 100 });
        cursor = next;
        l2Entries += keys.length;
      } while (cursor !== "0");
    } catch {
      // ignore
    }
  }

  return {
    enabled: !!redis,
    l1Entries: _l1.size,
    l1MaxEntries: L1_MAX_ENTRIES,
    l2Entries,
    ttlSeconds: CACHE_TTL_SECONDS,
  };
}

// ─── Single-flight wrappers ─────────────────────────────────────────────────

export function getInFlightClassification(
  message: string,
): Promise<LLMClassificationResult | null> | null {
  const key = buildCacheKey(message);
  return _inFlight.get(key) ?? null;
}

export function setInFlightClassification(
  message: string,
  promise: Promise<LLMClassificationResult | null>,
): void {
  const key = buildCacheKey(message);
  _inFlight.set(key, promise);
  promise.finally(() => _inFlight.delete(key)).catch(() => {});
}
