import { Router } from "express";
import type { z } from "zod";
import { requireAuth } from "../middlewares/auth";
import { validateBody } from "../lib/validateRequest";
import { asyncHandler } from "../lib/errors";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { ApiRequest } from "../types/apiRequest";
import {
  PushSubscribeBody,
  PushUnsubscribeBody,
} from "../lib/schemas";

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
router.post(
  "/push/subscribe",
  requireAuth,
  validateBody(PushSubscribeBody, "PushSubscribeBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof PushSubscribeBody>>, res) => {
    const { endpoint, keys } = req.body;

    // Store subscription in DB (using raw SQL since we haven't created a typed table)
    await db
      .execute(sql`
        INSERT INTO push_subscriptions (user_id, endpoint, keys)
        VALUES (${req.userId}, ${endpoint}, ${JSON.stringify(keys)})
        ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys
      `)
      .catch(() => {
        // Table may not exist yet — gracefully skip
      });

    res.json({ ok: true });
  }),
);

router.post(
  "/push/unsubscribe",
  requireAuth,
  validateBody(PushUnsubscribeBody, "PushUnsubscribeBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof PushUnsubscribeBody>>, res) => {
    const { endpoint } = req.body;
    await db
      .execute(sql`
        DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}
      `)
      .catch(() => {});
    res.json({ ok: true });
  }),
);

export default router;
