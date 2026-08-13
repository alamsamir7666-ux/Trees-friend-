/**
 * FeedbackButtons — thumbs-up / thumbs-down on each assistant message.
 *
 * Behavior:
 *   - Clicking the same rating again toggles it off (unsets).
 *   - Clicking the opposite rating swaps it in place.
 *   - Persisted to backend via POST /api/ai/feedback.
 *   - Visual state is local until the request succeeds — if the request
 *     fails, the button reverts.
 *
 * ─── Bug #2 fix: cookie-based auth + 401/403/429 handling ──────────────────
 *
 * The backend now requires the requester to be authenticated (Clerk) OR
 * hold a signed session token (HttpOnly cookie). We send
 * `credentials: "include"` on every fetch so the cookie is attached
 * automatically. The response handling covers three new error cases:
 *
 *   - 401 (no identity): the user has no session cookie and isn't signed
 *     in. The buttons stay visible but clicking them shows a hint. This
 *     shouldn't normally happen — by the time the user sees a message
 *     bubble, they've already chatted, so they have a session cookie.
 *   - 403 (ownership failure): the user is trying to rate a message from
 *     a session they don't own. This is rare (only happens if the
 *     messageId was injected/tampered with) — we silently revert, like
 *     a network failure.
 *   - 429 (rate limit): the user is submitting too fast. We silently
 *     revert. The toast is omitted because feedback is a low-stakes
 *     action; a console warning is enough for debugging.
 *   - 409 (concurrent insert): a duplicate request was sent in flight.
 *     We automatically retry once after a short delay — the second
 *     attempt will hit the "existing" branch on the server and behave
 *     correctly (toggle or update).
 *
 * Props:
 *   - messageId: numeric ID from the DB (set after the assistant response
 *     is persisted). For the in-flight streaming bubble, messageId is
 *     undefined and the buttons don't render.
 *   - initialRating: the rating already on record (e.g. when rehydrating
 *     history on page load). null = no rating yet.
 */
import { useState, useCallback } from "react";
import { ThumbsUp, ThumbsDown, Loader2 } from "lucide-react";
import { getToken } from "@/lib/getToken";

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

interface FeedbackButtonsProps {
  messageId?: number;
  initialRating?: "up" | "down" | null;
}

export function FeedbackButtons({
  messageId,
  initialRating = null,
}: FeedbackButtonsProps) {
  const [rating, setRating] = useState<"up" | "down" | null>(initialRating);
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(
    async (next: "up" | "down", isRetry = false): Promise<void> => {
      if (!messageId || submitting) return;
      // Optimistic toggle: same rating → unset, opposite → swap.
      const optimistic = rating === next ? null : next;
      setRating(optimistic);
      setSubmitting(true);

      try {
        const token = await getToken();
        const res = await fetch(`${BASE_URL}/api/ai/feedback`, {
          method: "POST",
          credentials: "include", // ← send + receive the session cookie
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ messageId, rating: next }),
        });

        // ─── Handle non-OK responses ────────────────────────────────────
        if (!res.ok) {
          // 409 = concurrent insert conflict. Retry once (idempotent —
          // the second attempt will hit the "existing feedback" branch
          // on the server). Don't retry more than once to avoid loops.
          if (res.status === 409 && !isRetry) {
            // Brief delay to let the conflicting request settle.
            await new Promise((r) => setTimeout(r, 100));
            return submit(next, true);
          }

          // 401 = no identity. 403 = ownership failure. 429 = rate limit.
          // 4xx/5xx = server error. All of these: silently revert the
          // optimistic update. The error is logged in the network tab.
          // We don't show a toast because feedback is low-stakes — the
          // user can always click again. (If we want to be more
          // communicative later, we can add a `onError` prop.)
          if (res.status === 401) {
            console.info(
              "FeedbackButtons: 401 — no session cookie. The user may need to start a conversation first.",
            );
          } else if (res.status === 403) {
            console.warn(
              "FeedbackButtons: 403 — ownership check failed. The user may be trying to rate a message from a session they don't own.",
            );
          } else if (res.status === 429) {
            console.info("FeedbackButtons: 429 — rate limited. Please slow down.");
          }
          throw new Error(`HTTP ${res.status}`);
        }

        const data = (await res.json()) as {
          rating: "up" | "down" | null;
        };
        // Sync with server's source of truth.
        setRating(data.rating);
      } catch {
        // Revert on failure.
        setRating(rating);
        // Silent fail — don't interrupt the user with a toast for an
        // optional feedback action. The error is logged in the network tab.
      } finally {
        setSubmitting(false);
      }
    },
    [messageId, rating, submitting],
  );

  if (!messageId) return null;

  const btn = "p-1.5 rounded-md transition-all hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="flex items-center gap-1 -ml-1 mt-1">
      <button
        type="button"
        aria-label="Helpful"
        onClick={() => submit("up")}
        disabled={submitting}
        className={`${btn} ${
          rating === "up"
            ? "text-primary"
            : "text-muted-foreground/60 hover:text-primary"
        }`}
        title="Helpful"
      >
        {submitting && rating === "up" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ThumbsUp className="h-3.5 w-3.5" fill={rating === "up" ? "currentColor" : "none"} />
        )}
      </button>
      <button
        type="button"
        aria-label="Not helpful"
        onClick={() => submit("down")}
        disabled={submitting}
        className={`${btn} ${
          rating === "down"
            ? "text-destructive"
            : "text-muted-foreground/60 hover:text-destructive"
        }`}
        title="Not helpful"
      >
        {submitting && rating === "down" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ThumbsDown className="h-3.5 w-3.5" fill={rating === "down" ? "currentColor" : "none"} />
        )}
      </button>
    </div>
  );
}
