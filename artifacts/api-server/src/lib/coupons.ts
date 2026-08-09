/**
 * Coupon validation business logic.
 *
 * EXTRACTED from routes/coupons.ts (the /coupons/validate endpoint) so that:
 *  • The same validation is reused by routes/orders.ts at checkout time,
 *    eliminating the duplication between the "validate" endpoint and the
 *    "apply at checkout" flow.
 *  • The logic is unit-testable in isolation.
 *  • Future non-HTTP callers (cron jobs that apply auto-coupons, CLI tools)
 *    can reuse it without importing Express.
 *
 * ─── Validation rules ───────────────────────────────────────────────────────
 *
 *  1. Coupon exists and `isActive = true`.
 *  2. `expiryDate` (if set) is in the future.
 *  3. `orderAmount >= minOrderAmount` (if minOrderAmount is set).
 *  4. If `coupon.sellerId` is set, the cart must contain at least one item
 *     from that seller. (sellerIds is the distinct seller ids in the buyer's
 *     cart — null excluded. If the caller doesn't send sellerIds, this check
 *     is skipped and the order-creation-time check remains the enforcement.)
 *
 * Returns the coupon row on success. Throws `HttpError` (with the appropriate
 * status + message) on validation failure — the caller can let it propagate
 * to the global error handler, or catch it and re-throw.
 */

import { db } from "@workspace/db";
import { couponsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { HttpError } from "./errors";

export interface ValidatedCoupon {
  id: number;
  code: string;
  discountType: "percentage" | "fixed";
  discountValue: number;  // already converted from numeric string
  minOrderAmount: number | null;
  sellerId: number | null;
  expiryDate: Date | null;
}

/**
 * Validate a coupon code against an order. Throws HttpError on validation
 * failure. Returns the coupon (with discountValue coerced to a number) on
 * success.
 *
 * @param code        The raw coupon code as the buyer typed it. Will be
 *                    uppercased + stripped of non-alphanumeric chars.
 * @param orderAmount The order subtotal (used for minOrderAmount check).
 * @param sellerIds   Optional: distinct seller ids in the buyer's cart
 *                    (null excluded). If omitted, the seller-scoping check
 *                    is skipped.
 */
export async function validateCoupon(
  code: string,
  orderAmount: number,
  sellerIds?: number[],
): Promise<ValidatedCoupon> {
  // Sanitize coupon code — only alphanumeric + dashes (business rule).
  const sanitizedCode = code.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (!sanitizedCode) {
    throw new HttpError(400, "Invalid coupon code format");
  }

  const [coupon] = await db
    .select()
    .from(couponsTable)
    .where(eq(couponsTable.code, sanitizedCode))
    .limit(1);

  if (!coupon || !coupon.isActive) {
    throw new HttpError(404, "Invalid or expired coupon");
  }

  if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
    throw new HttpError(400, "Coupon has expired");
  }

  if (coupon.minOrderAmount && orderAmount < Number(coupon.minOrderAmount)) {
    throw new HttpError(
      400,
      `Minimum order amount is ৳${coupon.minOrderAmount}`,
    );
  }

  // Seller scoping — same rule enforced at order-creation time in
  // routes/orders.ts (see groupBySellerAndAllocateDiscount's targetSellerId
  // doc comment). Checked here too so the buyer sees an honest "invalid
  // coupon" at the moment they type the code instead of a false "applied!"
  // that then silently fails at Place Order.
  if (coupon.sellerId !== null && sellerIds !== undefined) {
    const cartHasSeller = sellerIds.some((id) => id === coupon.sellerId);
    if (!cartHasSeller) {
      throw new HttpError(400, "This coupon isn't valid for the items in your cart.");
    }
  }

  return {
    id: coupon.id,
    code: coupon.code,
    discountType: coupon.discountType as "percentage" | "fixed",
    discountValue: Number(coupon.discountValue),
    minOrderAmount: coupon.minOrderAmount != null ? Number(coupon.minOrderAmount) : null,
    sellerId: coupon.sellerId,
    expiryDate: coupon.expiryDate,
  };
}

/**
 * Compute the discount amount for a given coupon + order subtotal.
 *
 * For percentage coupons: `floor(subtotal * discountValue / 100)`.
 * For fixed coupons: `min(discountValue, subtotal)` — never more than the
 * order total (no negative totals).
 */
export function computeDiscount(coupon: ValidatedCoupon, subtotal: number): number {
  if (coupon.discountType === "percentage") {
    return Math.floor((subtotal * coupon.discountValue) / 100);
  }
  return Math.min(coupon.discountValue, subtotal);
}
