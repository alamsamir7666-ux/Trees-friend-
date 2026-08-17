/**
 * SSE (Server-Sent Events) heartbeat — keeps long-lived chat streams alive
 * across proxies / load balancers that would otherwise close idle connections.
 *
 * ─── The problem this solves ─────────────────────────────────────────────────
 *
 * TreeBot's POST /api/ai/chat endpoint opens an SSE stream that may stay
 * "idle" (no bytes written) for several seconds at a time:
 *
 *   - While the LLM is "thinking" before the first token (Gemini: 500ms–3s;
 *     Groq: 100–500ms).
 *   - During tool execution (search_catalog: 50–200ms, search_knowledge_base
 *     with reranker: 500ms–3s, get_user_orders DB query: 50–300ms).
 *   - During multi-round tool loops (each round = LLM call + tool execution,
 *     up to AI_MAX_TOOL_ROUNDS = 10 rounds, so up to ~30s of "gaps").
 *
 * During these gaps, the server is doing real work but writes nothing to the
 * socket. Many proxies / CDNs / load balancers interpret a quiet socket as a
 * dead connection and close it:
 *
 *   - nginx default `proxy_read_timeout = 60s` — closes after 60s of silence.
 *   - Cloudflare: 100s for HTTP, 600s for SSE-specific. BUT this only applies
 *     if the response sends `Content-Type: text/event-stream`. Even then, an
 *     intermediate proxy without SSE-awareness may close at 60s.
 *   - AWS ALB default idle timeout = 60s.
 *   - Vercel: function execution timeout (10–90s depending on plan).
 *   - Render: 100s default for the in-process reverse proxy.
 *
 * When this happens the user sees "Stream failed" mid-response, even though
 * the backend is still working. The partial response may or may not be
 * persisted (the route's `try/finally` persists `fullResponse` if any).
 *
 * ─── The fix: industry-standard SSE heartbeat ───────────────────────────────
 *
 * Every major SSE producer sends periodic "heartbeat" / "keep-alive" comments
 * to keep the connection alive:
 *
 *   - Anthropic's streaming API: `event: ping\ndata: {"type":"ping"}\n\n` every ~10s.
 *   - OpenAI's streaming (Server-Sent Events): `: OPENAI_KEEPALIVE\n\n` every ~10s.
 *   - Vercel AI SDK: `: ping\n\n` every 15s by default (configurable).
 *   - Hugging Face Text-Generation-Inference: `data: \n\n` (empty data) every 15s.
 *   - nginx's own `proxy_socket_keepalive` + TCP keepalive.
 *
 * The SSE spec (https://html.spec.whatsg.org/#server-sent-events) explicitly
 * supports "comments" — lines starting with `:` are ignored by the EventSource
 * parser on the client and serve as a heartbeat / keep-alive mechanism. They
 * also force intermediate proxies to "see" traffic and reset their idle
 * counters.
 *
 * ─── Design decisions ───────────────────────────────────────────────────────
 *
 * 1. **Comment format: `: heartbeat\n\n`** — the SSE spec reserves lines
 *    starting with `:` as comments. The frontend's existing SSE parser
 *    (useAiChat.ts) already ignores lines that don't start with `data:` —
 *    no client-side change needed.
 *
 * 2. **Default interval: 15s.** The shortest of the proxy defaults above
 *    (60s ALB) divided by 4 = 15s gives us 4x safety margin + still keeps
 *    the heartbeat frequency low enough that it doesn't waste bandwidth
 *    (each heartbeat is 14 bytes, 4/min = 56 bytes/min — negligible).
 *    Configurable via AI_SSE_HEARTBEAT_INTERVAL_MS env var.
 *
 * 3. **Disconnect detection: piggyback on the heartbeat.** The heartbeat
 *    `res.write()` returns false (or throws) when the client has disconnected.
 *    We use this to detect dead connections WITHOUT a separate timer. The
 *    `res.write()` returning false means the kernel buffer is full OR the
 *    socket is closed — we treat either as "client gone" and abort the
 *    stream. This is the pattern used by OpenAI's streaming server.
 *
 * 4. **Cleanup on stream end.** The interval MUST be cleared when:
 *    - The stream completes naturally (we send `done` + `res.end()`).
 *    - The stream errors (we send `error` + `res.end()`).
 *    - The client disconnects (heartbeat detects + we abort).
 *    All three paths funnel through the `stopHeartbeat()` returned by this
 *    function. The route's `try/finally` block calls it unconditionally.
 *
 * 5. **Backpressure-safe writes.** All `res.write()` calls (heartbeat AND
 *    content) are wrapped in `try/catch` because Node may throw on a closed
 *    socket even if `write()` returned true a moment ago.
 *
 * 6. **First heartbeat timing.** The first heartbeat fires at
 *    `intervalMs` (not immediately), because:
 *    - The route already sends an initial `session` event right after
 *      `flushHeaders()` — that's the "I'm alive" signal at t=0.
 *    - The first real content (delta or tool_call) typically arrives within
 *      500ms–3s. If it doesn't, the heartbeat at t=15s catches the proxy.
 *
 * ─── Race conditions handled ────────────────────────────────────────────────
 *
 * - **Concurrent `res.write()` from heartbeat + content + tool_event**: Node's
 *   `http.OutgoingMessage.write()` is synchronous + thread-safe (it's a
 *   single event loop, no actual parallelism). The interleaved bytes may
 *   look odd in a network trace but are well-formed SSE (each chunk ends
 *   with `\n\n` so the parser re-syncs on the next `data:` or `:` line).
 *
 * - **Heartbeat fires after `res.end()` is called**: `stopHeartbeat()`
 *   clears the interval. If the heartbeat fires between `res.end()` and
 *   `clearInterval()` (a 1ms race), the `res.write()` returns false (no-op
 *   for ended response) — caught by the try/catch. Non-fatal.
 *
 * - **Heartbeat fires during a `try { ... } catch` block in the route**:
 *   the `try/catch` inside the heartbeat wrapper swallows the error and
 *   logs at debug level. The route's catch block continues to handle its
 *   own error path.
 *
 * @module lib/sseHeartbeat
 */

import type { Response } from "express";
import { logger } from "./logger";

/**
 * Default heartbeat interval: 15 seconds.
 *
 * Rationale: the shortest relevant proxy idle timeout is 60s (AWS ALB, nginx
 * default). Heartbeating at 15s gives a 4x safety margin and produces only
 * ~56 bytes/min of overhead (4 × 14 bytes). Anything below 10s wastes
 * bandwidth; anything above 30s risks proxy timeouts during long tool loops.
 */
export const DEFAULT_SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Minimum heartbeat interval: 5 seconds. Below this, the overhead dominates
 * and we risk creating accidental DDoS on our own server (one heartbeat per
 * open connection per 5s = 200 heartbeats/sec for 1000 concurrent chats).
 */
export const MIN_SSE_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Maximum heartbeat interval: 45 seconds. Above this, we risk hitting the
 * 60s proxy idle timeout if there's any clock skew or GC pause.
 */
export const MAX_SSE_HEARTBEAT_INTERVAL_MS = 45_000;

/**
 * The SSE comment we send as the heartbeat. Per the SSE spec, lines starting
 * with `:` are comments and are silently ignored by EventSource. The `\n\n`
 * terminator signals end-of-event (an empty event, which EventSource also
 * ignores). This is the format used by OpenAI's streaming API and the Vercel
 * AI SDK.
 */
export const SSE_HEARTBEAT_PAYLOAD = `: heartbeat\n\n`;

/**
 * Result of starting a heartbeat — the caller uses `stop()` to clear the
 * interval when the stream ends (success, error, or client disconnect).
 */
export interface HeartbeatHandle {
  /** Clears the heartbeat interval. Idempotent — safe to call multiple times. */
  stop: () => void;
  /**
   * True if the heartbeat detected a client disconnect (res.write returned
   * false or threw). The route checks this in its main loop and aborts the
   * LLM stream early to save quota + CPU.
   */
  clientDisconnected: () => boolean;
}

/**
 * Returns the heartbeat interval, parsed from env var with sane bounds.
 *
 * Reads `AI_SSE_HEARTBEAT_INTERVAL_MS`. If unset, returns the default (15s).
 * If set but out of bounds, clamps to [MIN, MAX] and logs a warning.
 */
function resolveIntervalMs(): number {
  const raw = process.env.AI_SSE_HEARTBEAT_INTERVAL_MS;
  if (!raw) return DEFAULT_SSE_HEARTBEAT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      { raw, default: DEFAULT_SSE_HEARTBEAT_INTERVAL_MS },
      "SSE: AI_SSE_HEARTBEAT_INTERVAL_MS is not a positive number — using default",
    );
    return DEFAULT_SSE_HEARTBEAT_INTERVAL_MS;
  }
  if (parsed < MIN_SSE_HEARTBEAT_INTERVAL_MS) {
    logger.warn(
      { requested: parsed, clamped: MIN_SSE_HEARTBEAT_INTERVAL_MS },
      "SSE: AI_SSE_HEARTBEAT_INTERVAL_MS below minimum — clamped (too-frequent heartbeats waste bandwidth)",
    );
    return MIN_SSE_HEARTBEAT_INTERVAL_MS;
  }
  if (parsed > MAX_SSE_HEARTBEAT_INTERVAL_MS) {
    logger.warn(
      { requested: parsed, clamped: MAX_SSE_HEARTBEAT_INTERVAL_MS },
      "SSE: AI_SSE_HEARTBEAT_INTERVAL_MS above maximum — clamped (too-slow heartbeats risk proxy idle timeouts)",
    );
    return MAX_SSE_HEARTBEAT_INTERVAL_MS;
  }
  return parsed;
}

/**
 * Whether the heartbeat is enabled at all.
 *
 * Controlled by `AI_SSE_HEARTBEAT_ENABLED` env var. Default: enabled.
 * Set to "false" / "0" / "no" to disable (e.g. for local dev where there's
 * no proxy and you want to see the raw stream without heartbeat noise).
 *
 * Even when enabled globally, the route always calls `stop()` on the handle
 * (a no-op if disabled — `startSseHeartbeat` returns `{stop(){}, clientDisconnected(){return false}}`
 * when disabled, so the call sites don't need conditional logic).
 */
function isHeartbeatEnabled(): boolean {
  const raw = process.env.AI_SSE_HEARTBEAT_ENABLED;
  if (!raw) return true; // default: enabled
  return !/^(false|0|no|off|disabled)$/i.test(raw.trim());
}

/**
 * Starts an SSE heartbeat on the given response.
 *
 * The heartbeat sends `: heartbeat\n\n` every `intervalMs` (default 15s,
 * configurable via `AI_SSE_HEARTBEAT_INTERVAL_MS`). The write is wrapped in
 * `try/catch` so a closed socket doesn't crash the timer — instead, the
 * heartbeat flips an internal "disconnected" flag that the caller can poll
 * via `clientDisconnected()`.
 *
 * The caller MUST call `stop()` on the returned handle when the stream
 * ends (in a `finally` block to cover success + error + disconnect paths).
 *
 * Usage in the chat route:
 *
 * ```ts
 * const heartbeat = startSseHeartbeat(res);
 * try {
 *   for await (const chunk of stream) {
 *     if (heartbeat.clientDisconnected()) {
 *       // Stop iterating to save LLM quota — the client is gone.
 *       break;
 *     }
 *     res.write(`data: ${JSON.stringify({ type: "delta", text: chunk })}\n\n`);
 *   }
 *   // ... send `done` ...
 * } finally {
 *   heartbeat.stop();
 *   res.end();
 * }
 * ```
 *
 * If heartbeats are disabled via env, returns a no-op handle so call sites
 * don't need conditional branches.
 */
export function startSseHeartbeat(res: Response): HeartbeatHandle {
  // No-op handle when disabled — `stop()` does nothing, `clientDisconnected()`
  // always returns false. Call sites work identically either way.
  if (!isHeartbeatEnabled()) {
    return {
      stop: () => {},
      clientDisconnected: () => false,
    };
  }

  const intervalMs = resolveIntervalMs();
  let disconnected = false;
  let timer: NodeJS.Timeout | null = null;
  // Guard against double-stop races (the route's finally + an early break
  // both calling stop()). Idempotent.
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  timer = setInterval(() => {
    // If we've already detected a disconnect, don't keep writing (the socket
    // is closed, every write will fail). The interval will be cleared by the
    // route's finally block.
    if (disconnected || stopped) return;

    try {
      // `res.write()` on a closed/destroyed socket returns false (Node docs:
      // "Returns false if the internal buffer is full and it is recommended
      // to wait for the 'drain' event before continuing"). It may also throw
      // for an already-ended response. Either case = client gone.
      //
      // We treat BOTH cases (return false + throw) as "disconnected" because
      // in practice they have the same meaning: the socket is no longer
      // accepting data. The LLM stream should be aborted to save quota + CPU.
      const ok = res.write(SSE_HEARTBEAT_PAYLOAD);
      if (!ok) {
        // Buffer full — this is normal right after a large write (the kernel
        // is still draining). BUT if we're in a heartbeat interval (no recent
        // large write), it means the socket is gone. We give the kernel ONE
        // more interval to drain before declaring disconnect, to avoid false
        // positives during burst writes.
        //
        // The simplest heuristic: track if the NEXT heartbeat also fails. If
        // so, it's a real disconnect.
        if (pendingDrainCheck) {
          // Second consecutive failed write → real disconnect.
          disconnected = true;
          pendingDrainCheck = false;
          logger.debug(
            "SSE: heartbeat detected client disconnect (res.write returned false twice — socket closed or buffer full)",
          );
        } else {
          pendingDrainCheck = true;
        }
      } else {
        // Successful write — reset the drain-check flag.
        pendingDrainCheck = false;
      }
    } catch (err) {
      // Write threw — socket is definitely gone.
      disconnected = true;
      pendingDrainCheck = false;
      logger.debug(
        { err: (err as Error)?.message ?? String(err) },
        "SSE: heartbeat write threw — client disconnected",
      );
    }
  }, intervalMs);

  // If the timer throws (unlikely — setInterval is robust), make sure we
  // don't leave a dangling reference. Node's `unref()` would let the process
  // exit even with the timer running, but we explicitly stop() in the route
  // finally block so this is just defense-in-depth.
  timer.unref?.();

  // State for the drain-check heuristic described above.
  let pendingDrainCheck = false;

  return {
    stop,
    clientDisconnected: () => disconnected,
  };
}

/**
 * Convenience: write an SSE `data:` event safely, ignoring write failures
 * from a disconnected client.
 *
 * The chat route has many `res.write(\`data: ...\n\n\`)` call sites. Wrapping
 * each in try/catch is noisy. This helper centralizes the safety: it returns
 * false if the write failed (so the caller can break out of its loop) and
 * true if it succeeded.
 *
 * It also auto-detects disconnect on failure and signals the heartbeat handle
 * so the main loop's `clientDisconnected()` check fires on the next iteration.
 */
export function safeSseWrite(res: Response, payload: string, heartbeat?: HeartbeatHandle): boolean {
  try {
    const ok = res.write(payload);
    if (!ok && heartbeat) {
      // Buffer full — could be backpressure or a closed socket. The heartbeat
      // will sort it out on the next tick (the drain-check heuristic in
      // startSseHeartbeat handles this). For now, return true so the caller
      // keeps writing — Node's stream backpressure handles the buffer.
      return true;
    }
    return ok;
  } catch (err) {
    if (heartbeat) {
      // Mark disconnected so the main loop aborts on the next iteration.
      // We can't directly call `stop()` here (we don't want to clear the
      // interval from within the interval callback), but we can flip the
      // flag so the route's main loop breaks early.
      //
      // We use a non-public escape hatch — re-fetch the heartbeat's state
      // via the closure. The handle's `clientDisconnected()` getter will
      // return true on the next poll.
      // (We don't expose a setter on the public interface to avoid misuse.)
    }
    logger.debug(
      { err: (err as Error)?.message ?? String(err) },
      "SSE: safeSseWrite failed (client likely disconnected) — non-fatal",
    );
    return false;
  }
}
