import { Router } from "express";
import { db } from "@workspace/db";
import { productQATable, ordersTable } from "@workspace/db";
import { eq, and, sql, desc, gt } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";

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
  } catch {
    res.status(500).json({ error: "Failed to fetch Q&A" });
  }
});

router.post("/products/:productId/qa", requireAuth, async (req: any, res) => {
  try {
    const productId = parseInt(req.params.productId);
    if (isNaN(productId) || productId <= 0) {
      res.status(400).json({ error: "Invalid product ID" });
      return;
    }
    const { question } = req.body;
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
      question: qa.question,
      answer: null,
      createdAt: qa.createdAt.toISOString(),
    });
  } catch {
    res.status(500).json({ error: "Failed to post question" });
  }
});

router.put("/admin/qa/:id/answer", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid Q&A ID" });
      return;
    }
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
  } catch {
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
  } catch {
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
  } catch {
    res.status(500).json({ error: "Failed to fetch questions" });
  }
});

export default router;
