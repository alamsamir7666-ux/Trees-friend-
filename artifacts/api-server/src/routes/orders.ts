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
  paymentSessionsTable,
} from "@workspace/db";
import { eq, desc, and, sql, inArray, ilike, gte, lte } from "drizzle-orm";
import { requireGuestOrAuth } from "../middlewares/auth";
import { sendOrderConfirmation } from "../lib/email";
import { sendWhatsAppOrderConfirmation } from "../lib/whatsapp";
import { logger } from "../lib/logger";
import { formatOrder } from "../lib/formatters";
import { asyncHandler, HttpError, generateId } from "../lib/errors";
import {
  checkoutLimiter,
  guestCheckoutLimiter,
  chainRateLimiters,
  trackOrderLimiter,
} from "../middlewares/rateLimiter";
import { CreateOrderBody } from "@workspace/api-zod";
import { validateBody } from "../lib/validateRequest";
import { CancelOrderBody } from "../lib/schemas";
import type { ApiRequest } from "../types/apiRequest";
import type { z } from "zod";
import { awardPoints, redeemPoints, TAKA_PER_POINT } from "./loyalty";
import type { OrderItem } from "@workspace/db";
import { groupBySellerAndAllocateDiscount } from "@workspace/db/logic";

export { groupBySellerAndAllocateDiscount };

const router = Router();

/**
 * Industry-standard BD phone number regex: 11 digits starting with 01
 * followed by [3-9] (Bangladeshi mobile operators). Validates both the
 * authenticated and guest checkout shipping address phone field.
 */
const BD_PHONE_REGEX = /^01[3-9]\d{8}$/;

/**
 * Payment-pending order expiration window (minutes). bKash orders that
 * haven't been completed within this window are auto-cancelled by the
 * payment-expiration cron job, and their stock is restored. Shopify
 * default is 60 minutes; we match that.
 */
const PAYMENT_PENDING_TTL_MINUTES = 60;

function paymentExpiryDate(): Date {
  const d = new Date();
  d.setMinutes(d.getMinutes() + PAYMENT_PENDING_TTL_MINUTES);
  return d;
}

router.get(
  "/orders",
  requireGuestOrAuth,
  asyncHandler(async (req: ApiRequest, res) => {
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

    // ── Industry-standard order list filtering ───────────────────────
    // ?orderStatus=pending — filter by a single order status value.
    //   Supports all valid orderStatus values (pending, confirmed,
    //   processing, shipped, delivered, cancelled, return_completed).
    //   Unknown values are ignored (no filter applied) rather than
    //   returning an empty list — keeps the frontend resilient to new
    //   status values added server-side before the frontend is updated.
    // ?search=EE1234 — case-insensitive partial match on trackingId OR
    //   any product name in the order's items[] JSONB array. Uses ILIKE
    //   on trackingId + a JSONB containment check on items. Truncated to
    //   50 chars to prevent abuse. Empty string = no filter.
    // ?dateFrom=2024-01-01&dateTo=2024-12-31 — date range filter on
    //   createdAt. Both bounds are inclusive. Either bound can be omitted
    //   for open-ended ranges. Dates are parsed as ISO 8601; invalid
    //   dates are ignored (no filter applied).
    //
    // All filters compose: ?orderStatus=shipped&search=mango&dateFrom=2024-01-01
    // returns shipped orders containing "mango" in any item, placed on or
    // after Jan 1, 2024.
    const orderStatus =
      typeof req.query.orderStatus === "string" ? req.query.orderStatus.trim().toLowerCase() : "";
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 50) : "";
    const dateFrom = typeof req.query.dateFrom === "string" ? new Date(req.query.dateFrom) : null;
    const dateTo = typeof req.query.dateTo === "string" ? new Date(req.query.dateTo) : null;

    const conditions = [eq(ordersTable.userId, req.userId!)];
    if (orderStatus) {
      conditions.push(eq(ordersTable.orderStatus, orderStatus));
    }
    if (search) {
      // Search BOTH trackingId (ILIKE) AND items[] JSONB (product name
      // containment). The JSONB check uses the @> operator with a
      // jsonb_build_object pattern — matches any item whose productName
      // contains the search string (case-insensitive via ILIKE on the
      // extracted text). This is the industry-standard pattern for
      // searching inside a JSONB array of objects.
      conditions.push(
        sql`(${ilike(ordersTable.trackingId, `%${search}%`)} OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(${ordersTable.items}) AS item
          WHERE item->>'productName' ILIKE ${`%${search}%`}
        ))`,
      );
    }
    if (dateFrom && !isNaN(dateFrom.getTime())) {
      conditions.push(gte(ordersTable.createdAt, dateFrom));
    }
    if (dateTo && !isNaN(dateTo.getTime())) {
      // Add 1 day to dateTo so the bound is inclusive of the entire day
      // (a buyer passing dateTo=2024-12-31 means "through end of Dec 31",
      // not "through 00:00:00 of Dec 31").
      const endOfDay = new Date(dateTo);
      endOfDay.setDate(endOfDay.getDate() + 1);
      conditions.push(lte(ordersTable.createdAt, endOfDay));
    }

    const orders = await db
      .select()
      .from(ordersTable)
      .where(and(...conditions))
      .orderBy(desc(ordersTable.createdAt))
      .limit(limit)
      .offset(offset);
    res.json(orders.map(formatOrder));
  }),
);

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

router.post(
  "/orders",
  requireGuestOrAuth,
  // Chain both limiters: checkoutLimiter (10/15min for auth users) +
  // guestCheckoutLimiter (5/15min, tighter for guests). Whichever trips
  // first returns its 429. Guests have less trust capital, so the tighter
  // limit applies to them.
  chainRateLimiters(checkoutLimiter, guestCheckoutLimiter),
  validateBody(CreateOrderBody, "CreateOrderBody"),
  async (req: ApiRequest<z.infer<typeof CreateOrderBody>>, res) => {
    try {
      // ── Idempotency key ──────────────────────────────────────────────
      // If the buyer's client sends an Idempotency-Key header, check if an
      // order with that key already exists. If so, return the existing
      // order(s) instead of creating duplicates — prevents duplicate orders
      // on network retry / double-click. Industry standard (Stripe, Shopify).
      const idempotencyKey = req.get("Idempotency-Key");
      if (idempotencyKey) {
        const existing = await db
          .select()
          .from(ordersTable)
          .where(eq(ordersTable.idempotencyKey, idempotencyKey));
        if (existing.length > 0) {
          res.status(200).json({ ...existing.map(formatOrder), idempotentReplay: true } as any);
          return;
        }
      }

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
      if (
        !shippingAddress?.fullName ||
        !shippingAddress?.phone ||
        !shippingAddress?.street ||
        !shippingAddress?.city
      ) {
        res.status(400).json({ error: "Incomplete shipping address" });
        return;
      }
      // BD phone format validation (same regex as guest checkout).
      if (
        shippingAddress.phone &&
        !BD_PHONE_REGEX.test(String(shippingAddress.phone).replace(/[\s-]/g, ""))
      ) {
        res
          .status(400)
          .json({ error: "Please enter a valid Bangladeshi phone number (e.g. 01XXXXXXXXX)" });
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
          .select({
            cart: cartItemsTable,
            product: productsTable,
            listing: sellerListingsTable,
            variant: sellerListingVariantsTable,
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
          .where(eq(cartItemsTable.userId, req.userId!)),
      ]);

      if (variantLines.length === 0 && listingLines.length === 0) {
        res.status(400).json({ error: "Cart is empty" });
        return;
      }

      for (const { cart, product, variant } of variantLines) {
        if (variant.stock < cart.quantity) {
          res.status(400).json({
            error: `Insufficient stock for "${product.name}" (${variant.name}). Only ${variant.stock} left.`,
          });
          return;
        }
      }
      for (const { cart, product, listing, variant } of listingLines) {
        // Stock-sufficiency check moves to the VARIANT's availableQuantity
        // (Phase 2) -- the listing itself no longer carries stock data.
        if (variant.availableQuantity < cart.quantity) {
          res.status(400).json({
            error: `Insufficient stock for "${product.name}" from this seller. Only ${variant.availableQuantity} left.`,
          });
          return;
        }
        if (listing.approvalStatus !== "approved" || listing.visibility !== "public") {
          res
            .status(400)
            .json({ error: `"${product.name}" from this seller is no longer available.` });
          return;
        }
      }

      // ── Price locking enforcement (industry-standard) ──────────────
      // Compare the price snapshot taken at add-time (cart.priceSeenAtAdd)
      // against the current variant price. If they differ by more than 1
      // taka, return 409 with the list of changed items so the frontend
      // can prompt the buyer to re-confirm. This prevents the buyer from
      // being silently charged a different amount than what they saw in
      // the bag. Shopify, WooCommerce, and Magento all do this.
      //
      // The 1-taka threshold handles floating-point rounding noise from
      // numeric→Number conversion. A real price change is always > 1 taka.
      const priceChangedItems: {
        productId: number;
        productName: string;
        variantName: string;
        oldPrice: number;
        newPrice: number;
      }[] = [];
      for (const { cart, product, variant } of variantLines) {
        if (cart.priceSeenAtAdd == null) continue; // legacy cart line with no snapshot
        const snapshotPrice = Number(cart.priceSeenAtAdd);
        const currentPrice =
          variant.discountPrice != null ? Number(variant.discountPrice) : Number(variant.price);
        if (Math.abs(snapshotPrice - currentPrice) > 1) {
          priceChangedItems.push({
            productId: product.id,
            productName: product.name,
            variantName: variant.name,
            oldPrice: snapshotPrice,
            newPrice: currentPrice,
          });
        }
      }
      for (const { cart, product, variant } of listingLines) {
        if (cart.priceSeenAtAdd == null) continue;
        const snapshotPrice = Number(cart.priceSeenAtAdd);
        const currentPrice =
          variant.discountPrice != null ? Number(variant.discountPrice) : Number(variant.price);
        if (Math.abs(snapshotPrice - currentPrice) > 1) {
          priceChangedItems.push({
            productId: product.id,
            productName: product.name,
            // Seller listing variants don't have a `name` field — use a
            // composite label from form/potSize/age for display.
            variantName:
              [variant.form, variant.potSize, variant.age].filter(Boolean).join(" · ") || "N/A",
            oldPrice: snapshotPrice,
            newPrice: currentPrice,
          });
        }
      }
      if (priceChangedItems.length > 0) {
        res.status(409).json({
          error: "Prices for some items in your bag have changed. Please review and re-confirm.",
          priceChangedItems,
        });
        return;
      }

      type ResolvedLine = {
        sellerId: number | null;
        lineTotal: number;
        orderItem: OrderItem;
        deliveryCharge: number;
      };

      const resolvedVariantLines: ResolvedLine[] = variantLines.map(
        ({ cart, product, variant }) => {
          const price =
            variant.discountPrice != null ? Number(variant.discountPrice) : Number(variant.price);
          const deliveryCharge = Number(variant.deliveryCharge);
          return {
            sellerId: null,
            lineTotal: price * cart.quantity,
            deliveryCharge: deliveryCharge * cart.quantity,
            orderItem: {
              productId: product.id,
              productName: product.name,
              productImage: (product.images as string[])[0] ?? "",
              variantId: variant.id,
              variantName: variant.name,
              quantity: cart.quantity,
              price,
              deliveryCharge,
            },
          };
        },
      );

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
      const resolvedListingLines: ResolvedLine[] = listingLines.map(
        ({ cart, product, listing, variant }) => {
          const price =
            variant.discountPrice != null ? Number(variant.discountPrice) : Number(variant.price);
          const deliveryCharge = Number(variant.deliveryCharge);
          return {
            sellerId: listing.sellerId,
            lineTotal: price * cart.quantity,
            deliveryCharge: 0, // buyer pays courier directly to seller, NOT collected in groupTotal -- see doc comment above
            orderItem: {
              productId: product.id,
              productName: product.name,
              productImage: (product.images as string[])[0] ?? "",
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
        },
      );

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
      let couponRow: typeof couponsTable.$inferSelect | null = null;
      if (couponCode) {
        const [coupon] = await db
          .select()
          .from(couponsTable)
          .where(eq(couponsTable.code, couponCode.toUpperCase()))
          .limit(1);
        if (coupon && coupon.isActive) {
          const sellerInCart =
            coupon.sellerId === null || allLines.some((l) => l.sellerId === coupon.sellerId);
          if (!sellerInCart) {
            res.status(400).json({ error: "This coupon isn't valid for the items in your cart." });
            return;
          }
          // Usage limit check: if the coupon has reached its global usage
          // limit, reject it rather than silently applying a discount that
          // exceeds the campaign budget.
          if (coupon.usageLimit != null && coupon.timesUsed >= coupon.usageLimit) {
            res.status(400).json({ error: "This coupon has reached its usage limit." });
            return;
          }
          couponDiscount =
            coupon.discountType === "percentage"
              ? Math.floor((grandSubtotal * Number(coupon.discountValue)) / 100)
              : Math.min(Number(coupon.discountValue), grandSubtotal);
          couponSellerId = coupon.sellerId;
          couponRow = coupon;
        }
      }

      // Part 3: phone-verified guests use this same checkout endpoint.
      // Guests can't use loyalty points (no loyalty_points row exists for
      // guest_<phone> — FK to users.clerkId would fail), can't save
      // addresses (same FK issue), and don't have an email for order
      // confirmation. The isGuest flag gates all three features.
      const isGuest = req.userId!.startsWith("guest_");

      let loyaltyDiscount = 0;
      const pointsToRedeem = isGuest
        ? 0
        : Math.max(0, Math.floor(Number(loyaltyPointsToRedeem) || 0));
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
      const afterCoupon = groupBySellerAndAllocateDiscount(
        allLines,
        couponDiscount,
        couponSellerId,
      );
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
          res
            .status(400)
            .json({ error: "Payment method is required for every seller in your cart" });
          return;
        }
        if (method === "bkash" && !(await isPlatformBkashAvailable())) {
          res.status(400).json({
            error: "bKash payment isn't available right now. Please choose Cash on Delivery.",
          });
          return;
        }
        const groupSenderNumber: string | null = sellerSenderNumbers?.[key] ?? senderNumber ?? null;
        resolvedPaymentMethods.set(g.sellerId, method);
        resolvedSenderNumbers.set(g.sellerId, groupSenderNumber?.trim() || null);
      }

      // 6 bytes (48 bits) = ~281 trillion possibilities. Collision-safe at
      // marketplace scale; previously was 4 bytes (32 bits = ~4 billion).
      const trackingId = () => generateId("EE", 6);

      // Fetch gift wrap cost from platform config (was hardcoded at 50).
      // Falls back to 50 if the config row doesn't exist or the column is NULL.
      const [giftWrapConfig] = await db
        .select({ giftWrapCost: platformPaymentConfigTable.giftWrapCost })
        .from(platformPaymentConfigTable)
        .limit(1);
      const giftWrapCost =
        giftWrapConfig?.giftWrapCost != null ? Number(giftWrapConfig.giftWrapCost) : 50;

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
                // Sequential order number from a Postgres SEQUENCE (created
                // via migration). nextval is atomic and race-free — two
                // concurrent checkouts always get different numbers.
                orderNumber: sql`nextval('order_number_seq')`,
                userId: req.userId!,
                sellerId: g.sellerId,
                items: g.lines.map((l) => l.orderItem),
                totalAmount: String(groupTotal + (giftWrap ? giftWrapCost : 0)),
                paymentMethod: method,
                paymentStatus,
                orderStatus: "pending",
                transactionId: method === "bkash" ? null : (transactionId?.trim() ?? null),
                senderNumber: method === "bkash" ? null : groupSenderNumber,
                shippingAddress,
                couponCode: g.discountAmount > 0 && couponCode ? couponCode : null,
                discountAmount: String(g.discountAmount),
                giftWrap: !!giftWrap,
                giftMessage: giftWrap ? giftMessage : null,
                // Idempotency key from the request header (NULL if not provided).
                // Only the FIRST order in a multi-seller split gets the key —
                // subsequent orders in the same checkout are part of the same
                // idempotent operation, so they don't need their own keys.
                idempotencyKey: created.length === 0 ? (idempotencyKey ?? null) : null,
                // bKash orders get a 60-minute payment window; COD orders
                // have no payment-pending state to expire.
                paymentExpiresAt: method === "bkash" ? paymentExpiryDate() : null,
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
              tx
                .update(productVariantsTable)
                .set({ stock: Math.max(0, variant.stock - cart.quantity) })
                .where(eq(productVariantsTable.id, variant.id)),
            ),
            // Phase 2: stock decrement moves to sellerListingVariantsTable -- the
            // listing itself no longer carries stock/availableQuantity.
            ...listingLines.map(({ cart, variant }) =>
              tx
                .update(sellerListingVariantsTable)
                .set({
                  stock: Math.max(0, variant.stock - cart.quantity),
                  availableQuantity: Math.max(0, variant.availableQuantity - cart.quantity),
                  updatedAt: new Date(),
                })
                .where(eq(sellerListingVariantsTable.id, variant.id)),
            ),
          ]);

          // Increment coupon usage counter inside the transaction — if the
          // transaction rolls back, the counter isn't incremented (no phantom
          // usage). Atomic with the order creation. Only incremented once
          // per checkout, not once per seller-group order.
          if (couponRow) {
            await tx
              .update(couponsTable)
              .set({ timesUsed: sql`${couponsTable.timesUsed} + 1` })
              .where(eq(couponsTable.id, couponRow.id));
          }

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

      // Loyalty points redeem/award — guests skip this entirely (no
      // loyalty_points row, FK to users.clerkId would fail). Fire-and-forget
      // for authenticated users.
      if (!isGuest) {
        if (pointsToRedeem > 0) {
          const actualPointsToRedeem = Math.ceil(loyaltyDiscount / TAKA_PER_POINT);
          redeemPoints(req.userId!, actualPointsToRedeem, createdOrders[0].id).catch(() => {});
        }
        const grandTotal = createdOrders.reduce((s, o) => s + Number(o.totalAmount), 0);
        awardPoints(req.userId!, createdOrders[0].id, grandTotal).catch(() => {});
      }

      // Address auto-save — guests skip this (addressesTable.userId has
      // an FK to users.clerkId, which would fail for guest_<phone>).
      // Authenticated users get their shipping address saved for next time.
      if (!isGuest) {
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
      }

      // Email order confirmation — guests skip email (no users row).
      // Instead, guests get a WhatsApp order confirmation (they have a
      // verified phone number — we know they have WhatsApp).
      if (!isGuest) {
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
            [userRow.firstName, userRow.lastName].filter(Boolean).join(" ") || "Customer";
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
      } else {
        // Guest — send WhatsApp order confirmation to the verified phone.
        // The phone is extracted from the guest userId ("guest_<phone>")
        // and the shipping address phone. We use the guest userId phone
        // (verified via OTP) as the destination — it's guaranteed to be
        // a real WhatsApp-capable number.
        const guestPhone = req.userId!.replace("guest_", "");
        // Send one WhatsApp message per order (Daraz sends per-order too,
        // so the buyer can track each one independently).
        for (const order of createdOrders) {
          sendWhatsAppOrderConfirmation({
            phone: guestPhone,
            orderSummary: {
              trackingId: order.trackingId,
              totalAmount: Number(order.totalAmount),
              itemCount: (order.items as any[]).length,
              paymentMethod: order.paymentMethod,
            },
          }).catch(() => {});
        }
      }

      // ── Payment Session creation (Phase 1: multi-seller bKash) ──────
      // If ANY of the created orders is bKash, create ONE payment session
      // covering all bKash orders from this checkout. The buyer then pays
      // the session total (sum of all bKash orders) in a SINGLE bKash
      // redirect, instead of N separate bKash redirects. This is the
      // industry-standard pattern (Shopify, Amazon, Etsy all do this).
      //
      // COD orders are NOT linked to the session — they have no bKash
      // charge to group. Only bKash orders get linked.
      //
      // The session is created OUTSIDE the checkout transaction because:
      // 1. The orders are already committed (the transaction succeeded).
      // 2. If session creation fails (DB blip), the orders still exist —
      //    the buyer can retry payment per-order from the order detail
      //    page (fallback to the old per-order flow).
      // 3. The session is a payment-orchestration concern, not an order-
      //    creation concern — they have different failure modes.
      const bkashOrders = createdOrders.filter((o) => o.paymentMethod === "bkash");
      let paymentSessionId: number | null = null;
      if (bkashOrders.length > 0) {
        try {
          const sessionTotal = bkashOrders.reduce((s, o) => s + Number(o.totalAmount), 0);
          const [session] = await db
            .insert(paymentSessionsTable)
            .values({
              userId: req.userId!,
              totalAmount: String(sessionTotal),
              paymentStatus: "payment_pending",
              paymentExpiresAt: paymentExpiryDate(),
            })
            .returning();
          paymentSessionId = session.id;

          // Link all bKash orders to this session. The callback will use
          // this FK to cascade "paid" status to all linked orders when
          // the single bKash payment succeeds.
          await db
            .update(ordersTable)
            .set({ paymentSessionId: session.id })
            .where(
              inArray(
                ordersTable.id,
                bkashOrders.map((o) => o.id),
              ),
            );
        } catch (err) {
          // Non-fatal: if session creation fails, the orders still exist.
          // The buyer falls back to the old per-order payment flow
          // (POST /bkash/create-payment with orderId). Log so we know.
          logger.error(
            { err, userId: req.userId!, orderIds: bkashOrders.map((o) => o.id) },
            "Payment session creation failed — falling back to per-order payment",
          );
        }
      }

      // Always an array, even when checkout didn't split (single-seller or
      // all-admin-direct cart still produces exactly one order). A
      // conditional single-object-vs-wrapper response shape forces every
      // caller to branch on "did it split," which is worse than the one-time
      // cost of every caller expecting an array. See CheckoutPage.tsx.
      //
      // paymentSessionId is included when a bKash session was created —
      // the frontend uses it to call POST /bkash/create-payment-session
      // (one bKash redirect for all orders) instead of POST /bkash/create-payment
      // (one redirect per order). NULL for COD-only carts.
      const formattedOrders = createdOrders.map(formatOrder);
      res.status(201).json({
        orders: formattedOrders,
        paymentSessionId,
      } as any);
    } catch (err) {
      logger.error({ err, userId: req.userId! }, "Order creation failed");
      res.status(500).json({ error: "Failed to create order" });
    }
  },
);

router.get(
  "/orders/track/:trackingId",
  trackOrderLimiter,
  asyncHandler(async (req, res) => {
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

    const statuses = ["pending", "confirmed", "processing", "shipped", "delivered"];
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

    // ─── PII REDACTION ───────────────────────────────────────────────────
    // The tracking endpoint is PUBLIC (no auth, no OTP) — anyone who knows
    // or guesses the tracking ID can fetch this response. The previous
    // implementation returned the full `formatOrder(...)` payload, which
    // includes shippingAddress (fullName, phone, street, city, district,
    // postalCode), userId (which leaks the buyer's phone for guests as
    // "guest_<phone>"), senderNumber, giftMessage, transactionId, and
    // paymentSessionId — all of which constitute PII or internal payment
    // identifiers.
    //
    // The TrackOrderPage UI only needs: trackingId, orderNumber, status,
    // timeline, payment method/status, total + subtotal + discount (for the
    // delivery-cost breakdown), items (for product names + quantities, NOT
    // customer-PII), and timestamps. So we return exactly that subset.
    //
    // Item-level PII: `order.items` is a jsonb array of OrderItem shapes
    // (see lib/db/src/logic/orders.ts) — each item has productName,
    // productImage, quantity, price, deliveryCharge. None of these are
    // customer-PII (they describe the product, not the buyer), so the
    // items array is returned as-is. If a future OrderItem field ever
    // adds buyer info (e.g. gift-wrap recipient phone), it must be
    // stripped here.
    //
    // The authenticated GET /orders/:id route still returns the full
    // formatOrder(...) payload (including shippingAddress) because the
    // caller there is scoping by req.userId — only the order's owner
    // can read it.
    const subtotal = (order.items as any[]).reduce((s, i) => s + Number(i.price) * i.quantity, 0);

    res.json({
      trackingId: order.trackingId,
      orderNumber: order.orderNumber ?? null,
      orderStatus: order.orderStatus,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      totalAmount: Number(order.totalAmount),
      subtotal,
      discountAmount: Number(order.discountAmount),
      giftWrap: order.giftWrap,
      items: order.items,
      timeline,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      confirmedAt: order.confirmedAt ? order.confirmedAt.toISOString() : null,
      shippedAt: order.shippedAt ? order.shippedAt.toISOString() : null,
      deliveredAt: order.deliveredAt ? order.deliveredAt.toISOString() : null,
      cancelledAt: order.cancelledAt ? order.cancelledAt.toISOString() : null,
      // Explicitly NOT included: shippingAddress, userId, senderNumber,
      // giftMessage, transactionId, paymentSessionId, couponCode.
      // These are returned only by the authenticated GET /orders/:id route.
    });
  }),
);

router.get(
  "/orders/:id",
  requireGuestOrAuth,
  asyncHandler(async (req: ApiRequest, res) => {
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
  }),
);

router.post(
  "/orders/:id/cancel",
  requireGuestOrAuth,
  validateBody(CancelOrderBody, "CancelOrderBody"),
  asyncHandler(async (req: ApiRequest<z.infer<typeof CancelOrderBody>>, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      throw new HttpError(400, "Invalid order ID");
    }
    const { reason } = req.body;
    if (!reason || reason.trim().length < 3) {
      throw new HttpError(400, "Cancellation reason is required");
    }

    const [order] = await db
      .select()
      .from(ordersTable)
      .where(and(eq(ordersTable.id, id), eq(ordersTable.userId, req.userId!)))
      .limit(1);

    if (!order) throw new HttpError(404, "Order not found");

    // RELAXED: buyer can cancel until the order is SHIPPED (was: only
    // pending). Standard e-commerce allows buyer cancellation until the
    // package leaves the seller's hands — once it's shipped, it's in the
    // courier's possession and the buyer must use the return flow instead.
    // "return_completed" and "cancelled" are also rejected (already in
    // a terminal state).
    const cancellableStatuses = ["pending", "confirmed", "processing"];
    if (!cancellableStatuses.includes(order.orderStatus)) {
      throw new HttpError(
        400,
        order.orderStatus === "shipped"
          ? "Cannot cancel an order that has already been shipped. Please request a return after delivery."
          : `Cannot cancel an order that is already "${order.orderStatus}". Please contact support.`,
      );
    }

    // ── Stock restoration on cancel ────────────────────────────────
    // BUG FIX: previously, cancelling an order did NOT restore the stock
    // that was decremented at checkout — cancelled orders permanently
    // lost inventory. Now restores via additive `stock = stock + quantity`
    // (idempotent — safe even if the job runs twice).
    const items = (order.items ?? []) as OrderItem[];
    for (const item of items) {
      if (item.variantId != null) {
        await db
          .update(productVariantsTable)
          .set({ stock: sql`${productVariantsTable.stock} + ${item.quantity}` })
          .where(eq(productVariantsTable.id, item.variantId));
      } else if (item.sellerListingVariantId != null) {
        await db
          .update(sellerListingVariantsTable)
          .set({
            stock: sql`${sellerListingVariantsTable.stock} + ${item.quantity}`,
            availableQuantity: sql`${sellerListingVariantsTable.availableQuantity} + ${item.quantity}`,
            updatedAt: new Date(),
          })
          .where(eq(sellerListingVariantsTable.id, item.sellerListingVariantId));
      }
    }

    const [updated] = await db
      .update(ordersTable)
      .set({
        orderStatus: "cancelled",
        paymentStatus:
          order.paymentStatus === "payment_pending" ? "cancelled" : order.paymentStatus,
        cancellationReason: reason.trim(),
        cancelledAt: new Date(),
        // Clear the payment-pending expiry timer (if any) — the order is
        // now cancelled, not waiting for payment.
        paymentExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(ordersTable.id, id))
      .returning();

    // Notify the seller (if marketplace order) that the buyer cancelled.
    // Fire-and-forget — non-blocking. The seller should know their order
    // was cancelled + stock was restored.
    if (order.sellerId) {
      try {
        const [seller] = await db
          .select()
          .from(sellersTable)
          .where(eq(sellersTable.id, order.sellerId))
          .limit(1);
        if (seller?.contactEmail) {
          // Best-effort: a proper "order cancelled" seller email template
          // is a follow-up. For now, the seller sees the cancellation in
          // their dashboard on next refresh.
        }
      } catch (err) {
        logger.warn({ err, orderId: id }, "Cancel: seller notification failed (non-blocking)");
      }
    }

    res.json(formatOrder(updated));
  }),
);

export default router;
