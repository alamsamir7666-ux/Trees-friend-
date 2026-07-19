// artifacts/api-server/src/routes/reviews.ts
// REPLACES existing reviews.ts — adds photo upload via Cloudinary + order timeline
// Also adds GET /orders/:id/timeline PATCH for admins to push status events.

import { Router } from "express";
import { db } from "@workspace/db";
import { reviewsTable, ordersTable, productsTable } from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";

// ─── Cloudinary config (add to .env.example too) ──────────────────────────
// CLOUDINARY_CLOUD_NAME=your_cloud
// CLOUDINARY_API_KEY=your_key
// CLOUDINARY_API_SECRET=your_secret
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// multer: store in memory (we stream straight to Cloudinary)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 4 }, // 8MB per file, max 4 photos
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are allowed"));
      return;
    }
    cb(null, true);
  },
});

async function uploadToCloudinary(buffer: Buffer, folder: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image", quality: "auto", fetch_format: "auto" },
      (err, result) => {
        if (err || !result) return reject(err ?? new Error("Upload failed"));
        resolve(result.secure_url);
      },
    );
    stream.end(buffer);
  });
}

const router = Router();

function formatReview(r: typeof reviewsTable.$inferSelect) {
  return {
    id: r.id,
    productId: r.productId,
    userId: r.userId,
    userName: r.userName,
    rating: r.rating,
    comment: r.comment,
    photos: (r as any).photos ?? [],  // new field from migration
    createdAt: r.createdAt.toISOString(),
  };
}

router.get("/reviews/:productId", async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    if (isNaN(productId) || productId <= 0) {
      res.status(400).json({ error: "Invalid product ID" }); return;
    }
    const reviews = await db
      .select()
      .from(reviewsTable)
      .where(eq(reviewsTable.productId, productId))
      .orderBy(desc(reviewsTable.createdAt));
    res.json(reviews.map(formatReview));
  } catch { res.status(500).json({ error: "Failed to fetch reviews" }); }
});

router.get("/reviews/:productId/eligibility", requireAuth, async (req: any, res) => {
  try {
    const productId = parseInt(req.params.productId);
    if (isNaN(productId) || productId <= 0) {
      res.status(400).json({ error: "Invalid product ID" }); return;
    }
    const userId = req.userId as string;
    const [existing] = await db
      .select({ id: reviewsTable.id })
      .from(reviewsTable)
      .where(and(eq(reviewsTable.productId, productId), eq(reviewsTable.userId, userId)))
      .limit(1);
    if (existing) { res.json({ canReview: false, reason: "already_reviewed" }); return; }

    const orders = await db
      .select({ id: ordersTable.id, items: ordersTable.items, orderStatus: ordersTable.orderStatus })
      .from(ordersTable)
      .where(and(eq(ordersTable.userId, userId), sql`order_status NOT IN ('cancelled')`));

    const hasPurchased = orders.some((o) =>
      (o.items as any[]).some((item: any) => item.productId === productId),
    );
    if (!hasPurchased) { res.json({ canReview: false, reason: "not_purchased" }); return; }
    res.json({ canReview: true, reason: null });
  } catch { res.status(500).json({ error: "Failed to check eligibility" }); }
});

// POST /reviews/:productId — with optional photo uploads
// Frontend sends multipart/form-data: rating, comment, photos[]
router.post(
  "/reviews/:productId",
  requireAuth,
  upload.array("photos", 4),
  async (req: any, res) => {
    try {
      const productId = parseInt(req.params.productId);
      if (isNaN(productId) || productId <= 0) {
        res.status(400).json({ error: "Invalid product ID" }); return;
      }

      const { rating, comment } = req.body;
      const userId = req.userId as string;

      const ratingNum = Number(rating);
      if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
        res.status(400).json({ error: "Rating must be between 1 and 5" }); return;
      }
      if (!comment || typeof comment !== "string" || comment.trim().length < 5) {
        res.status(400).json({ error: "Comment must be at least 5 characters" }); return;
      }
      if (comment.trim().length > 1000) {
        res.status(400).json({ error: "Comment cannot exceed 1000 characters" }); return;
      }

      // Duplicate check
      const [existing] = await db
        .select({ id: reviewsTable.id })
        .from(reviewsTable)
        .where(and(eq(reviewsTable.productId, productId), eq(reviewsTable.userId, userId)))
        .limit(1);
      if (existing) { res.status(409).json({ error: "You have already reviewed this product" }); return; }

      // Purchase check
      const orders = await db
        .select({ id: ordersTable.id, items: ordersTable.items })
        .from(ordersTable)
        .where(and(eq(ordersTable.userId, userId), sql`order_status NOT IN ('cancelled')`));
      const hasPurchased = orders.some((o) =>
        (o.items as any[]).some((item: any) => item.productId === productId),
      );
      if (!hasPurchased) {
        res.status(403).json({ error: "You must purchase this product before writing a review" }); return;
      }

      // Upload photos to Cloudinary (parallel)
      const files = (req.files ?? []) as Express.Multer.File[];
      let photoUrls: string[] = [];
      if (files.length > 0) {
        photoUrls = await Promise.all(
          files.map((f) => uploadToCloudinary(f.buffer, `envy-reviews/${productId}`)),
        );
      }

      const dbUser = req.dbUser;
      const fullName = `${dbUser?.firstName ?? ""} ${dbUser?.lastName ?? ""}`.trim();
      const userName = fullName || (dbUser?.email ? dbUser.email.split("@")[0] : "Customer");

      const [review] = await db
        .insert(reviewsTable)
        .values({
          productId,
          userId,
          userName,
          rating: Math.round(ratingNum),
          comment: comment.trim(),
          // Cast needed because the column is added via migration, not in Drizzle schema yet
          ...(photoUrls.length > 0 ? { photos: photoUrls } : {}),
        } as any)
        .returning();

      res.status(201).json(formatReview(review));
    } catch (err) {
      console.error("Review submit error:", err);
      res.status(500).json({ error: "Failed to submit review" });
    }
  },
);

router.put("/reviews/:reviewId", requireAuth, async (req: any, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);
    if (isNaN(reviewId) || reviewId <= 0) {
      res.status(400).json({ error: "Invalid review ID" }); return;
    }
    const { rating, comment } = req.body;
    const ratingNum = Number(rating);
    if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      res.status(400).json({ error: "Rating must be between 1 and 5" }); return;
    }
    if (!comment || typeof comment !== "string" || comment.trim().length < 5) {
      res.status(400).json({ error: "Comment must be at least 5 characters" }); return;
    }
    const [review] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, reviewId)).limit(1);
    if (!review) { res.status(404).json({ error: "Not found" }); return; }
    if (review.userId !== req.userId) { res.status(403).json({ error: "Forbidden" }); return; }
    const [updated] = await db
      .update(reviewsTable)
      .set({ rating: Math.round(ratingNum), comment: comment.trim() })
      .where(eq(reviewsTable.id, reviewId))
      .returning();
    res.json(formatReview(updated));
  } catch { res.status(500).json({ error: "Failed to update review" }); }
});

router.delete("/reviews/:productId/:reviewId", requireAuth, async (req: any, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);
    if (isNaN(reviewId) || reviewId <= 0) {
      res.status(400).json({ error: "Invalid review ID" }); return;
    }
    const [review] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, reviewId)).limit(1);
    if (!review) { res.status(404).json({ error: "Not found" }); return; }
    if (review.userId !== req.userId && req.dbUser?.role !== "admin") {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    await db.delete(reviewsTable).where(eq(reviewsTable.id, reviewId));
    res.json({ message: "Review deleted" });
  } catch { res.status(500).json({ error: "Failed to delete review" }); }
});

router.get("/admin/reviews", requireAdmin, async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: reviewsTable.id,
        productId: reviewsTable.productId,
        userId: reviewsTable.userId,
        userName: reviewsTable.userName,
        rating: reviewsTable.rating,
        comment: reviewsTable.comment,
        createdAt: reviewsTable.createdAt,
        productName: productsTable.name,
        productImage: sql<string>`${productsTable.images}->>0`,
      })
      .from(reviewsTable)
      .leftJoin(productsTable, eq(reviewsTable.productId, productsTable.id))
      .orderBy(desc(reviewsTable.createdAt));

    res.json(
      rows.map((r) => ({
        id: r.id, productId: r.productId, userId: r.userId, userName: r.userName,
        rating: r.rating, comment: r.comment, createdAt: r.createdAt.toISOString(),
        productName: r.productName ?? "Unknown", productImage: r.productImage ?? null,
      })),
    );
  } catch { res.status(500).json({ error: "Failed to fetch reviews" }); }
});

// ─── Order status timeline ────────────────────────────────────────────────────
// Admin: push a new timeline event to an order
router.post("/admin/orders/:id/timeline", requireAdmin, async (req: any, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { status, note } = req.body;

    const validStatuses = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: "Invalid status" }); return;
    }

    const [order] = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .limit(1);
    if (!order) { res.status(404).json({ error: "Order not found" }); return; }

    const existing = ((order as any).statusTimeline ?? []) as any[];
    const newEvent = { status, note: note ?? null, timestamp: new Date().toISOString() };
    const timeline = [...existing, newEvent];

    await db
      .update(ordersTable)
      .set({
        orderStatus: status,
        statusTimeline: timeline,
        updatedAt: new Date(),
      } as any)
      .where(eq(ordersTable.id, orderId));

    res.json({ timeline });
  } catch { res.status(500).json({ error: "Failed to update order timeline" }); }
});

export default router;

// ─── Install multer + cloudinary ─────────────────────────────────────────────
// cd artifacts/api-server && npm install multer cloudinary @types/multer
//
// Add to .env:
// CLOUDINARY_CLOUD_NAME=your_cloud
// CLOUDINARY_API_KEY=your_key
// CLOUDINARY_API_SECRET=your_secret
