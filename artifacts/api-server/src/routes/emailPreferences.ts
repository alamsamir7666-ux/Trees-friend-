// artifacts/api-server/src/routes/emailPreferences.ts
import { Router } from "express";
import { db } from "@workspace/db";
import { emailPreferencesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

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
router.get("/email-preferences", requireAuth, async (req: any, res) => {
  try {
    const [prefs] = await db
      .select()
      .from(emailPreferencesTable)
      .where(eq(emailPreferencesTable.userId, req.userId))
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
  } catch {
    res.status(500).json({ error: "Failed to fetch preferences" });
  }
});

// PUT /email-preferences — upsert
router.put("/email-preferences", requireAuth, async (req: any, res) => {
  try {
    const {
      orderUpdates, promotions, restockAlerts,
      newsletter, abandonedCart, loyaltyUpdates,
    } = req.body;

    const boolOrDefault = (v: unknown, def: boolean) =>
      typeof v === "boolean" ? v : def;

    const values = {
      userId: req.userId,
      orderUpdates: boolOrDefault(orderUpdates, true),
      promotions: boolOrDefault(promotions, true),
      restockAlerts: boolOrDefault(restockAlerts, true),
      newsletter: boolOrDefault(newsletter, true),
      abandonedCart: boolOrDefault(abandonedCart, true),
      loyaltyUpdates: boolOrDefault(loyaltyUpdates, true),
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
  } catch {
    res.status(500).json({ error: "Failed to save preferences" });
  }
});

export default router;
