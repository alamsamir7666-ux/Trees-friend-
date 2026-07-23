import { Router } from "express";
import { db } from "@workspace/db";
import {
  cartItemsTable,
  productsTable,
  productVariantsTable,
  sellerListingsTable,
  sellerListingVariantsTable,
  sellersTable,
  sellerPaymentConfigsTable,
} from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();

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
      .where(eq(cartItemsTable.userId, userId)),
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
      .innerJoin(sellerListingVariantsTable, eq(cartItemsTable.sellerListingVariantId, sellerListingVariantsTable.id))
      .innerJoin(sellerListingsTable, eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id))
      .innerJoin(sellersTable, eq(sellerListingsTable.sellerId, sellersTable.id))
      .where(eq(cartItemsTable.userId, userId)),
  ]);

  // Batch-fetch verified-payment-config status for every distinct seller
  // touched by this cart's listing lines, in one query (not per-row), the
  // same way this function already runs variantLines/listingVariantLines as
  // two parallel top-level queries rather than one query per line.
  // isVerified must be true AND a row must exist -- same rule as
  // hasVerifiedPaymentConfig() in sellerListings.ts -- because a listing's
  // own paymentMethod field can drift from the seller's actual config
  // state (e.g. an admin unverifies a seller without touching their
  // listings), and checkout needs the live truth, not the listing's claim.
  const distinctSellerIds = [...new Set(listingVariantLines.map((row) => row.listing.sellerId))];
  const verifiedSellerIds = new Set<number>();
  if (distinctSellerIds.length > 0) {
    const paymentConfigRows = await db
      .select({ sellerId: sellerPaymentConfigsTable.sellerId, isVerified: sellerPaymentConfigsTable.isVerified })
      .from(sellerPaymentConfigsTable)
      .where(inArray(sellerPaymentConfigsTable.sellerId, distinctSellerIds));
    for (const row of paymentConfigRows) {
      if (row.isVerified === true) verifiedSellerIds.add(row.sellerId);
    }
  }

  let subtotal = 0;
  let discount = 0;
  let deliveryTotal = 0;

  const mappedVariantLines = variantLines.map(({ cart, product, variant }) => {
    const originalPrice = Number(variant.price);
    const discountedPrice = variant.discountPrice != null ? Number(variant.discountPrice) : originalPrice;
    const deliveryCharge = Number(variant.deliveryCharge);

    subtotal += discountedPrice * cart.quantity;
    deliveryTotal += deliveryCharge * cart.quantity;
    if (discountedPrice < originalPrice) {
      discount += (originalPrice - discountedPrice) * cart.quantity;
    }

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
        averageRating: 0,
        reviewCount: 0,
        isFeatured: product.homepageTag,
        createdAt: product.createdAt.toISOString(),
      },
    };
  });

  const mappedListingVariantLines = listingVariantLines.map(({ cart, product, listing, variant, seller }) => {
    const originalPrice = Number(variant.price);
    const discountedPrice = variant.discountPrice != null ? Number(variant.discountPrice) : originalPrice;
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
        hasVerifiedPaymentConfig: verifiedSellerIds.has(seller.id),
      },
      quantity: cart.quantity,
      variant: null,
      listing: {
        id: listing.id,
        deliveryTimeDays: listing.deliveryTimeDays ?? null,
        paymentMethod: listing.paymentMethod,
        variant: {
          id: variant.id,
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
          deliveryCharge,
          isPreOrder: variant.isPreOrder,
        },
      },
      product: {
        id: product.id,
        name: product.name,
        slug: product.slug,
        categoryId: product.categoryId,
        description: product.description,
        images: product.images as string[],
        averageRating: 0,
        reviewCount: 0,
        isFeatured: product.homepageTag,
        createdAt: product.createdAt.toISOString(),
      },
    };
  });

  const items = [...mappedVariantLines, ...mappedListingVariantLines];

  return { items, subtotal, discount, deliveryTotal, total: subtotal + deliveryTotal };
}

router.get("/cart", requireAuth, async (req: any, res) => {
  try {
    const cart = await buildCart(req.userId);
    res.json(cart);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch cart" });
  }
});

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
router.post("/cart/items", requireAuth, async (req: any, res) => {
  try {
    const { productId, quantity } = req.body;
    const variantId = req.body.variantId != null ? Number(req.body.variantId) : null;
    const sellerListingVariantId =
      req.body.sellerListingVariantId != null ? Number(req.body.sellerListingVariantId) : null;

    if (!productId || isNaN(Number(productId))) {
      res.status(400).json({ error: "Invalid product ID" });
      return;
    }
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

    if (hasVariant) {
      const [variant] = await db
        .select({ id: productVariantsTable.id, stock: productVariantsTable.stock, productId: productVariantsTable.productId })
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
        .where(and(eq(cartItemsTable.userId, req.userId), eq(cartItemsTable.variantId, variantId!)))
        .limit(1);

      const newQty = existing.length > 0 ? existing[0].quantity + qty : qty;

      if (variant.stock < newQty) {
        res.status(400).json({ error: `Only ${variant.stock} items available in stock` });
        return;
      }

      if (existing.length > 0) {
        await db
          .update(cartItemsTable)
          .set({ quantity: newQty, updatedAt: new Date() })
          .where(eq(cartItemsTable.id, existing[0].id));
      } else {
        await db.insert(cartItemsTable).values({
          userId: req.userId,
          productId: Number(productId),
          variantId,
          quantity: qty,
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
        .innerJoin(sellerListingsTable, eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id))
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
            eq(cartItemsTable.userId, req.userId),
            eq(cartItemsTable.sellerListingVariantId, sellerListingVariantId!),
          ),
        )
        .limit(1);

      const newQty = existing.length > 0 ? existing[0].quantity + qty : qty;

      if (variant.availableQuantity < newQty) {
        res.status(400).json({ error: `Only ${variant.availableQuantity} items available in stock` });
        return;
      }

      if (existing.length > 0) {
        await db
          .update(cartItemsTable)
          .set({ quantity: newQty, updatedAt: new Date() })
          .where(eq(cartItemsTable.id, existing[0].id));
      } else {
        await db.insert(cartItemsTable).values({
          userId: req.userId,
          productId: Number(productId),
          // Denormalized from the variant's own FK, not trusted from the
          // request body -- see route doc comment above.
          sellerListingId: listing.id,
          sellerListingVariantId,
          quantity: qty,
        });
      }
    }

    const cart = await buildCart(req.userId);
    res.json(cart);
  } catch (err) {
    res.status(500).json({ error: "Failed to add to cart" });
  }
});

/**
 * cart_items.id (the row's own primary key) addresses a cart line for
 * update/delete, NOT variantId/sellerListingVariantId -- an admin-direct
 * line has no sellerListingVariantId and vice versa, so a type-keyed path
 * can't unambiguously address either. The row id is unambiguous for both
 * line types and was already a stable, unique identifier before this
 * change; this is a routing fix, not a new concept.
 */
router.put("/cart/items/:id", requireAuth, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid cart item ID" });
      return;
    }

    const { quantity } = req.body;
    const qty = Number(quantity);
    if (isNaN(qty) || qty < 1 || qty > 99) {
      res.status(400).json({ error: "Quantity must be between 1 and 99" });
      return;
    }

    const [line] = await db
      .select()
      .from(cartItemsTable)
      .where(and(eq(cartItemsTable.id, id), eq(cartItemsTable.userId, req.userId)))
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
        res.status(400).json({ error: `Only ${variant.availableQuantity} items available in stock` });
        return;
      }
    }

    await db
      .update(cartItemsTable)
      .set({ quantity: qty, updatedAt: new Date() })
      .where(eq(cartItemsTable.id, id));
    const cart = await buildCart(req.userId);
    res.json(cart);
  } catch (err) {
    res.status(500).json({ error: "Failed to update cart" });
  }
});

router.delete("/cart/items/:id", requireAuth, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid cart item ID" });
      return;
    }

    await db
      .delete(cartItemsTable)
      .where(and(eq(cartItemsTable.id, id), eq(cartItemsTable.userId, req.userId)));
    const cart = await buildCart(req.userId);
    res.json(cart);
  } catch (err) {
    res.status(500).json({ error: "Failed to remove from cart" });
  }
});

router.delete("/cart", requireAuth, async (req: any, res) => {
  try {
    await db
      .delete(cartItemsTable)
      .where(eq(cartItemsTable.userId, req.userId));
    res.json({ message: "Cart cleared" });
  } catch (err) {
    res.status(500).json({ error: "Failed to clear cart" });
  }
});

export default router;
