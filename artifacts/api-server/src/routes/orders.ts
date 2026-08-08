import { Router } from "express";
import { db } from "@workspace/db";
import {
  ordersTable,
  cartItemsTable,
  productsTable,
  productVariantsTable,
  sellerListingsTable,
  sellerListingVariantsTable,
  sellersTable,
  platformPaymentConfigTable,
  couponsTable,
  usersTable,
  addressesTable,
} from "@workspace/db";
import { eq, desc, and, sql, inArray } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { sendOrderConfirmation } from "../lib/email";
import { logger } from "../lib/logger";
import { checkoutLimiter, guestCheckoutLimiter } from "../middlewares/rateLimiter";
import { CreateOrderBody } from "@workspace/api-zod";
import { validateBody } from "../lib/validateRequest";
import type { ApiRequest } from "../types/apiRequest";
import type { z } from "zod";
import crypto from "crypto";
import { awardPoints, redeemPoints, TAKA_PER_POINT } from "./loyalty";
import type { OrderItem } from "@workspace/db";
import { groupBySellerAndAllocateDiscount } from "@workspace/db/logic";

export { groupBySellerAndAllocateDiscount };

const router = Router();

function formatOrder(o: typeof ordersTable.$inferSelect) {
  return {
    id: o.id,
    trackingId: o.trackingId,
    userId: o.userId,
    sellerId: o.sellerId ?? null,
    items: o.items as any[],
    totalAmount: Number(o.totalAmount),
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    senderNumber: o.senderNumber,
    paidAt: o.paidAt,
    orderStatus: o.orderStatus,
    transactionId: o.transactionId,
    shippingAddress: o.shippingAddress as any,
    couponCode: o.couponCode,
    discountAmount: Number(o.discountAmount),
    cancellationReason: o.cancellationReason ?? null,
    giftWrap: o.giftWrap ?? "false",
    giftMessage: o.giftMessage ?? null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

router.get("/orders", requireAuth, async (req: ApiRequest, res) => {
  try {
    // PERF-5: Add DB-level LIMIT — was fetching ALL orders for the user
    // in one unbounded query. A buyer with 500 lifetime orders got all 500
    // on every page load. Now defaults to 50 (generous enough for a single
    // page; the frontend can add pagination UI later). Non-breaking: the
    // response shape stays Order[] (the OpenAPI spec documents this as an
    // array). The frontend's useInfiniteScroll pattern can add ?page=&limit=
    // params when needed.
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? "50")));
    const page = Math.max(1, parseInt((req.query.page as string) ?? "1"));
    const offset = (page - 1) * limit;

    const orders = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.userId, req.userId!))
      .orderBy(desc(ordersTable.createdAt))
      .limit(limit)
      .offset(offset);
    res.json(orders.map(formatOrder));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/**
 * Shared helper used by both the guest and authenticated checkout paths
 * below, so the split-by-seller behavior (plan doc §2, §7) can't drift
 * between them.
 *
 * groupBySellerAndAllocateDiscount itself now lives in @workspace/db/logic
 * (moved there post-Phase-9 so scripts/src/verify-seller-marketplace.ts can
 * import the real implementation instead of reimplementing it -- see that
 * module's doc comment for the full rationale, including why this couldn't
 * just stay here with an `export` keyword added). Imported above and
 * re-exported here so this file's existing export surface is unaffected.
 */

router.post("/orders/guest", guestCheckoutLimiter, async (req: ApiRequest, res) => {
  try {
    const { paymentMethod, transactionId, senderNumber, shippingAddress, items, couponCode, giftWrap, giftMessage } = req.body as Record<string, unknown> & { paymentMethod?: string; transactionId?: string; senderNumber?: string; shippingAddress?: any; items?: any[]; couponCode?: string; giftWrap?: string; giftMessage?: string };

    if (!paymentMethod) {
      res.status(400).json({ error: "Payment method is required" });
      return;
    }
    if (!shippingAddress?.fullName || !shippingAddress?.phone || !shippingAddress?.street || !shippingAddress?.city) {
      res.status(400).json({ error: "Incomplete shipping address" });
      return;
    }
    // Part 2: guest checkout no longer collects a buyer-typed sending
    // number for "bkash" -- the buyer is redirected to bKash's hosted
    // payment page instead (routes/bkashPayment.ts), same as the
    // authenticated /orders route. Guest orders are always sellerId=null
    // (admin-direct only, see doc comment below), which is exactly the
    // group that pays into the platform's single bKash merchant account,
    // so there's no per-seller config to check here -- only whether the
    // platform config itself exists and is verified, checked just before
    // insert below.
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "Cart is empty" });
      return;
    }
    // Guest checkout is admin-direct-only (variant lines). Marketplace
    // (seller-listing) checkout requires an account, same as the
    // authenticated /orders route below -- guests never get a sellerId to
    // attach an order to, and per-seller payment method selection (plan
    // doc §7) needs a real checkout session, not a single guest POST body.
    for (const i of items) {
      if (i.variantId == null || isNaN(Number(i.variantId))) {
        res.status(400).json({ error: "Each item must specify a variant (e.g. Seed, Sapling, Grafted, Potted)" });
        return;
      }
    }

    const productIds = items.map((i: any) => i.productId);
    const variantIds = items.map((i: any) => Number(i.variantId));
    const [products, variants] = await Promise.all([
      db.select().from(productsTable).where(inArray(productsTable.id, productIds)),
      db.select().from(productVariantsTable).where(inArray(productVariantsTable.id, variantIds)),
    ]);
    const productMap = new Map(products.map(p => [p.id, p]));
    const variantMap = new Map(variants.map(v => [v.id, v]));

    for (const i of items) {
      const product = productMap.get(i.productId);
      const variant = variantMap.get(Number(i.variantId));
      if (!product) { res.status(400).json({ error: "Product not found" }); return; }
      if (!variant || variant.productId !== product.id) {
        res.status(400).json({ error: `Variant not found for "${product.name}"` });
        return;
      }
      if (variant.stock < i.quantity) {
        res.status(400).json({ error: `Insufficient stock for "${product.name}" (${variant.name}). Only ${variant.stock} left.` });
        return;
      }
    }

    let subtotal = 0;
    let deliveryFee = 0;
    const orderItems: OrderItem[] = items.map((i: any) => {
      const product = productMap.get(i.productId)!;
      const variant = variantMap.get(Number(i.variantId))!;
      const price = variant.discountPrice != null ? Number(variant.discountPrice) : Number(variant.price);
      const deliveryCharge = Number(variant.deliveryCharge);
      subtotal += price * i.quantity;
      deliveryFee += deliveryCharge * i.quantity;
      return {
        productId: product.id,
        productName: product.name,
        productImage: ((product.images as string[])[0]) ?? "",
        variantId: variant.id,
        variantName: variant.name,
        quantity: i.quantity,
        price,
        deliveryCharge,
      };
    });

    // Guest checkout is admin-direct-only (sellerId: null, see doc comment
    // above) -- so only a platform-wide coupon (couponsTable.sellerId ===
    // null) can ever apply here. A seller-scoped coupon has no matching
    // seller group on this path by construction, so it's rejected rather
    // than silently ignored (which would look to the buyer like their
    // code just didn't work, with no explanation).
    let discountAmount = 0;
    if (couponCode) {
      const [coupon] = await db.select().from(couponsTable).where(eq(couponsTable.code, couponCode.toUpperCase())).limit(1);
      if (coupon && coupon.isActive) {
        if (coupon.sellerId !== null) {
          res.status(400).json({ error: "This coupon isn't valid for the items in your cart." });
          return;
        }
        discountAmount = coupon.discountType === "percentage"
          ? Math.floor((subtotal * Number(coupon.discountValue)) / 100)
          : Math.min(Number(coupon.discountValue), subtotal);
      }
    }

    // Part 2: same platform-config gate as the authenticated route --
    // "bkash" is refused up front if the platform's merchant account isn't
    // configured/verified, rather than creating a payment_pending order
    // that can never actually be paid.
    if (paymentMethod === "bkash") {
      const [config] = await db
        .select({ isVerified: platformPaymentConfigTable.isVerified })
        .from(platformPaymentConfigTable)
        .limit(1);
      if (config?.isVerified !== true) {
        res.status(400).json({ error: "bKash payment isn't available right now. Please choose Cash on Delivery." });
        return;
      }
    }

    const totalAmount = Math.max(0, subtotal - discountAmount + deliveryFee);
    const trackingId = "EE" + crypto.randomBytes(4).toString("hex").toUpperCase();
    // See the authenticated /orders route's matching doc comment for why
    // "bkash" now maps to "payment_pending" instead of the old
    // "pending_verification".
    const paymentStatus = paymentMethod === "cod" ? "pending" : "payment_pending";
    const guestUserId = "guest_" + crypto.randomBytes(8).toString("hex");

    const [order] = await db.insert(ordersTable).values({
      trackingId,
      userId: guestUserId,
      sellerId: null,
      items: orderItems,
      totalAmount: String(totalAmount),
      paymentMethod,
      paymentStatus,
      orderStatus: "pending",
      transactionId: paymentMethod === "bkash" ? null : (transactionId?.trim() ?? null),
      senderNumber: paymentMethod === "bkash" ? null : (senderNumber ?? null),
      shippingAddress,
      couponCode: couponCode ?? null,
      discountAmount: String(discountAmount),
      giftWrap: giftWrap ? "true" : "false",
      giftMessage: giftMessage ?? null,
    }).returning();

    await Promise.all(
      items.map((i: any) => {
        const variant = variantMap.get(Number(i.variantId))!;
        return db.update(productVariantsTable).set({ stock: Math.max(0, variant.stock - i.quantity) }).where(eq(productVariantsTable.id, variant.id));
      })
    );

    res.status(201).json({ id: order.id, trackingId: order.trackingId });
  } catch (err: any) {
    logger.error({ err: err }, "guest order error");
    res.status(500).json({ error: "Failed to place order" });
  }
});

/**
 * Place an order for the authenticated user's full cart. A cart spanning
 * multiple sellers (plus, optionally, admin-direct variant lines) splits
 * into ONE ORDER PER SELLER GROUP, with admin-direct lines forming their
 * own group under sellerId=null (plan doc §2, §7) -- this preserves
 * exactly the pre-marketplace single-order behavior for a cart that's
 * 100% admin-direct, since in that case there's only ever one group.
 *
 * sellerPaymentMethods lets the buyer choose a payment method PER SELLER
 * GROUP (bkash/cod), since sellers can accept different methods
 * (plan doc §7) -- keyed by sellerId as a string (JSON object keys are
 * always strings), with a "null" key for the admin-direct group. Falls
 * back to top-level paymentMethod for any group not present in the map,
 * so existing single-store callers that only ever send paymentMethod
 * keep working unchanged.
 *
 * sellerSenderNumbers (Part 5): same per-group/fallback shape as
 * sellerPaymentMethods, for the bKash sending number. PHASE3_HANDOFF.md
 * flagged that a single top-level senderNumber was reused across every
 * seller group that resolved to bkash -- a real simplification, not a
 * considered design, since different sellers' bKash accounts may need the
 * buyer to send from different numbers. Fixed here: each group's
 * senderNumber is resolved independently (sellerSenderNumbers[key] falls
 * back to the top-level senderNumber, so single-seller/admin-direct
 * callers sending only `senderNumber` are unaffected).
 *
 * Payment-method enforcement (Part 2 of 4, see PART2_HANDOFF.md -- REPLACES
 * the old Part 5 per-seller check this comment used to describe): "bkash"
 * for ANY group -- admin-direct (sellerId === null) or marketplace
 * (sellerId != null) -- now requires the PLATFORM's single
 * platform_payment_config row to exist AND be verified, not a per-seller
 * seller_payment_configs row. Under the new admin-custodial model every
 * buyer bKash payment settles into the platform's one merchant account
 * (Part 1's PART1_HANDOFF.md); a marketplace seller's own bKash
 * merchant-account status is no longer relevant to whether their listing
 * can be paid via bKash at checkout -- see cart.ts's matching change to
 * hasVerifiedPaymentConfig, which this route's own gate must stay
 * consistent with (both now read platformPaymentConfigTable.isVerified,
 * not sellerPaymentConfigsTable). The OLD sellerPaymentConfigsTable /
 * sellerPaymentConfigs.ts route are left untouched per this part's
 * explicit scope (still used by sellerListings.ts to gate what a seller
 * may SET their listing's paymentMethod to -- a separate, still-live
 * concern this part doesn't change), but checkout-time eligibility no
 * longer reads that table.
 *
 * senderNumber/sellerSenderNumbers are NO LONGER required or read for the
 * "bkash" method (Part 2): the buyer no longer types their own sending
 * number and transaction id at checkout -- they're redirected to bKash's
 * own hosted payment page (routes/bkashPayment.ts's
 * POST /bkash/create-payment), which collects the sending number/OTP/PIN
 * itself. senderNumber fields are left in the schema/request body for
 * backward compatibility (COD-only carts and any external caller that
 * still sends them are unaffected) but are no longer validated as
 * required when method === "bkash".
 */

router.post("/orders", requireAuth, checkoutLimiter, validateBody(CreateOrderBody, "CreateOrderBody"), async (req: ApiRequest<z.infer<typeof CreateOrderBody>>, res) => {
  try {
    // P0-1: body shape now validated by Zod (CreateOrderBody). The
    // hand-rolled "Incomplete shipping address" check below is kept as a
    // business rule — Zod validates the SHAPE of shippingAddress (object
    // with fullName/phone/street/city/district strings), but the route
    // still needs to enforce that those fields are non-empty for the
    // order to be valid. The "Payment method is required" check is also
    // kept because CreateOrderBody.paymentMethod is .optional() in the
    // schema (the spec allows sellerPaymentMethods as an alternative).
    const {
      paymentMethod,
      sellerPaymentMethods,
      transactionId,
      senderNumber,
      sellerSenderNumbers,
      shippingAddress,
      couponCode,
      loyaltyPointsToRedeem,
      giftWrap,
      giftMessage,
    } = req.body;

    if (!paymentMethod && !sellerPaymentMethods) {
      res.status(400).json({ error: "Payment method is required" });
      return;
    }
    if (!shippingAddress?.fullName || !shippingAddress?.phone || !shippingAddress?.street || !shippingAddress?.city) {
      res.status(400).json({ error: "Incomplete shipping address" });
      return;
    }

    const [variantLines, listingLines] = await Promise.all([
      db
        .select({ cart: cartItemsTable, product: productsTable, variant: productVariantsTable })
        .from(cartItemsTable)
        .innerJoin(productsTable, eq(cartItemsTable.productId, productsTable.id))
        .innerJoin(productVariantsTable, eq(cartItemsTable.variantId, productVariantsTable.id))
        .where(eq(cartItemsTable.userId, req.userId!)),
      // Phase 2: resolves through sellerListingVariantsTable now, not
      // sellerListingsTable directly -- price/discountPrice/
      // availableQuantity/deliveryCharge all moved to the variant. Still
      // joins sellerListingsTable for listing-level fields (id, sellerId,
      // approvalStatus, visibility).
      db
        .select({ cart: cartItemsTable, product: productsTable, listing: sellerListingsTable, variant: sellerListingVariantsTable })
        .from(cartItemsTable)
        .innerJoin(productsTable, eq(cartItemsTable.productId, productsTable.id))
        .innerJoin(sellerListingVariantsTable, eq(cartItemsTable.sellerListingVariantId, sellerListingVariantsTable.id))
        .innerJoin(sellerListingsTable, eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id))
        .where(eq(cartItemsTable.userId, req.userId!)),
    ]);

    if (variantLines.length === 0 && listingLines.length === 0) {
      res.status(400).json({ error: "Cart is empty" });
      return;
    }

    for (const { cart, product, variant } of variantLines) {
      if (variant.stock < cart.quantity) {
        res.status(400).json({ error: `Insufficient stock for "${product.name}" (${variant.name}). Only ${variant.stock} left.` });
        return;
      }
    }
    for (const { cart, product, listing, variant } of listingLines) {
      // Stock-sufficiency check moves to the VARIANT's availableQuantity
      // (Phase 2) -- the listing itself no longer carries stock data.
      if (variant.availableQuantity < cart.quantity) {
        res.status(400).json({ error: `Insufficient stock for "${product.name}" from this seller. Only ${variant.availableQuantity} left.` });
        return;
      }
      if (listing.approvalStatus !== "approved" || listing.visibility !== "public") {
        res.status(400).json({ error: `"${product.name}" from this seller is no longer available.` });
        return;
      }
    }

    type ResolvedLine = { sellerId: number | null; lineTotal: number; orderItem: OrderItem; deliveryCharge: number };

    const resolvedVariantLines: ResolvedLine[] = variantLines.map(({ cart, product, variant }) => {
      const price = variant.discountPrice != null ? Number(variant.discountPrice) : Number(variant.price);
      const deliveryCharge = Number(variant.deliveryCharge);
      return {
        sellerId: null,
        lineTotal: price * cart.quantity,
        deliveryCharge: deliveryCharge * cart.quantity,
        orderItem: {
          productId: product.id,
          productName: product.name,
          productImage: ((product.images as string[])[0]) ?? "",
          variantId: variant.id,
          variantName: variant.name,
          quantity: cart.quantity,
          price,
          deliveryCharge,
        },
      };
    });

    // Phase 2: price/discountPrice/deliveryCharge now come from the
    // seller-listing VARIANT the cart line points to, not the listing.
    //
    // deliveryCharge here is real, seller-set data (courier fee for THIS
    // variant -- a seed packet and a mature potted tree of the same
    // listing ship very differently) that MUST be shown to the buyer on the
    // order (orderItem.deliveryCharge, populated below from the variant's
    // real value) so they know what they'll owe the courier. But the
    // platform does NOT collect it at checkout -- the buyer pays the
    // courier directly (plan doc §4, §8). That's why `deliveryCharge` on
    // ResolvedLine itself (the field groupDeliveryFee below actually sums
    // into groupTotal, the platform-collected total) is hard-coded to 0
    // here, structurally separate from orderItem.deliveryCharge: this is
    // not a comment-only convention, it's two different fields carrying two
    // different numbers on purpose, so a future edit to one can't
    // accidentally leak courier money into the platform total by
    // "simplifying" what looks like a duplicate field.
    const resolvedListingLines: ResolvedLine[] = listingLines.map(({ cart, product, listing, variant }) => {
      const price = variant.discountPrice != null ? Number(variant.discountPrice) : Number(variant.price);
      const deliveryCharge = Number(variant.deliveryCharge);
      return {
        sellerId: listing.sellerId,
        lineTotal: price * cart.quantity,
        deliveryCharge: 0, // buyer pays courier directly to seller, NOT collected in groupTotal -- see doc comment above
        orderItem: {
          productId: product.id,
          productName: product.name,
          productImage: ((product.images as string[])[0]) ?? "",
          sellerListingId: listing.id,
          sellerListingVariantId: variant.id,
          sellerId: listing.sellerId,
          quantity: cart.quantity,
          price,
          // Real, visible, buyer-owes-the-courier charge -- NOT summed into
          // any platform-collected total (see doc comment above).
          deliveryCharge,
        },
      };
    });

    const allLines = [...resolvedVariantLines, ...resolvedListingLines];
    const grandSubtotal = allLines.reduce((s, l) => s + l.lineTotal, 0);

    // Coupon scoping: a coupon with couponsTable.sellerId set was created
    // by that seller and must ONLY discount that seller's own group in
    // this cart -- never any other seller's, and never the platform's
    // admin-direct (sellerId: null) group. If that seller isn't actually
    // present in the cart, the coupon is rejected outright rather than
    // silently applied nowhere or, worse, to some other group -- see
    // groupBySellerAndAllocateDiscount's targetSellerId doc comment for
    // why "just fall back to largest group" is exactly the bug this
    // replaces. A coupon with sellerId === null is platform-wide and is
    // allowed to land on whichever group is largest, same as loyalty.
    let couponDiscount = 0;
    let couponSellerId: number | null | undefined; // undefined = no valid coupon applied
    if (couponCode) {
      const [coupon] = await db.select().from(couponsTable).where(eq(couponsTable.code, couponCode.toUpperCase())).limit(1);
      if (coupon && coupon.isActive) {
        const sellerInCart = coupon.sellerId === null || allLines.some((l) => l.sellerId === coupon.sellerId);
        if (!sellerInCart) {
          res.status(400).json({ error: "This coupon isn't valid for the items in your cart." });
          return;
        }
        couponDiscount = coupon.discountType === "percentage"
          ? Math.floor((grandSubtotal * Number(coupon.discountValue)) / 100)
          : Math.min(Number(coupon.discountValue), grandSubtotal);
        couponSellerId = coupon.sellerId;
      }
    }

    let loyaltyDiscount = 0;
    const pointsToRedeem = Math.max(0, Math.floor(Number(loyaltyPointsToRedeem) || 0));
    if (pointsToRedeem > 0) {
      const maxLoyaltyDiscount = Math.floor(grandSubtotal * 0.2);
      loyaltyDiscount = Math.min(pointsToRedeem * TAKA_PER_POINT, maxLoyaltyDiscount);
    }

    // Coupon and loyalty can no longer be summed into one number and
    // allocated in a single pass -- a seller-scoped coupon must land on
    // that seller's group specifically, while loyalty (always
    // platform-wide) still goes to the largest group. Two passes: apply
    // the coupon first (targeted or largest-group, per couponSellerId),
    // then layer loyalty on top via a second pass over the same lines
    // using each group's now-discounted subtotal as its remaining room.
    const afterCoupon = groupBySellerAndAllocateDiscount(allLines, couponDiscount, couponSellerId);
    const remainingLines = afterCoupon.map((g) => ({
      sellerId: g.sellerId,
      lineTotal: g.subtotal - g.discountAmount,
    }));
    const afterLoyalty = groupBySellerAndAllocateDiscount(remainingLines, loyaltyDiscount);

    const groups = afterCoupon.map((g, i) => ({
      ...g,
      discountAmount: g.discountAmount + afterLoyalty[i].discountAmount,
    }));

    if (groups.length === 0) {
      res.status(400).json({ error: "Cart is empty" });
      return;
    }

    // Validate/resolve payment method per group up front, before writing
    // any order rows, so a bad payment method for one seller doesn't leave
    // earlier groups' orders already committed.
    //
    // Part 2 change: the platform-config verified-check below used to be a
    // per-seller lookup (sellerPaymentConfigsTable, keyed by g.sellerId).
    // It's now a single check against platformPaymentConfigTable, done
    // ONCE before the loop (not per-group) since every group either can or
    // can't use "bkash" for the exact same reason now -- there's only one
    // merchant account, not one per seller. senderNumber/
    // sellerSenderNumbers are no longer required for "bkash" -- see doc
    // comment above this route.
    let platformBkashAvailable: boolean | null = null; // computed lazily, only if some group actually resolves to "bkash"
    async function isPlatformBkashAvailable(): Promise<boolean> {
      if (platformBkashAvailable !== null) return platformBkashAvailable;
      const [config] = await db
        .select({ isVerified: platformPaymentConfigTable.isVerified })
        .from(platformPaymentConfigTable)
        .limit(1);
      platformBkashAvailable = config?.isVerified === true;
      return platformBkashAvailable;
    }

    const resolvedPaymentMethods = new Map<number | null, string>();
    const resolvedSenderNumbers = new Map<number | null, string | null>();
    for (const g of groups) {
      const key = g.sellerId === null ? "null" : String(g.sellerId);
      const method = sellerPaymentMethods?.[key] ?? paymentMethod;
      if (!method) {
        res.status(400).json({ error: "Payment method is required for every seller in your cart" });
        return;
      }
      if (method === "bkash" && !(await isPlatformBkashAvailable())) {
        res.status(400).json({
          error: "bKash payment isn't available right now. Please choose Cash on Delivery.",
        });
        return;
      }
      const groupSenderNumber: string | null = (sellerSenderNumbers?.[key] ?? senderNumber) ?? null;
      resolvedPaymentMethods.set(g.sellerId, method);
      resolvedSenderNumbers.set(g.sellerId, groupSenderNumber?.trim() || null);
    }

    const trackingId = () => "EE" + crypto.randomBytes(4).toString("hex").toUpperCase();

    // ─── ATOMIC CHECKOUT TRANSACTION ────────────────────────────────────────
    // All order writes (insert orders, delete cart, decrement stock) MUST be
    // atomic. Previously these were separate SQL statements — a mid-checkout
    // failure (DB blip, FK violation, deadlock) left the buyer with partial
    // orders, decremented stock without orders, or a deleted cart with no
    // orders. Now wrapped in a single db.transaction: either all writes
    // commit together, or all roll back together.
    //
    // Side effects (loyalty points, email confirmation, address auto-save)
    // are deliberately OUTSIDE the transaction — they're fire-and-forget
    // (.catch(() => {})) and don't need to block the order commit. If they
    // fail after the order is committed, the order still exists; the buyer
    // just doesn't get the email. That's the correct failure mode.
    const createdOrders = await db.transaction(
      async (tx) => {
        const created: (typeof ordersTable.$inferSelect)[] = [];

      for (const g of groups) {
        const method = resolvedPaymentMethods.get(g.sellerId)!;
        const groupSenderNumber = resolvedSenderNumbers.get(g.sellerId) ?? null;
        const groupDeliveryFee = g.lines.reduce((s, l) => s + l.deliveryCharge, 0);
        const groupTotal = Math.max(0, g.subtotal - g.discountAmount + groupDeliveryFee);
        // Part 2: "bkash" now creates the order BEFORE any bKash API call has
        // happened at all -- see PART2_HANDOFF.md's order-sequencing
        // decision. "payment_pending" (new value, distinct from the old
        // "pending_verification") specifically means "a real bKash Create
        // Payment/Execute Payment cycle for this order hasn't completed yet"
        // -- routes/bkashPayment.ts's callback handler is the only place
        // that ever moves an order OUT of this status (to "paid" on success;
        // left as "payment_pending" -- not "failed" -- on a bKash-side
        // cancel/failure, so the buyer can retry payment against the SAME
        // order via a fresh Create Payment call rather than the order being
        // silently dead-ended; see that route's doc comment for the full
        // "pending_verification" is intentionally left alone and untouched by
        // this part -- it remains preOrders.ts's status from the old manual
        // payment-matching flow (since removed), not reused here, so a stale
        // reader of "pending_verification" doesn't silently pick up unrelated
        // bKash-in-progress orders.
        const paymentStatus = method === "cod" ? "pending" : "payment_pending";

        const [order] = await tx
          .insert(ordersTable)
          .values({
            trackingId: trackingId(),
            userId: req.userId!,
            sellerId: g.sellerId,
            items: g.lines.map((l) => l.orderItem),
            totalAmount: String(groupTotal),
            paymentMethod: method,
            paymentStatus,
            orderStatus: "pending",
            transactionId: method === "bkash" ? null : (transactionId?.trim() ?? null),
            senderNumber: method === "bkash" ? null : groupSenderNumber,
            shippingAddress,
            couponCode: g.discountAmount > 0 && couponCode ? couponCode : null,
            discountAmount: String(g.discountAmount),
            giftWrap: giftWrap ? "true" : "false",
            giftMessage: giftWrap ? giftMessage : null,
          })
          .returning();
        created.push(order);
      }

      // Delete the buyer's cart now that every order has been inserted.
      // Inside the transaction so a stock-decrement failure below rolls
      // back the cart deletion too — without this, a failed checkout would
      // leave the buyer with an empty cart and no orders.
      await tx.delete(cartItemsTable).where(eq(cartItemsTable.userId, req.userId!));

      // Decrement stock on every purchased variant. Inside the transaction
      // so a failure here rolls back the order inserts — without this, a
      // stock mismatch would create orders for items that weren't actually
      // in stock.
      await Promise.all([
        ...variantLines.map(({ cart, variant }) =>
          tx.update(productVariantsTable).set({ stock: Math.max(0, variant.stock - cart.quantity) }).where(eq(productVariantsTable.id, variant.id))
        ),
        // Phase 2: stock decrement moves to sellerListingVariantsTable -- the
        // listing itself no longer carries stock/availableQuantity.
        ...listingLines.map(({ cart, variant }) =>
          tx.update(sellerListingVariantsTable).set({
            stock: Math.max(0, variant.stock - cart.quantity),
            availableQuantity: Math.max(0, variant.availableQuantity - cart.quantity),
            updatedAt: new Date(),
          }).where(eq(sellerListingVariantsTable.id, variant.id))
        ),
      ]);

      return created;
    },
      // SERIALIZABLE isolation: prevents race conditions where two concurrent
      // checkouts for the same variant could both read the same stock count
      // and both decrement, resulting in overselling. SERIALIZABLE is the
      // strongest isolation level — if two transactions conflict, one is
      // aborted and must retry. For checkout (low frequency, high stakes),
      // this is the correct tradeoff.
      { isolationLevel: "serializable" },
    );

    // Loyalty points redeem/award once at the grand-total level (a single
    // ledger event), not once per resulting order -- points are a
    // platform-wide concept, not a per-seller one.
    if (pointsToRedeem > 0) {
      const actualPointsToRedeem = Math.ceil(loyaltyDiscount / TAKA_PER_POINT);
      redeemPoints(req.userId!, actualPointsToRedeem, createdOrders[0].id).catch(() => {});
    }
    const grandTotal = createdOrders.reduce((s, o) => s + Number(o.totalAmount), 0);
    awardPoints(req.userId!, createdOrders[0].id, grandTotal).catch(() => {});

    const addr = shippingAddress as {
      fullName?: string;
      phone?: string;
      street?: string;
      city?: string;
      district?: string;
      postalCode?: string;
    } | null;
    if (addr?.fullName && addr?.street && addr?.city) {
      try {
        const existing = await db
          .select()
          .from(addressesTable)
          .where(eq(addressesTable.userId, req.userId!));
        const alreadySaved = existing.some(
          (a) => a.street === addr.street && a.city === addr.city,
        );
        if (!alreadySaved) {
          await db.insert(addressesTable).values({
            userId: req.userId!,
            fullName: addr.fullName ?? "",
            phone: addr.phone ?? "",
            street: addr.street ?? "",
            city: addr.city ?? "",
            district: addr.district ?? "",
            postalCode: addr.postalCode ?? null,
            isDefault: existing.length === 0,
          });
        }
      } catch (err) {
        // VAL-4: was catch (_) {} — completely swallowed with no logging.
        // Address auto-save is non-blocking (the order is already committed),
        // but a silent failure means the buyer's address won't be saved for
        // next time and we'll never know why. Log it so it's visible in
        // production logs without failing the checkout response.
        logger.warn({ err, userId: req.userId! }, "Address auto-save failed (non-blocking)");
      }
    }

    const [userRow] = await db
      .select({
        email: usersTable.email,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
      })
      .from(usersTable)
      .where(eq(usersTable.clerkId, req.userId!))
      .limit(1);

    if (userRow?.email && !userRow.email.endsWith("@clerk.user")) {
      const name =
        [userRow.firstName, userRow.lastName].filter(Boolean).join(" ") ||
        "Customer";
      for (const order of createdOrders) {
        sendOrderConfirmation({
          to: userRow.email,
          name,
          orderId: order.id,
          trackingId: order.trackingId,
          items: order.items as any[],
          total: Number(order.totalAmount),
          shippingAddress,
          paymentMethod: order.paymentMethod,
        }).catch(() => {});
      }
    }

    // Always an array, even when checkout didn't split (single-seller or
    // all-admin-direct cart still produces exactly one order). A
    // conditional single-object-vs-wrapper response shape forces every
    // caller to branch on "did it split," which is worse than the one-time
    // cost of every caller expecting an array. See CheckoutPage.tsx.
    res.status(201).json(createdOrders.map(formatOrder));
  } catch (err) {
    logger.error({ err, userId: req.userId! }, "Order creation failed");
    res.status(500).json({ error: "Failed to create order" });
  }
});

router.get("/orders/track/:trackingId", async (req, res) => {
  try {
    const rawId = req.params.trackingId;
    if (!/^[A-Z0-9]{2,20}$/i.test(rawId)) {
      res.status(400).json({ error: "Invalid tracking ID format" });
      return;
    }

    const [order] = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.trackingId, rawId.toUpperCase()))
      .limit(1);

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    const statuses = [
      "pending",
      "confirmed",
      "processing",
      "shipped",
      "delivered",
    ];
    const labels: Record<string, string> = {
      pending: "Order Placed",
      confirmed: "Order Confirmed",
      processing: "Processing",
      shipped: "Shipped",
      delivered: "Delivered",
    };

    const currentIdx = statuses.indexOf(order.orderStatus);
    const timeline = statuses.map((s, i) => ({
      status: s,
      label: labels[s] ?? s,
      timestamp: i <= currentIdx ? order.updatedAt.toISOString() : null,
      completed: i <= currentIdx,
    }));

    res.json({
      ...formatOrder(order),
      subtotal: (order.items as any[]).reduce((s, i) => s + Number(i.price) * i.quantity, 0),
      timeline,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to track order" });
  }
});

router.get("/orders/:id", requireAuth, async (req: ApiRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid order ID" });
      return;
    }
    const [order] = await db
      .select()
      .from(ordersTable)
      .where(and(eq(ordersTable.id, id), eq(ordersTable.userId, req.userId!)))
      .limit(1);
    if (!order) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(formatOrder(order));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch order" });
  }
});

router.post("/orders/:id/cancel", requireAuth, async (req: ApiRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid order ID" });
      return;
    }
    const { reason } = req.body as { reason?: string };
    if (!reason || reason.trim().length < 3) {
      res.status(400).json({ error: "Cancellation reason is required" });
      return;
    }

    const [order] = await db
      .select()
      .from(ordersTable)
      .where(and(eq(ordersTable.id, id), eq(ordersTable.userId, req.userId!)))
      .limit(1);

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    if (!["pending"].includes(order.orderStatus)) {
      res.status(400).json({
        error: `Cannot cancel an order that is already "${order.orderStatus}". Please contact support.`,
      });
      return;
    }

    const [updated] = await db
      .update(ordersTable)
      .set({
        orderStatus: "cancelled",
        cancellationReason: reason.trim(),
        updatedAt: new Date(),
      })
      .where(eq(ordersTable.id, id))
      .returning();

    res.json(formatOrder(updated));
  } catch (err) {
    res.status(500).json({ error: "Failed to cancel order" });
  }
});

export default router;
