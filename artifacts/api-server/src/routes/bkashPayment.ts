import { logger } from "../lib/logger";
import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { createPayment, executePayment, queryPayment, BkashApiError } from "../lib/bkash";
import { checkoutLimiter, guestBkashLimiter } from "../middlewares/rateLimiter";
import { CreateBkashPaymentBody, CreateBkashPaymentGuestBody } from "@workspace/api-zod";
import { validateBody } from "../lib/validateRequest";
import type { ApiRequest } from "../types/apiRequest";
import type { z } from "zod";

/**
 * bKash Tokenized Checkout create -> redirect -> callback -> execute cycle
 * (Part 2 of 4, see PART2_HANDOFF.md). Deliberately NOT registered in
 * lib/api-spec/openapi.yaml for /bkash/callback specifically -- same
 * precedent as routes/courierWebhooks.ts (checked before writing this):
 * an external provider's redirect/webhook target isn't part of our typed
 * frontend-facing client. POST /bkash/create-payment and
 * GET /bkash/query-payment/:paymentID ARE genuinely called by our own
 * frontend, so those two ARE added to openapi.yaml (see that file's
 * bkashPayment block).
 *
 * ORDER-SEQUENCING DECISION (the prompt's own "single most consequential
 * design decision in this part" -- full reasoning repeated here, not just
 * in the handoff doc, since it directly explains this file's shape):
 * routes/orders.ts now creates the order row(s) FIRST, at paymentStatus
 * "payment_pending", exactly the same way it already creates a
 * "pending_verification" row today before any manual bKash confirmation
 * happens -- checkout's existing stock-decrement / discount-allocation /
 * multi-seller-split / address-save / email logic in orders.ts is entirely
 * REUSED, unchanged, rather than rebuilt around a "cart snapshot held
 * somewhere until payment succeeds" alternative. This route's
 * POST /bkash/create-payment then takes an ALREADY-CREATED order's
 * trackingId as bKash's merchantInvoiceNumber and kicks off Create
 * Payment. See this file's own doc comment further down and
 * PART2_HANDOFF.md for the full alternative-considered writeup (why
 * "hold order creation until Execute Payment succeeds" was rejected).
 *
 * MULTI-ORDER CARTS: bKash's Create Payment takes exactly one amount and
 * one merchantInvoiceNumber -- there is no "pay N orders in one bKash
 * session" concept in the API. A multi-seller cart checkout (routes/orders.ts's
 * POST /orders) already returns an ARRAY of created orders. For a cart
 * where MULTIPLE resulting orders resolved to "bkash", the frontend calls
 * POST /bkash/create-payment (or its guest counterpart, see below) ONCE
 * PER bkash order, sequentially (pay order 1 -> land back via callback ->
 * pay order 2 -> ...), driven from CheckoutPage.tsx's post-create-order
 * response. This is a real UX tradeoff (multiple bKash hosted-page
 * round-trips instead of one), not hidden: flagged explicitly in
 * PART2_HANDOFF.md as the honest cost of "bKash has no multi-invoice
 * payment primitive," not glossed over.
 *
 * TWO create-payment ROUTES, not one: POST /bkash/create-payment
 * (requireAuth-gated, orderId in body) for logged-in buyers, and
 * POST /bkash/create-payment/guest (public, trackingId in body) for guest
 * checkout -- mirrors this codebase's existing convention of guest vs.
 * authenticated checkout being two separate routes (routes/orders.ts's
 * POST /orders/guest vs POST /orders) rather than one route silently
 * branching on whether an auth token happened to be attached.
 */

const router = Router();

/**
 * Loads an order by id, scoped to the authenticated caller. Used by the
 * authenticated create-payment route below -- mirrors GET /orders/:id's
 * own ownership rule (order.userId === req.userId) in routes/orders.ts.
 */
async function loadOwnOrder(
  req: ApiRequest,
): Promise<{ order: typeof ordersTable.$inferSelect } | { error: string; status: number }> {
  const { orderId } = req.body as { orderId?: number };
  if (orderId == null) return { error: "orderId is required", status: 400 };
  const id = Number(orderId);
  if (isNaN(id) || id <= 0) return { error: "Invalid order id", status: 400 };
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
  if (!order || order.userId !== req.userId) return { error: "Order not found", status: 404 };
  return { order };
}

/**
 * Loads a GUEST order by tracking id, no auth required. Mirrors
 * GET /orders/track/:trackingId's own trust model (routes/orders.ts,
 * public route, no middleware): the tracking id itself -- an 8-hex-char
 * random suffix generated server-side, never sequential/guessable -- is
 * the bearer secret, since a guest has no other identity to check
 * against. Scoped to orders whose userId starts with "guest_" so this
 * can't be used to reach an authenticated account's order by trying its
 * tracking id here instead of through the authenticated route.
 */
async function loadGuestOrder(
  req: ApiRequest,
): Promise<{ order: typeof ordersTable.$inferSelect } | { error: string; status: number }> {
  const { trackingId } = req.body as { trackingId?: string };
  if (!trackingId || !/^[A-Z0-9]{2,20}$/i.test(trackingId)) {
    return { error: "A valid trackingId is required", status: 400 };
  }
  const [order] = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.trackingId, trackingId.toUpperCase()))
    .limit(1);
  if (!order || !order.userId.startsWith("guest_"))
    return { error: "Order not found", status: 404 };
  return { order };
}

/**
 * Shared Create Payment logic for both routes below -- everything past
 * "we have an order we're allowed to act on" is identical regardless of
 * which ownership check got us there.
 */
async function handleCreatePayment(order: typeof ordersTable.$inferSelect, res: any) {
  if (order.paymentMethod !== "bkash") {
    res.status(400).json({ error: "This order isn't a bKash order" });
    return;
  }
  // Idempotency guard: an order already marked "paid" shouldn't be
  // payable again (buyer hitting back/refresh after a successful payment,
  // or a double-submit). "payment_pending" is the only status this route
  // will act on -- anything else (paid, failed, refunded, cancelled) is
  // refused rather than silently re-running Create Payment against a
  // settled order.
  if (order.paymentStatus !== "payment_pending") {
    res.status(400).json({
      error: `This order's payment status is "${order.paymentStatus}", not payable via bKash right now.`,
    });
    return;
  }

  const callbackURL = `${process.env.APP_URL ?? "https://treefriend.com"}/api/bkash/callback`;

  let result;
  try {
    result = await createPayment({
      amount: Number(order.totalAmount),
      invoiceNumber: order.trackingId,
      callbackURL,
    });
  } catch (err) {
    if (err instanceof BkashApiError) {
      logger.error({ err, step: err.step }, "bkash create-payment error");
      res.status(502).json({ error: "Couldn't start bKash payment. Please try again shortly." });
      return;
    }
    throw err;
  }

  // Persist the bKash paymentID on the order row so the callback can look
  // up the order directly by paymentID (indexed) instead of calling
  // queryPayment (a network round-trip to bKash's API) just to discover
  // which order the callback is for. This eliminates one API call per
  // callback and makes the callback O(1) on the DB.
  await db
    .update(ordersTable)
    .set({ bkashPaymentId: result.paymentID })
    .where(eq(ordersTable.id, order.id));

  res.json({
    paymentID: result.paymentID,
    bkashURL: result.bkashURL,
    orderId: order.id,
    trackingId: order.trackingId,
  });
}

/**
 * POST /bkash/create-payment — AUTHENTICATED path, for a logged-in
 * buyer's own order (orderId in body). requireAuth-gated at the route
 * level (fixes an earlier draft of this file that imported requireAuth
 * but never actually applied it, which would have left req.userId unset
 * for every caller). Called by the frontend right after checkout creates
 * the order(s) (or, separately, from an order-detail "retry payment"
 * action for an order still sitting at paymentStatus "payment_pending" --
 * see doc comment on that status in routes/admin.ts). Returns bKash's
 * bkashURL for the frontend to redirect/popup the buyer to.
 *
 * See order-sequencing doc comment at the top of this file for why this
 * acts on an ALREADY-CREATED order rather than creating one itself.
 */
router.post(
  "/bkash/create-payment",
  requireAuth,
  checkoutLimiter,
  validateBody(CreateBkashPaymentBody, "CreateBkashPaymentBody"),
  async (req: ApiRequest<z.infer<typeof CreateBkashPaymentBody>>, res) => {
    try {
      const loaded = await loadOwnOrder(req);
      if ("error" in loaded) {
        res.status(loaded.status).json({ error: loaded.error });
        return;
      }
      await handleCreatePayment(loaded.order, res);
    } catch (err) {
      logger.error({ err: err }, "[bkash] create-payment unexpected error");
      res.status(500).json({ error: "Failed to start bKash payment" });
    }
  },
);

/**
 * POST /bkash/create-payment/guest — PUBLIC path, for guest checkout
 * (trackingId in body, no auth). Split into its own route rather than
 * branching on presence/absence of an auth token in one shared route,
 * specifically so this route can be left OFF requireAuth honestly instead
 * of the handler quietly deciding for itself whether auth was "required
 * this time" -- matches this codebase's existing convention of guest vs.
 * authenticated checkout being two entirely separate routes in
 * routes/orders.ts (POST /orders/guest vs POST /orders) rather than one
 * route with conditional auth.
 */
router.post(
  "/bkash/create-payment/guest",
  guestBkashLimiter,
  validateBody(CreateBkashPaymentGuestBody, "CreateBkashPaymentGuestBody"),
  async (req: ApiRequest<z.infer<typeof CreateBkashPaymentGuestBody>>, res) => {
    try {
      const loaded = await loadGuestOrder(req);
      if ("error" in loaded) {
        res.status(loaded.status).json({ error: loaded.error });
        return;
      }
      await handleCreatePayment(loaded.order, res);
    } catch (err) {
      logger.error({ err }, "bkash create-payment (guest) unexpected error");
      res.status(500).json({ error: "Failed to start bKash payment" });
    }
  },
);

/**
 * GET /bkash/callback — bKash redirects the buyer's BROWSER here after
 * they complete or cancel/fail authorization on bKash's own hosted page.
 * Verified as GET (query-string paymentID/status), not POST, across every
 * integration guide checked while building this (see lib/bkash.ts's module
 * doc comment for the sourcing caveat) -- bKash appends paymentID and a
 * status indicator to the callbackURL as query params rather than posting
 * a body, since this is a browser REDIRECT, not a server-to-server
 * webhook (contrast with courierWebhooks.ts, which genuinely is a
 * server-to-server POST). Flagged for the same "verify before this
 * touches real money" reason as the base URLs in lib/bkash.ts.
 *
 * bKash's own query param for outcome is commonly `status` with values
 * like "success" | "failure" | "cancel" in the sources checked -- this
 * handler treats anything other than "success" as non-success and skips
 * calling Execute Payment (calling Execute Payment on a payment the buyer
 * cancelled would be pointless and, per every guide checked, bKash's own
 * execute call for a non-authorized paymentID just returns a failure
 * status anyway -- but skipping it here avoids the extra round-trip and
 * keeps the order's paymentStatus change conditioned on OUR read of the
 * redirect, not a second network call's outcome, for the cancel case
 * specifically).
 *
 * On success: calls Execute Payment (the actual finalizing call -- see
 * lib/bkash.ts), and only flips paymentStatus to "paid" if bKash's
 * transactionStatus for the execute response is itself a success value
 * ("Completed", per every source checked). On any other outcome (buyer
 * cancelled, execute fails, transactionStatus isn't "Completed"), the
 * order is left at "payment_pending" -- NOT flipped to "failed" -- so the
 * buyer can retry the SAME order via another POST /bkash/create-payment
 * call rather than the order being permanently dead. This mirrors how the
 * OLD manual flow never had a hard "failed" state either (an unconfirmed
 * "pending_verification" order just sat there until an admin acted) --
 * "payment_pending" plays the same "still awaitable" role
 * "pending_verification" already played for pre-orders under that old
 * manual/SMS-based flow (since removed), just for the new live-API flow
 * instead of the old manual one.
 *
 * Redirects the buyer's browser to a frontend page afterward (does not
 * return JSON -- this endpoint is only ever hit by a browser redirect, no
 * frontend code calls it directly).
 */
router.get("/bkash/callback", async (req, res) => {
  const frontendBase = process.env.APP_URL ?? "https://treefriend.com";
  try {
    const paymentID = typeof req.query.paymentID === "string" ? req.query.paymentID : undefined;
    const status =
      typeof req.query.status === "string" ? req.query.status.toLowerCase() : undefined;

    if (!paymentID) {
      res.redirect(`${frontendBase}/orders?bkash=missing_payment_id`);
      return;
    }

    // Look up the order by the bKash paymentID that was persisted on the
    // order row at Create Payment time (routes/bkashPayment.ts:
    // handleCreatePayment writes bkashPaymentId). This is an indexed
    // lookup (orders_bkash_payment_id_idx) — O(1) on the DB, no network
    // call to bKash needed just to find the order.
    //
    // Fallback: if no order has this paymentID (e.g. the order was
    // created before the bkashPaymentId column existed, or the
    // handleCreatePayment write failed silently), fall back to the old
    // queryPayment path to recover the merchantInvoiceNumber.
    const [orderByPaymentId] = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.bkashPaymentId, paymentID))
      .limit(1);

    let order: typeof ordersTable.$inferSelect | null = orderByPaymentId ?? null;

    if (!order) {
      // Fallback: query bKash for the merchantInvoiceNumber (the old path).
      // This handles legacy orders that don't have bkashPaymentId set.
      let merchantInvoiceNumber: string | null = null;
      try {
        const queried = await queryPayment({ paymentID });
        merchantInvoiceNumber = queried.merchantInvoiceNumber ?? null;
      } catch (err) {
        logger.error({ err: err }, "[bkash] callback: query-payment lookup failed");
      }

      if (!merchantInvoiceNumber) {
        res.redirect(
          `${frontendBase}/orders?bkash=lookup_failed&paymentID=${encodeURIComponent(paymentID)}`,
        );
        return;
      }

      const [legacyOrder] = await db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.trackingId, merchantInvoiceNumber))
        .limit(1);

      if (!legacyOrder) {
        logger.error(
          { merchantInvoiceNumber },
          "[bkash] callback: no order matches merchantInvoiceNumber",
        );
        res.redirect(`${frontendBase}/orders?bkash=order_not_found`);
        return;
      }
      order = legacyOrder;
    }

    const orderPath = order.userId.startsWith("guest_")
      ? `/orders/${order.trackingId}`
      : `/orders/${order.id}`;

    if (status && status !== "success") {
      res.redirect(`${frontendBase}${orderPath}?bkash=${status}`);
      return;
    }

    let executed;
    try {
      executed = await executePayment({ paymentID });
    } catch (err) {
      logger.error({ err: err }, "[bkash] callback: execute-payment failed");
      res.redirect(`${frontendBase}${orderPath}?bkash=execute_failed`);
      return;
    }

    if (executed.transactionStatus !== "Completed") {
      res.redirect(`${frontendBase}${orderPath}?bkash=not_completed`);
      return;
    }

    // ── Amount verification (security critical) ──────────────────────
    // Verify the paid amount matches the order total. Previously the
    // order was marked "paid" based purely on transactionStatus ===
    // "Completed", without checking the amount — a partial payment or
    // manipulated invoice would still mark the order as paid. Industry
    // standard (Stripe, Shopify, every payment gateway): always assert
    // paid_amount === expected_amount before fulfilling the order.
    const paidAmount = Number(executed.amount);
    const expectedAmount = Number(order.totalAmount);
    if (isNaN(paidAmount) || Math.abs(paidAmount - expectedAmount) > 0.01) {
      logger.error(
        { orderId: order.id, expectedAmount, paidAmount, transactionId: executed.trxID },
        "[bkash] callback: amount mismatch — order NOT marked paid",
      );
      res.redirect(`${frontendBase}${orderPath}?bkash=amount_mismatch`);
      return;
    }

    await db
      .update(ordersTable)
      .set({
        paymentStatus: "paid",
        transactionId: executed.trxID,
        paidAt: new Date(),
        // Clear the payment-pending expiry timer — the order is now paid.
        paymentExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(ordersTable.id, order.id));

    res.redirect(`${frontendBase}${orderPath}?bkash=success`);
  } catch (err) {
    logger.error({ err: err }, "[bkash] callback unexpected error");
    res.redirect(`${frontendBase}/orders?bkash=error`);
  }
});

/**
 * GET /bkash/query-payment/:paymentID — reconciliation/debugging (prompt's
 * "your call" on whether to expose this -- decided yes). Admin-gated:
 * exposes raw bKash transaction status, which is an operational/support
 * tool (e.g. "buyer says they paid but the order still shows
 * payment_pending, what does bKash's own record say"), not something a
 * buyer needs directly -- a buyer-facing equivalent would just be
 * "refresh the order page," which already reflects whatever the callback
 * last wrote.
 */
router.get("/bkash/query-payment/:paymentID", requireAdmin, async (req: ApiRequest, res) => {
  try {
    const { paymentID } = req.params;
    const result = await queryPayment({ paymentID });
    res.json(result);
  } catch (err) {
    if (err instanceof BkashApiError) {
      logger.error({ err, step: err.step }, "bkash query-payment error");
      res.status(502).json({ error: "Couldn't query bKash payment status" });
      return;
    }
    logger.error({ err: err }, "[bkash] query-payment unexpected error");
    res.status(500).json({ error: "Failed to query payment" });
  }
});

export default router;
