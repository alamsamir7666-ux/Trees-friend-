/**
 * l1LruCache.ts — P2 #9: shared L1 LRU cache class.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 *
 * The `L1Cache` class was previously DUPLICATED across 4 cache modules:
 *   - rerankerCache.ts
 *   - promptInjectionCache.ts
 *   - topicClassifierCache.ts
 *   - intentClassifier.ts (though this one uses a simpler cache)
 *
 * Each file had its own copy of the class with IDENTICAL logic:
 *   - `get(key)` — returns the entry + LRU-promotes it (move to end).
 *   - `set(key, entry)` — inserts + evicts oldest if at capacity.
 *   - `clear()` — clears all entries, returns the count.
 *   - `get size()` — returns the current entry count.
 *
 * This caused MAINTENANCE BURDEN — a bug fix in one file wouldn't propagate
 * to the others. The deep-dive analysis identified this as drift risk.
 *
 * This module provides a SINGLE generic class `L1LruCache<T>` that all 4
 * consumers import. The class is generic over the entry type `T`, so each
 * consumer can use its own `CacheEntry` interface.
 *
 * ─── Design decisions ────────────────────────────────────────────────────────
 *
 * 1. **Generic over `T`** — the entry type. Each consumer passes its own
 *    `CacheEntry` interface (e.g., `L1LruCache<RerankCacheEntry>`).
 *
 * 2. **LRU eviction** — when the cache is at capacity, the OLDEST entry
 *    (first in insertion order) is evicted. This is the standard LRU pattern
 *    using JS `Map`'s insertion-order-preserving property.
 *
 * 3. **Promote-on-read** — `get()` deletes + re-inserts the entry to move
 *    it to the end (most recently used). This is the standard LRU pattern.
 *
 * 4. **No TTL** — L1 entries don't have a TTL (they're cleared explicitly
 *    by `clear()` or evicted by LRU). TTL is handled by L2 (Redis) for
 *    cross-instance sharing.
 *
 * 5. **Single-process** — L1 is in-process (not shared across instances).
 *    On multi-instance deploys (Vercel), each instance has its own L1.
 *    L2 (Redis) provides cross-instance sharing.
 *
 * 6. **No async** — all methods are synchronous (Map operations are sync).
 *    This matches the existing pattern — L1 lookups are zero-latency.
 *
 * ─── Compatibility ───────────────────────────────────────────────────────────
 *
 * This module is purely additive — it doesn't change any behavior. The 4
 * consumers now import `L1LruCache` from here instead of maintaining their
 * own copies. The class has the SAME methods + signatures as the per-module
 * `L1Cache` it replaces.
 */

/**
 * A generic L1 LRU (Least Recently Used) cache.
 *
 * Uses a JS `Map` (which preserves insertion order) to implement LRU
 * eviction. When the cache is at capacity, the oldest entry (first in
 * insertion order) is evicted. On `get()`, the entry is moved to the end
 * (most recently used).
 *
 * @example
 *   const cache = new L1LruCache<string>(128); // max 128 entries
 *   cache.set("key1", "value1");
 *   cache.get("key1"); // → "value1" (promoted to most-recently-used)
 *   cache.size; // → 1
 *   cache.clear(); // → 1 (count of cleared entries)
 */
export class L1LruCache<T> {
  private map = new Map<string, T>();
  private readonly maxEntries: number;

  /**
   * @param maxEntries The maximum number of entries to keep. When exceeded,
   *                   the oldest entry (least recently used) is evicted.
   */
  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  /**
   * Returns the entry for the given key, or null if not found.
   *
   * LRU promotion: the entry is moved to the end (most recently used)
   * by deleting + re-inserting it. This ensures the oldest entries (least
   * recently used) are at the front + evicted first.
   *
   * @param key The cache key.
   * @returns The cached entry, or null if not found.
   */
  get(key: string): T | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    // LRU: move to end (most recently used).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  /**
   * Inserts or updates an entry.
   *
   * If the cache is at capacity, the oldest entry (first in insertion order)
   * is evicted BEFORE the new entry is inserted. This ensures the cache never
   * exceeds `maxEntries`.
   *
   * @param key The cache key.
   * @param entry The entry to cache.
   */
  set(key: string, entry: T): void {
    // Evict oldest if at capacity (and the key isn't already present —
    // an update doesn't need eviction).
    if (!this.map.has(key) && this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey) this.map.delete(oldestKey);
    }
    this.map.set(key, entry);
  }

  /**
   * Clears all entries from the cache.
   *
   * @returns The number of entries that were cleared (for logging/metrics).
   */
  clear(): number {
    const count = this.map.size;
    this.map.clear();
    return count;
  }

  /**
   * Returns the current number of entries in the cache.
   */
  get size(): number {
    return this.map.size;
  }
}
