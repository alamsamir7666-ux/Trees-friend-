/**
 * useAiChat — React hook that talks to the TreeBot backend.
 *
 * Responsibilities:
 *   - Persist a session token in localStorage (so the same anonymous
 *     visitor can resume their conversation across page refreshes).
 *   - On mount, fetch prior chat history from GET /api/ai/sessions/:token.
 *   - Send a new message via POST /api/ai/chat (Server-Sent Events stream).
 *   - Expose { messages, send, clear, loading, error } to the UI.
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

function getSessionToken(): string {
  let token = localStorage.getItem(SESSION_TOKEN_KEY);
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem(SESSION_TOKEN_KEY, token);
  }
  return token;
}

export function useAiChat(): UseAiChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // AbortController for the in-flight request, so we can cancel if the
  // user sends another message before the previous stream finishes.
  const abortRef = useRef<AbortController | null>(null);

  // ─── Load history on mount ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const token = getSessionToken();

    (async () => {
      try {
        const authHeader = await buildAuthHeader();
        const res = await fetch(
          `${BASE_URL}/api/ai/sessions/${encodeURIComponent(token)}`,
          { headers: { ...authHeader } },
        );
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
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
      const token = getSessionToken();
      const authHeader = await buildAuthHeader();
      const res = await fetch(`${BASE_URL}/api/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeader,
        },
        body: JSON.stringify({ message: trimmed, sessionToken: token }),
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
        if (data.sessionToken) {
          localStorage.setItem(SESSION_TOKEN_KEY, data.sessionToken);
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
            localStorage.setItem(SESSION_TOKEN_KEY, payload.sessionToken);
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
  const clear = useCallback(async () => {
    // Cancel any in-flight request first.
    abortRef.current?.abort();
    abortRef.current = null;

    const oldToken = getSessionToken();
    // Generate a fresh token so the next message starts a new session.
    const newToken = crypto.randomUUID();
    localStorage.setItem(SESSION_TOKEN_KEY, newToken);

    // Best-effort: tell the server to delete the old session + messages.
    try {
      const authHeader = await buildAuthHeader();
      await fetch(
        `${BASE_URL}/api/ai/sessions/${encodeURIComponent(oldToken)}`,
        {
          method: "DELETE",
          headers: { ...authHeader },
        },
      );
    } catch {
      // Non-fatal — local state is already cleared.
    }

    setMessages([]);
    setError(null);
  }, []);

  return { messages, loading, error, send, clear };
}

async function buildAuthHeader(): Promise<Record<string, string>> {
  const token = await getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
