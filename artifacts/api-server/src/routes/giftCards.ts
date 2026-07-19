// artifacts/api-server/src/routes/giftCards.ts
import { Router } from "express";
import { db } from "@workspace/db";
import { giftCardsTable, giftCardTransactionsTable } from "@workspace/db";
import { eq, and, gte } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import crypto from "crypto";

const router = Router();

function generateCode(): string {
  // Format: ENVY-XXXX-XXXX-XXXX
  const part = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `ENVY-${part()}-${part()}-${part()}`;
}

function formatCard(c: typeof giftCardsTable.$inferSelect) {
  return {
    id: c.id,
    code: c.code,
    initialBalance: Number(c.initialBalance),
    balance: Number(c.balance),
    isActive: c.isActive,
    recipientEmail: c.recipientEmail,
    recipientName: c.recipientName,
    message: c.message,
    expiryDate: c.expiryDate?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

// GET /gift-cards/check/:code — look up a card's balance (public, used at checkout)
router.get("/gift-cards/check/:code", async (req, res) => {
  try {
    const code = req.params.code.toUpperCase().trim();
    const [card] = await db
      .select()
      .from(giftCardsTable)
      .where(eq(giftCardsTable.code, code))
      .limit(1);

    if (!card || !card.isActive) {
      res.status(404).json({ error: "Gift card not found or inactive" });
      return;
    }
    if (card.expiryDate && card.expiryDate < new Date()) {
      res.status(400).json({ error: "This gift card has expired" });
      return;
    }
    if (Number(card.balance) <= 0) {
      res.status(400).json({ error: "This gift card has no remaining balance" });
      return;
    }

    res.json({
      code: card.code,
      balance: Number(card.balance),
      recipientName: card.recipientName,
      expiryDate: card.expiryDate?.toISOString() ?? null,
    });
  } catch {
    res.status(500).json({ error: "Failed to check gift card" });
  }
});

// GET /gift-cards/my — cards purchased by current user
router.get("/gift-cards/my", requireAuth, async (req: any, res) => {
  try {
    const cards = await db
      .select()
      .from(giftCardsTable)
      .where(eq(giftCardsTable.purchasedByUserId, req.userId));
    res.json(cards.map(formatCard));
  } catch {
    res.status(500).json({ error: "Failed to fetch gift cards" });
  }
});

// POST /gift-cards — purchase a gift card
router.post("/gift-cards", requireAuth, async (req: any, res) => {
  try {
    const { amount, recipientEmail, recipientName, message, expiryDays } = req.body;

    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum < 100) {
      res.status(400).json({ error: "Minimum gift card amount is ৳100" });
      return;
    }
    if (amountNum > 50000) {
      res.status(400).json({ error: "Maximum gift card amount is ৳50,000" });
      return;
    }

    let expiryDate: Date | null = null;
    if (expiryDays) {
      expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + Number(expiryDays));
    } else {
      // Default 1 year expiry
      expiryDate = new Date();
      expiryDate.setFullYear(expiryDate.getFullYear() + 1);
    }

    const code = generateCode();

    const [card] = await db
      .insert(giftCardsTable)
      .values({
        code,
        initialBalance: amountNum.toFixed(2),
        balance: amountNum.toFixed(2),
        purchasedByUserId: req.userId,
        recipientEmail: recipientEmail ?? null,
        recipientName: recipientName ?? null,
        message: message ?? null,
        expiryDate,
      })
      .returning();

    res.status(201).json(formatCard(card));
  } catch {
    res.status(500).json({ error: "Failed to create gift card" });
  }
});

// POST /gift-cards/redeem — apply to an order (called internally from orders route)
// Body: { code, amount, orderId, userId }
router.post("/gift-cards/redeem", requireAuth, async (req: any, res) => {
  try {
    const { code, amount } = req.body;
    const debitAmount = Number(amount);

    if (!code || isNaN(debitAmount) || debitAmount <= 0) {
      res.status(400).json({ error: "Valid code and amount required" });
      return;
    }

    const [card] = await db
      .select()
      .from(giftCardsTable)
      .where(eq(giftCardsTable.code, code.toUpperCase().trim()))
      .limit(1);

    if (!card || !card.isActive) {
      res.status(404).json({ error: "Gift card not found" });
      return;
    }
    if (card.expiryDate && card.expiryDate < new Date()) {
      res.status(400).json({ error: "Gift card has expired" });
      return;
    }

    const currentBalance = Number(card.balance);
    if (debitAmount > currentBalance) {
      res.status(400).json({ error: `Insufficient balance. Available: ৳${currentBalance}` });
      return;
    }

    const newBalance = currentBalance - debitAmount;

    await db
      .update(giftCardsTable)
      .set({
        balance: newBalance.toFixed(2),
        isActive: newBalance > 0,
        updatedAt: new Date(),
      })
      .where(eq(giftCardsTable.id, card.id));

    await db.insert(giftCardTransactionsTable).values({
      giftCardId: card.id,
      userId: req.userId,
      amount: (-debitAmount).toFixed(2),
      balanceAfter: newBalance.toFixed(2),
      note: "Order redemption",
    });

    res.json({ amountApplied: debitAmount, remainingBalance: newBalance });
  } catch {
    res.status(500).json({ error: "Failed to redeem gift card" });
  }
});

// Admin: issue gift card manually
router.post("/admin/gift-cards", requireAdmin, async (_req, res) => {
  try {
    const { amount, recipientEmail, recipientName, message } = (_req as any).body;
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      res.status(400).json({ error: "Valid amount required" });
      return;
    }

    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + 1);

    const [card] = await db
      .insert(giftCardsTable)
      .values({
        code: generateCode(),
        initialBalance: amountNum.toFixed(2),
        balance: amountNum.toFixed(2),
        recipientEmail: recipientEmail ?? null,
        recipientName: recipientName ?? null,
        message: message ?? null,
        expiryDate,
      })
      .returning();

    res.status(201).json(formatCard(card));
  } catch {
    res.status(500).json({ error: "Failed to issue gift card" });
  }
});

// Admin: list all gift cards
router.get("/admin/gift-cards", requireAdmin, async (_req, res) => {
  try {
    const cards = await db.select().from(giftCardsTable);
    res.json(cards.map(formatCard));
  } catch {
    res.status(500).json({ error: "Failed to fetch gift cards" });
  }
});

export default router;
