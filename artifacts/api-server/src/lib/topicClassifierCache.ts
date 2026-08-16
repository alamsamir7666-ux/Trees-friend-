/**
 * Topic-classification cache (v5.3.1).
 *
 * Dedicated cache for topic-classification results. Mirrors the proven
 * promptInjectionCache.ts architecture exactly:
 *   - L1 (in-process LRU Map) — 512 entries, ~0.5MB, zero latency
 *   - L2 (Redis, shared, 24h TTL) — cross-instance cache sharing
 *   - Single-flight — concurrent identical messages share one LLM call
 *   - Negative caching — failures cached 60s to prevent hammering
 *
 * Why a separate cache (not reusing promptInjectionCache)?
 *   - Different semantic meaning (isOnTopic vs isInjection)
 *   - Different TTL tuning (topic results are more stable than injection)
 *   - Different cache key namespace (ai:topic: vs ai:inj:)
 *   - Cleaner code (no awkward type coercion between result shapes)
 *
 * Cache key: `ai:topic:<sha256(normalizedMessage)>`
 *   - Normalization: NFC + trim + lowercase + collapse whitespace + truncate 1000
 *   - Same message = same result (deterministic, temperature=0.1)
 *
 * TTLs:
 *   - Positive (successful classification): 24h default
 *   - Negative (LLM failure): 60s (short, so transient failures recover)
 *
 * Industry standard: this is the same pattern used by Vercel AI SDK's
 * `streamText` cache, LangChain's `CacheBackedEmbeddings`, and every
 * major RAG framework. Multi-tier caching with single-flight is the
 * textbook approach for expensive deterministic operations.
 */
import { getRedis } from "./redisClient";
import { logger } from "./logger";
import { createHash } from "crypto";
import type { TopicCheckResult } from "./topicClassifier";

// ─── Config ──────────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = Number(process.env.TOPIC_CLASSIFIER_CACHE_TTL_SECONDS ?? 24 * 60 * 60); // 24h
const NEGATIVE_TTL_SECONDS = Number(process.env.TOPIC_CLASSIFIER_CACHE_NEGATIVE_TTL_SECONDS ?? 60); // 60s
const L1_MAX_ENTRIES = Number(process.env.TOPIC_CLASSIFIER_CACHE_L1_MAX ?? 512);

// ─── Types ───────────────────────────────────────────────────────────────────

interface TopicCacheEntry {
  result: TopicCheckResult;
  isFailure: boolean; // true if the LLM call failed (cached fallback)
  cachedAt: number;
  hitCount: number;
}

// ─── L1 cache (in-process LRU Map) ──────────────────────────────────────────

class L1Cache {
  private map = new Map<string, TopicCacheEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  get(key: string): TopicCacheEntry | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    // LRU: move to end (most recently used).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key: string, entry: TopicCacheEntry): void {
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
//
// If 5 concurrent requests ask the same question, only the FIRST calls the
// LLM; the other 4 await the same Promise. Critical for traffic spikes
// (e.g., a viral question, or a bot sending the same message repeatedly).

const _inFlight = new Map<string, Promise<TopicCheckResult | null>>();

// ─── Cache key construction ─────────────────────────────────────────────────

/**
 * Normalizes the message for cache key construction.
 * - NFC unicode normalization (Bangla composed form)
 * - trim + collapse internal whitespace
 * - lowercase
 * - truncate to 1000 chars (matches the LLM classifier's input truncation)
 */
function normalizeMessage(message: string): string {
  return message.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 1000);
}

/**
 * Builds a stable cache key from the message.
 *
 * `ai:topic:<sha256(normalizedMessage).slice(0,32)>`
 * - `ai:topic:` namespace — separate from `ai:inj:` (injection cache) and
 *   `ai:cache:` (response cache) so each can be cleared independently.
 * - sha256 first 32 hex chars = 128 bits — collision-safe for cache keys.
 */
function buildCacheKey(message: string): string {
  const hash = createHash("sha256").update(normalizeMessage(message)).digest("hex").slice(0, 32);
  return `ai:topic:${hash}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Checks the cache for a matching topic classification.
 *
 * @param message - The user's message (PII-redacted)
 * @returns The cached TopicCheckResult if found, or null if not cached.
 */
export async function getCachedTopicClassification(
  message: string,
): Promise<TopicCheckResult | null> {
  const key = buildCacheKey(message);

  // ─── L1 lookup (in-process LRU) ────────────────────────────────────────
  const l1Entry = _l1.get(key);
  if (l1Entry) {
    l1Entry.hitCount++;
    logger.debug(
      { key: key.slice(0, 24), hitCount: l1Entry.hitCount, isFailure: l1Entry.isFailure },
      "Topic cache: L1 HIT",
    );
    return l1Entry.result;
  }

  // ─── L2 lookup (Redis) ─────────────────────────────────────────────────
  const redis = getRedis();
  if (!redis) return null;

  try {
    const raw = await redis.get<string>(key);
    if (!raw) return null;

    const entry = JSON.parse(raw) as TopicCacheEntry;
    // Populate L1 so subsequent reads are zero-latency.
    _l1.set(key, entry);
    entry.hitCount++;
    // Fire-and-forget the hit-count update to Redis.
    redis.set(key, JSON.stringify(entry), { ex: CACHE_TTL_SECONDS }).catch(() => {});

    logger.debug(
      { key: key.slice(0, 24), hitCount: entry.hitCount, isFailure: entry.isFailure },
      "Topic cache: L2 HIT",
    );
    return entry.result;
  } catch (err) {
    logger.debug({ err }, "Topic cache: L2 get failed (non-fatal)");
    return null;
  }
}

/**
 * Stores a topic classification result in the cache.
 *
 * @param message - The user's message (must match what was passed to getCachedTopicClassification)
 * @param result - The classification result to cache
 * @param isFailure - True if the LLM call failed (use short TTL)
 */
export async function setCachedTopicClassification(
  message: string,
  result: TopicCheckResult,
  isFailure = false,
): Promise<void> {
  const key = buildCacheKey(message);
  const ttl = isFailure ? NEGATIVE_TTL_SECONDS : CACHE_TTL_SECONDS;

  const entry: TopicCacheEntry = {
    result,
    isFailure,
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
      { key: key.slice(0, 24), ttl, isFailure, isOnTopic: result.isOnTopic },
      "Topic cache: SET",
    );
  } catch (err) {
    logger.debug({ err }, "Topic cache: L2 set failed (non-fatal)");
  }
}

/**
 * Clears all topic-classification cache entries.
 * Used by the admin cache-clear endpoint.
 */
export async function clearAllTopicCache(): Promise<number> {
  const l1Count = _l1.clear();

  const redis = getRedis();
  if (!redis) return l1Count;

  try {
    let cursor = "0";
    let deleted = 0;
    do {
      const [next, keys] = await redis.scan(cursor, { match: "ai:topic:*", count: 100 });
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== "0");

    logger.info({ l1Cleared: l1Count, l2Cleared: deleted }, "Topic cache: cleared all entries");
    return Math.max(l1Count, deleted);
  } catch (err) {
    logger.error({ err }, "Topic cache: clear failed");
    return l1Count;
  }
}

/**
 * Returns cache statistics for the admin endpoint.
 */
export async function getTopicCacheStats(): Promise<{
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
        const [next, keys] = await redis.scan(cursor, { match: "ai:topic:*", count: 100 });
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

// ─── Single-flight wrappers ─────────────────────────────────────────────────

/**
 * Returns the in-flight promise for a message, if one exists.
 * Used by topicClassifier.ts to coalesce concurrent requests.
 */
export function getInFlightTopicClassification(
  message: string,
): Promise<TopicCheckResult | null> | null {
  const key = buildCacheKey(message);
  return _inFlight.get(key) ?? null;
}

/**
 * Sets the in-flight promise for a message.
 * The entry is automatically cleared when the promise settles.
 */
export function setInFlightTopicClassification(
  message: string,
  promise: Promise<TopicCheckResult | null>,
): void {
  const key = buildCacheKey(message);
  _inFlight.set(key, promise);
  // Clear the in-flight entry when the promise settles (success or failure).
  promise.finally(() => _inFlight.delete(key)).catch(() => {});
}
