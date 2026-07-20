import { Router } from "express";
import multerPkg from "multer";
import { v2 as cloudinaryV2 } from "cloudinary";
import { db } from "@workspace/db";
import {
  sellerListingsTable,
  sellersTable,
  productsTable,
  listingAttributeOptionsTable,
  reviewsTable,
} from "@workspace/db";
import { eq, and, inArray, sql, desc, asc } from "drizzle-orm";
import { requireAuth, requireSeller, requireAdmin } from "../middlewares/auth";
import { hasVerifiedPaymentConfig } from "@workspace/db/logic";

export { hasVerifiedPaymentConfig };

cloudinaryV2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadStorage = multerPkg.memoryStorage();
const uploadMiddleware = multerPkg({ storage: uploadStorage, limits: { fileSize: 10 * 1024 * 1024 } });

const router = Router();

// Comparison-critical fields that must validate against
// listingAttributeOptionsTable for the listing's product's category
// (plan doc §3a). Free-text fields (condition, description, certification,
// tags, offerText, returnPolicyText) are never checked here.
const CONTROLLED_ATTRIBUTES = ["height", "potSize", "age", "rootType"] as const;
const ATTRIBUTE_NAME_MAP: Record<(typeof CONTROLLED_ATTRIBUTES)[number], string> = {
  height: "height",
  potSize: "pot_size",
  age: "age",
  rootType: "root_type",
};

type SellerListingRow = typeof sellerListingsTable.$inferSelect;

function toListing(l: SellerListingRow) {
  return {
    id: l.id,
    productId: l.productId,
    sellerId: l.sellerId,
    form: l.form ?? null,
    rootType: l.rootType ?? null,
    potSize: l.potSize ?? null,
    age: l.age ?? null,
    height: l.height ?? null,
    condition: l.condition ?? null,
    price: Number(l.price),
    discountPrice: l.discountPrice != null ? Number(l.discountPrice) : null,
    stock: l.stock,
    availableQuantity: l.availableQuantity,
    deliveryTimeDays: l.deliveryTimeDays ?? null,
    warrantyDays: l.warrantyDays ?? null,
    returnPolicyText: l.returnPolicyText ?? null,
    paymentMethod: l.paymentMethod,
    images: l.images,
    videoUrl: l.videoUrl ?? null,
    description: l.description ?? null,
    offerText: l.offerText ?? null,
    certification: l.certification ?? null,
    tags: l.tags,
    visibility: l.visibility,
    hiddenReason: l.hiddenReason ?? null,
    approvalStatus: l.approvalStatus,
    rejectionReason: l.rejectionReason ?? null,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}

/**
 * Validates height/potSize/age/rootType against listingAttributeOptionsTable
 * for the given product's category, per plan doc §3a: "Enforce at the API
 * layer, not just client-side -- validate submitted values exist in
 * listing_attribute_options for that category/attribute before accepting a
 * listing write." Only checks fields that are present in `fields` (so PUT
 * partial updates don't require re-submitting every controlled field).
 * A field left as null/undefined is not validated -- it's optional, not a
 * value that needs to match an option set.
 */
async function validateControlledAttributes(
  categoryId: number,
  fields: Partial<Record<(typeof CONTROLLED_ATTRIBUTES)[number], string | null | undefined>>,
): Promise<string | null> {
  const toCheck = CONTROLLED_ATTRIBUTES.filter(
    (f) => fields[f] !== undefined && fields[f] !== null && fields[f] !== "",
  );
  if (toCheck.length === 0) return null;

  const attributeNames = toCheck.map((f) => ATTRIBUTE_NAME_MAP[f]);
  const options = await db
    .select()
    .from(listingAttributeOptionsTable)
    .where(
      and(
        eq(listingAttributeOptionsTable.categoryId, categoryId),
        inArray(listingAttributeOptionsTable.attributeName, attributeNames),
      ),
    );

  for (const field of toCheck) {
    const attributeName = ATTRIBUTE_NAME_MAP[field];
    const value = fields[field]!;
    const validValues = options.filter((o) => o.attributeName === attributeName).map((o) => o.value);
    if (!validValues.includes(value)) {
      return `"${value}" is not a valid ${attributeName.replace("_", " ")} option for this category. Valid options: ${
        validValues.length > 0 ? validValues.join(", ") : "(none configured for this category yet)"
      }`;
    }
  }
  return null;
}

/**
 * Payment-method enforcement (plan doc §7): "A seller with no verified
 * seller_payment_configs row can only offer COD -- enforce this at the
 * listing level (reject payment_method = 'advance' or 'both' if no
 * verified config exists)." This was flagged as unenforced in both the
 * Phase 2 and Phase 4 handoffs; this is the actual enforcement, added in
 * Part 5.
 *
 * hasVerifiedPaymentConfig itself now lives in @workspace/db/logic (moved
 * there post-Phase-9 so scripts/src/verify-seller-marketplace.ts can import
 * the real implementation instead of reimplementing it -- see that
 * module's doc comment for why). Imported above and re-exported here so
 * every existing caller of this file's hasVerifiedPaymentConfig export is
 * unaffected.
 */

const PAYMENT_METHOD_ERROR =
  'You need a verified bKash payment config before offering "advance" or "both" as a payment method. ' +
  "Add your bKash merchant credentials in Payment Settings, or choose \"cod\" for this listing.";

/**
 * Seller: list the current seller's own listings (all approval statuses,
 * all visibility) -- this is the "Manage Inventory" view, not the
 * buyer-facing one below, so it must show pending/rejected/hidden listings
 * too, not just what buyers can currently see.
 */
router.get("/seller-listings/mine", requireSeller, async (req, res) => {
  try {
    const listings = await db
      .select()
      .from(sellerListingsTable)
      .where(eq(sellerListingsTable.sellerId, req.dbSeller!.id))
      .orderBy(desc(sellerListingsTable.createdAt));
    res.json(listings.map(toListing));
  } catch (err) {
    console.error("List my seller listings error:", err);
    res.status(500).json({ error: "Failed to fetch your listings" });
  }
});

/**
 * Seller: create a listing against an existing admin-owned product
 * (variety). Per plan doc §1.6, sellers never create products/varieties --
 * only listings against ones that already exist, hence the explicit product
 * lookup/404 rather than trusting productId blindly. New listings start
 * approvalStatus "pending" -- whether that requires actual admin review
 * before going visible, or is auto-approved, is a product decision this
 * route does not make; see note near approvalStatus below.
 *
 * paymentMethod "advance"/"both" requires a verified seller_payment_configs
 * row per plan doc §7 -- ENFORCED here as of Part 5 (see
 * hasVerifiedPaymentConfig above). Previously any seller could set
 * paymentMethod to "advance"/"both" with no config at all; that gap is
 * closed now.
 */
router.post("/seller-listings", requireSeller, async (req, res) => {
  try {
    const {
      productId,
      form,
      rootType,
      potSize,
      age,
      height,
      condition,
      price,
      discountPrice,
      stock,
      deliveryTimeDays,
      warrantyDays,
      returnPolicyText,
      paymentMethod,
      images,
      videoUrl,
      description,
      offerText,
      certification,
      tags,
    } = req.body;

    if (!productId || isNaN(Number(productId))) {
      res.status(400).json({ error: "productId is required" });
      return;
    }
    if (price === undefined || isNaN(Number(price)) || Number(price) <= 0) {
      res.status(400).json({ error: "A valid price is required" });
      return;
    }
    if (paymentMethod !== undefined && !["cod", "advance", "both"].includes(paymentMethod)) {
      res.status(400).json({ error: 'paymentMethod must be "cod", "advance", or "both"' });
      return;
    }
    if (paymentMethod === "advance" || paymentMethod === "both") {
      const verified = await hasVerifiedPaymentConfig(req.dbSeller!.id);
      if (!verified) {
        res.status(400).json({ error: PAYMENT_METHOD_ERROR });
        return;
      }
    }
    if (images !== undefined && !Array.isArray(images)) {
      res.status(400).json({ error: "images must be an array of URLs" });
      return;
    }
    if (tags !== undefined && !Array.isArray(tags)) {
      res.status(400).json({ error: "tags must be an array of strings" });
      return;
    }

    const [product] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, Number(productId)))
      .limit(1);
    if (!product) {
      res.status(404).json({ error: "Product (variety) not found" });
      return;
    }

    const validationError = await validateControlledAttributes(product.categoryId, {
      height,
      potSize,
      age,
      rootType,
    });
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const stockNum = stock !== undefined ? Number(stock) : 0;
    const [listing] = await db
      .insert(sellerListingsTable)
      .values({
        productId: Number(productId),
        sellerId: req.dbSeller!.id,
        form: form || null,
        rootType: rootType || null,
        potSize: potSize || null,
        age: age || null,
        height: height || null,
        condition: condition || null,
        price: String(price),
        discountPrice: discountPrice != null ? String(discountPrice) : null,
        stock: stockNum,
        availableQuantity: stockNum,
        deliveryTimeDays: deliveryTimeDays != null ? Number(deliveryTimeDays) : null,
        warrantyDays: warrantyDays != null ? Number(warrantyDays) : null,
        returnPolicyText: returnPolicyText || null,
        paymentMethod: paymentMethod || "cod",
        images: Array.isArray(images) ? images : [],
        videoUrl: videoUrl || null,
        description: description || null,
        offerText: offerText || null,
        certification: certification || null,
        tags: Array.isArray(tags) ? tags : [],
        visibility: "public",
        approvalStatus: "pending",
      })
      .returning();

    res.status(201).json(toListing(listing));
  } catch (err) {
    console.error("Create seller listing error:", err);
    res.status(500).json({ error: "Failed to create listing" });
  }
});

/**
 * Seller: update their own listing. Ownership is checked explicitly
 * (sellerId must match req.dbSeller.id) -- requireSeller only confirms the
 * caller IS an active seller, not that they own THIS listing.
 */
router.put("/seller-listings/:id", requireSeller, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid listing id" });
      return;
    }

    const [existing] = await db.select().from(sellerListingsTable).where(eq(sellerListingsTable.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Listing not found" });
      return;
    }
    if (existing.sellerId !== req.dbSeller!.id) {
      res.status(403).json({ error: "You don't own this listing" });
      return;
    }

    const {
      form, rootType, potSize, age, height, condition,
      price, discountPrice, stock, deliveryTimeDays, warrantyDays, returnPolicyText,
      paymentMethod, images, videoUrl, description, offerText, certification, tags, visibility,
    } = req.body;

    if (paymentMethod !== undefined && !["cod", "advance", "both"].includes(paymentMethod)) {
      res.status(400).json({ error: 'paymentMethod must be "cod", "advance", or "both"' });
      return;
    }
    if (paymentMethod === "advance" || paymentMethod === "both") {
      const verified = await hasVerifiedPaymentConfig(req.dbSeller!.id);
      if (!verified) {
        res.status(400).json({ error: PAYMENT_METHOD_ERROR });
        return;
      }
    }
    if (visibility !== undefined && !["public", "hidden"].includes(visibility)) {
      res.status(400).json({ error: 'visibility must be "public" or "hidden"' });
      return;
    }
    if (images !== undefined && !Array.isArray(images)) {
      res.status(400).json({ error: "images must be an array of URLs" });
      return;
    }
    if (tags !== undefined && !Array.isArray(tags)) {
      res.status(400).json({ error: "tags must be an array of strings" });
      return;
    }

    const [product] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, existing.productId))
      .limit(1);
    // product should always exist (FK constraint), but guard anyway rather
    // than crash on categoryId lookup if data is ever in a bad state.
    if (product) {
      const validationError = await validateControlledAttributes(product.categoryId, {
        height, potSize, age, rootType,
      });
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (form !== undefined) updates.form = form || null;
    if (rootType !== undefined) updates.rootType = rootType || null;
    if (potSize !== undefined) updates.potSize = potSize || null;
    if (age !== undefined) updates.age = age || null;
    if (height !== undefined) updates.height = height || null;
    if (condition !== undefined) updates.condition = condition || null;
    if (price !== undefined) updates.price = String(price);
    if (discountPrice !== undefined) updates.discountPrice = discountPrice != null ? String(discountPrice) : null;
    if (stock !== undefined) {
      // availableQuantity mirrors stock on every stock edit -- this route
      // has no separate "reserve stock for a pending order" concept yet
      // (that's checkout/order-fulfillment territory, phase 3), so the two
      // fields stay in lockstep here rather than availableQuantity silently
      // drifting from stock with no mechanism to reconcile them.
      updates.stock = Number(stock);
      updates.availableQuantity = Number(stock);
    }
    if (deliveryTimeDays !== undefined) updates.deliveryTimeDays = deliveryTimeDays != null ? Number(deliveryTimeDays) : null;
    if (warrantyDays !== undefined) updates.warrantyDays = warrantyDays != null ? Number(warrantyDays) : null;
    if (returnPolicyText !== undefined) updates.returnPolicyText = returnPolicyText || null;
    if (paymentMethod !== undefined) updates.paymentMethod = paymentMethod;
    if (images !== undefined) updates.images = images;
    if (videoUrl !== undefined) updates.videoUrl = videoUrl || null;
    if (description !== undefined) updates.description = description || null;
    if (offerText !== undefined) updates.offerText = offerText || null;
    if (certification !== undefined) updates.certification = certification || null;
    if (tags !== undefined) updates.tags = tags;
    if (visibility !== undefined) {
      updates.visibility = visibility;
      // A seller manually toggling visibility is a deliberate choice, not
      // the subscription job's automated hide -- clear hiddenReason so a
      // later admin mark-as-paid pass doesn't misread this as still being
      // subscription-caused (see sellerListingsTable.hiddenReason comment).
      updates.hiddenReason = null;
    }

    const [updated] = await db
      .update(sellerListingsTable)
      .set(updates)
      .where(eq(sellerListingsTable.id, id))
      .returning();

    res.json(toListing(updated));
  } catch (err) {
    console.error("Update seller listing error:", err);
    res.status(500).json({ error: "Failed to update listing" });
  }
});

/**
 * Seller: delete their own listing. Existing reviews referencing this
 * sellerListingId cascade-delete per the schema's onDelete: "cascade" --
 * that's a real, deliberate loss of review history, not a bug, and matches
 * how productVariantsTable deletion already works elsewhere in this
 * codebase (no soft-delete convention exists here to follow instead).
 */
router.delete("/seller-listings/:id", requireSeller, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid listing id" });
      return;
    }
    const [existing] = await db.select().from(sellerListingsTable).where(eq(sellerListingsTable.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Listing not found" });
      return;
    }
    if (existing.sellerId !== req.dbSeller!.id) {
      res.status(403).json({ error: "You don't own this listing" });
      return;
    }
    await db.delete(sellerListingsTable).where(eq(sellerListingsTable.id, id));
    res.json({ message: "Listing deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete listing" });
  }
});

/**
 * Seller: upload images/video for a listing. Same hand-called
 * fetch+FormData convention as /sellers/upload-verification-doc and
 * /products/upload-image -- not in openapi.yaml, for the same multer/zod
 * codegen conflict reason documented in PHASE1_HANDOFF.md point 3.
 */
router.post("/seller-listings/upload-image", requireSeller, uploadMiddleware.array("images", 8), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: "No files uploaded" });
      return;
    }
    const urls = await Promise.all(
      files.map(
        (file) =>
          new Promise<string>((resolve, reject) => {
            const stream = cloudinaryV2.uploader.upload_stream(
              { folder: "treefriend/seller-listings", quality: 80, format: "webp" },
              (err, result) => {
                if (err || !result) {
                  console.error("Cloudinary error:", err);
                  return reject(err ?? new Error("Upload failed"));
                }
                resolve(result.secure_url);
              },
            );
            stream.end(file.buffer);
          }),
      ),
    );
    res.json({ urls });
  } catch (err) {
    console.error("Seller listing image upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

/**
 * Buyer-facing: seller cards for a variety detail page (plan doc §6). Only
 * shows listings that are actually purchasable right now:
 *   - listing.visibility = "public" AND approvalStatus = "approved"
 *   - seller.status = "active" (not suspended/vacation/pending) -- per
 *     adminSellers.ts's own note, this is exactly where that check belongs.
 * Supports sort by price/deliveryTime/rating; "More Filters" (plan doc §6
 * mentions it but doesn't specify which filters) is intentionally not
 * built here since the plan doesn't define its filter set -- flagging
 * rather than guessing which fields it should filter on.
 */
router.get("/products/:productId/seller-listings", async (req: any, res) => {
  try {
    const productId = parseInt(req.params.productId);
    if (isNaN(productId) || productId <= 0) {
      res.status(400).json({ error: "Invalid product id" });
      return;
    }
    const { sort } = req.query as { sort?: string };

    const rows = await db
      .select({ listing: sellerListingsTable, seller: sellersTable })
      .from(sellerListingsTable)
      .innerJoin(sellersTable, eq(sellerListingsTable.sellerId, sellersTable.id))
      .where(
        and(
          eq(sellerListingsTable.productId, productId),
          eq(sellerListingsTable.visibility, "public"),
          eq(sellerListingsTable.approvalStatus, "approved"),
          eq(sellersTable.status, "active"),
        ),
      );

    const listingIds = rows.map((r) => r.listing.id);
    const statsMap = new Map<number, { avg: number; count: number }>();
    if (listingIds.length > 0) {
      const stats = await db
        .select({
          sellerListingId: reviewsTable.sellerListingId,
          avg: sql<string>`COALESCE(AVG(${reviewsTable.rating}), 0)`,
          count: sql<string>`COUNT(*)`,
        })
        .from(reviewsTable)
        .where(inArray(reviewsTable.sellerListingId, listingIds))
        .groupBy(reviewsTable.sellerListingId);
      for (const s of stats) {
        if (s.sellerListingId != null) {
          statsMap.set(s.sellerListingId, { avg: Number(Number(s.avg).toFixed(1)), count: Number(s.count) });
        }
      }
    }

    let cards = rows.map(({ listing, seller }) => {
      const stats = statsMap.get(listing.id) ?? { avg: 0, count: 0 };
      return {
        listing: toListing(listing),
        seller: {
          id: seller.id,
          businessName: seller.businessName,
          nurseryName: seller.nurseryName,
          location: seller.location,
        },
        rating: stats.avg,
        reviewCount: stats.count,
      };
    });

    if (sort === "price_asc") {
      cards = cards.sort(
        (a, b) => (a.listing.discountPrice ?? a.listing.price) - (b.listing.discountPrice ?? b.listing.price),
      );
    } else if (sort === "price_desc") {
      cards = cards.sort(
        (a, b) => (b.listing.discountPrice ?? b.listing.price) - (a.listing.discountPrice ?? a.listing.price),
      );
    } else if (sort === "delivery_time") {
      cards = cards.sort(
        (a, b) => (a.listing.deliveryTimeDays ?? Infinity) - (b.listing.deliveryTimeDays ?? Infinity),
      );
    } else if (sort === "rating") {
      cards = cards.sort((a, b) => b.rating - a.rating);
    }

    res.json(cards);
  } catch (err) {
    console.error("List product seller listings error:", err);
    res.status(500).json({ error: "Failed to fetch seller listings" });
  }
});

/**
 * Admin: list listings pending approval, and approve/reject them. Whether
 * approval is actually required before a listing goes live (vs. the
 * pending default just being informational) is not specified in the plan
 * doc beyond approvalStatus existing in the schema -- this route makes
 * pending/approved/rejected meaningful by gating the buyer-facing query
 * above on approvalStatus = "approved", but if that's not the intended
 * workflow, this is the piece to revisit, not something to silently change
 * on the buyer-facing side alone.
 */
router.get("/admin/seller-listings", requireAdmin, async (req, res) => {
  try {
    const { approvalStatus } = req.query as { approvalStatus?: string };
    const valid = ["pending", "approved", "rejected"];
    const rows = await db
      .select({ listing: sellerListingsTable, seller: sellersTable, product: productsTable })
      .from(sellerListingsTable)
      .innerJoin(sellersTable, eq(sellerListingsTable.sellerId, sellersTable.id))
      .innerJoin(productsTable, eq(sellerListingsTable.productId, productsTable.id))
      .where(approvalStatus && valid.includes(approvalStatus) ? eq(sellerListingsTable.approvalStatus, approvalStatus) : undefined)
      .orderBy(asc(sellerListingsTable.createdAt));

    res.json(
      rows.map(({ listing, seller, product }) => ({
        ...toListing(listing),
        sellerBusinessName: seller.businessName,
        productName: product.name,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch listings" });
  }
});

router.put("/admin/seller-listings/:id/approve", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid listing id" });
      return;
    }
    const [listing] = await db
      .update(sellerListingsTable)
      .set({ approvalStatus: "approved", rejectionReason: null, updatedAt: new Date() })
      .where(eq(sellerListingsTable.id, id))
      .returning();
    if (!listing) {
      res.status(404).json({ error: "Listing not found" });
      return;
    }
    res.json(toListing(listing));
  } catch (err) {
    res.status(500).json({ error: "Failed to approve listing" });
  }
});

router.put("/admin/seller-listings/:id/reject", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid listing id" });
      return;
    }
    const { reason } = req.body as { reason?: string };
    const [listing] = await db
      .update(sellerListingsTable)
      .set({ approvalStatus: "rejected", rejectionReason: reason ?? null, updatedAt: new Date() })
      .where(eq(sellerListingsTable.id, id))
      .returning();
    if (!listing) {
      res.status(404).json({ error: "Listing not found" });
      return;
    }
    res.json(toListing(listing));
  } catch (err) {
    res.status(500).json({ error: "Failed to reject listing" });
  }
});

export default router;
