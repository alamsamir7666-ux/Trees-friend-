import { Router } from "express";
import type { z } from "zod";
import { db } from "@workspace/db";
import { newsletterTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import { newsletterLimiter } from "../middlewares/rateLimiter";
import { validateBody } from "../lib/validateRequest";
import { asyncHandler } from "../lib/errors";
import {
  NewsletterSubscribeBody,
  NewsletterUnsubscribeBody,
} from "../lib/schemas";

const router = Router();

router.post(
  "/newsletter/subscribe",
  newsletterLimiter,
  validateBody(NewsletterSubscribeBody, "NewsletterSubscribeBody"),
  asyncHandler(async (req, res) => {
    const { email } = req.body as z.infer<typeof NewsletterSubscribeBody>;
    const clean = email.toLowerCase().trim();

    await db
      .insert(newsletterTable)
      .values({ email: clean })
      .onConflictDoUpdate({
        target: newsletterTable.email,
        set: { isActive: true },
      });

    res.status(201).json({ message: "Successfully subscribed to newsletter" });
  }),
);

router.post(
  "/newsletter/unsubscribe",
  validateBody(NewsletterUnsubscribeBody, "NewsletterUnsubscribeBody"),
  asyncHandler(async (req, res) => {
    const { email } = req.body as z.infer<typeof NewsletterUnsubscribeBody>;
    await db
      .update(newsletterTable)
      .set({ isActive: false })
      .where(eq(newsletterTable.email, email.toLowerCase().trim()));
    res.json({ message: "Unsubscribed successfully" });
  }),
);

router.get(
  "/admin/newsletter/subscribers",
  requireAdmin,
  asyncHandler(async (_req, res) => {
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
  }),
);

export default router;
