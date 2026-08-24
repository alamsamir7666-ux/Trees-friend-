import { Router } from "express";
import { logger } from "../lib/logger";
import { db } from "@workspace/db";
import {
  wishlistTable,
  productsTable,
  productVariantsTable,
  reviewsTable,
  sellerListingsTable,
  sellerListingVariantsTable,
  sellersTable,
} from "@workspace/db";
import {
  AddToWishlistParams,
  RemoveFromWishlistParams,
  AddSellerListingVariantToWishlistParams,
  RemoveSellerListingVariantFromWishlistParams,
} from "@workspace/api-zod";
import { validateParams, validateBody } from "../lib/validateRequest";
import type { ApiRequest } from "../types/apiRequest";
import { z } from "zod";
import { eq, and, isNull, isNotNull, sql, inArray } from "drizzle-orm";
import { requireGuestOrAuth } from "../middlewares/auth";
import { wishlistLimiter } from "../middlewares/rateLimiter";

const router = Router();

// Cap on total wishlist rows per user (matching MAX_CART_LINES in cart.ts).
// Prevents a runaway script (or a careless merge) from creating thousands
// of wishlist rows that bloat GET /wishlist responses.
const MAX_WISHLIST_LINES = 200;

// Body schema for POST /wishlist/merge — mirrors MergeCartBody in cart.ts.
// A guest's localStorage wishlist has two arrays (products + seller-listing
// variants), sent in one merge request after OTP verification.
const MergeWishlistBody = z.object({
  products: z.array(z.object({ productId: z.number() })).max(MAX_WISHLIST_LINES),
  sellerListingVariants: z
    .array(z.object({ sellerListingVariantId: z.number() }))
    .max(MAX_WISHLIST_LINES),
});

router.get("/wishlist", requireGuestOrAuth, async (req: ApiRequest, res) => {
  // Product-variety rows only (seller_listing_variant_id IS NULL) --
  // seller-listing rows are fetched and shaped separately below, since
  // they need a different join (seller_listings/seller_listing_variants,
  // not the admin-variant/marketplace-price-fallback logic below, which
  // only makes sense for "no seller chosen yet" product rows).
  const items = await db
    .select({ wishlist: wishlistTable, product: productsTable })
    .from(wishlistTable)
    .innerJoin(productsTable, eq(wishlistTable.productId, productsTable.id))
    .where(
      and(eq(wishlistTable.userId, req.userId!), isNull(wishlistTable.sellerListingVariantId)),
    );

  const productIds = items.map((i) => i.product.id);

  const statsRows =
    productIds.length > 0
      ? await db
          .select({
            productId: reviewsTable.productId,
            avg: sql<string>`COALESCE(AVG(${reviewsTable.rating}), 0)`,
            count: sql<string>`COUNT(*)`,
          })
          .from(reviewsTable)
          .where(inArray(reviewsTable.productId, productIds))
          .groupBy(reviewsTable.productId)
      : [];
  const statsMap = new Map(
    statsRows.map((r) => [
      r.productId,
      { avg: Number(Number(r.avg).toFixed(1)), count: Number(r.count) },
    ]),
  );

  const variantRows =
    productIds.length > 0
      ? await db
          .select()
          .from(productVariantsTable)
          .where(inArray(productVariantsTable.productId, productIds))
      : [];
  const variantsByProduct = new Map<number, typeof variantRows>();
  for (const v of variantRows) {
    const list = variantsByProduct.get(v.productId) ?? [];
    list.push(v);
    variantsByProduct.set(v.productId, list);
  }

  // Phase 2 marketplace fallback -- same rationale as routes/search.ts:
  // admin variants are legacy-only going forward, so a product with no
  // admin variants needs a marketplace-sourced price/stock signal or it
  // would always show blank/out-of-stock on the wishlist page regardless
  // of what sellers are actually offering.
  const listingRows =
    productIds.length > 0
      ? await db
          .select({
            productId: sellerListingsTable.productId,
            price: sellerListingVariantsTable.price,
            discountPrice: sellerListingVariantsTable.discountPrice,
            availableQuantity: sellerListingVariantsTable.availableQuantity,
          })
          .from(sellerListingVariantsTable)
          .innerJoin(
            sellerListingsTable,
            eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id),
          )
          .innerJoin(sellersTable, eq(sellerListingsTable.sellerId, sellersTable.id))
          .where(
            and(
              inArray(sellerListingsTable.productId, productIds),
              eq(sellerListingsTable.visibility, "public"),
              eq(sellerListingsTable.approvalStatus, "approved"),
              eq(sellersTable.status, "active"),
            ),
          )
      : [];
  const listingsByProduct = new Map<number, typeof listingRows>();
  for (const r of listingRows) {
    const list = listingsByProduct.get(r.productId) ?? [];
    list.push(r);
    listingsByProduct.set(r.productId, list);
  }

  const result = items.map(({ wishlist, product }) => {
    const stats = statsMap.get(product.id) ?? { avg: 0, count: 0 };
    const variants = variantsByProduct.get(product.id) ?? [];
    const effectivePrices = variants.map((v) =>
      v.discountPrice != null ? Number(v.discountPrice) : Number(v.price),
    );
    const adminPrice = effectivePrices.length > 0 ? Math.min(...effectivePrices) : null;
    const adminInStock = variants.some((v) => v.stock > 0);

    const listings = listingsByProduct.get(product.id) ?? [];
    const qualifyingListings = listings.filter((l) => l.availableQuantity > 0);
    const listingPrices = qualifyingListings.map((l) =>
      l.discountPrice != null ? Number(l.discountPrice) : Number(l.price),
    );
    const marketplacePrice = listingPrices.length > 0 ? Math.min(...listingPrices) : null;
    const marketplaceInStock = qualifyingListings.length > 0;

    // Same "admin wins if present, else marketplace fallback" rule as
    // routes/search.ts -- see that file's doc comment for why this
    // endpoint's fields don't need the same admin/marketplace field split
    // toProduct() in routes/products.ts uses.
    const startingPrice = adminPrice ?? marketplacePrice;
    const inStock = variants.length > 0 ? adminInStock : marketplaceInStock;

    return {
      id: wishlist.id,
      productId: wishlist.productId,
      addedAt: wishlist.addedAt.toISOString(),
      product: {
        id: product.id,
        name: product.name,
        slug: product.slug,
        categoryId: product.categoryId,
        description: product.description,
        images: product.images as string[],
        startingPrice,
        inStock,
        averageRating: stats.avg,
        reviewCount: Number(stats.count),
        isFeatured: product.homepageTag,
        createdAt: product.createdAt.toISOString(),
      },
    };
  });

  // Seller-listing rows (seller_listing_variant_id IS NOT NULL) -- kept as
  // a second, differently-shaped array rather than merged into `result`
  // above, since these need listing/variant/seller data, not the admin-
  // variant/marketplace-fallback product pricing that only applies when no
  // seller has been chosen yet. A row here means "this exact seller's
  // variant", not "this product from any seller".
  const listingItems = await db
    .select({
      wishlist: wishlistTable,
      variant: sellerListingVariantsTable,
      listing: sellerListingsTable,
      product: productsTable,
      seller: sellersTable,
    })
    .from(wishlistTable)
    .innerJoin(
      sellerListingVariantsTable,
      eq(wishlistTable.sellerListingVariantId, sellerListingVariantsTable.id),
    )
    .innerJoin(
      sellerListingsTable,
      eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id),
    )
    .innerJoin(productsTable, eq(sellerListingsTable.productId, productsTable.id))
    .innerJoin(sellersTable, eq(sellerListingsTable.sellerId, sellersTable.id))
    .where(
      and(eq(wishlistTable.userId, req.userId!), isNotNull(wishlistTable.sellerListingVariantId)),
    );

  const sellerListingResult = listingItems.map(
    ({ wishlist, variant, listing, product, seller }) => ({
      id: wishlist.id,
      productId: wishlist.productId,
      sellerListingVariantId: variant.id,
      addedAt: wishlist.addedAt.toISOString(),
      product: {
        id: product.id,
        name: product.name,
        slug: product.slug,
        images: product.images as string[],
      },
      listing: { id: listing.id, images: listing.images as string[] },
      seller: { id: seller.id, businessName: seller.businessName, nurseryName: seller.nurseryName },
      variant,
    }),
  );

  res.json({ products: result, sellerListings: sellerListingResult });
});

router.post(
  "/wishlist/:productId",
  requireGuestOrAuth,
  wishlistLimiter,
  validateParams(AddToWishlistParams, "AddToWishlistParams"),
  async (req: ApiRequest, res) => {
    const productId = req.params.productId as unknown as number; // P0-1: validated + coerced to number
    try {
      await db.insert(wishlistTable).values({ userId: req.userId!, productId });
    } catch (err) {
      logger.error({ err }, "Unhandled error in route");
    }
    res.json({ message: "Added to wishlist" });
  },
);

router.delete(
  "/wishlist/:productId",
  requireGuestOrAuth,
  wishlistLimiter,
  validateParams(RemoveFromWishlistParams, "RemoveFromWishlistParams"),
  async (req: ApiRequest, res) => {
    const productId = req.params.productId as unknown as number; // P0-1: validated + coerced to number
    // Scoped to seller_listing_variant_id IS NULL -- this route removes only
    // the plain product-variety wishlist row. Kept explicit (rather than
    // relying on there simply being no other row to match) so this route can
    // never be repurposed to accidentally also remove a user's seller-listing
    // wishlist rows for the same product.
    await db
      .delete(wishlistTable)
      .where(
        and(
          eq(wishlistTable.userId, req.userId!),
          eq(wishlistTable.productId, productId),
          isNull(wishlistTable.sellerListingVariantId),
        ),
      );
    res.json({ message: "Removed from wishlist" });
  },
);

router.post(
  "/wishlist/seller-listing-variant/:variantId",
  requireGuestOrAuth,
  wishlistLimiter,
  validateParams(
    AddSellerListingVariantToWishlistParams,
    "AddSellerListingVariantToWishlistParams",
  ),
  async (req: ApiRequest, res) => {
    const sellerListingVariantId = req.params.variantId as unknown as number; // P0-1: validated + coerced to number
    const [variant] = await db
      .select()
      .from(sellerListingVariantsTable)
      .where(eq(sellerListingVariantsTable.id, sellerListingVariantId));
    if (!variant) {
      res.status(404).json({ message: "Listing variant not found" });
      return;
    }
    const [listing] = await db
      .select()
      .from(sellerListingsTable)
      .where(eq(sellerListingsTable.id, variant.sellerListingId));
    if (!listing) {
      res.status(404).json({ message: "Listing not found" });
      return;
    }
    try {
      await db.insert(wishlistTable).values({
        userId: req.userId!,
        productId: listing.productId,
        sellerListingVariantId,
      });
    } catch (err) {
      logger.error({ err }, "Unhandled error in route");
    }
    res.json({ message: "Added to wishlist" });
  },
);

router.delete(
  "/wishlist/seller-listing-variant/:variantId",
  requireGuestOrAuth,
  wishlistLimiter,
  validateParams(
    RemoveSellerListingVariantFromWishlistParams,
    "RemoveSellerListingVariantFromWishlistParams",
  ),
  async (req: ApiRequest, res) => {
    const sellerListingVariantId = req.params.variantId as unknown as number; // P0-1: validated + coerced to number
    await db
      .delete(wishlistTable)
      .where(
        and(
          eq(wishlistTable.userId, req.userId!),
          eq(wishlistTable.sellerListingVariantId, sellerListingVariantId),
        ),
      );
    res.json({ message: "Removed from wishlist" });
  },
);

// ─── POST /wishlist/merge ──────────────────────────────────────────────────
// Mirrors POST /cart/merge. After OTP verification, a verified guest's
// localStorage wishlist (maintained by GuestWishlistContext.tsx) is sent
// to this endpoint in one batch and upserted into the server wishlist
// table under userId = "guest_<phone>". When the guest later signs up
// with the same phone, accountClaim.ts migrates the rows to their
// clerkId (same pattern as cart_items + orders).
//
// Why a dedicated merge endpoint (vs. looping POST /wishlist/:productId
// from the client):
//   1. Atomicity — all writes happen inside one db.transaction. If the
//      3rd insert fails, the first 2 roll back (the previous cart-merge
//      implementation learned this lesson the hard way — see cart.ts's
//      merge doc comment).
//   2. Performance — one round-trip, batched existence check, no N+1.
//   3. Idempotency — the unique partial indexes on wishlist
//      (wishlist_user_product_unique, wishlist_user_seller_listing_variant_unique)
//      make re-merging the same items a no-op. Safe to retry.
//   4. Validation — re-validates that the productId/sellerListingVariantId
//      still exist (a stale localStorage entry from days ago may point at
//      a since-deleted product/variant).
//
// Returns:
//   { merged: number, skipped: { productId, reason }[] }
// where `skipped` lists any localStorage items that couldn't be merged
// (deleted product, deleted listing variant, cap exceeded). The client
// uses skipped[] only for logging — the merge is best-effort.
router.post(
  "/wishlist/merge",
  requireGuestOrAuth,
  wishlistLimiter,
  validateBody(MergeWishlistBody, "MergeWishlistBody"),
  async (req: ApiRequest<z.infer<typeof MergeWishlistBody>>, res) => {
    try {
      const { products, sellerListingVariants } = req.body;
      const skipped: { productId?: number; sellerListingVariantId?: number; reason: string }[] = [];

      if (products.length === 0 && sellerListingVariants.length === 0) {
        res.json({ merged: 0, skipped: [] });
        return;
      }

      // ── Batch fetch existence + validity ───────────────────────────────
      // Pre-fetch all product rows and seller-listing-variant rows in two
      // batch queries (avoids N+1 inside the transaction). Also fetch
      // the parent listing + seller for each variant, so we can validate
      // the listing still exists and is approved/public (a guest might
      // have wishlisted a listing that the seller later hid or that an
      // admin rejected).
      const productIds = products.map((p) => p.productId);
      const productRows =
        productIds.length > 0
          ? await db
              .select({ id: productsTable.id })
              .from(productsTable)
              .where(inArray(productsTable.id, productIds))
          : [];
      const productExists = new Set(productRows.map((r) => r.id));

      const variantIds = sellerListingVariants.map((v) => v.sellerListingVariantId);
      const variantRows =
        variantIds.length > 0
          ? await db
              .select({
                variant: sellerListingVariantsTable,
                listing: sellerListingsTable,
              })
              .from(sellerListingVariantsTable)
              .innerJoin(
                sellerListingsTable,
                eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id),
              )
              .where(inArray(sellerListingVariantsTable.id, variantIds))
          : [];
      const variantMap = new Map(variantRows.map((r) => [r.variant.id, r]));

      // ── Batch fetch existing wishlist rows for this user ───────────────
      // (so we can skip items already wishlisted without an N+1 SELECT-per-
      // insert inside the transaction).
      const existingRows = await db
        .select({
          productId: wishlistTable.productId,
          sellerListingVariantId: wishlistTable.sellerListingVariantId,
        })
        .from(wishlistTable)
        .where(eq(wishlistTable.userId, req.userId!));
      const existingProductIds = new Set(
        existingRows.filter((r) => r.sellerListingVariantId == null).map((r) => r.productId),
      );
      const existingVariantIds = new Set(
        existingRows
          .filter((r) => r.sellerListingVariantId != null)
          .map((r) => r.sellerListingVariantId!),
      );

      // ── Cap check ───────────────────────────────────────────────────────
      // MAX_WISHLIST_LINES is the hard ceiling. Existing + new - dedup
      // must not exceed it. Reject the whole merge if it would — partial
      // merges would silently drop items the user expected to be saved.
      const newProducts = products.filter(
        (p) => !existingProductIds.has(p.productId) && productExists.has(p.productId),
      );
      const newVariants = sellerListingVariants.filter(
        (v) =>
          !existingVariantIds.has(v.sellerListingVariantId) &&
          variantMap.has(v.sellerListingVariantId),
      );
      const totalAfterMerge = existingRows.length + newProducts.length + newVariants.length;
      if (totalAfterMerge > MAX_WISHLIST_LINES) {
        res.status(400).json({
          error: `Merging would exceed the maximum wishlist size (${MAX_WISHLIST_LINES} items). Remove items from your wishlist and try again.`,
        });
        return;
      }

      // ── Atomic merge inside one transaction ───────────────────────────
      // Same pattern as cart.ts's merge — all writes happen inside one
      // db.transaction so a mid-merge failure rolls back the entire batch.
      // READ COMMITTED (default) is sufficient — no read-then-write race
      // like checkout's stock-decrement.
      const { mergedCount } = await db.transaction(async (tx) => {
        let count = 0;

        // Product-variety rows (seller_listing_variant_id IS NULL).
        // Reuse the unique partial index wishlist_user_product_unique
        // (declared in schema/wishlist.ts) by inserting with ON CONFLICT
        // DO NOTHING — idempotent re-merges of the same localStorage cart
        // are a no-op rather than a 409.
        for (const p of newProducts) {
          try {
            await tx
              .insert(wishlistTable)
              .values({
                userId: req.userId!,
                productId: p.productId,
              })
              .onConflictDoNothing({
                target: [wishlistTable.userId, wishlistTable.productId],
                where: sql`seller_listing_variant_id IS NULL`,
              });
            count++;
          } catch (err) {
            // Defensive: onConflictDoNothing should make this unreachable,
            // but log + skip rather than abort the whole merge if some
            // unexpected constraint trips on one row.
            logger.warn(
              { err, productId: p.productId, userId: req.userId },
              "wishlist merge: product insert failed, skipping",
            );
            skipped.push({ productId: p.productId, reason: "Insert failed" });
          }
        }

        // Seller-listing-variant rows (seller_listing_variant_id NOT NULL).
        // Use the unique partial index wishlist_user_seller_listing_variant_unique
        // for ON CONFLICT DO NOTHING.
        for (const v of newVariants) {
          const row = variantMap.get(v.sellerListingVariantId)!;
          try {
            await tx
              .insert(wishlistTable)
              .values({
                userId: req.userId!,
                productId: row.listing.productId,
                sellerListingVariantId: v.sellerListingVariantId,
              })
              .onConflictDoNothing({
                target: [wishlistTable.userId, wishlistTable.sellerListingVariantId],
                where: sql`seller_listing_variant_id IS NOT NULL`,
              });
            count++;
          } catch (err) {
            logger.warn(
              { err, sellerListingVariantId: v.sellerListingVariantId, userId: req.userId },
              "wishlist merge: variant insert failed, skipping",
            );
            skipped.push({
              sellerListingVariantId: v.sellerListingVariantId,
              reason: "Insert failed",
            });
          }
        }

        return { mergedCount: count };
      });

      // Skipped items: anything in the request that wasn't already on the
      // server wishlist AND couldn't be merged (deleted product/variant,
      // unapproved listing, etc.).
      for (const p of products) {
        if (existingProductIds.has(p.productId)) continue; // already there
        if (productExists.has(p.productId)) continue; // merged above
        skipped.push({ productId: p.productId, reason: "Product no longer exists" });
      }
      for (const v of sellerListingVariants) {
        if (existingVariantIds.has(v.sellerListingVariantId)) continue;
        const row = variantMap.get(v.sellerListingVariantId);
        if (!row) {
          skipped.push({
            sellerListingVariantId: v.sellerListingVariantId,
            reason: "Listing variant no longer exists",
          });
          continue;
        }
        if (row.listing.approvalStatus !== "approved" || row.listing.visibility !== "public") {
          skipped.push({
            sellerListingVariantId: v.sellerListingVariantId,
            reason: "Listing is no longer available",
          });
        }
      }

      res.json({ merged: mergedCount, skipped });
    } catch (err) {
      logger.error({ err, userId: req.userId }, "wishlist: merge failed");
      res.status(500).json({ error: "Failed to merge guest wishlist" });
    }
  },
);

export default router;
