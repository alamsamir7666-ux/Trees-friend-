import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { apiClient } from "@/lib/apiClient";
import { getToken } from "@/lib/getToken";

/**
 * Presence tracking for chat — industry-standard WhatsApp/Telegram-style.
 *
 * Two responsibilities:
 *
 * 1. Heartbeat: while the user is signed in AND the tab is visible, send
 *    POST /api/presence/heartbeat every 30 seconds. Also fire one immediately
 *    on `visibilitychange` (tab becomes visible) and `focus` (window gains
 *    focus). On `pagehide`/`beforeunload`, fire-and-forget a final
 *    POST /api/presence/offline with `keepalive: true` so the server marks
 *    the user as offline right away (instead of waiting 60s for the
 *    threshold to expire).
 *
 * 2. Status query: given another user's Clerk ID, poll
 *    GET /api/presence/:clerkUserId every 15 seconds and return the
 *    current presence. The polling is intentionally a separate concern
 *    from the heartbeat — the heartbeat runs app-wide (one user, one
 *    presence row), while status queries are per-conversation (the other
 *    party in the chat).
 *
 * Why not WebSocket? See the route's docstring — heartbeats are simpler to
 * scale, degrade gracefully, and work through proxies that block WS
 * upgrades. The 30s + 60s + 15s cadence matches WhatsApp Web's observed
 * behavior.
 *
 * Hook shape (two hooks):
 *   - useHeartbeat()             → app-wide, fires heartbeats for the
 *                                  signed-in user. Mount once in App.
 *   - usePresence(otherUserId)   → returns { status, lastSeenAt, isLoading }
 *                                  for the OTHER party in a chat.
 */

// ─── Heartbeat cadence ────────────────────────────────────────────────────
// 30s interval matches WhatsApp Web. The server treats the user as online
// if last_seen_at is within the last 60s (2x buffer for one missed beat).
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

// ─── Status polling cadence ───────────────────────────────────────────────
// 15s interval for polling the OTHER user's status. Aggressive enough that
// the chat header reflects "online" within ~15s of the other party opening
// the app, but not so aggressive that it spams the server. Polling stops
// entirely when the tab is hidden (no point updating a header nobody sees).
const STATUS_POLL_INTERVAL_MS = 15 * 1000;

/**
 * App-wide heartbeat hook. Mount once (e.g. in App or AppLayout) — fires
 * heartbeats whenever the user is signed in and the tab is visible.
 *
 * No return value — this hook is purely a side-effect.
 */
export function useHeartbeat(): void {
  const { isSignedIn } = useAuth();
  // Ref so the interval callback always sees the latest value without
  // needing to tear down and recreate the interval on every auth change.
  const isSignedInRef = useRef(isSignedIn);
  isSignedInRef.current = isSignedIn;

  useEffect(() => {
    if (!isSignedIn) return;

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    async function sendHeartbeat() {
      // Don't send if signed out (race between auth change and timer) or
      // if the tab is hidden (no point — the user isn't actively using
      // the app, and the server will naturally age them to "offline").
      if (!isSignedInRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        await apiClient.post("/api/presence/heartbeat");
      } catch {
        // Swallow errors — a failed heartbeat is harmless. The server
        // will just age the user to "last seen at <old time>".
      }
    }

    async function sendOffline() {
      // Best-effort "I'm leaving" signal. Uses navigator.sendBeacon via
      // fetch's keepalive flag so the request survives the page unload.
      // We can't use apiClient here because it doesn't set keepalive, so
      // build the request manually.
      if (!isSignedInRef.current) return;
      try {
        const token = await getToken();
        const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
        await fetch(`${baseUrl}/api/presence/offline`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          keepalive: true,
          // body doesn't matter — the route just reads req.userId from the
          // auth middleware — but POST requires a body for some browsers.
          body: "{}",
        });
      } catch {
        // Swallow — best-effort, page is unloading.
      }
    }

    function onVisibilityChange() {
      // When the tab becomes visible again, fire a heartbeat immediately
      // so the user shows "online" right away instead of waiting up to
      // 30s for the next scheduled beat.
      if (document.visibilityState === "visible") {
        sendHeartbeat();
      }
    }

    function onFocus() {
      // Some browsers fire `focus` without `visibilitychange` when the
      // window regains focus from another app (e.g. alt-tab on desktop).
      sendHeartbeat();
    }

    function onPageHide() {
      // pagehide is the modern equivalent of beforeunload and is more
      // reliable on mobile (especially iOS Safari, where beforeunload is
      // famously flaky). Fire the offline beacon.
      sendOffline();
    }

    // Fire one immediately on mount so the user shows "online" the moment
    // they sign in, without waiting 30s.
    sendHeartbeat();

    // Schedule recurring heartbeats.
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onPageHide);
    // beforeunload as a fallback for browsers that don't fire pagehide
    // reliably (older browsers, some edge cases).
    window.addEventListener("beforeunload", onPageHide);

    return () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onPageHide);
      // When the user signs out (isSignedIn flips to false), mark them
      // offline immediately. This runs as part of the cleanup of the
      // previous effect run (when isSignedIn was true).
      sendOffline();
    };
    // We intentionally only depend on isSignedIn — the heartbeat logic
    // itself is stable and uses refs to read the latest auth state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn]);
}

// ─── Types ────────────────────────────────────────────────────────────────

export type PresenceStatus = "online" | "offline" | "unknown";

export interface PresenceState {
  status: PresenceStatus;
  /** ISO string of the other user's last heartbeat, or null if never seen. */
  lastSeenAt: string | null;
  /** True on first fetch; false after the first successful (or 404) response. */
  isLoading: boolean;
}

const INITIAL_STATE: PresenceState = {
  status: "unknown",
  lastSeenAt: null,
  isLoading: true,
};

/**
 * Poll the presence of ANOTHER user (the other party in a chat).
 *
 * @param otherUserClerkId The Clerk user ID of the user whose presence to
 *   poll. Pass null/undefined to disable polling (e.g. when the conversation
 *   hasn't loaded yet).
 *
 * Returns the current PresenceState. Re-fetches every 15s while the tab is
 * visible, and immediately on `visibilitychange` (tab becomes visible).
 */
export function usePresence(otherUserClerkId: string | null | undefined): PresenceState {
  const [state, setState] = useState<PresenceState>(INITIAL_STATE);

  // Track whether the hook is still mounted so we don't setState after
  // unmount (which would trigger a React warning and could leak stale
  // data into a different conversation's header).
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!otherUserClerkId) {
      setState(INITIAL_STATE);
      return;
    }

    let pollTimer: ReturnType<typeof setInterval> | null = null;

    async function fetchPresence() {
      // Don't poll when the tab is hidden — saves server load and the
      // user can't see the result anyway.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const res = await apiClient.get(`/api/presence/${otherUserClerkId}`);
        if (!isMountedRef.current) return;
        const data = res.data as { status: "online" | "offline"; lastSeenAt: string | null };
        setState({
          status: data.status,
          lastSeenAt: data.lastSeenAt,
          isLoading: false,
        });
      } catch {
        // Swallow — leave the previous state in place. A transient
        // network blip shouldn't blank out the header.
        if (!isMountedRef.current) return;
        setState((prev) => ({ ...prev, isLoading: false }));
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        // Tab visible again — refresh immediately so the header doesn't
        // show stale "offline" for up to 15s after switching back.
        fetchPresence();
      }
    }

    // Fire one immediately so the header shows the right status without
    // waiting 15s.
    fetchPresence();
    pollTimer = setInterval(fetchPresence, STATUS_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      if (pollTimer) clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [otherUserClerkId]);

  return state;
}

// ─── Formatting helpers ───────────────────────────────────────────────────
// These match WhatsApp's "last seen" formatting closely:
//   - Within the last minute: "last seen just now"
//   - Same day:                "last seen today at 5:42 PM"
//   - Yesterday:               "last seen yesterday at 9:30 AM"
//   - Within the last week:    "last seen Monday at 9:30 AM"
//   - Older:                   "last seen Aug 1" / "last seen Aug 1, 2025"

/**
 * Format a "last seen" timestamp into a human-friendly string matching
 * WhatsApp/Telegram conventions. Returns null if the timestamp is null
 * (user has never sent a heartbeat — show no "last seen" text).
 *
 * @param isoString ISO timestamp string, or null
 * @returns Formatted string like "last seen today at 5:42 PM", or null
 */
export function formatLastSeen(isoString: string | null): string | null {
  if (!isoString) return null;

  const lastSeen = new Date(isoString);
  if (isNaN(lastSeen.getTime())) return null;

  const now = new Date();
  const diffMs = now.getTime() - lastSeen.getTime();
  const diffMinutes = Math.floor(diffMs / (60 * 1000));

  // Within the last minute — "just now" (avoid "0 minutes ago")
  if (diffMinutes < 1) return "last seen just now";

  // Same calendar day — "today at 5:42 PM"
  const isSameDay = lastSeen.toDateString() === now.toDateString();
  if (isSameDay) {
    return `last seen today at ${formatTime(lastSeen)}`;
  }

  // Yesterday — "yesterday at 9:30 AM"
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (lastSeen.toDateString() === yesterday.toDateString()) {
    return `last seen yesterday at ${formatTime(lastSeen)}`;
  }

  // Within the last 7 days — "Monday at 9:30 AM"
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays < 7) {
    return `last seen ${lastSeen.toLocaleDateString(undefined, { weekday: "long" })} at ${formatTime(lastSeen)}`;
  }

  // Same year — "Aug 1"
  if (lastSeen.getFullYear() === now.getFullYear()) {
    return `last seen ${lastSeen.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }

  // Different year — "Aug 1, 2025"
  return `last seen ${lastSeen.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}
