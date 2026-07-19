import { Router } from "express";
import { db } from "@workspace/db";
import { newsletterTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

router.post("/newsletter/subscribe", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== "string" || !email.includes("@")) {
      res.status(400).json({ error: "Valid email is required" });
      return;
    }

    const clean = email.toLowerCase().trim();

    await db
      .insert(newsletterTable)
      .values({ email: clean })
      .onConflictDoUpdate({
        target: newsletterTable.email,
        set: { isActive: true },
      });

    res.status(201).json({ message: "Successfully subscribed to newsletter" });
  } catch {
    res.status(500).json({ error: "Failed to subscribe" });
  }
});

router.post("/newsletter/unsubscribe", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes("@")) {
      res.status(400).json({ error: "Valid email is required" });
      return;
    }
    await db
      .update(newsletterTable)
      .set({ isActive: false })
      .where(eq(newsletterTable.email, email.toLowerCase().trim()));
    res.json({ message: "Unsubscribed successfully" });
  } catch {
    res.status(500).json({ error: "Failed to unsubscribe" });
  }
});

router.get("/admin/newsletter/subscribers", requireAdmin, async (_req, res) => {
  try {
    const subscribers = await db
      .select()
      .from(newsletterTable)
      .where(eq(newsletterTable.isActive, true))
      .orderBy(newsletterTable.createdAt);

    res.json({
      total: subscribers.length,
      subscribers: subscribers.map((s) => ({
        id: s.id,
        email: s.email,
        subscribedAt: s.createdAt.toISOString(),
      })),
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch subscribers" });
  }
});

export default router;
