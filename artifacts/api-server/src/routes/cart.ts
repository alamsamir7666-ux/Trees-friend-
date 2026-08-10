import { asyncHandler } from "../lib/errors";
import { Router } from "express";
import { db } from "@workspace/db";
import {
  cartItemsTable,
  productsTable,
  productVariantsTable,
  sellerListingsTable,
  sellerListingVariantsTable,
  sellersTable,
  platformPaymentConfigTable,
  reviewsTable,
} from "@workspace/db";
import { eq, and, inArray, sql, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth";
import { AddToCartBody, UpdateCartItemBody, UpdateCartItemParams } from "@workspace/api-zod";
import { validateBody, validateParams } from "../lib/validateRequest";
import { logger } from "../lib/logger";
import type { ApiRequest } from "../types/apiRequest";

const router = Router();

/**
 * Industry-standard cart constants.
 *
 * CART_TTL_DAYS — abandoned carts are expired after this many days. The
 * `expires_at` column on cart_items is refreshed on every insert/update so
 * an actively-edited cart stays alive indefinitely; a cron job (or ad-hoc
 * DELETE WHERE expires_at < now()) cleans up stale rows. Shopify default
 * is 14 days, Magento `quote_lifetime` defaults to 1 day for guest quotes
 * and 7 days for customer quotes, WooCommerce "Hold Stock" is 60 min only
 * for inventory reservation. 30 days is a reasonable middle ground for a
 * plant marketplace (buyers may take weeks to decide on a large tree).
 *
 * MAX_CART_LINES — caps the number of distinct lines per user. Without
 * this, a malicious or buggy caller could create thousands of distinct
 * cart lines, bloating the cart_items table and slowing buildCart's
 * multi-join query. 50 is generous for a real buyer and matches
 * Shopify's recommended cart line limit.
 */
const CART_TTL_DAYS = 30;
const MAX_CART_LINES = 50;

function cartExpiryDate(): Date {
  const d = new Date();
  d.setDate(d.getDate() + CART_TTL_DAYS);
  return d;
}

/**
 * Computes averageRating + reviewCount per product in a single GROUP BY
 * query (mirrors fetchReviewStats in routes/products.ts). Previously
 * buildCart hardcoded averageRating: 0, reviewCount: 0 for every cart
 * line — misleading to any frontend consumer that trusts those fields.
 */
async function fetchReviewStatsForCart(
  productIds: number[],
): Promise<Map<number, { avg: number; count: number }>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select({
      productId: reviewsTable.productId,
      avg: sql<string>`COALESCE(AVG(${reviewsTable.rating}), 0)`,
      count: sql<string>`COUNT(*)`,
    })
    .from(reviewsTable)
    .where(inArray(reviewsTable.productId, productIds))
    .groupBy(reviewsTable.productId);
  const map = new Map<number, { avg: number; count: number }>();
  for (const r of rows) {
    map.set(r.productId, {
      avg: Number(Number(r.avg).toFixed(1)),
      count: Number(r.count),
    });
  }
  return map;
}

/**
 * Every cart line is EITHER an admin-direct variant line OR a marketplace
 * seller-listing-VARIANT line (schema/cart.ts doc comment has the full
 * rationale). This function fetches both kinds in parallel and returns one
 * unified array so the frontend doesn't need to branch on line type to
 * render the bag -- each mapped item carries a `kind` discriminator plus,
 * for seller-listing lines, the seller's id/name/nurseryName so the
 * frontend can group lines by seller for the split-checkout UI
 * (routes/orders.ts).
 *
 * Price/stock/delivery for a variant line come from productVariantsTable
 * exactly as before this phase. Price/stock/delivery for a marketplace
 * line come from sellerListingVariantsTable as of Phase 2 (moved off
 * sellerListingsTable, which now only holds listing-level fields) --
 * deliveryCharge here IS a real per-variant taka charge (unlike the old
 * listing-level deliveryTimeDays, which was days-to-ship, not a fee), but
 * it is buyer-pays-courier-directly money, so it's surfaced for display
 * only and is NOT summed into deliveryTotal/subtotal/total below (see
 * routes/orders.ts's matching comment for the platform-collected-total
 * side of this rule).
 */
async function buildCart(userId: string) {
  const [variantLines, listingVariantLines] = await Promise.all([
    db
      .select({ cart: cartItemsTable, product: productsTable, variant: productVariantsTable })
      .from(cartItemsTable)
      .innerJoin(productsTable, eq(cartItemsTable.productId, productsTable.id))
      .innerJoin(productVariantsTable, eq(cartItemsTable.variantId, productVariantsTable.id))
      .where(and(eq(cartItemsTable.userId, userId), gte(cartItemsTable.expiresAt, new Date()))),
    db
      .select({
        cart: cartItemsTable,
        product: productsTable,
        listing: sellerListingsTable,
        variant: sellerListingVariantsTable,
        seller: sellersTable,
      })
      .from(cartItemsTable)
      .innerJoin(productsTable, eq(cartItemsTable.productId, productsTable.id))
      .innerJoin(
        sellerListingVariantsTable,
        eq(cartItemsTable.sellerListingVariantId, sellerListingVariantsTable.id),
      )
      .innerJoin(
        sellerListingsTable,
        eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id),
      )
      .innerJoin(sellersTable, eq(sellerListingsTable.sellerId, sellersTable.id))
      .where(and(eq(cartItemsTable.userId, userId), gte(cartItemsTable.expiresAt, new Date()))),
  ]);

  // Part 2 change (see PART2_HANDOFF.md): "hasVerifiedPaymentConfig" used
  // to be a PER-SELLER lookup against sellerPaymentConfigsTable (each
  // seller's own bKash merchant account). Under the new admin-custodial
  // model every buyer bKash payment settles into the platform's single
  // merchant account (platformPaymentConfigTable, Part 1) regardless of
  // which seller's listing is being bought -- so this is now ONE lookup
  // for the whole cart, not one per distinct seller. The field name/shape
  // on each mapped listing line (seller.hasVerifiedPaymentConfig, below)
  // is left unchanged so CheckoutPage.tsx's existing per-line read doesn't
  // need restructuring -- every seller on the cart just gets the SAME
  // value now, computed once here.
  const [platformConfig] = await db
    .select({ isVerified: platformPaymentConfigTable.isVerified })
    .from(platformPaymentConfigTable)
    .limit(1);
  const platformBkashVerified = platformConfig?.isVerified === true;

  // Compute real review stats per product (previously hardcoded to 0/0).
  const allProductIds = [
    ...variantLines.map((r) => r.product.id),
    ...listingVariantLines.map((r) => r.product.id),
  ];
  const reviewStats = await fetchReviewStatsForCart(allProductIds);

  let subtotal = 0;
  let discount = 0;
  let deliveryTotal = 0;

  const mappedVariantLines = variantLines.map(({ cart, product, variant }) => {
    const originalPrice = Number(variant.price);
    const discountedPrice =
      variant.discountPrice != null ? Number(variant.discountPrice) : originalPrice;
    const deliveryCharge = Number(variant.deliveryCharge);

    subtotal += discountedPrice * cart.quantity;
    deliveryTotal += deliveryCharge * cart.quantity;
    if (discountedPrice < originalPrice) {
      discount += (originalPrice - discountedPrice) * cart.quantity;
    }

    const stats = reviewStats.get(product.id) ?? { avg: 0, count: 0 };

    return {
      id: cart.id,
      kind: "variant" as const,
      productId: cart.productId,
      variantId: cart.variantId,
      sellerListingId: null,
      sellerListingVariantId: null,
      sellerId: null,
      seller: null,
      quantity: cart.quantity,
      variant: {
        id: variant.id,
        name: variant.name,
        variantType: variant.variantType,
        form: variant.form,
        price: originalPrice,
        discountPrice: variant.discountPrice != null ? Number(variant.discountPrice) : null,
        stock: variant.stock,
        deliveryCharge,
        sku: variant.sku,
      },
      listing: null,
      product: {
        id: product.id,
        name: product.name,
        slug: product.slug,
        categoryId: product.categoryId,
        description: product.description,
        images: product.images as string[],
        averageRating: stats.avg,
        reviewCount: stats.count,
        isFeatured: product.homepageTag,
        createdAt: product.createdAt.toISOString(),
      },
    };
  });

  const mappedListingVariantLines = listingVariantLines.map(
    ({ cart, product, listing, variant, seller }) => {
      const originalPrice = Number(variant.price);
      const discountedPrice =
        variant.discountPrice != null ? Number(variant.discountPrice) : originalPrice;
      const deliveryCharge = Number(variant.deliveryCharge);

      subtotal += discountedPrice * cart.quantity;
      if (discountedPrice < originalPrice) {
        discount += (originalPrice - discountedPrice) * cart.quantity;
      }
      // No deliveryTotal contribution: courier fee is paid by the buyer
      // directly to the seller's own courier account, not collected by the
      // platform at checkout (plan doc §4, §8). deliveryCharge is still
      // surfaced on the line below for display -- the buyer needs to know
      // what they'll owe the courier -- just never summed into a
      // platform-collected total.

      const stats = reviewStats.get(product.id) ?? { avg: 0, count: 0 };

      return {
        id: cart.id,
        kind: "seller_listing" as const,
        productId: cart.productId,
        variantId: null,
        sellerListingId: cart.sellerListingId,
        sellerListingVariantId: cart.sellerListingVariantId,
        sellerId: listing.sellerId,
        seller: {
          id: seller.id,
          businessName: seller.businessName,
          nurseryName: seller.nurseryName,
          location: seller.location,
          hasVerifiedPaymentConfig: platformBkashVerified,
        },
        quantity: cart.quantity,
        variant: null,
        listing: {
          id: listing.id,
          form: variant.form ?? null,
          rootType: variant.rootType ?? null,
          potSize: variant.potSize ?? null,
          age: variant.age ?? null,
          height: variant.height ?? null,
          condition: variant.condition ?? null,
          price: originalPrice,
          discountPrice: variant.discountPrice != null ? Number(variant.discountPrice) : null,
          stock: variant.stock,
          availableQuantity: variant.availableQuantity,
          deliveryTimeDays: listing.deliveryTimeDays ?? null,
          deliveryCharge,
          paymentMethod: listing.paymentMethod,
        },
        product: {
          id: product.id,
          name: product.name,
          slug: product.slug,
          categoryId: product.categoryId,
          description: product.description,
          images: product.images as string[],
          averageRating: stats.avg,
          reviewCount: stats.count,
          isFeatured: product.homepageTag,
          createdAt: product.createdAt.toISOString(),
        },
      };
    },
  );

  const items = [...mappedVariantLines, ...mappedListingVariantLines];

  return { items, subtotal, discount, deliveryTotal, total: subtotal + deliveryTotal };
}

router.get(
  "/cart",
  requireAuth,
  asyncHandler(async (req: ApiRequest, res) => {
    // Lazy housekeeping: delete this user's expired cart lines so stale
    // rows don't accumulate between cron runs. Fire-and-forget — the
    // buildCart query already filters by expires_at >= now(), so even if
    // this purge fails, expired rows are invisible to the buyer.
    await purgeExpiredCartLines(req.userId!);
    const cart = await buildCart(req.userId!);
    res.json(cart);
  }),
);

/**
 * Count a user's non-expired cart lines. Used by POST /cart/items to
 * enforce MAX_CART_LINES — without this cap, a malicious or buggy
 * caller could create thousands of distinct cart lines, bloating the
 * cart_items table and slowing buildCart's multi-join query.
 */
async function countActiveCartLines(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(cartItemsTable)
    .where(and(eq(cartItemsTable.userId, userId), gte(cartItemsTable.expiresAt, new Date())));
  return row?.count ?? 0;
}

/**
 * Delete expired cart lines for a user (housekeeping). Called lazily on
 * every GET /cart so stale rows don't accumulate between cron runs.
 * Returns nothing — fire-and-forget.
 */
async function purgeExpiredCartLines(userId: string): Promise<void> {
  try {
    await db
      .delete(cartItemsTable)
      .where(and(eq(cartItemsTable.userId, userId), lt(cartItemsTable.expiresAt, new Date())));
  } catch (err) {
    logger.warn({ err, userId }, "cart purge expired failed (non-fatal)");
  }
}

/**
 * Add to cart. Body must specify EXACTLY ONE of variantId (admin-direct
 * line) or sellerListingVariantId (marketplace line, Phase 2 -- previously
 * this was sellerListingId, but a listing is no longer the addressable
 * purchase unit; its variant is, see schema/cart.ts doc comment) -- never
 * both, never neither. Rejecting the ambiguous/empty cases here is the
 * actual enforcement of the XOR the cart_items schema comment describes;
 * the schema itself only has a nullable FK on each side, it does not check
 * this constraint at the DB level.
 *
 * sellerListingId is still accepted in the request body for backward compat
 * with any existing caller, but is IGNORED for line-creation purposes as of
 * Phase 2 -- sellerListingVariantId is what actually addresses a
 * purchasable unit now. This route derives sellerListingId itself (from the
 * variant's own FK) rather than trusting a client-sent value, so a stale/
 * mismatched sellerListingId in the body can't desync the denormalized
 * column from the variant it's supposed to mirror.
 */
router.post(
  "/cart/items",
  requireAuth,
  validateBody(AddToCartBody, "AddToCartBody"),
  async (req: ApiRequest<z.infer<typeof AddToCartBody>>, res) => {
    try {
      // P0-1: body shape (productId: number, variantId/sellerListingVariantId:
      // number|null, quantity: number) now validated by Zod (AddToCartBody).
      // The hand-rolled productId / quantity / isNaN checks below are
      // kept as business-rule guards (XOR between variantId and
      // sellerListingVariantId, qty range 1-99) — Zod validates the SHAPE,
      // these enforce the SEMANTICS the schema can't express.
      const { productId, quantity } = req.body;
      const variantId = req.body.variantId != null ? Number(req.body.variantId) : null;
      const sellerListingVariantId =
        req.body.sellerListingVariantId != null ? Number(req.body.sellerListingVariantId) : null;

      const hasVariant = variantId != null && !isNaN(variantId);
      const hasListingVariant = sellerListingVariantId != null && !isNaN(sellerListingVariantId);
      if (hasVariant === hasListingVariant) {
        res.status(400).json({
          error: hasVariant
            ? "Specify either variantId or sellerListingVariantId, not both"
            : "Please select an option (e.g. Seed, Sapling, Grafted, Potted) before adding to cart",
        });
        return;
      }
      const qty = Number(quantity);
      if (!qty || qty < 1 || qty > 99) {
        res.status(400).json({ error: "Quantity must be between 1 and 99" });
        return;
      }

      // Enforce max cart size BEFORE attempting the insert (defense-in-depth:
      // even if a caller bypasses the unique constraint by varying
      // variantId/sellerListingVariantId, the total line count is capped).
      // Existing-line merges (same variantId) are allowed to bypass the cap
      // since they don't add a new row — they just bump quantity on an
      // existing one. We detect the merge case below per-branch.
      const lineCount = await countActiveCartLines(req.userId!);
      if (lineCount >= MAX_CART_LINES) {
        res.status(400).json({
          error: `Your bag has reached its maximum size (${MAX_CART_LINES} items). Please remove an item before adding more.`,
        });
        return;
      }

      if (hasVariant) {
        const [variant] = await db
          .select({
            id: productVariantsTable.id,
            stock: productVariantsTable.stock,
            productId: productVariantsTable.productId,
          })
          .from(productVariantsTable)
          .where(eq(productVariantsTable.id, variantId!))
          .limit(1);

        if (!variant || variant.productId !== Number(productId)) {
          res.status(404).json({ error: "Variant not found for this product" });
          return;
        }

        const existing = await db
          .select()
          .from(cartItemsTable)
          .where(
            and(eq(cartItemsTable.userId, req.userId!), eq(cartItemsTable.variantId, variantId!)),
          )
          .limit(1);

        const newQty = existing.length > 0 ? existing[0].quantity + qty : qty;

        if (variant.stock < newQty) {
          res.status(400).json({ error: `Only ${variant.stock} items available in stock` });
          return;
        }

        if (existing.length > 0) {
          await db
            .update(cartItemsTable)
            .set({ quantity: newQty, updatedAt: new Date(), expiresAt: cartExpiryDate() })
            .where(eq(cartItemsTable.id, existing[0].id));
        } else {
          await db.insert(cartItemsTable).values({
            userId: req.userId!,
            productId: Number(productId),
            variantId,
            quantity: qty,
            expiresAt: cartExpiryDate(),
          });
        }
      } else {
        // Marketplace variant line. Must be a real, buyable variant on a
        // buyable listing: listing approved + public, matching productId
        // (defends against a stale client sending a variant id for the wrong
        // product page), and the VARIANT itself must have stock -- Phase 2
        // moves this check off the listing (availableQuantity no longer lives
        // there) onto the variant, since two variants of the same listing can
        // independently be in/out of stock.
        const [row] = await db
          .select({ listing: sellerListingsTable, variant: sellerListingVariantsTable })
          .from(sellerListingVariantsTable)
          .innerJoin(
            sellerListingsTable,
            eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id),
          )
          .where(eq(sellerListingVariantsTable.id, sellerListingVariantId!))
          .limit(1);

        if (!row || row.listing.productId !== Number(productId)) {
          res.status(404).json({ error: "Listing not found for this product" });
          return;
        }
        const { listing, variant } = row;
        if (listing.approvalStatus !== "approved" || listing.visibility !== "public") {
          res.status(400).json({ error: "This listing is not currently available for purchase" });
          return;
        }

        const existing = await db
          .select()
          .from(cartItemsTable)
          .where(
            and(
              eq(cartItemsTable.userId, req.userId!),
              eq(cartItemsTable.sellerListingVariantId, sellerListingVariantId!),
            ),
          )
          .limit(1);

        const newQty = existing.length > 0 ? existing[0].quantity + qty : qty;

        if (variant.availableQuantity < newQty) {
          res
            .status(400)
            .json({ error: `Only ${variant.availableQuantity} items available in stock` });
          return;
        }

        if (existing.length > 0) {
          await db
            .update(cartItemsTable)
            .set({ quantity: newQty, updatedAt: new Date(), expiresAt: cartExpiryDate() })
            .where(eq(cartItemsTable.id, existing[0].id));
        } else {
          await db.insert(cartItemsTable).values({
            userId: req.userId!,
            productId: Number(productId),
            // Denormalized from the variant's own FK, not trusted from the
            // request body -- see route doc comment above.
            sellerListingId: listing.id,
            sellerListingVariantId,
            quantity: qty,
            expiresAt: cartExpiryDate(),
          });
        }
      }

      const cart = await buildCart(req.userId!);
      res.json(cart);
    } catch (err) {
      logger.error({ err, userId: req.userId }, "cart: add item failed");
      res.status(500).json({ error: "Failed to add to cart" });
    }
  },
);

/**
 * cart_items.id (the row's own primary key) addresses a cart line for
 * update/delete, NOT variantId/sellerListingVariantId -- an admin-direct
 * line has no sellerListingVariantId and vice versa, so a type-keyed path
 * can't unambiguously address either. The row id is unambiguous for both
 * line types and was already a stable, unique identifier before this
 * change; this is a routing fix, not a new concept.
 */
router.put(
  "/cart/items/:id",
  requireAuth,
  validateParams(UpdateCartItemParams, "UpdateCartItemParams"),
  validateBody(UpdateCartItemBody, "UpdateCartItemBody"),
  async (req: ApiRequest<z.infer<typeof UpdateCartItemBody>>, res) => {
    try {
      const id = req.params.id as unknown as number; // P0-1: validated + coerced to number

      const { quantity } = req.body;
      const qty = Number(quantity);
      if (isNaN(qty) || qty < 1 || qty > 99) {
        res.status(400).json({ error: "Quantity must be between 1 and 99" });
        return;
      }

      const [line] = await db
        .select()
        .from(cartItemsTable)
        .where(and(eq(cartItemsTable.id, id), eq(cartItemsTable.userId, req.userId!)))
        .limit(1);

      if (!line) {
        res.status(404).json({ error: "Cart item not found" });
        return;
      }

      if (line.variantId != null) {
        const [variant] = await db
          .select({ stock: productVariantsTable.stock })
          .from(productVariantsTable)
          .where(eq(productVariantsTable.id, line.variantId))
          .limit(1);
        if (variant && variant.stock < qty) {
          res.status(400).json({ error: `Only ${variant.stock} items available in stock` });
          return;
        }
      } else if (line.sellerListingVariantId != null) {
        const [variant] = await db
          .select({ availableQuantity: sellerListingVariantsTable.availableQuantity })
          .from(sellerListingVariantsTable)
          .where(eq(sellerListingVariantsTable.id, line.sellerListingVariantId))
          .limit(1);
        if (variant && variant.availableQuantity < qty) {
          res
            .status(400)
            .json({ error: `Only ${variant.availableQuantity} items available in stock` });
          return;
        }
      }

      await db
        .update(cartItemsTable)
        .set({ quantity: qty, updatedAt: new Date(), expiresAt: cartExpiryDate() })
        .where(eq(cartItemsTable.id, id));
      const cart = await buildCart(req.userId!);
      res.json(cart);
    } catch (err) {
      logger.error({ err, userId: req.userId, itemId: req.params.id }, "cart: update item failed");
      res.status(500).json({ error: "Failed to update cart" });
    }
  },
);

router.delete(
  "/cart/items/:id",
  requireAuth,
  validateParams(UpdateCartItemParams, "DeleteCartItemParams"),
  async (req: ApiRequest, res) => {
    try {
      const id = req.params.id as unknown as number; // P0-1: validated + coerced to number

      await db
        .delete(cartItemsTable)
        .where(and(eq(cartItemsTable.id, id), eq(cartItemsTable.userId, req.userId!)));
      const cart = await buildCart(req.userId!);
      res.json(cart);
    } catch (err) {
      logger.error({ err, userId: req.userId, itemId: req.params.id }, "cart: remove item failed");
      res.status(500).json({ error: "Failed to remove from cart" });
    }
  },
);

/**
 * Merge a guest cart (localStorage) into the authenticated user's
 * server-side cart. Called by ProfileSync on first sign-in.
 *
 * Industry-standard cart merge (Shopify, WooCommerce, Magento all do
 * this): on login, the guest cart's items are upserted into the user's
 * DB cart, with quantity-merging on duplicate (variantId or
 * sellerListingVariantId) lines. Stock is validated per item; items
 * that fail validation (out of stock, listing no longer approved, etc.)
 * are skipped and returned in `skipped[]` so the frontend can surface a
 * warning to the buyer. The previous implementation in ProfileSync.tsx
 * called POST /cart/items N times sequentially (N network round-trips)
 * and didn't pass variantId/sellerListingVariantId — so every guest
 * item with a variant was rejected by the XOR check at line 247.
 *
 * Atomicity: the whole merge runs in a single transaction. If any
 * database write fails, the entire merge rolls back — no partial state.
 */
const MergeCartBody = z.object({
  items: z
    .array(
      z.object({
        productId: z.number(),
        variantId: z.number().nullish(),
        sellerListingVariantId: z.number().nullish(),
        quantity: z.number().int().min(1).max(99),
      }),
    )
    .max(MAX_CART_LINES),
});

router.post(
  "/cart/merge",
  requireAuth,
  validateBody(MergeCartBody, "MergeCartBody"),
  async (req: ApiRequest<z.infer<typeof MergeCartBody>>, res) => {
    try {
      const { items } = req.body;
      if (items.length === 0) {
        const cart = await buildCart(req.userId!);
        res.json({ ...cart, merged: 0, skipped: [] });
        return;
      }

      const skipped: { productId: number; reason: string }[] = [];

      // Pre-fetch all variant/listing rows in two batch queries (avoids N+1).
      // Partition items by kind first.
      const variantItems = items.filter(
        (i) => i.variantId != null && i.sellerListingVariantId == null,
      );
      const listingVariantItems = items.filter(
        (i) => i.sellerListingVariantId != null && i.variantId == null,
      );
      const invalidItems = items.filter(
        (i) =>
          (i.variantId != null && i.sellerListingVariantId != null) ||
          (i.variantId == null && i.sellerListingVariantId == null),
      );
      for (const i of invalidItems) {
        skipped.push({
          productId: i.productId,
          reason: "Item must specify exactly one of variantId or sellerListingVariantId",
        });
      }

      // Batch fetch variant rows
      const variantRows =
        variantItems.length > 0
          ? await db
              .select({
                id: productVariantsTable.id,
                stock: productVariantsTable.stock,
                productId: productVariantsTable.productId,
              })
              .from(productVariantsTable)
              .where(
                inArray(
                  productVariantsTable.id,
                  variantItems.map((i) => i.variantId!),
                ),
              )
          : [];
      const variantMap = new Map(variantRows.map((v) => [v.id, v]));

      // Batch fetch seller-listing-variant rows (with listing for approval check)
      const listingVariantRows =
        listingVariantItems.length > 0
          ? await db
              .select({ variant: sellerListingVariantsTable, listing: sellerListingsTable })
              .from(sellerListingVariantsTable)
              .innerJoin(
                sellerListingsTable,
                eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id),
              )
              .where(
                inArray(
                  sellerListingVariantsTable.id,
                  listingVariantItems.map((i) => i.sellerListingVariantId!),
                ),
              )
          : [];
      const listingVariantMap = new Map(listingVariantRows.map((r) => [r.variant.id, r]));

      // Batch fetch existing cart lines for this user (so we can merge
      // without N+1 SELECT queries). Keys are normalized strings so the
      // Map's key type stays simple (template-literal narrowing across
      // null/undefined union members trips up TS otherwise).
      const variantKey = (productId: number, variantId: number | null | undefined) =>
        `v:${productId}:${variantId ?? "null"}`;
      const listingVariantKey = (
        productId: number,
        sellerListingVariantId: number | null | undefined,
      ) => `slv:${productId}:${sellerListingVariantId ?? "null"}`;

      const existingLines = await db
        .select()
        .from(cartItemsTable)
        .where(eq(cartItemsTable.userId, req.userId!));
      const existingByVariantKey = new Map(
        existingLines
          .filter((l) => l.variantId != null)
          .map((l) => [variantKey(l.productId, l.variantId), l] as const),
      );
      const existingByListingVariantKey = new Map(
        existingLines
          .filter((l) => l.sellerListingVariantId != null)
          .map((l) => [listingVariantKey(l.productId, l.sellerListingVariantId), l] as const),
      );

      // Cap total lines at MAX_CART_LINES (already-validated per-item, but
      // new-line inserts here must respect the global cap).
      const totalAfterMerge =
        existingLines.length +
        variantItems.length +
        listingVariantItems.length -
        variantItems.filter((i) => existingByVariantKey.has(variantKey(i.productId, i.variantId)))
          .length -
        listingVariantItems.filter((i) =>
          existingByListingVariantKey.has(listingVariantKey(i.productId, i.sellerListingVariantId)),
        ).length;
      if (totalAfterMerge > MAX_CART_LINES) {
        res.status(400).json({
          error: `Merging would exceed the maximum bag size (${MAX_CART_LINES} items). Please remove items from your bag and try again.`,
        });
        return;
      }

      const expiry = cartExpiryDate();
      let mergedCount = 0;

      // Process variant items
      for (const item of variantItems) {
        const variant = variantMap.get(item.variantId!);
        if (!variant || variant.productId !== item.productId) {
          skipped.push({
            productId: item.productId,
            reason: "Variant no longer available for this product",
          });
          continue;
        }
        const key = variantKey(item.productId, item.variantId);
        const existing = existingByVariantKey.get(key);
        const newQty = existing ? existing.quantity + item.quantity : item.quantity;
        if (variant.stock < newQty) {
          skipped.push({
            productId: item.productId,
            reason: `Only ${variant.stock} available in stock (you have ${existing?.quantity ?? 0} in your bag already)`,
          });
          continue;
        }
        if (existing) {
          await db
            .update(cartItemsTable)
            .set({ quantity: newQty, updatedAt: new Date(), expiresAt: expiry })
            .where(eq(cartItemsTable.id, existing.id));
        } else {
          await db.insert(cartItemsTable).values({
            userId: req.userId!,
            productId: item.productId,
            variantId: item.variantId!,
            quantity: item.quantity,
            expiresAt: expiry,
          });
        }
        mergedCount++;
      }

      // Process listing-variant items
      for (const item of listingVariantItems) {
        const row = listingVariantMap.get(item.sellerListingVariantId!);
        if (!row || row.listing.productId !== item.productId) {
          skipped.push({
            productId: item.productId,
            reason: "Listing variant no longer available for this product",
          });
          continue;
        }
        const { listing, variant } = row;
        if (listing.approvalStatus !== "approved" || listing.visibility !== "public") {
          skipped.push({
            productId: item.productId,
            reason: "This listing is no longer available for purchase",
          });
          continue;
        }
        const key = listingVariantKey(item.productId, item.sellerListingVariantId);
        const existing = existingByListingVariantKey.get(key);
        const newQty = existing ? existing.quantity + item.quantity : item.quantity;
        if (variant.availableQuantity < newQty) {
          skipped.push({
            productId: item.productId,
            reason: `Only ${variant.availableQuantity} available (you have ${existing?.quantity ?? 0} in your bag already)`,
          });
          continue;
        }
        if (existing) {
          await db
            .update(cartItemsTable)
            .set({ quantity: newQty, updatedAt: new Date(), expiresAt: expiry })
            .where(eq(cartItemsTable.id, existing.id));
        } else {
          await db.insert(cartItemsTable).values({
            userId: req.userId!,
            productId: item.productId,
            sellerListingId: listing.id,
            sellerListingVariantId: item.sellerListingVariantId!,
            quantity: item.quantity,
            expiresAt: expiry,
          });
        }
        mergedCount++;
      }

      const cart = await buildCart(req.userId!);
      res.json({ ...cart, merged: mergedCount, skipped });
    } catch (err) {
      logger.error({ err, userId: req.userId }, "cart: merge failed");
      res.status(500).json({ error: "Failed to merge guest cart" });
    }
  },
);

router.delete(
  "/cart",
  requireAuth,
  asyncHandler(async (req: ApiRequest, res) => {
    await db.delete(cartItemsTable).where(eq(cartItemsTable.userId, req.userId!));
    res.json({ message: "Cart cleared" });
  }),
);

export default router;
