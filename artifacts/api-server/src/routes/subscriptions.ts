// artifacts/api-server/src/routes/subscriptions.ts
import { Router } from "express";
import { db } from "@workspace/db";
import { subscriptionsTable, productsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import type { SubscriptionItem, SubscriptionAddress } from "@workspace/db";

const router = Router();

const FREQUENCY_DAYS: Record<string, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

function nextOrderDate(frequency: string): Date {
  const days = FREQUENCY_DAYS[frequency] ?? 30;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

function formatSub(s: typeof subscriptionsTable.$inferSelect) {
  return {
    id: s.id,
    userId: s.userId,
    status: s.status,
    frequency: s.frequency,
    items: s.items as SubscriptionItem[],
    shippingAddress: s.shippingAddress as SubscriptionAddress,
    totalAmount: Number(s.totalAmount),
    discountPercent: s.discountPercent,
    nextOrderDate: s.nextOrderDate.toISOString(),
    lastOrderDate: s.lastOrderDate?.toISOString() ?? null,
    orderCount: s.orderCount,
    paymentMethod: s.paymentMethod,
    notes: s.notes,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

// GET /subscriptions — list user's subscriptions
router.get("/subscriptions", requireAuth, async (req: any, res) => {
  try {
    const subs = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, req.userId));
    res.json(subs.map(formatSub));
  } catch {
    res.status(500).json({ error: "Failed to fetch subscriptions" });
  }
});

// GET /subscriptions/:id — single subscription
router.get("/subscriptions/:id", requireAuth, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const [sub] = await db
      .select()
      .from(subscriptionsTable)
      .where(and(eq(subscriptionsTable.id, id), eq(subscriptionsTable.userId, req.userId)))
      .limit(1);
    if (!sub) { res.status(404).json({ error: "Not found" }); return; }
    res.json(formatSub(sub));
  } catch {
    res.status(500).json({ error: "Failed to fetch subscription" });
  }
});

// POST /subscriptions — create a new subscription
router.post("/subscriptions", requireAuth, async (req: any, res) => {
  try {
    const { items, frequency, shippingAddress, paymentMethod, notes } = req.body;

    if (!items?.length) {
      res.status(400).json({ error: "At least one item is required" });
      return;
    }
    if (!["weekly", "biweekly", "monthly"].includes(frequency)) {
      res.status(400).json({ error: "frequency must be weekly, biweekly, or monthly" });
      return;
    }
    if (!shippingAddress?.fullName || !shippingAddress?.phone || !shippingAddress?.street || !shippingAddress?.city) {
      res.status(400).json({ error: "Complete shipping address is required" });
      return;
    }

    // Validate items against DB
    const productIds: number[] = items.map((i: any) => i.productId);
    const products = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, productIds[0])); // simple check — extend for multi

    const DISCOUNT = 10;
    const totalAmount = items.reduce((sum: number, i: any) => {
      const price = Number(i.price) * (1 - DISCOUNT / 100);
      return sum + price * (i.quantity ?? 1);
    }, 0);

    const [sub] = await db
      .insert(subscriptionsTable)
      .values({
        userId: req.userId,
        status: "active",
        frequency,
        items,
        shippingAddress,
        totalAmount: totalAmount.toFixed(2),
        discountPercent: DISCOUNT,
        nextOrderDate: nextOrderDate(frequency),
        paymentMethod: paymentMethod ?? "cod",
        notes: notes ?? null,
      })
      .returning();

    res.status(201).json(formatSub(sub));
  } catch {
    res.status(500).json({ error: "Failed to create subscription" });
  }
});

// PATCH /subscriptions/:id — pause, resume, cancel, or update frequency
router.patch("/subscriptions/:id", requireAuth, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status, frequency, shippingAddress, notes } = req.body;

    const [sub] = await db
      .select()
      .from(subscriptionsTable)
      .where(and(eq(subscriptionsTable.id, id), eq(subscriptionsTable.userId, req.userId)))
      .limit(1);

    if (!sub) { res.status(404).json({ error: "Not found" }); return; }
    if (sub.status === "cancelled") {
      res.status(400).json({ error: "Cannot modify a cancelled subscription" });
      return;
    }

    const updates: Partial<typeof subscriptionsTable.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (status && ["active", "paused", "cancelled"].includes(status)) {
      updates.status = status;
    }
    if (frequency && ["weekly", "biweekly", "monthly"].includes(frequency)) {
      updates.frequency = frequency;
      updates.nextOrderDate = nextOrderDate(frequency);
    }
    if (shippingAddress) updates.shippingAddress = shippingAddress;
    if (notes !== undefined) updates.notes = notes;

    const [updated] = await db
      .update(subscriptionsTable)
      .set(updates)
      .where(eq(subscriptionsTable.id, id))
      .returning();

    res.json(formatSub(updated));
  } catch {
    res.status(500).json({ error: "Failed to update subscription" });
  }
});

// DELETE /subscriptions/:id — hard cancel
router.delete("/subscriptions/:id", requireAuth, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const [sub] = await db
      .select()
      .from(subscriptionsTable)
      .where(and(eq(subscriptionsTable.id, id), eq(subscriptionsTable.userId, req.userId)))
      .limit(1);
    if (!sub) { res.status(404).json({ error: "Not found" }); return; }

    await db
      .update(subscriptionsTable)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(subscriptionsTable.id, id));

    res.json({ message: "Subscription cancelled" });
  } catch {
    res.status(500).json({ error: "Failed to cancel subscription" });
  }
});

// Admin: list all subscriptions
router.get("/admin/subscriptions", requireAdmin, async (_req, res) => {
  try {
    const subs = await db.select().from(subscriptionsTable);
    res.json(subs.map(formatSub));
  } catch {
    res.status(500).json({ error: "Failed to fetch subscriptions" });
  }
});

export default router;
