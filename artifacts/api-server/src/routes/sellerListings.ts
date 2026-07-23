import { Router } from "express";
import multerPkg from "multer";
import { v2 as cloudinaryV2 } from "cloudinary";
import { db } from "@workspace/db";
import {
  sellerListingsTable,
  sellerListingVariantsTable,
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
//
// Phase 2: these fields moved from sellerListingsTable to
// sellerListingVariantsTable, so validation now runs PER VARIANT rather
// than once per listing (a listing with a "Sapling" variant at 1-2ft and a
// "Grafted" variant at 3-4ft needs each checked against its own values).
const CONTROLLED_ATTRIBUTES = ["height", "potSize", "age", "rootType"] as const;
const ATTRIBUTE_NAME_MAP: Record<(typeof CONTROLLED_ATTRIBUTES)[number], string> = {
  height: "height",
  potSize: "pot_size",
  age: "age",
  rootType: "root_type",
};

type SellerListingRow = typeof sellerListingsTable.$inferSelect;
type SellerListingVariantRow = typeof sellerListingVariantsTable.$inferSelect;

/**
 * Listing-level fields only (Phase 2 shape). No price/stock/form/etc. here
 * anymore -- those live on variants, see toVariant() below. Existing
 * callers that expect a flat listing+variant shape (pre-Phase-2 toListing())
 * must move to toListingWithVariants() -- see the "which consumers need
 * which shape" note near the bottom of this file's route handlers.
 */
function toListing(l: SellerListingRow) {
  return {
    id: l.id,
    productId: l.productId,
    sellerId: l.sellerId,
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

function toVariant(v: SellerListingVariantRow) {
  return {
    id: v.id,
    sellerListingId: v.sellerListingId,
    form: v.form ?? null,
    rootType: v.rootType ?? null,
    potSize: v.potSize ?? null,
    age: v.age ?? null,
    height: v.height ?? null,
    condition: v.condition ?? null,
    price: Number(v.price),
    discountPrice: v.discountPrice != null ? Number(v.discountPrice) : null,
    stock: v.stock,
    availableQuantity: v.availableQuantity,
    deliveryCharge: Number(v.deliveryCharge),
    isPreOrder: v.isPreOrder,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

/**
 * toListing() + its variants, nested. This is the shape every route in this
 * file that returns listings to a client now uses (GET /seller-listings/mine,
 * GET /admin/seller-listings, POST/PUT responses) -- see the doc comment
 * above each route for why nested-over-flat is correct for that consumer.
 */
function toListingWithVariants(l: SellerListingRow, variants: SellerListingVariantRow[]) {
  return {
    ...toListing(l),
    variants: variants.map(toVariant),
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
 *
 * Phase 2: called once PER VARIANT now (height/potSize/age/rootType moved
 * to sellerListingVariantsTable), not once per listing.
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
 * Validates a single incoming variant payload's shape (independent of the
 * controlled-attribute DB check above, which needs the product's
 * categoryId and is async). Returns a human-readable error or null.
 */
function validateVariantShape(v: any, label: string): string | null {
  if (!v || typeof v !== "object") return `Variant "${label}" must be an object`;
  if (v.price === undefined || isNaN(Number(v.price)) || Number(v.price) <= 0) {
    return `A valid price is required for variant "${label}"`;
  }
  if (v.discountPrice != null && Number(v.discountPrice) >= Number(v.price)) {
    return `Discount price must be less than regular price for variant "${label}"`;
  }
  return null;
}

/**
 * Payment-method enforcement (plan doc §7): "A seller with no verified
 * seller_payment_configs row can only offer COD -- enforce this at the
 * listing level (reject payment_method = 'advance' or 'both' if no
 * verified config exists)." This was flagged as unenforced in both the
 * Phase 2 and Phase 4 handoffs; this is the actual enforcement, added in
 * Part 5. Unaffected by the Phase 2 listing/variant split -- payment method
 * is a listing-level field, not a variant-level one.
 *
 * hasVerifiedPaymentConfig itself lives in @workspace/db/logic (moved there
 * post-Phase-9 so scripts/src/verify-seller-marketplace.ts can import the
 * real implementation instead of reimplementing it -- see that module's doc
 * comment for why). Imported above and re-exported here so every existing
 * caller of this file's hasVerifiedPaymentConfig export is unaffected.
 */

const PAYMENT_METHOD_ERROR =
  'You need a verified bKash payment config before offering "advance" or "both" as a payment method. ' +
  "Add your bKash merchant credentials in Payment Settings, or choose \"cod\" for this listing.";

/**
 * Seller: list the current seller's own listings (all approval statuses,
 * all visibility) -- this is the "Manage Inventory" view, not the
 * buyer-facing one below, so it must show pending/rejected/hidden listings
 * too, not just what buyers can currently see.
 *
 * Returns the NESTED shape (toListingWithVariants) -- "Manage Inventory"
 * needs to show/edit every variant under each listing, not just the
 * listing's shared fields. Grepped artifacts/tree-friend's seller inventory
 * UI (out of scope to edit this phase, Phase 3's job) to confirm this is
 * the consumer; flagging here so Phase 3 knows the shape it will receive.
 */
router.get("/seller-listings/mine", requireSeller, async (req, res) => {
  try {
    const listings = await db
      .select()
      .from(sellerListingsTable)
      .where(eq(sellerListingsTable.sellerId, req.dbSeller!.id))
      .orderBy(desc(sellerListingsTable.createdAt));

    const listingIds = listings.map((l) => l.id);
    const variants = listingIds.length > 0
      ? await db
          .select()
          .from(sellerListingVariantsTable)
          .where(inArray(sellerListingVariantsTable.sellerListingId, listingIds))
      : [];
    const variantsByListing = new Map<number, SellerListingVariantRow[]>();
    for (const v of variants) {
      const list = variantsByListing.get(v.sellerListingId) ?? [];
      list.push(v);
      variantsByListing.set(v.sellerListingId, list);
    }

    res.json(listings.map((l) => toListingWithVariants(l, variantsByListing.get(l.id) ?? [])));
  } catch (err) {
    console.error("List my seller listings error:", err);
    res.status(500).json({ error: "Failed to fetch your listings" });
  }
});

/**
 * Seller: create a listing against an existing admin-owned product
 * (variety), plus one or more variants inside it. Per plan doc §1.6,
 * sellers never create products/varieties -- only listings against ones
 * that already exist, hence the explicit product lookup/404 rather than
 * trusting productId blindly. New listings start approvalStatus "pending"
 * -- whether that requires actual admin review before going visible, or is
 * auto-approved, is a product decision this route does not make; see note
 * near approvalStatus below.
 *
 * Phase 2 shape: body carries listing-level fields as before, PLUS a
 * required `variants: [...]` array (at least one entry) -- a listing with
 * zero variants isn't purchasable, so creating one with none is rejected.
 * Each variant object carries form/rootType/potSize/age/height/condition/
 * price/discountPrice/stock/deliveryCharge/isPreOrder.
 * validateControlledAttributes runs once PER VARIANT now, since
 * height/potSize/age/rootType moved there from the listing.
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
      variants,
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
    if (!Array.isArray(variants) || variants.length === 0) {
      res.status(400).json({ error: "At least one variant (e.g. Seed, Sapling, Grafted, Potted) is required" });
      return;
    }
    for (let i = 0; i < variants.length; i++) {
      const err = validateVariantShape(variants[i], variants[i]?.form || `#${i + 1}`);
      if (err) {
        res.status(400).json({ error: err });
        return;
      }
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

    for (const v of variants) {
      const validationError = await validateControlledAttributes(product.categoryId, {
        height: v.height,
        potSize: v.potSize,
        age: v.age,
        rootType: v.rootType,
      });
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
    }

    const [listing] = await db
      .insert(sellerListingsTable)
      .values({
        productId: Number(productId),
        sellerId: req.dbSeller!.id,
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

    const insertedVariants = await db
      .insert(sellerListingVariantsTable)
      .values(
        variants.map((v: any) => {
          const stockNum = v.stock !== undefined ? Number(v.stock) : 0;
          return {
            sellerListingId: listing.id,
            form: v.form || null,
            rootType: v.rootType || null,
            potSize: v.potSize || null,
            age: v.age || null,
            height: v.height || null,
            condition: v.condition || null,
            price: String(v.price),
            discountPrice: v.discountPrice != null ? String(v.discountPrice) : null,
            stock: stockNum,
            availableQuantity: stockNum,
            deliveryCharge: String(v.deliveryCharge ?? 0),
            isPreOrder: v.isPreOrder === true,
          };
        }),
      )
      .returning();

    res.status(201).json(toListingWithVariants(listing, insertedVariants));
  } catch (err) {
    console.error("Create seller listing error:", err);
    res.status(500).json({ error: "Failed to create listing" });
  }
});

/**
 * Seller: update their own listing, and manage its variants. Ownership is
 * checked explicitly (sellerId must match req.dbSeller.id) -- requireSeller
 * only confirms the caller IS an active seller, not that they own THIS
 * listing.
 *
 * Phase 2 request shape (documented here since this is a new concept, not
 * in the original file): body may include listing-level fields as before
 * (unchanged behavior), PLUS an optional `variants` array to manage
 * variants in the same request:
 *   - `variants: [{ id: 5, price: 700, ... }, ...]` -- an item WITH an `id`
 *     updates that existing variant (partial update, same
 *     only-set-what's-present convention as listing-level fields below).
 *   - `variants: [{ price: 400, form: "seed", ... }, ...]` -- an item with
 *     NO `id` creates a new variant under this listing.
 *   - `deletedVariantIds: [3, 7]` -- an optional separate top-level array;
 *     any variant id listed here is deleted from this listing.
 * A single PUT can mix all three (update some, create some, delete some) in
 * one request. This shape was chosen over e.g. "always replace the whole
 * variants array" because it lets the frontend send only what changed
 * (matches this route's existing partial-update convention for
 * listing-level fields, where a field is only touched if present in the
 * body) rather than needing to resend every untouched variant's full data
 * on every edit.
 *
 * Guard: a listing must always end this request with at least one variant
 * (same "a listing needs >=1 variant to be purchasable" rule as POST) --
 * rejected if deletions would leave zero.
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
      deliveryTimeDays, warrantyDays, returnPolicyText,
      paymentMethod, images, videoUrl, description, offerText, certification, tags, visibility,
      variants, deletedVariantIds,
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
    if (variants !== undefined && !Array.isArray(variants)) {
      res.status(400).json({ error: "variants must be an array" });
      return;
    }
    if (deletedVariantIds !== undefined && !Array.isArray(deletedVariantIds)) {
      res.status(400).json({ error: "deletedVariantIds must be an array" });
      return;
    }

    const existingVariants = await db
      .select()
      .from(sellerListingVariantsTable)
      .where(eq(sellerListingVariantsTable.sellerListingId, id));
    const existingVariantIds = new Set(existingVariants.map((v) => v.id));

    const toDelete: number[] = Array.isArray(deletedVariantIds)
      ? deletedVariantIds.map((n: any) => Number(n)).filter((n: number) => existingVariantIds.has(n))
      : [];

    const toUpdate: any[] = [];
    const toCreate: any[] = [];
    if (Array.isArray(variants)) {
      for (const v of variants) {
        if (v && v.id != null) {
          const vid = Number(v.id);
          if (!existingVariantIds.has(vid)) {
            res.status(404).json({ error: `Variant ${vid} not found on this listing` });
            return;
          }
          if (toDelete.includes(vid)) {
            res.status(400).json({ error: `Variant ${vid} is both being updated and deleted -- pick one` });
            return;
          }
          toUpdate.push({ ...v, id: vid });
        } else {
          const shapeError = validateVariantShape(v, v?.form || "(new)");
          if (shapeError) {
            res.status(400).json({ error: shapeError });
            return;
          }
          toCreate.push(v);
        }
      }
    }

    const resultingVariantCount = existingVariantIds.size - toDelete.length + toCreate.length;
    if (resultingVariantCount <= 0) {
      res.status(400).json({ error: "A listing must have at least one variant -- can't remove the last one" });
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
      for (const v of [...toUpdate, ...toCreate]) {
        const validationError = await validateControlledAttributes(product.categoryId, {
          height: v.height, potSize: v.potSize, age: v.age, rootType: v.rootType,
        });
        if (validationError) {
          res.status(400).json({ error: validationError });
          return;
        }
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
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

    if (toDelete.length > 0) {
      await db.delete(sellerListingVariantsTable).where(inArray(sellerListingVariantsTable.id, toDelete));
    }

    for (const v of toUpdate) {
      const variantUpdates: Record<string, unknown> = { updatedAt: new Date() };
      if (v.form !== undefined) variantUpdates.form = v.form || null;
      if (v.rootType !== undefined) variantUpdates.rootType = v.rootType || null;
      if (v.potSize !== undefined) variantUpdates.potSize = v.potSize || null;
      if (v.age !== undefined) variantUpdates.age = v.age || null;
      if (v.height !== undefined) variantUpdates.height = v.height || null;
      if (v.condition !== undefined) variantUpdates.condition = v.condition || null;
      if (v.price !== undefined) variantUpdates.price = String(v.price);
      if (v.discountPrice !== undefined) variantUpdates.discountPrice = v.discountPrice != null ? String(v.discountPrice) : null;
      if (v.stock !== undefined) {
        // availableQuantity mirrors stock on every stock edit -- same
        // lockstep convention this route used pre-Phase-2 (no separate
        // "reserve stock for a pending order" concept exists yet).
        variantUpdates.stock = Number(v.stock);
        variantUpdates.availableQuantity = Number(v.stock);
      }
      if (v.deliveryCharge !== undefined) variantUpdates.deliveryCharge = String(v.deliveryCharge);
      if (v.isPreOrder !== undefined) variantUpdates.isPreOrder = v.isPreOrder === true;
      await db.update(sellerListingVariantsTable).set(variantUpdates).where(eq(sellerListingVariantsTable.id, v.id));
    }

    let createdVariants: SellerListingVariantRow[] = [];
    if (toCreate.length > 0) {
      createdVariants = await db
        .insert(sellerListingVariantsTable)
        .values(
          toCreate.map((v: any) => {
            const stockNum = v.stock !== undefined ? Number(v.stock) : 0;
            return {
              sellerListingId: id,
              form: v.form || null,
              rootType: v.rootType || null,
              potSize: v.potSize || null,
              age: v.age || null,
              height: v.height || null,
              condition: v.condition || null,
              price: String(v.price),
              discountPrice: v.discountPrice != null ? String(v.discountPrice) : null,
              stock: stockNum,
              availableQuantity: stockNum,
              deliveryCharge: String(v.deliveryCharge ?? 0),
              isPreOrder: v.isPreOrder === true,
            };
          }),
        )
        .returning();
    }

    const finalVariants = await db
      .select()
      .from(sellerListingVariantsTable)
      .where(eq(sellerListingVariantsTable.sellerListingId, id));

    res.json(toListingWithVariants(updated, finalVariants));
  } catch (err) {
    console.error("Update seller listing error:", err);
    res.status(500).json({ error: "Failed to update listing" });
  }
});

/**
 * Seller: delete their own listing. Variants cascade-delete with it --
 * sellerListingVariantsTable.sellerListingId has onDelete: "cascade" (see
 * lib/db/src/schema/sellerListingVariants.ts), confirmed by inspecting that
 * FK definition; not re-verified against a live DB this phase (no DB
 * connection available in this environment -- see handoff doc). Existing
 * reviews referencing this sellerListingId (and, as of Phase 2,
 * sellerListingVariantId) also cascade-delete per their own onDelete:
 * "cascade" FKs -- that's a real, deliberate loss of review history, not a
 * bug, matching how productVariantsTable deletion already works elsewhere
 * in this codebase (no soft-delete convention exists here to follow
 * instead).
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
 *
 * Phase 2: each card now represents one listing with potentially SEVERAL
 * variants, each independently addressable (nested, via
 * toListingWithVariants) -- the frontend can show a price range per seller
 * (min/max across variants) or list each variant individually. The
 * `availableQuantity > 0` purchasability check moves to the VARIANT level:
 * a listing is included if it has at least one variant with
 * availableQuantity > 0, but variants with availableQuantity = 0 (e.g.
 * sold-out or pre-order-only) are still returned nested (not filtered out
 * entirely) so the frontend can show them as unavailable/pre-order rather
 * than silently hiding them -- only listings with ZERO purchasable variants
 * are dropped from the response.
 *
 * price_asc/price_desc sort: sorts by the listing's CHEAPEST QUALIFYING
 * variant (a variant counts as "qualifying" for this purpose if
 * availableQuantity > 0 -- consistent with the inclusion filter above; an
 * out-of-stock variant's price shouldn't be able to make an otherwise
 * pricier listing look cheap in the sort). See handoff doc for a worked
 * example trace of this.
 *
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

    const [variantRows, statsRows] = await Promise.all([
      listingIds.length > 0
        ? db
            .select()
            .from(sellerListingVariantsTable)
            .where(inArray(sellerListingVariantsTable.sellerListingId, listingIds))
        : Promise.resolve([] as SellerListingVariantRow[]),
      listingIds.length > 0
        ? db
            .select({
              sellerListingId: reviewsTable.sellerListingId,
              avg: sql<string>`COALESCE(AVG(${reviewsTable.rating}), 0)`,
              count: sql<string>`COUNT(*)`,
            })
            .from(reviewsTable)
            .where(inArray(reviewsTable.sellerListingId, listingIds))
            .groupBy(reviewsTable.sellerListingId)
        : Promise.resolve([]),
    ]);

    const variantsByListing = new Map<number, SellerListingVariantRow[]>();
    for (const v of variantRows) {
      const list = variantsByListing.get(v.sellerListingId) ?? [];
      list.push(v);
      variantsByListing.set(v.sellerListingId, list);
    }

    const statsMap = new Map<number, { avg: number; count: number }>();
    for (const s of statsRows) {
      if (s.sellerListingId != null) {
        statsMap.set(s.sellerListingId, { avg: Number(Number(s.avg).toFixed(1)), count: Number(s.count) });
      }
    }

    let cards = rows
      .map(({ listing, seller }) => {
        const variants = variantsByListing.get(listing.id) ?? [];
        const qualifyingVariants = variants.filter((v) => v.availableQuantity > 0);
        const stats = statsMap.get(listing.id) ?? { avg: 0, count: 0 };
        return {
          listing: toListingWithVariants(listing, variants),
          qualifyingVariants,
          seller: {
            id: seller.id,
            businessName: seller.businessName,
            nurseryName: seller.nurseryName,
            location: seller.location,
          },
          rating: stats.avg,
          reviewCount: stats.count,
        };
      })
      // Drop listings with zero purchasable variants entirely -- see doc
      // comment above for why sold-out/pre-order-only variants inside an
      // otherwise-qualifying listing are kept nested instead.
      .filter((card) => card.qualifyingVariants.length > 0);

    function cheapestQualifyingPrice(card: (typeof cards)[number]): number {
      const prices = card.qualifyingVariants.map((v) =>
        v.discountPrice != null ? Number(v.discountPrice) : Number(v.price),
      );
      return Math.min(...prices);
    }

    if (sort === "price_asc") {
      cards = cards.sort((a, b) => cheapestQualifyingPrice(a) - cheapestQualifyingPrice(b));
    } else if (sort === "price_desc") {
      cards = cards.sort((a, b) => cheapestQualifyingPrice(b) - cheapestQualifyingPrice(a));
    } else if (sort === "delivery_time") {
      cards = cards.sort(
        (a, b) => (a.listing.deliveryTimeDays ?? Infinity) - (b.listing.deliveryTimeDays ?? Infinity),
      );
    } else if (sort === "rating") {
      cards = cards.sort((a, b) => b.rating - a.rating);
    }

    res.json(cards.map(({ qualifyingVariants, ...card }) => card));
  } catch (err) {
    console.error("List product seller listings error:", err);
    res.status(500).json({ error: "Failed to fetch seller listings" });
  }
});

/**
 * Buyer-facing: ONE listing's full detail by id, publicly, nested variants +
 * seller info (Phase 3b Part 3 -- added because no existing route served
 * this: GET /seller-listings/mine is seller-auth-scoped to the caller's own
 * listings, and GET /products/:productId/seller-listings returns a LIST of
 * cards, not one listing's full detail alone by id). Powers the new
 * "See details" listing-detail page.
 *
 * Same visibility/approval/active-seller gate as the list route above
 * (public + approved + seller active) -- a listing that wouldn't appear in
 * the list shouldn't be independently reachable by guessing its id either.
 * Unlike the list route, this does NOT drop the listing if it has zero
 * qualifying (in-stock) variants -- a listing detail page should still be
 * able to show a sold-out listing's variants (each individually marked
 * unavailable), not 404 it outright, since "sold out" is a real, showable
 * state here rather than a reason to hide the whole listing from a list.
 */
router.get("/seller-listings/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid listing id" });
      return;
    }

    const [row] = await db
      .select({ listing: sellerListingsTable, seller: sellersTable })
      .from(sellerListingsTable)
      .innerJoin(sellersTable, eq(sellerListingsTable.sellerId, sellersTable.id))
      .where(
        and(
          eq(sellerListingsTable.id, id),
          eq(sellerListingsTable.visibility, "public"),
          eq(sellerListingsTable.approvalStatus, "approved"),
          eq(sellersTable.status, "active"),
        ),
      )
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "Listing not found" });
      return;
    }

    const [variants, reviewStats] = await Promise.all([
      db
        .select()
        .from(sellerListingVariantsTable)
        .where(eq(sellerListingVariantsTable.sellerListingId, id)),
      db
        .select({
          avg: sql<string>`COALESCE(AVG(${reviewsTable.rating}), 0)`,
          count: sql<string>`COUNT(*)`,
        })
        .from(reviewsTable)
        .where(eq(reviewsTable.sellerListingId, id)),
    ]);

    const stats = reviewStats[0] ?? { avg: "0", count: "0" };

    res.json({
      listing: toListingWithVariants(row.listing, variants),
      seller: {
        id: row.seller.id,
        businessName: row.seller.businessName,
        nurseryName: row.seller.nurseryName,
        location: row.seller.location,
      },
      rating: Number(Number(stats.avg).toFixed(1)),
      reviewCount: Number(stats.count),
    });
  } catch (err) {
    console.error("Get seller listing by id error:", err);
    res.status(500).json({ error: "Failed to fetch listing" });
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
 *
 * Returns the NESTED shape (toListingWithVariants) -- admin review needs to
 * see what a seller is actually offering (variants, prices, stock) to make
 * an approve/reject decision, not just the listing's shared fields.
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

    const listingIds = rows.map((r) => r.listing.id);
    const variants = listingIds.length > 0
      ? await db
          .select()
          .from(sellerListingVariantsTable)
          .where(inArray(sellerListingVariantsTable.sellerListingId, listingIds))
      : [];
    const variantsByListing = new Map<number, SellerListingVariantRow[]>();
    for (const v of variants) {
      const list = variantsByListing.get(v.sellerListingId) ?? [];
      list.push(v);
      variantsByListing.set(v.sellerListingId, list);
    }

    res.json(
      rows.map(({ listing, seller, product }) => ({
        ...toListingWithVariants(listing, variantsByListing.get(listing.id) ?? []),
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
    const variants = await db
      .select()
      .from(sellerListingVariantsTable)
      .where(eq(sellerListingVariantsTable.sellerListingId, listing.id));
    res.json(toListingWithVariants(listing, variants));
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
    const variants = await db
      .select()
      .from(sellerListingVariantsTable)
      .where(eq(sellerListingVariantsTable.sellerListingId, listing.id));
    res.json(toListingWithVariants(listing, variants));
  } catch (err) {
    res.status(500).json({ error: "Failed to reject listing" });
  }
});

export default router;
