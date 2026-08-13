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
  id?: number;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  /** v2.0: true if this message was an off-topic refusal. */
  offTopic?: boolean;
  /** v2.0: true if this message was a pure-greeting shortcut response. */
  greeting?: boolean;
}

interface UseAiChatResult {
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  send: (text: string) => Promise<void>;
  clear: () => Promise<void>;
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
  // AbortController for the in-flight request, so we can cancel if the
  // user sends another message before the previous stream finishes.
  const abortRef = useRef<AbortController | null>(null);

  // ─── Load history on mount ──────────────────────────────────────────────
  // The session token now lives in an HttpOnly cookie set by the server,
  // so we don't need to read it from localStorage here. We just send the
  // request with `credentials: "include"` and the browser attaches the
  // cookie automatically. For legacy users (localStorage still has a bare
  // UUID), we fall back to putting it in the URL — the server's
  // `verifySessionAccess` will migrate it to a cookie on the next POST /ai/chat.
  useEffect(() => {
    let cancelled = false;
    const legacyToken = getLegacySessionToken();
    // Build the URL: if we have a legacy token, include it in the path
    // (for migration). Otherwise, use a placeholder — the server reads
    // from the cookie. The path token is required by the route signature
    // (`/ai/sessions/:token`) so we send the legacy UUID if we have one,
    // or a fresh anonymous one if not (the server will verify + reject if
    // it's not signed, then fall back to the cookie).
    const urlToken = legacyToken ?? "anonymous";

    (async () => {
      try {
        const authHeader = await buildAuthHeader();
        const res = await fetch(
          `${BASE_URL}/api/ai/sessions/${encodeURIComponent(urlToken)}`,
          {
            credentials: "include", // ← send + receive cookies
            headers: { ...authHeader },
          },
        );
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        // If the server returned a new signed token (via migration), the
        // Set-Cookie header on the response already set it — no JS action
        // needed. We just clear the legacy localStorage value if present.
        if (legacyToken && data.sessionToken && data.sessionToken !== legacyToken) {
          clearLegacySessionToken();
        }
        if (Array.isArray(data.messages) && data.messages.length > 0) {
          setMessages(
            data.messages.map((m: any) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              createdAt: m.createdAt,
              offTopic: m.offTopic,
              greeting: m.greeting,
            })),
          );
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
    if (!trimmed || loading) return;

    // Cancel any in-flight stream before starting a new one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setError(null);
    setLoading(true);

    // Optimistic: append the user's message immediately.
    const userMsg: ChatMessage = { role: "user", content: trimmed };
    // Reserve a slot for the assistant response — we'll mutate its content
    // as deltas arrive. Using a stable id so React doesn't remount.
    const assistantId = `pending-${Date.now()}`;
    const assistantMsg: ChatMessage = {
      id: assistantId as any,
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

      // eslint-disable-next-line no-constant-condition
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
              prev.map((m) =>
                m.id === assistantMsg.id
                  ? { ...m, content: received }
                  : m,
              ),
            );
          } else if (payload.type === "messageId" && typeof payload.messageId === "number") {
            // Backend persisted the assistant message and is telling us its
            // DB id. We replace the ephemeral placeholder id with the real
            // numeric id so FeedbackButtons can reference it.
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id
                  ? { ...m, id: payload.messageId as number }
                  : m,
              ),
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
                        content:
                          "Sorry, I couldn't generate a response. Please try again.",
                      }
                    : m,
                ),
              );
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") return; // user-cancelled
      const msg = err?.message ?? "Something went wrong.";
      setError(msg);
      // Replace the placeholder assistant bubble with the error.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? { ...m, content: `Error: ${msg}` }
            : m,
        ),
      );
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [loading]);

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

  return { messages, loading, error, send, clear };
}

async function buildAuthHeader(): Promise<Record<string, string>> {
  const token = await getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
