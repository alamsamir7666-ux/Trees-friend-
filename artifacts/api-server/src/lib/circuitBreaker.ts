/**
 * Circuit breaker for AI provider models.
 *
 * Replaces the simple in-memory cooldown Map with a proper 3-state circuit
 * breaker pattern (Closed → Open → Half-Open), backed by Redis for
 * distributed coordination across server instances.
 *
 * States:
 *   CLOSED    — Normal operation. Requests flow through. Failures are counted.
 *   OPEN      — After `failureThreshold` failures in `failureWindowSeconds`,
 *               the circuit opens. All requests are short-circuited (not sent
 *               to the provider) for `cooldownSeconds`. This prevents
 *               cascading failures and saves API quota.
 *   HALF_OPEN — After the cooldown expires, the circuit enters half-open.
 *               ONE probe request is allowed through. If it succeeds, the
 *               circuit closes (back to normal). If it fails, the circuit
 *               re-opens for another cooldown period.
 *
 * Why this is better than the v3.0 cooldown Map:
 *   1. Failure-rate tracking: only opens after N failures, not on a single 429.
 *      A single transient 429 doesn't trip the circuit — only sustained failures do.
 *   2. Half-open probe: gracefully tests recovery instead of blindly retrying.
 *   3. Redis-backed: all server instances share the same circuit state.
 *      If instance A trips the circuit, instance B knows not to try either.
 *   4. Separate from cooldown: 429 quota errors still set a short per-model
 *      cooldown (via setCooldown), but the circuit breaker tracks ALL failure
 *      types (5xx, network, timeouts) for a more holistic view.
 *
 * Redis keys:
 *   ai:cb:{provider}:{model}:failures  — counter of recent failures
 *   ai:cb:{provider}:{model}:state      — "open" or "half_open" (absent = closed)
 *   ai:cb:{provider}:{model}:opened_at  — timestamp when circuit opened
 *
 * All keys have TTLs so stale state auto-expires if the server crashes.
 */
import { getRedis } from "./redisClient";
import { logger } from "./logger";

// ─── Config ──────────────────────────────────────────────────────────────────

const FAILURE_THRESHOLD = Number(process.env.AI_CB_FAILURE_THRESHOLD ?? 3);
const FAILURE_WINDOW_SECONDS = Number(process.env.AI_CB_FAILURE_WINDOW_SECONDS ?? 60);
const COOLDOWN_SECONDS = Number(process.env.AI_CB_COOLDOWN_SECONDS ?? 30);

// ─── Types ───────────────────────────────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerInfo {
  state: CircuitState;
  failures: number;
  openedAt: number | null;
  retryInMs: number | null; // null when closed or half_open
}

// ─── In-memory fallback (dev only) ──────────────────────────────────────────
// Used when Redis is not configured. NOT production-safe for multi-instance.

interface InMemoryCircuit {
  failures: number[];
  state: CircuitState;
  openedAt: number | null;
}
const _inMemory = new Map<string, InMemoryCircuit>();

function getInMemory(key: string): InMemoryCircuit {
  if (!_inMemory.has(key)) {
    _inMemory.set(key, { failures: [], state: "closed", openedAt: null });
  }
  return _inMemory.get(key)!;
}

// Clean up expired in-memory circuits every 5 minutes
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, circuit] of _inMemory.entries()) {
      // Prune old failures
      circuit.failures = circuit.failures.filter(
        (t) => now - t < FAILURE_WINDOW_SECONDS * 1000,
      );
      // Auto-close open circuits after cooldown
      if (
        circuit.state === "open" &&
        circuit.openedAt &&
        now - circuit.openedAt > COOLDOWN_SECONDS * 1000
      ) {
        circuit.state = "half_open";
      }
    }
  }, 60 * 1000).unref?.();
}

// ─── Key helpers ─────────────────────────────────────────────────────────────

function failureKey(provider: string, model: string): string {
  return `ai:cb:${provider}:${model}:failures`;
}

function stateKey(provider: string, model: string): string {
  return `ai:cb:${provider}:${model}:state`;
}

function openedAtKey(provider: string, model: string): string {
  return `ai:cb:${provider}:${model}:opened_at`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Checks if a request should be allowed through the circuit breaker.
 *
 * Returns:
 *   - { allowed: true, state: "closed" | "half_open" } — proceed with the request
 *   - { allowed: false, state: "open", retryInMs } — short-circuit, don't call the provider
 *
 * In half_open state, the request is allowed (it's the probe). The caller
 * must report success or failure via recordSuccess/recordFailure so the
 * circuit can close or re-open.
 */
export async function checkCircuit(
  provider: string,
  model: string,
): Promise<{ allowed: boolean; state: CircuitState; retryInMs: number | null }> {
  const redis = getRedis();

  // ─── Redis path (production) ───
  if (redis) {
    try {
      const state = await redis.get<string>(stateKey(provider, model));

      if (state === "open") {
        const openedAt = await redis.get<number>(openedAtKey(provider, model));
        if (openedAt != null) {
          const elapsedMs = Date.now() - openedAt;
          if (elapsedMs >= COOLDOWN_SECONDS * 1000) {
            // Cooldown expired → transition to half_open
            await redis.set(stateKey(provider, model), "half_open", { ex: COOLDOWN_SECONDS * 2 });
            return { allowed: true, state: "half_open", retryInMs: null };
          }
          const retryInMs = COOLDOWN_SECONDS * 1000 - elapsedMs;
          return { allowed: false, state: "open", retryInMs: Math.max(0, retryInMs) };
        }
      }

      if (state === "half_open") {
        // Allow the probe request through
        return { allowed: true, state: "half_open", retryInMs: null };
      }

      // Closed — normal operation
      return { allowed: true, state: "closed", retryInMs: null };
    } catch (err) {
      // Redis error → fail open (allow the request). Better to try and
      // potentially fail than to block all traffic during a Redis outage.
      logger.warn({ err, provider, model }, "Circuit breaker: Redis error, failing open");
      return { allowed: true, state: "closed", retryInMs: null };
    }
  }

  // ─── In-memory fallback (dev) ───
  const key = `${provider}:${model}`;
  const circuit = getInMemory(key);
  const now = Date.now();

  if (circuit.state === "open") {
    if (circuit.openedAt && now - circuit.openedAt >= COOLDOWN_SECONDS * 1000) {
      circuit.state = "half_open";
      return { allowed: true, state: "half_open", retryInMs: null };
    }
    const retryInMs = circuit.openedAt
      ? COOLDOWN_SECONDS * 1000 - (now - circuit.openedAt)
      : COOLDOWN_SECONDS * 1000;
    return { allowed: false, state: "open", retryInMs: Math.max(0, retryInMs) };
  }

  return { allowed: true, state: circuit.state, retryInMs: null };
}

/**
 * Records a successful request. Closes the circuit (if half_open) and
 * resets the failure counter.
 *
 * Must be called AFTER checkCircuit returns allowed=true and the request succeeds.
 */
export async function recordSuccess(provider: string, model: string): Promise<void> {
  const redis = getRedis();

  if (redis) {
    try {
      await redis.del(failureKey(provider, model));
      await redis.del(stateKey(provider, model));
      await redis.del(openedAtKey(provider, model));
    } catch {
      // non-fatal
    }
    return;
  }

  // In-memory
  const key = `${provider}:${model}`;
  const circuit = getInMemory(key);
  circuit.failures = [];
  circuit.state = "closed";
  circuit.openedAt = null;
}

/**
 * Records a failed request. Increments the failure counter and opens the
 * circuit if the threshold is reached.
 *
 * Must be called AFTER checkCircuit returns allowed=true and the request fails.
 */
export async function recordFailure(
  provider: string,
  model: string,
  _errorType?: "429" | "5xx" | "network" | "timeout" | "other",
): Promise<void> {
  const redis = getRedis();
  const now = Date.now();

  if (redis) {
    try {
      // Add timestamp to the failures list (with TTL = failure window)
      const fKey = failureKey(provider, model);
      await redis.rpush(fKey, String(now));
      await redis.expire(fKey, FAILURE_WINDOW_SECONDS);

      // Count recent failures (in the last FAILURE_WINDOW_SECONDS)
      const cutoff = now - FAILURE_WINDOW_SECONDS * 1000;
      const allFailures = await redis.lrange<number>(fKey, 0, -1);
      const recentFailures = allFailures.filter((t) => Number(t) > cutoff);

      // Trim old failures
      if (recentFailures.length < allFailures.length) {
        await redis.del(fKey);
        if (recentFailures.length > 0) {
          await redis.rpush(fKey, ...recentFailures.map(String));
          await redis.expire(fKey, FAILURE_WINDOW_SECONDS);
        }
      }

      if (recentFailures.length >= FAILURE_THRESHOLD) {
        // Open the circuit
        await redis.set(stateKey(provider, model), "open", { ex: COOLDOWN_SECONDS * 2 });
        await redis.set(openedAtKey(provider, model), String(now), { ex: COOLDOWN_SECONDS * 2 });
        logger.warn(
          { provider, model, failures: recentFailures.length, threshold: FAILURE_THRESHOLD },
          `Circuit breaker: OPENED for ${provider}/${model} after ${recentFailures.length} failures`,
        );
      }
    } catch (err) {
      logger.warn({ err, provider, model }, "Circuit breaker: Redis error recording failure");
    }
    return;
  }

  // In-memory
  const key = `${provider}:${model}`;
  const circuit = getInMemory(key);
  circuit.failures.push(now);
  circuit.failures = circuit.failures.filter(
    (t) => now - t < FAILURE_WINDOW_SECONDS * 1000,
  );

  if (circuit.failures.length >= FAILURE_THRESHOLD) {
    circuit.state = "open";
    circuit.openedAt = now;
    logger.warn(
      { provider, model, failures: circuit.failures.length, threshold: FAILURE_THRESHOLD },
      `Circuit breaker: OPENED for ${provider}/${model} (in-memory) after ${circuit.failures.length} failures`,
    );
  }
}

/**
 * Returns debug info about a circuit breaker. Used by the admin endpoint.
 */
export async function getCircuitInfo(
  provider: string,
  model: string,
): Promise<CircuitBreakerInfo> {
  const redis = getRedis();

  if (redis) {
    try {
      const state = (await redis.get<string>(stateKey(provider, model))) ?? "closed";
      const openedAt = await redis.get<number>(openedAtKey(provider, model));
      const now = Date.now();
      const cutoff = now - FAILURE_WINDOW_SECONDS * 1000;
      const allFailures = await redis.lrange<number>(failureKey(provider, model), 0, -1);
      const failures = allFailures.filter((t) => Number(t) > cutoff).length;

      let retryInMs: number | null = null;
      if (state === "open" && openedAt != null) {
        retryInMs = Math.max(0, COOLDOWN_SECONDS * 1000 - (now - openedAt));
      }

      return { state: state as CircuitState, failures, openedAt, retryInMs };
    } catch {
      return { state: "closed", failures: 0, openedAt: null, retryInMs: null };
    }
  }

  // In-memory
  const key = `${provider}:${model}`;
  const circuit = getInMemory(key);
  const now = Date.now();
  const recentFailures = circuit.failures.filter(
    (t) => now - t < FAILURE_WINDOW_SECONDS * 1000,
  );

  let retryInMs: number | null = null;
  if (circuit.state === "open" && circuit.openedAt) {
    retryInMs = Math.max(0, COOLDOWN_SECONDS * 1000 - (now - circuit.openedAt));
  }

  return {
    state: circuit.state,
    failures: recentFailures.length,
    openedAt: circuit.openedAt,
    retryInMs,
  };
}

/**
 * Clears all circuit breaker state. Used by the admin refresh endpoint.
 */
export async function clearAllCircuits(): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      // Scan and delete all ai:cb:* keys
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(cursor, { match: "ai:cb:*", count: 100 });
        cursor = next;
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } while (cursor !== "0");
    } catch {
      // non-fatal
    }
  }
  _inMemory.clear();
}
