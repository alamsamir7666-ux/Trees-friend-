/**
 * FeedbackButtons — thumbs-up / thumbs-down on each assistant message.
 *
 * Behavior:
 *   - Clicking the same rating again toggles it off (unsets).
 *   - Clicking the opposite rating swaps it in place.
 *   - Persisted to backend via POST /api/ai/feedback.
 *   - Visual state is local until the request succeeds — if the request
 *     fails, the button reverts and a toast shows (caller can wire this
 *     up via the optional onError callback).
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
    async (next: "up" | "down") => {
      if (!messageId || submitting) return;
      // Optimistic toggle: same rating → unset, opposite → swap.
      const optimistic = rating === next ? null : next;
      setRating(optimistic);
      setSubmitting(true);

      try {
        const token = await getToken();
        const res = await fetch(`${BASE_URL}/api/ai/feedback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ messageId, rating: next }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

  const btn = "p-1 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

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
