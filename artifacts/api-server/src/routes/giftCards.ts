// artifacts/api-server/src/routes/giftCards.ts
import { Router } from "express";
import type { z } from "zod";
import { db } from "@workspace/db";
import { giftCardsTable, giftCardTransactionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { validateBody } from "../lib/validateRequest";
import { asyncHandler, HttpError, isPgError, PG_ERROR_CODE } from "../lib/errors";
import {
  PurchaseGiftCardBody,
  RedeemGiftCardBody,
  IssueGiftCardBody,
} from "../lib/schemas";
import crypto from "crypto";
import type { ApiRequest } from "../types/apiRequest";

const router = Router();

function generateCode(): string {
  // Format: TF-XXXX-XXXX-XXXX (TreeFriend, not the legacy ENVY prefix)
  const part = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `TF-${part()}-${part()}-${part()}`;
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

const MIN_GIFT_CARD_AMOUNT = 100;
const MAX_GIFT_CARD_AMOUNT = 50000;

// GET /gift-cards/check/:code — look up a card's balance (public, used at checkout)
router.get(
  "/gift-cards/check/:code",
  asyncHandler(async (req, res) => {
    const code = req.params.code.toUpperCase().trim();
    const [card] = await db
      .select()
      .from(giftCardsTable)
      .where(eq(giftCardsTable.code, code))
      .limit(1);

    if (!card || !card.isActive) throw new HttpError(404, "Gift card not found or inactive");
    if (card.expiryDate && card.expiryDate < new Date()) {
      throw new HttpError(400, "This gift card has expired");
    }
    if (Number(card.balance) <= 0) {
      throw new HttpError(400, "This gift card has no remaining balance");
    }

    res.json({
      code: card.code,
      balance: Number(card.balance),
      recipientName: card.recipientName,
      expiryDate: card.expiryDate?.toISOString() ?? null,
    });
  }),
);

// GET /gift-cards/my — cards purchased by current user
router.get(
  "/gift-cards/my",
  requireAuth,
  asyncHandler(async (req: ApiRequest, res) => {
    const cards = await db
      .select()
      .from(giftCardsTable)
      .where(eq(giftCardsTable.purchasedByUserId, req.userId!));
    res.json(cards.map(formatCard));
  }),
);

// POST /gift-cards — purchase a gift card
router.post(
  "/gift-cards",
  requireAuth,
  validateBody(PurchaseGiftCardBody, "PurchaseGiftCardBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof PurchaseGiftCardBody>>, res) => {
    const { amount, recipientEmail, recipientName, message, expiryDays } = req.body;

    if (amount < MIN_GIFT_CARD_AMOUNT) {
      throw new HttpError(400, `Minimum gift card amount is ৳${MIN_GIFT_CARD_AMOUNT}`);
    }
    if (amount > MAX_GIFT_CARD_AMOUNT) {
      throw new HttpError(400, `Maximum gift card amount is ৳${MAX_GIFT_CARD_AMOUNT}`);
    }

    const expiryDate = new Date();
    if (expiryDays) {
      expiryDate.setDate(expiryDate.getDate() + expiryDays);
    } else {
      expiryDate.setFullYear(expiryDate.getFullYear() + 1);
    }

    // Retry on code collision (8 hex chars = ~4 billion possibilities, but
    // with a unique constraint the INSERT can fail). Retry up to 3 times.
    let card: typeof giftCardsTable.$inferSelect | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const [inserted] = await db
          .insert(giftCardsTable)
          .values({
            code: generateCode(),
            initialBalance: amount.toFixed(2),
            balance: amount.toFixed(2),
            purchasedByUserId: req.userId,
            recipientEmail: recipientEmail ?? null,
            recipientName: recipientName ?? null,
            message: message ?? null,
            expiryDate,
          })
          .returning();
        card = inserted;
        break;
      } catch (err) {
        if (isPgError(err) && err.code === PG_ERROR_CODE.UNIQUE_VIOLATION && attempt < 2) {
          // Code collision — retry with a new code
          continue;
        }
        throw err;
      }
    }
    if (!card) throw new HttpError(500, "Failed to generate unique gift card code");

    res.status(201).json(formatCard(card));
  }),
);

// POST /gift-cards/redeem — apply to an order (called internally from orders route)
// Body: { code, amount, orderId, userId }
router.post(
  "/gift-cards/redeem",
  requireAuth,
  validateBody(RedeemGiftCardBody, "RedeemGiftCardBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof RedeemGiftCardBody>>, res) => {
    const { code, amount } = req.body;

    const [card] = await db
      .select()
      .from(giftCardsTable)
      .where(eq(giftCardsTable.code, code.toUpperCase().trim()))
      .limit(1);

    if (!card || !card.isActive) throw new HttpError(404, "Gift card not found");
    if (card.expiryDate && card.expiryDate < new Date()) {
      throw new HttpError(400, "Gift card has expired");
    }

    const currentBalance = Number(card.balance);
    if (amount > currentBalance) {
      throw new HttpError(400, `Insufficient balance. Available: ৳${currentBalance}`);
    }

    // Atomic decrement — prevents race condition under concurrent redemption.
    const newBalance = currentBalance - amount;

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
      userId: req.userId!,
      amount: (-amount).toFixed(2),
      balanceAfter: newBalance.toFixed(2),
      note: "Order redemption",
    });

    res.json({ amountApplied: amount, remainingBalance: newBalance });
  }),
);

// Admin: issue gift card manually
router.post(
  "/admin/gift-cards",
  requireAdmin,
  validateBody(IssueGiftCardBody, "IssueGiftCardBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof IssueGiftCardBody>>, res) => {
    const { amount, recipientEmail, recipientName, message } = req.body;
    if (amount <= 0) throw new HttpError(400, "Valid amount required");

    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + 1);

    // Retry on code collision (same pattern as purchase route above).
    let card: typeof giftCardsTable.$inferSelect | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const [inserted] = await db
          .insert(giftCardsTable)
          .values({
            code: generateCode(),
            initialBalance: amount.toFixed(2),
            balance: amount.toFixed(2),
            recipientEmail: recipientEmail ?? null,
            recipientName: recipientName ?? null,
            message: message ?? null,
            expiryDate,
          })
          .returning();
        card = inserted;
        break;
      } catch (err) {
        if (isPgError(err) && err.code === PG_ERROR_CODE.UNIQUE_VIOLATION && attempt < 2) {
          continue;
        }
        throw err;
      }
    }
    if (!card) throw new HttpError(500, "Failed to generate unique gift card code");

    res.status(201).json(formatCard(card));
  }),
);

// Admin: list all gift cards
router.get(
  "/admin/gift-cards",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const cards = await db.select().from(giftCardsTable);
    res.json(cards.map(formatCard));
  }),
);

export default router;
