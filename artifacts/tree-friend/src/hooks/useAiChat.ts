/**
 * useAiChat — React hook that talks to the TreeBot backend.
 *
 * Responsibilities:
 *   - On mount, fetch prior chat history from GET /api/ai/sessions/:token.
 *   - Send a new message via POST /api/ai/chat (Server-Sent Events stream).
 *   - Expose { messages, send, clear, loading, error } to the UI.
 *
 * ─── Session token model (post-IDOR fix) ───────────────────────────────────
 *
 * Previously, this hook generated a `crypto.randomUUID()` and stored it in
 * `localStorage["treebot.sessionToken"]`, sending it as a JSON body field on
 * every request. That had three problems:
 *   1. XSS-exfiltrable (any injected script could read localStorage and
 *      steal the session).
 *   2. Referer-leakable (URLs with the token in the path leaked it on
 *      cross-origin image loads).
 *   3. Forgeable (anyone could mint a syntactically valid UUID).
 *
 * The new model uses an **HttpOnly cookie** set by the server. The cookie
 * is automatically sent on every same-origin (and configured cross-origin)
 * request via `credentials: "include"`. JavaScript CANNOT read it, which
 * eliminates the XSS exfiltration vector entirely.
 *
 * For the legacy migration window (existing users have a bare UUID in
 * localStorage, not a cookie), we still send the localStorage value as a
 * body field on POST /ai/chat. The server detects this, looks it up in
 * the DB, and migrates it to a signed cookie. The frontend then clears
 * the localStorage entry — the cookie takes over.
 *
 * Once the migration window closes (~30 days), the localStorage fallback
 * can be removed entirely.
 *
 * SSE parsing:
 *   The backend streams `data: {...}\n\n` lines. Each payload is one of:
 *     { type: "session", sessionToken: string }  // sent first
 *     { type: "delta",   text: string }           // incremental content
 *     { type: "done" }                            // stream complete
 *     { type: "error",   message: string }        // mid-stream failure
 *
 * We use the native fetch API + ReadableStream rather than EventSource
 * because EventSource is GET-only and we need POST for sending the message
 * body. This is the standard pattern for streaming chat APIs.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "@/lib/getToken";

const SESSION_TOKEN_KEY = "treebot.sessionToken";
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export interface ChatMessage {
  /**
   * The message's ID. Numeric for persisted messages (from the DB's
   * SERIAL primary key). String (`"pending-${Date.now()}"`) for
   * ephemeral optimistic placeholders that haven't been persisted yet.
   */
  id?: number | string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  /** v2.0: true if this message was an off-topic refusal. */
  offTopic?: boolean;
  /** v2.0: true if this message was a pure-greeting shortcut response. */
  greeting?: boolean;
  /**
   * v5.1: Live token/cost usage (streamed via `usage` SSE event).
   * Present when the provider sends usage metadata. The UI can render
   * "1,247 tokens · gemini-2.5-flash" below the message.
   */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    model?: string;
    provider?: string;
  };
  /**
   * v5.1: True when the backend is generating followups via structured
   * output (the `followups_loading` SSE event fired). The UI shows a
   * "Generating suggestions..." spinner.
   */
  followupsLoading?: boolean;
  /**
   * v5.1: Followup suggestions from the `followups_delta` SSE event
   * (structured output fallback). Rendered as chips by FollowupChips.
   */
  followups?: string[];
  /**
   * v6.2 Part 1: Tool results captured from the `tool_result` SSE event.
   * Each entry has the tool name + the structured result data (if the
   * backend sent it — only tools with registered UI components send
   * result data; other tools just send name + ok + durationMs).
   *
   * The frontend's ToolComponentRenderer maps tool names → React
   * components (OrderDetailCard, ListingGrid, etc.) and renders them
   * inline below the text bubble.
   */
  toolResults?: ToolResultEntry[];
}

/**
 * v6.2 Part 1: A captured tool result stored on a ChatMessage.
 */
export interface ToolResultEntry {
  /** The tool name (e.g. "get_order_details", "search_seller_listings"). */
  name: string;
  /** Whether the tool succeeded. */
  ok: boolean;
  /** The structured result data (present only for tools with UI components). */
  data?: unknown;
  /** Error message if ok=false. */
  error?: string;
  /** Execution duration in ms. */
  durationMs?: number;
}

/**
 * v3.7: A tool currently being executed by the AI. Tracked so the UI
 * can show "Looking up your order..." chips during multi-tool rounds.
 * Multiple tools can be active in parallel (the model can call several
 * tools in one round), and the same tool can be called multiple times
 * across rounds — `id` disambiguates them.
 */
export interface ActiveToolCall {
  /** Unique ID (server sends `name` only; we synthesize `${name}-${n}`). */
  id: string;
  /** The tool name (e.g. `search_catalog`, `get_user_orders`). */
  name: string;
  /**
   * v5.1: Partial tool-call args as they stream in (Groq only).
   * Accumulated from `tool_call_delta` SSE events. The UI can render
   * "Searching for: mang..." → "mango..." as args arrive.
   * NULL/empty when the provider doesn't stream args (Gemini).
   */
  argsPreview?: string;
}

interface UseAiChatResult {
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  send: (text: string) => Promise<void>;
  clear: () => Promise<void>;
  /**
   * v6.2 Part 5 (P1-6): Stop the in-flight stream. Aborts the AbortController,
   * which causes the fetch's `reader.read()` to throw an AbortError — caught
   * by the `catch` block in `send()` which silently returns. The `finally`
   * block then cleans up state (loading=false, activeToolCalls=[], etc.).
   *
   * The partial assistant message is KEPT (industry standard — ChatGPT,
   * Claude, Gemini all keep partial output when the user clicks Stop).
   * If the message has no content + no tool results (stopped before the
   * first delta), the finally block removes it entirely so the chat
   * doesn't show an empty bubble.
   *
   * Safe to call when not streaming — `abortRef.current?.abort()` is a
   * no-op when `abortRef.current` is null.
   */
  stop: () => void;
  /**
   * v6.2 Part 5 (P1-7): Regenerate the assistant message with the given id.
   *
   * Finds the user message immediately before the assistant message,
   * captures its content, removes BOTH from `messages`, then calls
   * `send(capturedContent)` to re-run the LLM.
   *
   * Industry standard (ChatGPT): only available on the LAST assistant
   * message — regenerating mid-history would invalidate every message
   * after it, which is confusing UX. The UI enforces this; the hook
   * also guards against `loadingRef.current` (no concurrent regen).
   *
   * If the message before the assistant message is not a user message
   * (defensive — shouldn't happen), only the assistant message is
   * removed and `send` is not called.
   */
  regenerate: (messageId: number | string) => Promise<void>;
  /**
   * v3.7: Tools currently being executed. Empty when no tools are in
   * flight. Render these as progress chips below the assistant bubble.
   */
  activeToolCalls: ActiveToolCall[];
  /** v5.1: Export the conversation as JSON or Markdown (triggers download). */
  exportConversation: (format?: "json" | "markdown") => Promise<void>;
  /** v5.1: Create a read-only share link for the conversation. */
  shareConversation: (opts?: {
    title?: string;
    expiresHours?: number;
  }) => Promise<{ shareToken: string; shareUrl: string; expiresAt: string | null }>;
}

/**
 * Reads the legacy localStorage session token, if present.
 *
 * Used ONLY for the migration path: the first POST /ai/chat after the
 * cookie-based auth is deployed will send this value in the body, the
 * server will migrate it to a signed cookie, and then we delete it
 * from localStorage (the cookie takes over).
 *
 * Returns null if no legacy token exists (new visitors, or visitors who
 * have already migrated).
 */
function getLegacySessionToken(): string | null {
  try {
    const token = localStorage.getItem(SESSION_TOKEN_KEY);
    if (token && token.length >= 8) return token;
  } catch {
    // localStorage may be unavailable (private browsing, disabled cookies
    // in some browsers also disable localStorage). Fall through to null.
  }
  return null;
}

/** Clears the legacy localStorage token (after successful migration to cookie). */
function clearLegacySessionToken(): void {
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // Best-effort — if localStorage is unavailable, there's nothing to clear.
  }
}

export function useAiChat(): UseAiChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * v3.7: Tools currently being executed by the AI. Tracked so the UI can
   * render "Looking up your order..." chips. Each entry is removed when
   * the matching `tool_result` event arrives. We use a counter to
   * synthesize a unique `id` per `tool_call` event (the server only
   * sends `name`), so the same tool called twice in sequence gets
   * distinct entries — important for sequential multi-round flows.
   */
  const [activeToolCalls, setActiveToolCalls] = useState<ActiveToolCall[]>([]);
  // AbortController for the in-flight request, so we can cancel if the
  // user sends another message before the previous stream finishes.
  const abortRef = useRef<AbortController | null>(null);

  // Bug #16 fix: loadingRef mirrors `loading` for use inside `send`'s guard.
  // The old code checked `loading` from the closure, but two rapid clicks
  // within the same React tick both saw `loading=false` (the state hadn't
  // flipped yet) and both proceeded — causing duplicate optimistic messages
  // + the second abort() killed the first stream prematurely. The ref is
  // updated synchronously inside `send` (before the first await), so the
  // second click sees `true` and bails out.
  const loadingRef = useRef(false);

  /**
   * v3.7: monotonically increasing counter for synthesizing unique IDs for
   * `tool_call` events. The server only sends the tool `name` (not an ID),
   * but the same tool can be called multiple times across rounds. We
   * synthesize `${name}-${counter}` so each call gets a distinct React key.
   */
  const toolCallCounterRef = useRef(0);

  // ─── Load history on mount ──────────────────────────────────────────────
  // v3.10: uses GET /api/ai/sessions/current (cookie-only, no URL token).
  //
  // The previous flow sent `GET /api/ai/sessions/anonymous` (with the
  // literal string "anonymous" as the URL token). That caused the
  // "history disappears on reopen" bug: if the cookie wasn't sent
  // (cross-origin SameSite issue, browser cookie blocking, or expired
  // cookie), the backend's `verifySessionAccess` rejected "anonymous"
  // as neither a valid signed token nor a valid legacy UUID → 401 →
  // the frontend's `if (!res.ok) return;` silent-failed → empty chat.
  //
  // The new `/current` route reads ONLY from the cookie. If no cookie
  // exists, it returns empty history (200, not 401) — the frontend
  // starts fresh, and the next POST mints a new session via Set-Cookie.
  // This is the standard pattern for cookie-based session APIs.
  //
  // Bug #8 fix: MERGE instead of REPLACE. Preserve any ephemeral
  // `pending-*` messages (optimistic user msg + assistant placeholder)
  // that the user added before this GET resolved.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const authHeader = await buildAuthHeader();
        const res = await fetch(`${BASE_URL}/api/ai/sessions/current`, {
          credentials: "include", // ← send + receive cookies
          headers: { ...authHeader },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data.messages) && data.messages.length > 0) {
          const historyMessages: ChatMessage[] = data.messages.map((m: any) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.createdAt,
            offTopic: m.offTopic,
            greeting: m.greeting,
          }));
          // Bug #8 fix: MERGE instead of REPLACE. Preserve any ephemeral
          // `pending-*` messages (optimistic user msg + assistant
          // placeholder) that the user added before this GET resolved.
          // Numeric ids from the server are also preserved (they're real
          // persisted messages). This way the user's in-flight
          // conversation isn't wiped by a late-arriving history fetch.
          setMessages((prev) => {
            const ephemeral = prev.filter(
              (m) => typeof m.id === "string" && m.id.startsWith("pending-"),
            );
            return [...historyMessages, ...ephemeral];
          });
        }
      } catch {
        // Silent fail — user just sees an empty chat, which is fine.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Send a message ─────────────────────────────────────────────────────
  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    // Bug #16 fix: check loadingRef (synchronous) instead of `loading`
    // (state, which may not have flipped yet within the same React tick).
    // This prevents the double-click race where two sends both pass the
    // guard, both append optimistic messages, and the second abort() kills
    // the first stream.
    if (!trimmed || loadingRef.current) return;
    loadingRef.current = true; // ← synchronous, before any await

    // Cancel any in-flight stream before starting a new one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setError(null);
    setLoading(true);
    // v3.7: reset tool-call tracking for the new request.
    setActiveToolCalls([]);
    toolCallCounterRef.current = 0;

    // Optimistic: append the user's message immediately.
    const userMsg: ChatMessage = { role: "user", content: trimmed };
    // Reserve a slot for the assistant response — we'll mutate its content
    // as deltas arrive. Using a stable id so React doesn't remount.
    // Bug #19 fix: removed the `as any` cast — ChatMessage.id is now
    // `number | string` so the string id is valid.
    const assistantId = `pending-${Date.now()}`;
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      // For the legacy migration: if localStorage has a bare UUID, send it
      // in the body so the server can migrate it. Otherwise, the cookie
      // (sent via `credentials: "include"`) handles everything.
      const legacyToken = getLegacySessionToken();
      const authHeader = await buildAuthHeader();
      const res = await fetch(`${BASE_URL}/api/ai/chat`, {
        method: "POST",
        credentials: "include", // ← send + receive cookies
        headers: {
          "Content-Type": "application/json",
          ...authHeader,
        },
        body: JSON.stringify({
          message: trimmed,
          // Only include sessionToken if we have a legacy one to migrate.
          // Once migrated, the cookie takes over and we stop sending this.
          ...(legacyToken ? { sessionToken: legacyToken } : {}),
        }),
        signal: controller.signal,
      });

      // Non-streaming error responses (4xx/5xx) — body is JSON.
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error ?? `Request failed (${res.status})`);
      }

      // Non-SSE response (e.g. off-topic refusal returns JSON).
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        const data = await res.json();
        // If the server returned a new signed token (migration or
        // rotation), the Set-Cookie header already set it. If we sent a
        // legacy token in the body and got a different one back, clear
        // localStorage — the cookie has taken over.
        if (legacyToken && data.sessionToken && data.sessionToken !== legacyToken) {
          clearLegacySessionToken();
        }
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  content: data.message ?? "(no response)",
                  id: typeof data.messageId === "number" ? data.messageId : m.id,
                  offTopic: data.offTopic === true,
                  greeting: data.greeting === true,
                }
              : m,
          ),
        );
        return;
      }

      // ─── Parse the SSE stream ───────────────────────────────────────────
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let received = "";
      let serverSessionToken: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line.
        let sepIdx: number;
        while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);

          // Each event may have multiple `data:` lines — concatenate.
          const dataLines = rawEvent
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim());
          if (dataLines.length === 0) continue;
          const payloadStr = dataLines.join("");

          let payload: any;
          try {
            payload = JSON.parse(payloadStr);
          } catch {
            continue; // skip malformed
          }

          if (payload.type === "session" && payload.sessionToken) {
            // The server sent us a (possibly rotated) signed token. The
            // Set-Cookie header on the response already set it as an
            // HttpOnly cookie — we can't read it from JS, and we don't
            // need to. We DO need to clear the legacy localStorage value
            // if we were migrating from one.
            serverSessionToken = payload.sessionToken;
            if (legacyToken && serverSessionToken !== legacyToken) {
              clearLegacySessionToken();
            }
          } else if (payload.type === "delta" && payload.text) {
            received += payload.text;
            // Update the assistant message in place.
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: received } : m)),
            );
          } else if (payload.type === "messageId" && typeof payload.messageId === "number") {
            // Backend persisted the assistant message and is telling us its
            // DB id. We replace the ephemeral placeholder id with the real
            // numeric id so FeedbackButtons can reference it.
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id ? { ...m, id: payload.messageId as number } : m,
              ),
            );
          } else if (payload.type === "tool_call" && typeof payload.name === "string") {
            // v3.7: A tool is about to execute. Add it to activeToolCalls
            // so the UI can render a "Looking up..." chip. We synthesize a
            // unique id because the server only sends `name` (the same tool
            // can be called multiple times across rounds).
            const counter = ++toolCallCounterRef.current;
            const toolId = `${payload.name}-${counter}`;
            setActiveToolCalls((prev) => [...prev, { id: toolId, name: payload.name }]);
          } else if (payload.type === "tool_call_delta") {
            // v5.1: Streaming tool-call args (Groq only). The model is
            // generating tool-call arguments token-by-token. We accumulate
            // the partial args + update the active tool call so the UI can
            // render "Searching for: mang..." → "mango...".
            //
            // The `toolCallId` from the server maps to the tool call we're
            // tracking. We try to find a matching active call (by name if
            // present, or by the first unnamed active call) + append the
            // argsDelta to its `argsPreview` field.
            if (payload.argsDelta) {
              setActiveToolCalls((prev) => {
                // If a name was provided, find the first active call with
                // that name + no argsPreview yet (the newest matching one).
                let targetIdx = -1;
                if (payload.name) {
                  // Find the LAST active call with this name (most recent)
                  for (let i = prev.length - 1; i >= 0; i--) {
                    if (prev[i].name === payload.name) {
                      targetIdx = i;
                      break;
                    }
                  }
                }
                if (targetIdx === -1 && prev.length > 0) {
                  targetIdx = prev.length - 1;
                }
                if (targetIdx === -1) return prev;
                const target = prev[targetIdx];
                const updated: ActiveToolCall = {
                  ...target,
                  argsPreview: (target.argsPreview ?? "") + payload.argsDelta,
                };
                return [...prev.slice(0, targetIdx), updated, ...prev.slice(targetIdx + 1)];
              });
            }
          } else if (payload.type === "tool_result" && typeof payload.name === "string") {
            // v3.7: A tool finished executing. Remove it from activeToolCalls.
            // We remove the FIRST matching entry (oldest) — if the same tool
            // was called multiple times, the oldest in-flight call is the one
            // most likely to have just completed.
            setActiveToolCalls((prev) => {
              const idx = prev.findIndex((t) => t.name === payload.name);
              if (idx === -1) return prev;
              return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
            });

            // v6.2 Part 1: capture the tool result DATA (if present) + store
            // on the current assistant message. The backend only sends
            // `result` for tools that have registered UI components
            // (get_order_details, get_user_orders, search_seller_listings,
            // get_product_care). For other tools, `result` is absent and
            // we don't store anything — the LLM already handled it.
            if (payload.result !== undefined) {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== assistantMsg.id) return m;
                  const toolResults = m.toolResults ?? [];
                  return {
                    ...m,
                    toolResults: [
                      ...toolResults,
                      {
                        name: payload.name!,
                        ok: payload.ok ?? true,
                        data: payload.result,
                        durationMs: payload.durationMs,
                      },
                    ],
                  };
                }),
              );
            }
          } else if (payload.type === "usage") {
            // v5.1: Live token/cost display. The provider sent usage metadata
            // (prompt + completion tokens). We store it on the assistant
            // message so the UI can render "1,247 tokens · GPT-4" live.
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id
                  ? {
                      ...m,
                      usage: {
                        promptTokens: payload.promptTokens,
                        completionTokens: payload.completionTokens,
                        totalTokens: payload.totalTokens,
                        model: payload.model,
                        provider: payload.provider,
                      },
                    }
                  : m,
              ),
            );
          } else if (payload.type === "followups_loading") {
            // v5.1: The backend is generating followups via structured output.
            // Show a loading state on the assistant message.
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantMsg.id ? { ...m, followupsLoading: true } : m)),
            );
          } else if (payload.type === "followups_delta" && Array.isArray(payload.followups)) {
            // v5.1: Followups arrived via structured output fallback.
            // Store them on the message for immediate rendering.
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id
                  ? { ...m, followupsLoading: false, followups: payload.followups }
                  : m,
              ),
            );
          } else if (payload.type === "response_replaced" && payload.text) {
            // v5.5: The backend's output safety check modified the response
            // (PII redacted or Constitutional AI flagged it as unsafe).
            // Replace the displayed message with the sanitized version.
            received = payload.text;
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: received } : m)),
            );
          } else if (payload.type === "error") {
            setError(payload.message ?? "Stream failed.");
            // Replace the empty assistant bubble with an error message.
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id
                  ? {
                      ...m,
                      content:
                        payload.message ??
                        "Sorry, I couldn't generate a response. Please try again.",
                    }
                  : m,
              ),
            );
            break;
          } else if (payload.type === "done") {
            // Stream complete. If we got no deltas, surface a fallback so
            // the bubble isn't permanently empty.
            if (!received) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? {
                        ...m,
                        content: "Sorry, I couldn't generate a response. Please try again.",
                      }
                    : m,
                ),
              );
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") return; // user-cancelled (Stop button)
      const msg = err?.message ?? "Something went wrong.";
      setError(msg);
      // Replace the placeholder assistant bubble with the error.
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: `Error: ${msg}` } : m)),
      );
    } finally {
      setLoading(false);
      // v3.7: clear any straggling tool calls (e.g. if the stream ended
      // mid-tool-execution due to an error or abort).
      setActiveToolCalls([]);
      // Bug #16 fix: reset the ref synchronously so the next `send` can
      // proceed immediately (not waiting for the next render cycle).
      loadingRef.current = false;
      abortRef.current = null;
      // v6.2 Part 5 (P1-6): if the assistant message ended up empty
      // (stopped before first delta, or stream returned nothing), remove
      // it so the chat doesn't show a permanent empty bubble. We check
      // for content + tool results — a tool result alone is enough to
      // keep the bubble (some tool calls return data without LLM text).
      // This runs on EVERY completion (success, error, abort) but is a
      // no-op when the message has content or tool results.
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (
          last &&
          last.role === "assistant" &&
          !last.content &&
          (!last.toolResults || last.toolResults.length === 0)
        ) {
          return prev.slice(0, -1);
        }
        return prev;
      });
    }
  }, []); // Bug #16 fix: removed `[loading]` dep — we now use loadingRef
  // (a ref, stable identity) so `send` has a stable reference and doesn't
  // recreate on every loading flip. This prevents unnecessary re-renders
  // of children that depend on `send`.

  // ─── v6.2 Part 5 (P1-6): Stop the in-flight stream ────────────────────────
  // Aborts the AbortController. The fetch's reader.read() throws an
  // AbortError → caught by `send()`'s catch (silent return) → finally
  // block cleans up state. Partial content is preserved; empty bubbles
  // are removed by the finally block above.
  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ─── v6.2 Part 5 (P1-7): Regenerate an assistant message ──────────────────
  // Removes the assistant message + the user message preceding it, then
  // re-sends the user message via `send()`. `send()` will append fresh
  // optimistic messages at the end.
  //
  // Two state updates happen in sequence (both queued via setMessages):
  //   1. remove the two messages
  //   2. send() appends new optimistic userMsg + assistantMsg
  // React batches these — the final state has the regenerated pair at the
  // end, exactly where the user expects them.
  //
  // Edge case: if `messageId` isn't found (e.g. user clicked regenerate
  // twice rapidly), setMessages returns `prev` unchanged and we skip send.
  // The `loadingRef.current` guard prevents concurrent regen + send.
  const regenerate = useCallback(
    async (messageId: number | string) => {
      if (loadingRef.current) return;
      let userContent: string | null = null;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx === -1) return prev;
        // Find the user message immediately before the assistant message.
        if (idx > 0 && prev[idx - 1].role === "user") {
          userContent = prev[idx - 1].content;
          return [...prev.slice(0, idx - 1), ...prev.slice(idx + 1)];
        }
        // No preceding user message — just remove the assistant message.
        return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      });
      if (userContent) {
        await send(userContent);
      }
    },
    [send],
  );

  // ─── Clear conversation ─────────────────────────────────────────────────
  // The session token now lives in an HttpOnly cookie. We don't generate
  // a new one client-side — the server does that via `Set-Cookie` on the
  // DELETE response (clearing the old cookie + the next POST /ai/chat
  // will mint a fresh anonymous one). We just send the DELETE with the
  // cookie attached.
  const clear = useCallback(async () => {
    // Cancel any in-flight request first.
    abortRef.current?.abort();
    abortRef.current = null;
    // Bug #16 fix: reset the ref so the next `send` can proceed.
    loadingRef.current = false;

    // Best-effort: tell the server to delete the session + messages.
    // The cookie is sent automatically via `credentials: "include"`.
    // We use the URL token "current" as a placeholder — the server reads
    // the actual sid from the cookie.
    try {
      const authHeader = await buildAuthHeader();
      await fetch(`${BASE_URL}/api/ai/sessions/current`, {
        method: "DELETE",
        credentials: "include", // ← send + receive cookies
        headers: { ...authHeader },
      });
    } catch {
      // Non-fatal — local state is already cleared.
    }

    // Clear any legacy localStorage token too (migration cleanup).
    clearLegacySessionToken();

    setMessages([]);
    setError(null);
  }, []);

  // ─── v5.1: Export conversation ──────────────────────────────────────────
  // Downloads the conversation as JSON or Markdown. Returns a blob URL
  // the caller can use to trigger a download (or open in a new tab).
  const exportConversation = useCallback(
    async (format: "json" | "markdown" = "json"): Promise<void> => {
      const authHeader = await buildAuthHeader();
      const res = await fetch(`${BASE_URL}/api/ai/sessions/current/export?format=${format}`, {
        credentials: "include",
        headers: { ...authHeader },
      });
      if (!res.ok) {
        throw new Error(`Export failed: ${res.status}`);
      }
      const blob = await res.blob();
      // Trigger a download via a temporary <a> element.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // Extract filename from Content-Disposition header, or use a default.
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
      a.download = filenameMatch?.[1] ?? `treebot-export.${format === "markdown" ? "md" : "json"}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke the blob URL after a short delay (download needs it to stay
      // alive briefly).
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    [],
  );

  // ─── v5.1: Share conversation ───────────────────────────────────────────
  // Creates a read-only share link for the current conversation. Returns
  // the share URL the user can copy + send to someone else.
  const shareConversation = useCallback(
    async (opts?: {
      title?: string;
      expiresHours?: number;
    }): Promise<{
      shareToken: string;
      shareUrl: string;
      expiresAt: string | null;
    }> => {
      const authHeader = await buildAuthHeader();
      const res = await fetch(`${BASE_URL}/api/ai/sessions/current/share`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          ...(opts?.title ? { title: opts.title } : {}),
          ...(opts?.expiresHours ? { expiresHours: opts.expiresHours } : {}),
        }),
      });
      if (!res.ok) {
        throw new Error(`Share failed: ${res.status}`);
      }
      return res.json();
    },
    [],
  );

  return {
    messages,
    loading,
    error,
    send,
    clear,
    stop,
    regenerate,
    activeToolCalls,
    exportConversation,
    shareConversation,
  };
}

async function buildAuthHeader(): Promise<Record<string, string>> {
  const token = await getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
