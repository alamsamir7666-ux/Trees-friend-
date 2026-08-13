/**
 * Shared Upstash Redis client for AI features.
 *
 * Extracted from rateLimiter.ts so that circuit breakers, semantic caches,
 * and other AI resilience features can share the same Redis connection
 * without duplicating the lazy-init + fallback logic.
 *
 * Why Redis for AI features:
 *   - Circuit breaker state must be shared across all server instances
 *     (in-memory Map is broken on multi-instance deploys like Vercel)
 *   - Semantic cache needs a shared store so all instances hit the same cache
 *   - Upstash Redis is HTTP-based — works in serverless where TCP pooling doesn't
 *
 * Fallback:
 *   If UPSTASH_REDIS_REST_URL is not set, returns null. Callers fall back
 *   to in-memory implementations (with a warning). This is fine for dev
 *   but NOT production-safe for multi-instance deployments.
 */
import { Redis } from "@upstash/redis";
import { logger } from "./logger";

let _redis: Redis | null = null;
let _initAttempted = false;

/**
 * Returns the shared Redis client, or null if not configured.
 * Callers should check for null and fall back to in-memory.
 */
export function getRedis(): Redis | null {
  if (_initAttempted) return _redis;
  _initAttempted = true;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return null;
  }

  try {
    _redis = new Redis({ url, token });
    logger.info("AI: connected to Upstash Redis (shared client)");
  } catch (err) {
    logger.error({ err }, "AI: failed to connect to Upstash Redis");
  }
  return _redis;
}

/**
 * Returns true if Redis is configured (has env vars set).
 * Used by callers to decide whether to use Redis or fall back to in-memory.
 */
export function isRedisAvailable(): boolean {
  return getRedis() !== null;
}
