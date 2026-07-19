import { Router } from "express";
import { db } from "@workspace/db";
import { affiliatesTable, ordersTable, couponsTable, affiliateCashoutsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAdmin, requireAuth } from "../middlewares/auth";
import { logAudit } from "../lib/audit";
import crypto from "crypto";

const router = Router();

function fmt(a: typeof affiliatesTable.$inferSelect) {
  return {
    id: a.id, name: a.name, email: a.email, code: a.code,
    commissionRate: Number(a.commissionRate),
    totalSales: Number(a.totalSales), totalOrders: a.totalOrders,
    totalCommission: Number(a.totalCommission), isActive: a.isActive,
    createdAt: a.createdAt.toISOString(),
  };
}

router.get("/affiliate/me", requireAuth, async (req: any, res) => {
  try {
    const email = (req as any).dbUser?.email;
    if (!email) { res.status(401).json({ error: "Unauthorized" }); return; }
    const [affiliate] = await db.select().from(affiliatesTable)
      .where(eq(affiliatesTable.email, email)).limit(1);
    if (!affiliate) { res.status(404).json({ error: "Not an affiliate" }); return; }
    res.json(fmt(affiliate));
  } catch { res.status(500).json({ error: "Failed to fetch affiliate" }); }
});

router.get("/admin/affiliates", requireAdmin, async (_req, res) => {
  try {
    const affiliates = await db.select().from(affiliatesTable).orderBy(desc(affiliatesTable.createdAt));
    res.json(affiliates.map(fmt));
  } catch { res.status(500).json({ error: "Failed to fetch affiliates" }); }
});

router.post("/admin/affiliates", requireAdmin, async (req: any, res) => {
  try {
    const { name, email, commissionRate } = req.body;
    if (!name?.trim() || !email?.includes("@")) {
      res.status(400).json({ error: "Name and valid email are required" }); return;
    }
    const rate = Number(commissionRate ?? 10);
    if (isNaN(rate) || rate < 1 || rate > 50) {
      res.status(400).json({ error: "Commission rate must be between 1% and 50%" }); return;
    }

    const code = (req.body.code ?? "").toUpperCase().trim().replace(/\s+/g, "");
    if (!code || code.length < 3) {
      res.status(400).json({ error: "Affiliate code is required (min 3 characters)" }); return;
    }

    // Also create a coupon for this affiliate code
    await db.insert(couponsTable).values({
      code, discountType: "percentage", discountValue: String(rate), isActive: true,
    }).onConflictDoNothing();

    const [a] = await db.insert(affiliatesTable).values({
      name: name.trim(), email: email.trim(), code,
      commissionRate: String(rate),
    }).returning();

    res.status(201).json(fmt(a));
  } catch (err: any) {
    if (err?.code === "23505") { res.status(409).json({ error: "Affiliate with this code already exists" }); return; }
    res.status(500).json({ error: "Failed to create affiliate" });
  }
});

router.patch("/admin/affiliates/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
    const { name, email, commissionRate } = req.body;
    const updates: Record<string, any> = {};
    if (name?.trim()) updates.name = name.trim();
    if (email?.includes("@")) updates.email = email.trim();
    if (commissionRate !== undefined) {
      const rate = Number(commissionRate);
      if (isNaN(rate) || rate < 1 || rate > 50) {
        res.status(400).json({ error: "Commission rate must be between 1% and 50%" }); return;
      }
      updates.commissionRate = String(rate);
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No valid fields to update" }); return;
    }
    const [updated] = await db.update(affiliatesTable).set(updates).where(eq(affiliatesTable.id, id)).returning();
    if (!updated) { res.status(404).json({ error: "Affiliate not found" }); return; }
    res.json(fmt(updated));
  } catch { res.status(500).json({ error: "Failed to update affiliate" }); }
});

router.patch("/admin/affiliates/:id/toggle", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
    const [existing] = await db.select().from(affiliatesTable).where(eq(affiliatesTable.id, id)).limit(1);
    if (!existing) { res.status(404).json({ error: "Affiliate not found" }); return; }
    const [updated] = await db.update(affiliatesTable)
      .set({ isActive: !existing.isActive }).where(eq(affiliatesTable.id, id)).returning();
    res.json(fmt(updated));
  } catch { res.status(500).json({ error: "Failed to toggle affiliate" }); }
});

router.delete("/admin/affiliates/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
    await db.delete(affiliatesTable).where(eq(affiliatesTable.id, id));
    res.json({ message: "Affiliate deleted" });
  } catch { res.status(500).json({ error: "Failed to delete affiliate" }); }
});

// POST /affiliate/cashout — request cashout
router.post("/affiliate/cashout", requireAuth, async (req: any, res) => {
  try {
    const email = req.dbUser?.email;
    if (!email) { res.status(401).json({ error: "Unauthorized" }); return; }

    const [affiliate] = await db.select().from(affiliatesTable)
      .where(eq(affiliatesTable.email, email)).limit(1);
    if (!affiliate) { res.status(404).json({ error: "Not an affiliate" }); return; }
    if (!affiliate.isActive) { res.status(400).json({ error: "Affiliate account is inactive" }); return; }

    const commission = Number(affiliate.totalCommission);
    if (commission < 500) {
      res.status(400).json({ error: `Minimum cashout is ৳500. Your current commission is ৳${commission.toFixed(0)}` });
      return;
    }

    // Check no pending cashout exists
    const [pending] = await db.select().from(affiliateCashoutsTable)
      .where(eq(affiliateCashoutsTable.affiliateId, affiliate.id))
      .then(rows => rows.filter(r => r.status === "pending"));
    if (pending) {
      res.status(400).json({ error: "You already have a pending cashout request" }); return;
    }

    const [cashout] = await db.insert(affiliateCashoutsTable).values({
      affiliateId: affiliate.id,
      amount: String(commission),
    }).returning();

    res.status(201).json({ id: cashout.id, amount: Number(cashout.amount), status: cashout.status, createdAt: cashout.createdAt });
  } catch { res.status(500).json({ error: "Failed to create cashout request" }); }
});

// GET /affiliate/cashouts — user cashout history
router.get("/affiliate/cashouts", requireAuth, async (req: any, res) => {
  try {
    const email = req.dbUser?.email;
    const [affiliate] = await db.select().from(affiliatesTable)
      .where(eq(affiliatesTable.email, email)).limit(1);
    if (!affiliate) { res.status(404).json({ error: "Not an affiliate" }); return; }

    const cashouts = await db.select().from(affiliateCashoutsTable)
      .where(eq(affiliateCashoutsTable.affiliateId, affiliate.id))
      .orderBy(desc(affiliateCashoutsTable.createdAt));

    res.json(cashouts.map(c => ({ id: c.id, amount: Number(c.amount), status: c.status, note: c.note, createdAt: c.createdAt })));
  } catch { res.status(500).json({ error: "Failed to fetch cashouts" }); }
});

// GET /admin/cashouts — admin sees all cashouts
router.get("/admin/cashouts", requireAdmin, async (_req, res) => {
  try {
    const cashouts = await db.select({
      id: affiliateCashoutsTable.id,
      amount: affiliateCashoutsTable.amount,
      status: affiliateCashoutsTable.status,
      note: affiliateCashoutsTable.note,
      createdAt: affiliateCashoutsTable.createdAt,
      affiliateName: affiliatesTable.name,
      affiliateEmail: affiliatesTable.email,
      affiliateCode: affiliatesTable.code,
    }).from(affiliateCashoutsTable)
      .leftJoin(affiliatesTable, eq(affiliateCashoutsTable.affiliateId, affiliatesTable.id))
      .orderBy(desc(affiliateCashoutsTable.createdAt));

    res.json(cashouts.map(c => ({ ...c, amount: Number(c.amount) })));
  } catch { res.status(500).json({ error: "Failed to fetch cashouts" }); }
});

// PATCH /admin/cashouts/:id — approve or reject
router.patch("/admin/cashouts/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status, note } = req.body;
    if (!["approved", "rejected", "paid"].includes(status)) {
      res.status(400).json({ error: "Status must be approved or rejected" }); return;
    }
    const [updated] = await db.update(affiliateCashoutsTable)
      .set({ status, note: note ?? null, updatedAt: new Date() })
      .where(eq(affiliateCashoutsTable.id, id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Cashout not found" }); return; }
    if (status === "paid") {
      await db.update(affiliatesTable).set({ totalCommission: "0" }).where(eq(affiliatesTable.id, updated.affiliateId));
    }
    res.json({ id: updated.id, status: updated.status, note: updated.note });
  } catch { res.status(500).json({ error: "Failed to update cashout" }); }
});


export default router;
