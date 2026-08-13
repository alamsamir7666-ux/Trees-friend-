/**
 * Semantic response cache for AI chat.
 *
 * Industry standard: cache AI responses to avoid redundant API calls.
 * 30-50% of chat queries are semantic duplicates ("how often to water
 * mango?" vs "how often should I water a mango tree?"). Caching cuts
 * costs dramatically.
 *
 * Two-tier cache:
 *   1. Exact-match: hash the (systemPrompt + userMessage + history hash)
 *      → instant cache hit, zero API cost.
 *   2. Similarity-based: (future — requires embeddings) compare the
 *      user's message embedding against cached query embeddings. If
 *      similarity > threshold, return the cached response.
 *
 * This implementation does tier 1 (exact-match) with Redis. Tier 2
 * requires an embedding model (Gemini text-embedding or OpenAI
 * text-embedding-3-small) and a vector store (Upstash Vector or
 * pgvector). The interface is designed so tier 2 can be added later
 * without changing the caller.
 *
 * Cache invalidation:
 *   - TTL-based: cached responses expire after AI_CACHE_TTL_SECONDS (default 1h)
 *   - Manual: DELETE /api/ai/admin/cache clears all entries
 *   - Automatic: product catalog changes should invalidate (via webhook
 *     from the admin product update route — not implemented yet)
 *
 * What's NOT cached:
 *   - Messages that triggered tool calls (the tool result may have changed)
 *   - Messages from signed-in users asking about their orders (private data)
 *   - Messages shorter than 10 chars (too generic, cache hit rate too high)
 */
import { getRedis } from "./redisClient";
import { logger } from "./logger";
import { createHash } from "crypto";

const CACHE_TTL_SECONDS = Number(process.env.AI_CACHE_TTL_SECONDS ?? 3600); // 1 hour
const MIN_MESSAGE_LENGTH = 10;

// ─── Cache key generation ───────────────────────────────────────────────────

/**
 * Generates a deterministic cache key from the inputs.
 *
 * The key includes:
 *   - A hash of the system prompt (so prompt changes invalidate the cache)
 *   - A hash of the recent history (so different conversation context = different cache entry)
 *   - The user message (normalized: trimmed, lowercased, collapsed whitespace)
 *
 * We use SHA-256 and take the first 16 hex chars (64 bits) — collision-safe
 * for cache keys (birthday bound: ~4 billion entries before 50% collision chance).
 */
function generateCacheKey(
  systemPrompt: string,
  history: { role: string; text: string }[],
  userMessage: string,
): string {
  // Normalize the user message: trim, lowercase, collapse whitespace
  const normalizedMessage = userMessage.trim().toLowerCase().replace(/\s+/g, " ");

  // Hash the system prompt (only first 500 chars — the prompt is long but
  // the version-specific part is usually at the top)
  const promptHash = createHash("sha256")
    .update(systemPrompt.slice(0, 500))
    .digest("hex")
    .slice(0, 16);

  // Hash the last 3 history messages (recent context affects the response)
  const recentHistory = history.slice(-3);
  const historyStr = recentHistory.map((h) => `${h.role}:${h.text.slice(0, 200)}`).join("|");
  const historyHash = createHash("sha256")
    .update(historyStr)
    .digest("hex")
    .slice(0, 16);

  return `ai:cache:${promptHash}:${historyHash}:${createHash("sha256").update(normalizedMessage).digest("hex").slice(0, 16)}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface CacheEntry {
  response: string;
  model: string;
  provider: string;
  cachedAt: number;
  hitCount: number;
}

/**
 * Checks the cache for a matching response.
 *
 * Returns the cached response if found, or null if not cached / cache
 * is disabled / the message is too short to cache.
 *
 * @param systemPrompt - The system prompt (used in cache key for invalidation)
 * @param history - Conversation history (last 3 messages used in key)
 * @param userMessage - The user's new message
 * @param isPrivate - If true, skip cache entirely (e.g. user is asking about their orders)
 */
export async function getCachedResponse(
  systemPrompt: string,
  history: { role: string; text: string }[],
  userMessage: string,
  isPrivate: boolean = false,
): Promise<CacheEntry | null> {
  // Don't cache private queries (order lookups, user-specific data)
  if (isPrivate) return null;

  // Don't cache very short messages (too generic)
  if (userMessage.trim().length < MIN_MESSAGE_LENGTH) return null;

  const redis = getRedis();
  if (!redis) return null; // cache disabled in dev

  try {
    const key = generateCacheKey(systemPrompt, history, userMessage);
    const raw = await redis.get<string>(key);
    if (!raw) return null;

    const entry = JSON.parse(raw) as CacheEntry;

    // Increment hit count (fire-and-forget)
    entry.hitCount++;
    redis.set(key, JSON.stringify(entry), { ex: CACHE_TTL_SECONDS }).catch(() => {});

    logger.debug({ key, model: entry.model, hitCount: entry.hitCount }, "AI cache: HIT");
    return entry;
  } catch (err) {
    logger.debug({ err }, "AI cache: get failed (non-fatal)");
    return null;
  }
}

/**
 * Stores a response in the cache.
 *
 * Only called after a successful (non-error) response. Tool-call responses
 * are NOT cached (the tool result may have changed since the cache entry
 * was created).
 *
 * @param systemPrompt - The system prompt
 * @param history - Conversation history
 * @param userMessage - The user's message
 * @param response - The AI's full response text
 * @param model - The model that generated the response
 * @param provider - The provider ("gemini" or "groq")
 * @param hadToolCalls - If true, don't cache (tool results may change)
 * @param isPrivate - If true, don't cache (user-specific data)
 */
export async function setCachedResponse(
  systemPrompt: string,
  history: { role: string; text: string }[],
  userMessage: string,
  response: string,
  model: string,
  provider: string,
  hadToolCalls: boolean = false,
  isPrivate: boolean = false,
): Promise<void> {
  // Don't cache tool-call responses or private queries
  if (hadToolCalls || isPrivate) return;

  // Don't cache very short messages
  if (userMessage.trim().length < MIN_MESSAGE_LENGTH) return;

  // Don't cache very long responses (would consume too much Redis memory)
  if (response.length > 10_000) return;

  const redis = getRedis();
  if (!redis) return;

  try {
    const key = generateCacheKey(systemPrompt, history, userMessage);
    const entry: CacheEntry = {
      response,
      model,
      provider,
      cachedAt: Date.now(),
      hitCount: 0,
    };
    await redis.set(key, JSON.stringify(entry), { ex: CACHE_TTL_SECONDS });
    logger.debug({ key, model, provider }, "AI cache: SET");
  } catch (err) {
    logger.debug({ err }, "AI cache: set failed (non-fatal)");
  }
}

/**
 * Clears all cached AI responses. Used by the admin cache-clear endpoint.
 */
export async function clearAiCache(): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;

  try {
    let cursor = "0";
    let deleted = 0;
    do {
      const [next, keys] = await redis.scan(cursor, { match: "ai:cache:*", count: 100 });
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== "0");
    logger.info({ deleted }, "AI cache: cleared all entries");
    return deleted;
  } catch (err) {
    logger.error({ err }, "AI cache: clear failed");
    return 0;
  }
}

/**
 * Returns cache statistics for the admin endpoint.
 */
export async function getCacheStats(): Promise<{
  enabled: boolean;
  ttlSeconds: number;
  entryCount: number;
}> {
  const redis = getRedis();
  if (!redis) {
    return { enabled: false, ttlSeconds: CACHE_TTL_SECONDS, entryCount: 0 };
  }

  try {
    let cursor = "0";
    let count = 0;
    do {
      const [next, keys] = await redis.scan(cursor, { match: "ai:cache:*", count: 100 });
      cursor = next;
      count += keys.length;
    } while (cursor !== "0");

    return { enabled: true, ttlSeconds: CACHE_TTL_SECONDS, entryCount: count };
  } catch {
    return { enabled: true, ttlSeconds: CACHE_TTL_SECONDS, entryCount: 0 };
  }
}
