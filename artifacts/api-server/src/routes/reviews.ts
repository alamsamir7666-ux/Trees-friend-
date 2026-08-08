// artifacts/api-server/src/routes/reviews.ts
// REPLACES existing reviews.ts — adds photo upload via Cloudinary + order timeline
// Also adds GET /orders/:id/timeline PATCH for admins to push status events.

import { Router } from "express";
import { db } from "@workspace/db";
import { reviewsTable, ordersTable, productsTable, sellerListingsTable, sellerListingVariantsTable, sellersTable } from "@workspace/db";
import { eq, and, sql, desc, isNull } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { deleteCloudinaryAssets } from "../lib/cloudinary";
import { UpdateReviewBody, UpdateReviewParams, DeleteReviewParams } from "@workspace/api-zod";
import { validateBody, validateParams } from "../lib/validateRequest";
import type { ApiRequest } from "../types/apiRequest";
import type { z } from "zod";

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
    photos: r.photos,
    createdAt: r.createdAt.toISOString(),
  };
}

router.get("/reviews/:productId", async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    if (isNaN(productId) || productId <= 0) {
      res.status(400).json({ error: "Invalid product ID" }); return;
    }
    // Only show product-level reviews (sellerListingId IS NULL).
    // Seller-listing-variant reviews (sellerListingId set) belong on the
    // seller listing detail page, not here — same isNull filter pattern
    // used in productQA.ts for the same reason.
    const reviews = await db
      .select()
      .from(reviewsTable)
      .where(and(eq(reviewsTable.productId, productId), isNull(reviewsTable.sellerListingId)))
      .orderBy(desc(reviewsTable.createdAt));
    res.json(reviews.map(formatReview));
  } catch (err) { logger.error({ err }, "Route handler error"); res.status(500).json({ error: "Failed to fetch reviews" }); }
});

router.get("/reviews/:productId/eligibility", requireAuth, async (req: ApiRequest, res) => {
  try {
    const productId = parseInt(req.params.productId);
    if (isNaN(productId) || productId <= 0) {
      res.status(400).json({ error: "Invalid product ID" }); return;
    }
    const userId = req.userId! as string;
    // Only check product-level reviews (sellerListingId IS NULL) so that a
    // seller-listing-variant review doesn't block the user from writing a
    // separate product-level review — same isNull filter as GET /reviews/:productId.
    const [existing] = await db
      .select({ id: reviewsTable.id })
      .from(reviewsTable)
      .where(and(eq(reviewsTable.productId, productId), eq(reviewsTable.userId, userId), isNull(reviewsTable.sellerListingId)))
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
  } catch (err) { logger.error({ err }, "Route handler error"); res.status(500).json({ error: "Failed to check eligibility" }); }
});

// POST /reviews/:productId — with optional photo uploads
// Frontend sends multipart/form-data: rating, comment, photos[]
router.post(
  "/reviews/:productId",
  requireAuth,
  upload.array("photos", 4),
  async (req: ApiRequest, res) => {
    try {
      const productId = parseInt(req.params.productId);
      if (isNaN(productId) || productId <= 0) {
        res.status(400).json({ error: "Invalid product ID" }); return;
      }

      const { rating, comment } = req.body as { rating?: string; comment?: string };
      const userId = req.userId! as string;

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

      // Duplicate check — only product-level reviews (sellerListingId IS NULL).
      // A seller-listing-variant review should not block writing a product-level
      // review, since they are different scopes (same isNull pattern as the
      // GET eligibility and list routes above).
      const [existing] = await db
        .select({ id: reviewsTable.id })
        .from(reviewsTable)
        .where(and(eq(reviewsTable.productId, productId), eq(reviewsTable.userId, userId), isNull(reviewsTable.sellerListingId)))
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
          photos: photoUrls,
        })
        .returning();

      res.status(201).json(formatReview(review));
    } catch (err) {
      logger.error({ err: err }, "Review submit error");
      res.status(500).json({ error: "Failed to submit review" });
    }
  },
);

// ─── Seller-listing reviews ────────────────────────────────────────────────
// Fully separate from the product-level reviews above (per product decision):
// a listing review only shows on that seller's listing page, keyed by
// sellerListingId, not productId. "Verified purchaser" here means the buyer
// bought THIS seller's listing specifically (order items[].sellerListingId
// match), not just the product from any seller -- see orders.ts's OrderItem
// type, which records sellerListingId per line but not the variant, so
// eligibility is listing-scoped rather than variant-scoped (the data can't
// distinguish which variant of a listing was purchased).

function formatSellerListingReview(r: typeof reviewsTable.$inferSelect) {
  return {
    id: r.id,
    sellerListingId: r.sellerListingId,
    sellerListingVariantId: r.sellerListingVariantId,
    productId: r.productId,
    userId: r.userId,
    userName: r.userName,
    rating: r.rating,
    comment: r.comment,
    photos: r.photos,
    createdAt: r.createdAt.toISOString(),
  };
}

router.get("/seller-listings/:sellerListingId/reviews", async (req, res) => {
  try {
    const sellerListingId = parseInt(req.params.sellerListingId);
    if (isNaN(sellerListingId) || sellerListingId <= 0) {
      res.status(400).json({ error: "Invalid seller listing ID" }); return;
    }
    const reviews = await db
      .select()
      .from(reviewsTable)
      .where(eq(reviewsTable.sellerListingId, sellerListingId))
      .orderBy(desc(reviewsTable.createdAt));
    res.json(reviews.map(formatSellerListingReview));
  } catch (err) { logger.error({ err }, "Route handler error"); res.status(500).json({ error: "Failed to fetch reviews" }); }
});

router.get("/seller-listings/:sellerListingId/reviews/eligibility", requireAuth, async (req: ApiRequest, res) => {
  try {
    const sellerListingId = parseInt(req.params.sellerListingId);
    const sellerListingVariantId = parseInt(req.query.variantId as string);
    if (isNaN(sellerListingId) || sellerListingId <= 0) {
      res.status(400).json({ error: "Invalid seller listing ID" }); return;
    }
    if (isNaN(sellerListingVariantId) || sellerListingVariantId <= 0) {
      res.status(400).json({ error: "variantId query param is required" }); return;
    }
    const userId = req.userId! as string;
    // Reviews attach to the exact VARIANT a buyer purchased (schema doc
    // comment on reviewsTable, Phase 2) -- a buyer can separately review
    // each variant of a seller's listing they've bought (e.g. Sapling AND
    // Grafted from the same seller are different purchase experiences), so
    // both the duplicate check and the purchase check below are keyed on
    // sellerListingVariantId, matching reviewsTable's own unique constraint
    // (sellerListingVariantId, userId), not sellerListingId.
    const [existing] = await db
      .select({ id: reviewsTable.id })
      .from(reviewsTable)
      .where(and(eq(reviewsTable.sellerListingVariantId, sellerListingVariantId), eq(reviewsTable.userId, userId)))
      .limit(1);
    if (existing) { res.json({ canReview: false, reason: "already_reviewed" }); return; }

    const orders = await db
      .select({ id: ordersTable.id, items: ordersTable.items, orderStatus: ordersTable.orderStatus })
      .from(ordersTable)
      .where(and(eq(ordersTable.userId, userId), sql`order_status NOT IN ('cancelled')`));

    const hasPurchased = orders.some((o) =>
      (o.items as any[]).some((item: any) => item.sellerListingVariantId === sellerListingVariantId),
    );
    if (!hasPurchased) { res.json({ canReview: false, reason: "not_purchased" }); return; }
    res.json({ canReview: true, reason: null });
  } catch (err) { logger.error({ err }, "Route handler error"); res.status(500).json({ error: "Failed to check eligibility" }); }
});

router.post(
  "/seller-listings/:sellerListingId/reviews",
  requireAuth,
  upload.array("photos", 4),
  async (req: ApiRequest, res) => {
    try {
      const sellerListingId = parseInt(req.params.sellerListingId);
      if (isNaN(sellerListingId) || sellerListingId <= 0) {
        res.status(400).json({ error: "Invalid seller listing ID" }); return;
      }

      const [listing] = await db.select().from(sellerListingsTable).where(eq(sellerListingsTable.id, sellerListingId));
      if (!listing) { res.status(404).json({ error: "Listing not found" }); return; }

      const { rating, comment, sellerListingVariantId: rawVariantId } = req.body as { rating?: string; comment?: string; sellerListingVariantId?: string };
      const sellerListingVariantId = parseInt(rawVariantId ?? "");
      if (isNaN(sellerListingVariantId) || sellerListingVariantId <= 0) {
        res.status(400).json({ error: "sellerListingVariantId is required" }); return;
      }
      const [variant] = await db.select().from(sellerListingVariantsTable).where(eq(sellerListingVariantsTable.id, sellerListingVariantId));
      if (!variant || variant.sellerListingId !== sellerListingId) {
        res.status(400).json({ error: "Variant does not belong to this listing" }); return;
      }

      const userId = req.userId! as string;

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

      // Same variant-exact scoping as the eligibility route above -- see
      // its comment for why this is keyed on sellerListingVariantId rather
      // than sellerListingId.
      const [existing] = await db
        .select({ id: reviewsTable.id })
        .from(reviewsTable)
        .where(and(eq(reviewsTable.sellerListingVariantId, sellerListingVariantId), eq(reviewsTable.userId, userId)))
        .limit(1);
      if (existing) { res.status(409).json({ error: "You have already reviewed this variant" }); return; }

      const orders = await db
        .select({ id: ordersTable.id, items: ordersTable.items })
        .from(ordersTable)
        .where(and(eq(ordersTable.userId, userId), sql`order_status NOT IN ('cancelled')`));
      const hasPurchased = orders.some((o) =>
        (o.items as any[]).some((item: any) => item.sellerListingVariantId === sellerListingVariantId),
      );
      if (!hasPurchased) {
        res.status(403).json({ error: "You must purchase this exact variant before writing a review" }); return;
      }

      const files = (req.files ?? []) as Express.Multer.File[];
      let photoUrls: string[] = [];
      if (files.length > 0) {
        photoUrls = await Promise.all(
          files.map((f) => uploadToCloudinary(f.buffer, `envy-reviews/listing-${sellerListingId}`)),
        );
      }

      const dbUser = req.dbUser;
      const fullName = `${dbUser?.firstName ?? ""} ${dbUser?.lastName ?? ""}`.trim();
      const userName = fullName || (dbUser?.email ? dbUser.email.split("@")[0] : "Customer");

      const [review] = await db
        .insert(reviewsTable)
        .values({
          productId: listing.productId,
          sellerId: listing.sellerId,
          sellerListingId,
          sellerListingVariantId,
          userId,
          userName,
          rating: Math.round(ratingNum),
          comment: comment.trim(),
          photos: photoUrls,
        })
        .returning();

      res.status(201).json(formatSellerListingReview(review));
    } catch (err) {
      logger.error({ err: err }, "Seller listing review submit error");
      res.status(500).json({ error: "Failed to submit review" });
    }
  },
);

// PUT /reviews/:reviewId and DELETE /reviews/:productId/:reviewId (below)
// are shared -- they operate on the review row by id/ownership and don't
// care whether it's a product-level or seller-listing-level review, so no
// separate edit/delete endpoints are needed here.

router.put("/reviews/:reviewId", requireAuth, validateParams(UpdateReviewParams, "UpdateReviewParams"), validateBody(UpdateReviewBody, "UpdateReviewBody"), async (req: ApiRequest<z.infer<typeof UpdateReviewBody>>, res) => {
  try {
    const reviewId = req.params.reviewId as unknown as number;  // P0-1: validated + coerced to number
    const { rating, comment } = req.body;
    const ratingNum = Number(rating);
    // P0-1: shape validated by Zod (UpdateReviewBody). Business rule below
    // enforces the 1-5 range (Zod schema allows any number; the DB CHECK
    // constraint at reviews.ts:103 also enforces 1-5 as defense-in-depth).
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
  } catch (err) { logger.error({ err }, "Route handler error"); res.status(500).json({ error: "Failed to update review" }); }
});

router.delete("/reviews/:productId/:reviewId", requireAuth, validateParams(DeleteReviewParams, "DeleteReviewParams"), async (req: ApiRequest, res) => {
  try {
    const reviewId = req.params.reviewId as unknown as number;  // P0-1: validated + coerced to number
    const [review] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, reviewId)).limit(1);
    if (!review) { res.status(404).json({ error: "Not found" }); return; }
    if (review.userId !== req.userId && req.dbUser?.role !== "admin") {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    await db.delete(reviewsTable).where(eq(reviewsTable.id, reviewId));

    // Best-effort Cloudinary cleanup after the DB delete succeeds. `review`
    // (fetched above, before the delete) still has its photos[] array.
    // Never blocks/fails the response -- the review is already gone either
    // way; failures are logged for a manual/retry pass instead.
    if (review.photos?.length) {
      deleteCloudinaryAssets(review.photos).catch(() => {});
    }

    res.json({ message: "Review deleted" });
  } catch (err) { logger.error({ err }, "Route handler error"); res.status(500).json({ error: "Failed to delete review" }); }
});

router.get("/admin/reviews", requireAdmin, async (_req, res) => {
  try {
    // Join reviews -> sellerListingVariants -> sellerListings -> sellers so the
    // admin Reviews tab can show what each review actually targets:
    //
    //   - Product-level review        (sellerListingVariantId IS NULL)
    //     -> "Review for product X"
    //
    //   - Seller-listing-variant revw (sellerListingVariantId NOT NULL)
    //     -> "Review for variant V of seller S's listing L on product X"
    //
    // All joins are LEFT because product-level reviews don't have a variant /
    // listing / seller. The schema also allows sellerListingId to be set
    // while sellerListingVariantId is null (Phase-1 marketplace rows); we
    // expose both fields separately so the UI can show the most specific
    // target that exists for each row.
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

        // Review target fields — all nullable; null = product-level review.
        sellerId: reviewsTable.sellerId,
        sellerListingId: reviewsTable.sellerListingId,
        sellerListingVariantId: reviewsTable.sellerListingVariantId,

        // Seller identity (for variant reviews).
        sellerBusinessName: sellersTable.businessName,
        sellerNurseryName: sellersTable.nurseryName,
        sellerLogoUrl: sellersTable.logoUrl,

        // Listing identity (variant reviews may also have a listing id
        // denormalized on the review row; sellerListingId above is the same
        // value but kept separate for clarity when no join hit happened).
        sellerListingDescription: sellerListingsTable.description,

        // Variant identity — form is the most useful single discriminator
        // for a variant ("Sapling" vs "Grafted" vs "Potted"), and the other
        // comparison-critical fields (potSize, age, height, rootType) are
        // included so the admin can see exactly what the customer bought.
        sellerListingVariantForm: sellerListingVariantsTable.form,
        sellerListingVariantPotSize: sellerListingVariantsTable.potSize,
        sellerListingVariantAge: sellerListingVariantsTable.age,
        sellerListingVariantHeight: sellerListingVariantsTable.height,
        sellerListingVariantRootType: sellerListingVariantsTable.rootType,
        sellerListingVariantCondition: sellerListingVariantsTable.condition,
      })
      .from(reviewsTable)
      .leftJoin(productsTable, eq(reviewsTable.productId, productsTable.id))
      .leftJoin(sellerListingVariantsTable, eq(reviewsTable.sellerListingVariantId, sellerListingVariantsTable.id))
      .leftJoin(sellerListingsTable, eq(reviewsTable.sellerListingId, sellerListingsTable.id))
      .leftJoin(sellersTable, eq(reviewsTable.sellerId, sellersTable.id))
      .orderBy(desc(reviewsTable.createdAt));

    res.json(
      rows.map((r) => ({
        id: r.id,
        productId: r.productId,
        userId: r.userId,
        userName: r.userName,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),

        productName: r.productName ?? "Unknown",
        productImage: r.productImage ?? null,

        // Review target. sellerListingVariantId is the discriminator: when
        // present, this is a variant review; when null, it's a product-level
        // review (legacy / pre-marketplace / admin-direct).
        sellerId: r.sellerId ?? null,
        sellerListingId: r.sellerListingId ?? null,
        sellerListingVariantId: r.sellerListingVariantId ?? null,

        // Seller fields — present iff sellerId is set.
        sellerBusinessName: r.sellerBusinessName ?? null,
        sellerNurseryName: r.sellerNurseryName ?? null,
        sellerLogoUrl: r.sellerLogoUrl ?? null,

        // Variant fields — present iff sellerListingVariantId is set.
        sellerListingVariantForm: r.sellerListingVariantForm ?? null,
        sellerListingVariantPotSize: r.sellerListingVariantPotSize ?? null,
        sellerListingVariantAge: r.sellerListingVariantAge ?? null,
        sellerListingVariantHeight: r.sellerListingVariantHeight ?? null,
        sellerListingVariantRootType: r.sellerListingVariantRootType ?? null,
        sellerListingVariantCondition: r.sellerListingVariantCondition ?? null,
      })),
    );
  } catch (err) { logger.error({ err }, "Route handler error"); res.status(500).json({ error: "Failed to fetch reviews" }); }
});

// ─── Order status timeline ────────────────────────────────────────────────────
// Admin: push a new timeline event to an order
router.post("/admin/orders/:id/timeline", requireAdmin, async (req: ApiRequest, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { status, note } = req.body as { status?: string; note?: string };

    const validStatuses = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];
    if (!status || !validStatuses.includes(status)) {
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
  } catch (err) { logger.error({ err }, "Route handler error"); res.status(500).json({ error: "Failed to update order timeline" }); }
});
import { logger } from "../lib/logger";

export default router;

// ─── Install multer + cloudinary ─────────────────────────────────────────────
// cd artifacts/api-server && npm install multer cloudinary @types/multer
//
// Add to .env:
// CLOUDINARY_CLOUD_NAME=your_cloud
// CLOUDINARY_API_KEY=your_key
// CLOUDINARY_API_SECRET=your_secret
