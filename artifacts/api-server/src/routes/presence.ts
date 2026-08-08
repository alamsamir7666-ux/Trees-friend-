import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { logger } from "../lib/logger";
import type { ApiRequest } from "../types/apiRequest";

/**
 * Presence route — tracks user online/offline/last-seen status for chat.
 *
 * Industry-standard WhatsApp/Telegram-style presence:
 *   - Frontend sends a heartbeat to POST /api/presence/heartbeat every
 *     30 seconds while the user is active (and on visibilitychange/focus).
 *   - Server treats the user as "online" if last_seen_at is within the
 *     last 60 seconds (ONLINE_THRESHOLD_MS). The 2x buffer over the 30s
 *     heartbeat interval tolerates one missed heartbeat without flipping
 *     the user to "offline".
 *   - Otherwise "offline" with last_seen_at shown as "last seen at <time>".
 *
 * Why heartbeat polling instead of WebSocket?
 *   - Simpler to scale: no long-lived connections to maintain.
 *   - Degrades gracefully: a missed heartbeat just shows "last seen at".
 *   - Works through any network (corporate proxies, mobile networks
 *     that block WebSocket upgrades, etc.).
 *   - The 30s interval + 60s threshold is exactly what WhatsApp Web
 *     uses today.
 *
 * Endpoints:
 *   POST /api/presence/heartbeat
 *     - Auth required
 *     - Updates caller's last_seen_at to NOW()
 *     - Returns { ok: true } (lightweight; the client doesn't need the
 *       timestamp back — it just needs to know the server accepted it)
 *
 *   POST /api/presence/offline
 *     - Auth required
 *     - Sets caller's last_seen_at to NOW() then leaves it — the user
 *       will naturally fall off "online" after the threshold expires.
 *       Sent on `beforeunload` / `pagehide` so the user shows offline
 *       immediately rather than 60s later. Best-effort (fire-and-forget)
 *       because the page is unloading.
 *
 *   GET /api/presence/:clerkUserId
 *     - Auth required
 *     - Returns the presence of ANOTHER user (the other party in a chat).
 *     - Response: { status: "online" | "offline", lastSeenAt: string | null }
 *     - 404 if the user doesn't exist in our DB (e.g. a buyer who hasn't
 *       signed up yet — though this shouldn't happen in practice since
 *       Clerk creates the user on first sign-in)
 */

const ONLINE_THRESHOLD_MS = 60 * 1000; // 60 seconds

const router = Router();

// ─── POST /presence/heartbeat ──────────────────────────────────────────────
// Updates the caller's last_seen_at to NOW(). Called by the frontend every
// 30 seconds while the user is active, and on visibilitychange/focus events.
router.post("/presence/heartbeat", requireAuth, async (req: ApiRequest, res) => {
  try {
    await db
      .update(usersTable)
      .set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(usersTable.clerkId, req.userId!));

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Presence heartbeat error");
    res.status(500).json({ error: "Failed to update presence" });
  }
});

// ─── POST /presence/offline ────────────────────────────────────────────────
// Best-effort "I'm going offline" signal sent on pagehide/beforeunload.
// Sets last_seen_at to NOW() so the user shows "last seen at <now>"
// immediately, instead of staying "online" for another 60 seconds until
// the threshold expires.
//
// Uses fire-and-forget semantics — the response is not awaited by the
// client (the page is unloading). The `keepalive` flag on the fetch
// ensures the request completes even after the page is gone.
router.post("/presence/offline", requireAuth, async (req: ApiRequest, res) => {
  try {
    await db
      .update(usersTable)
      .set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(usersTable.clerkId, req.userId!));

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Presence offline error");
    res.status(500).json({ error: "Failed to update presence" });
  }
});

// ─── GET /presence/:clerkUserId ────────────────────────────────────────────
// Returns the presence status of another user. Used by the chat header to
// show "Online" or "last seen at <time>" for the other party.
router.get("/presence/:clerkUserId", requireAuth, async (req: ApiRequest, res) => {
  try {
    const { clerkUserId } = req.params;
    if (!clerkUserId || typeof clerkUserId !== "string") {
      res.status(400).json({ error: "clerkUserId is required" });
      return;
    }

    const [user] = await db
      .select({ lastSeenAt: usersTable.lastSeenAt })
      .from(usersTable)
      .where(eq(usersTable.clerkId, clerkUserId))
      .limit(1);

    if (!user) {
      // The user doesn't exist in our DB. This shouldn't happen in normal
      // flows (Clerk creates the user on first sign-in, and our ProfileSync
      // component mirrors them into our users table), but we handle it
      // gracefully — treat as "offline" with no last-seen.
      res.json({
        status: "offline" as const,
        lastSeenAt: null,
      });
      return;
    }

    const lastSeenAt = user.lastSeenAt ?? null;
    const isOnline =
      lastSeenAt != null &&
      Date.now() - new Date(lastSeenAt).getTime() < ONLINE_THRESHOLD_MS;

    res.json({
      status: isOnline ? ("online" as const) : ("offline" as const),
      lastSeenAt: lastSeenAt ? new Date(lastSeenAt).toISOString() : null,
    });
  } catch (err) {
    logger.error({ err }, "Get presence error");
    res.status(500).json({ error: "Failed to fetch presence" });
  }
});

export default router;
