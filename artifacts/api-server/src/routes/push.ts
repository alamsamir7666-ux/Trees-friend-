import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router = Router();

/**
 * NOTE: For production push notifications you need:
 * npm install web-push
 * And generate VAPID keys: npx web-push generate-vapid-keys
 * Set env vars: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_MAILTO
 *
 * Subscriptions should be stored in a push_subscriptions table.
 * This file provides the API endpoints; the actual web-push sending
 * should be triggered from order status update events.
 */

// Store push subscription
router.post("/push/subscribe", requireAuth, async (req: any, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint) {
      res.status(400).json({ error: "Invalid subscription object" });
      return;
    }

    // Store subscription in DB (using raw SQL since we haven't created a typed table)
    await db.execute(sql`
      INSERT INTO push_subscriptions (user_id, endpoint, keys)
      VALUES (${req.userId}, ${subscription.endpoint}, ${JSON.stringify(subscription.keys)})
      ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys
    `).catch(() => {
      // Table may not exist yet — gracefully skip
    });

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to save subscription" });
  }
});

router.post("/push/unsubscribe", requireAuth, async (req: any, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      res.status(400).json({ error: "Endpoint is required" });
      return;
    }
    await db.execute(sql`
      DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}
    `).catch(() => {});
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to remove subscription" });
  }
});

export default router;
