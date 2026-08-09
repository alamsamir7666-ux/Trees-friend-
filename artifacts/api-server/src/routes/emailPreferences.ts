// artifacts/api-server/src/routes/emailPreferences.ts
import { Router } from "express";
import type { z } from "zod";
import { db } from "@workspace/db";
import { emailPreferencesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { validateBody } from "../lib/validateRequest";
import { asyncHandler } from "../lib/errors";
import { UpdateEmailPreferencesBody } from "../lib/schemas";
import type { ApiRequest } from "../types/apiRequest";

const router = Router();

function formatPrefs(p: typeof emailPreferencesTable.$inferSelect) {
  return {
    orderUpdates: p.orderUpdates,
    promotions: p.promotions,
    restockAlerts: p.restockAlerts,
    newsletter: p.newsletter,
    abandonedCart: p.abandonedCart,
    loyaltyUpdates: p.loyaltyUpdates,
    updatedAt: p.updatedAt.toISOString(),
  };
}

// GET /email-preferences
router.get(
  "/email-preferences",
  requireAuth,
  asyncHandler(async (req: ApiRequest, res) => {
    const [prefs] = await db
      .select()
      .from(emailPreferencesTable)
      .where(eq(emailPreferencesTable.userId, req.userId!))
      .limit(1);

    if (!prefs) {
      // Return defaults if not set yet
      res.json({
        orderUpdates: true,
        promotions: true,
        restockAlerts: true,
        newsletter: true,
        abandonedCart: true,
        loyaltyUpdates: true,
        updatedAt: null,
      });
      return;
    }

    res.json(formatPrefs(prefs));
  }),
);

// PUT /email-preferences — upsert
router.put(
  "/email-preferences",
  requireAuth,
  validateBody(UpdateEmailPreferencesBody, "UpdateEmailPreferencesBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof UpdateEmailPreferencesBody>>, res) => {
    const body = req.body;
    // Default unspecified fields to true (opt-out model).
    const values = {
      userId: req.userId!,
      orderUpdates: body.orderUpdates ?? true,
      promotions: body.promotions ?? true,
      restockAlerts: body.restockAlerts ?? true,
      newsletter: body.newsletter ?? true,
      abandonedCart: body.abandonedCart ?? true,
      loyaltyUpdates: body.loyaltyUpdates ?? true,
      updatedAt: new Date(),
    };

    const [prefs] = await db
      .insert(emailPreferencesTable)
      .values(values)
      .onConflictDoUpdate({
        target: emailPreferencesTable.userId,
        set: { ...values },
      })
      .returning();

    res.json(formatPrefs(prefs));
  }),
);

export default router;
