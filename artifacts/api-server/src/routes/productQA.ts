import { Router } from "express";
import { logger } from "../lib/logger";
import { db } from "@workspace/db";
import { productQATable, ordersTable, sellerListingsTable } from "@workspace/db";
import { eq, and, sql, desc, gt, isNull } from "drizzle-orm";
import { requireAuth, requireAdmin, requireSeller } from "../middlewares/auth";
import {
  CreateProductQuestionBody,
  CreateProductQuestionParams,
  CreateSellerListingQuestionBody,
  CreateSellerListingQuestionParams,
  AnswerSellerListingQuestionBody,
  AnswerSellerListingQuestionParams,
} from "@workspace/api-zod";
import { validateBody, validateParams } from "../lib/validateRequest";

const router = Router();

router.get("/products/:productId/qa", async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    if (isNaN(productId) || productId <= 0) {
      res.status(400).json({ error: "Invalid product ID" });
      return;
    }
    const questions = await db
      .select()
      .from(productQATable)
      .where(
        and(
          eq(productQATable.productId, productId),
          eq(productQATable.isPublished, true),
          // Product-level Q&A only -- excludes seller-listing questions,
          // which are fully separate (fetched via
          // GET /seller-listings/:sellerListingId/qa below) even though
          // they share this same table and carry the same productId.
          isNull(productQATable.sellerListingId),
        ),
      )
      .orderBy(productQATable.createdAt);

    res.json(
      questions.map((q) => ({
        id: q.id,
        userId: q.userId,
        userName: q.userName,
        question: q.question,
        answer: q.answer ?? null,
        answeredAt: q.answeredAt?.toISOString() ?? null,
        createdAt: q.createdAt.toISOString(),
      })),
    );
  } catch (err) {
    logger.error({ err }, "Route handler error");
    res.status(500).json({ error: "Failed to fetch Q&A" });
  }
});

router.post("/products/:productId/qa", requireAuth, validateParams(CreateProductQuestionParams, "CreateProductQuestionParams"), validateBody(CreateProductQuestionBody, "CreateProductQuestionBody"), async (req: any, res) => {
  try {
    const productId = req.params.productId;  // P0-1: validated + coerced to number
    const { question } = req.body;
    // P0-1: shape validated by Zod. Business rule: min 5 chars (semantic).
    if (!question || question.trim().length < 5) {
      res.status(400).json({ error: "Question must be at least 5 characters" });
      return;
    }
    if (question.trim().length > 500) {
      res.status(400).json({ error: "Question cannot exceed 500 characters" });
      return;
    }


    // 1-hour cooldown per user
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const [recentQ] = await db.select().from(productQATable)
      .where(and(eq(productQATable.userId, req.userId), gt(productQATable.createdAt, oneHourAgo)))
      .orderBy(desc(productQATable.createdAt)).limit(1);
    if (recentQ) {
      const waitMin = Math.ceil((recentQ.createdAt.getTime() + 3600000 - Date.now()) / 60000);
      res.status(429).json({ error: `You can ask another question in ${waitMin} minute${waitMin !== 1 ? "s" : ""}.` });
      return;
    }
    const dbUser = req.dbUser;
    const userName =
      `${dbUser?.firstName ?? ""} ${dbUser?.lastName ?? ""}`.trim() ||
      "Customer";

    const [qa] = await db
      .insert(productQATable)
      .values({
        productId,
        userId: req.userId,
        userName,
        question: question.trim(),
      })
      .returning();

    res.status(201).json({
      id: qa.id,
      userId: qa.userId,
      userName: qa.userName,
      question: qa.question,
      answer: null,
      answeredAt: null,
      createdAt: qa.createdAt.toISOString(),
    });
  } catch (err) {
    logger.error({ err }, "Route handler error");
    res.status(500).json({ error: "Failed to post question" });
  }
});

// ─── Seller-listing Q&A ─────────────────────────────────────────────────────
// Fully separate question list from product-level Q&A above (per product
// decision), scoped to one seller's listing and answered by that listing's
// OWNING seller (or an admin) rather than admin-only. Shares the same
// productQATable and the same 1-hour ask-cooldown as product Q&A (a single
// per-user cooldown across both kinds is intentional -- it's an anti-spam
// measure, not a per-surface quota).

router.get("/seller-listings/:sellerListingId/qa", async (req, res) => {
  try {
    const sellerListingId = parseInt(req.params.sellerListingId);
    if (isNaN(sellerListingId) || sellerListingId <= 0) {
      res.status(400).json({ error: "Invalid seller listing ID" });
      return;
    }
    const questions = await db
      .select()
      .from(productQATable)
      .where(
        and(
          eq(productQATable.sellerListingId, sellerListingId),
          eq(productQATable.isPublished, true),
        ),
      )
      .orderBy(productQATable.createdAt);

    res.json(
      questions.map((q) => ({
        id: q.id,
        userId: q.userId,
        userName: q.userName,
        question: q.question,
        answer: q.answer ?? null,
        answeredAt: q.answeredAt?.toISOString() ?? null,
        createdAt: q.createdAt.toISOString(),
      })),
    );
  } catch (err) {
    logger.error({ err }, "Route handler error");
    res.status(500).json({ error: "Failed to fetch Q&A" });
  }
});

router.post("/seller-listings/:sellerListingId/qa", requireAuth, validateParams(CreateSellerListingQuestionParams, "CreateSellerListingQuestionParams"), validateBody(CreateSellerListingQuestionBody, "CreateSellerListingQuestionBody"), async (req: any, res) => {
  try {
    const sellerListingId = req.params.sellerListingId;  // P0-1: validated + coerced
    const { question } = req.body;
    if (!question || question.trim().length < 5) {
      res.status(400).json({ error: "Question must be at least 5 characters" });
      return;
    }
    const [listing] = await db.select().from(sellerListingsTable).where(eq(sellerListingsTable.id, sellerListingId));
    if (!listing) {
      res.status(404).json({ error: "Listing not found" });
      return;
    }
    if (question.trim().length > 500) {
      res.status(400).json({ error: "Question cannot exceed 500 characters" });
      return;
    }

    // Same 1-hour cooldown as product Q&A, checked across ALL of this
    // user's questions (product- and listing-scoped alike) -- see comment
    // above the "Seller-listing Q&A" section header.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const [recentQ] = await db.select().from(productQATable)
      .where(and(eq(productQATable.userId, req.userId), gt(productQATable.createdAt, oneHourAgo)))
      .orderBy(desc(productQATable.createdAt)).limit(1);
    if (recentQ) {
      const waitMin = Math.ceil((recentQ.createdAt.getTime() + 3600000 - Date.now()) / 60000);
      res.status(429).json({ error: `You can ask another question in ${waitMin} minute${waitMin !== 1 ? "s" : ""}.` });
      return;
    }
    const dbUser = req.dbUser;
    const userName =
      `${dbUser?.firstName ?? ""} ${dbUser?.lastName ?? ""}`.trim() ||
      "Customer";

    const [qa] = await db
      .insert(productQATable)
      .values({
        productId: listing.productId,
        sellerListingId,
        sellerId: listing.sellerId,
        userId: req.userId,
        userName,
        question: question.trim(),
      })
      .returning();

    res.status(201).json({
      id: qa.id,
      userId: qa.userId,
      userName: qa.userName,
      question: qa.question,
      answer: null,
      answeredAt: null,
      createdAt: qa.createdAt.toISOString(),
    });
  } catch (err) {
    logger.error({ err }, "Route handler error");
    res.status(500).json({ error: "Failed to post question" });
  }
});

// Seller answers a question on their OWN listing. requireSeller attaches
// req.dbSeller (an active seller row); the ownership check below is what
// actually stops a seller answering on someone else's listing -- being
// merely "a seller" isn't enough.
router.put("/seller/qa/:id/answer", requireSeller, validateParams(AnswerSellerListingQuestionParams, "AnswerSellerListingQuestionParams"), validateBody(AnswerSellerListingQuestionBody, "AnswerSellerListingQuestionBody"), async (req: any, res) => {
  try {
    const id = req.params.id;  // P0-1: validated + coerced to number
    const { answer } = req.body;
    if (!answer || answer.trim().length < 2) {
      res.status(400).json({ error: "Answer is required" });
      return;
    }
    if (answer.trim().length > 1000) {
      res.status(400).json({ error: "Answer cannot exceed 1000 characters" });
      return;
    }

    const [existing] = await db.select().from(productQATable).where(eq(productQATable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Question not found" });
      return;
    }
    if (existing.sellerId !== req.dbSeller.id) {
      res.status(403).json({ error: "You can only answer questions on your own listings" });
      return;
    }

    const [qa] = await db
      .update(productQATable)
      .set({ answer: answer.trim(), answeredAt: new Date() })
      .where(eq(productQATable.id, id))
      .returning();

    res.json({
      id: qa.id,
      userId: qa.userId,
      userName: qa.userName,
      question: qa.question,
      answer: qa.answer,
      answeredAt: qa.answeredAt?.toISOString() ?? null,
      createdAt: qa.createdAt.toISOString(),
    });
  } catch (err) {
    logger.error({ err }, "Route handler error");
    res.status(500).json({ error: "Failed to post answer" });
  }
});

router.put("/admin/qa/:id/answer", requireAdmin, validateParams(AnswerSellerListingQuestionParams, "AnswerSellerListingQuestionParams"), validateBody(AnswerSellerListingQuestionBody, "AnswerSellerListingQuestionBody"), async (req: any, res) => {
  try {
    const id = req.params.id;  // P0-1: validated + coerced to number
    const { answer } = req.body;
    if (!answer || answer.trim().length < 2) {
      res.status(400).json({ error: "Answer is required" });
      return;
    }
    if (answer.trim().length > 1000) {
      res.status(400).json({ error: "Answer cannot exceed 1000 characters" });
      return;
    }

    const [qa] = await db
      .update(productQATable)
      .set({ answer: answer.trim(), answeredAt: new Date() })
      .where(eq(productQATable.id, id))
      .returning();

    if (!qa) {
      res.status(404).json({ error: "Question not found" });
      return;
    }
    res.json(qa);
  } catch (err) {
    logger.error({ err }, "Route handler error");
    res.status(500).json({ error: "Failed to post answer" });
  }
});

router.delete("/admin/qa/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid Q&A ID" });
      return;
    }
    await db.delete(productQATable).where(eq(productQATable.id, id));
    res.json({ message: "Deleted" });
  } catch (err) {
    logger.error({ err }, "Route handler error");
    res.status(500).json({ error: "Failed to delete question" });
  }
});

router.get("/admin/qa/unanswered", requireAdmin, async (_req, res) => {
  try {
    const questions = await db
      .select()
      .from(productQATable)
      .where(sql`answer IS NULL`)
      .orderBy(productQATable.createdAt);
    res.json(questions);
  } catch (err) {
    logger.error({ err }, "Route handler error");
    res.status(500).json({ error: "Failed to fetch questions" });
  }
});

export default router;
