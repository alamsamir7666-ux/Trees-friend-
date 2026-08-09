/**
 * Shared response formatters for entities that are returned from multiple
 * routes (e.g. `formatSeller` was duplicated byte-for-byte in `routes/sellers.ts`
 * and `routes/adminSellers.ts`; `formatOrder` was duplicated in `routes/orders.ts`
 * and `routes/admin.ts`).
 *
 * Centralizing these here:
 *  • Eliminates DRY violations (one bug fix → one place).
 *  • Ensures the admin and buyer-facing routes return the EXACT same shape
 *    for the same entity (frontend caching depends on this).
 *  • Makes the formatters unit-testable in isolation.
 *
 * Conventions:
 *  • Each formatter takes the raw Drizzle row type and returns a plain JSON-
 *    serializable object (Dates → ISO strings, numerics → numbers).
 *  • Formatters never throw; they're pure projections.
 *  • Add new formatters here as you encounter duplication. If a route needs
 *    a *different* shape (e.g. admin-only fields), extend the formatter with
 *    an options arg rather than duplicating the function.
 */

import type {
  sellersTable,
  ordersTable,
} from "@workspace/db";

/**
 * Public seller shape returned by /sellers/* and /admin/sellers/*.
 *
 * The previous `formatSeller` was duplicated byte-for-byte in
 * `routes/sellers.ts:32` and `routes/adminSellers.ts:25`. Both must return
 * the same shape so the frontend's TanStack Query cache can share entries
 * between the seller dashboard and the admin sellers view.
 */
export function formatSeller(s: typeof sellersTable.$inferSelect) {
  return {
    id: s.id,
    userId: s.userId,
    businessName: s.businessName,
    nurseryName: s.nurseryName,
    ownerName: s.ownerName,
    nidOrTradeLicenseUrl: s.nidOrTradeLicenseUrl,
    contactPhone: s.contactPhone,
    contactEmail: s.contactEmail,
    location: s.location,
    description: s.description,
    nurseryImages: s.nurseryImages,
    logoUrl: s.logoUrl,
    status: s.status,
    isVerified: s.isVerified,
    verificationRequestStatus: s.verificationRequestStatus,
    verificationRequestedAt: s.verificationRequestedAt?.toISOString() ?? null,
    verificationDecidedAt: s.verificationDecidedAt?.toISOString() ?? null,
    verificationRejectionReason: s.verificationRejectionReason,
    subscriptionStatus: s.subscriptionStatus,
    trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
    subscriptionExpiresAt: s.subscriptionExpiresAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/**
 * Public order shape returned by /orders/* and /admin/orders/*.
 *
 * The previous `formatOrder` was duplicated in `routes/orders.ts:34` and
 * `routes/admin.ts:52`. Same reasoning as `formatSeller` — the frontend
 * caches orders by id across the buyer and admin views.
 *
 * Note: the `items` array is passed through as-is (it's a jsonb column
 * with a per-order shape). Callers that need to project items should do so
 * in their own mapping rather than mutating this formatter.
 */
export function formatOrder(o: typeof ordersTable.$inferSelect) {
  return {
    id: o.id,
    trackingId: o.trackingId,
    userId: o.userId,
    sellerId: o.sellerId,
    items: o.items,
    totalAmount: Number(o.totalAmount),
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    orderStatus: o.orderStatus,
    transactionId: o.transactionId,
    shippingAddress: o.shippingAddress,
    couponCode: o.couponCode,
    discountAmount: Number(o.discountAmount),
    cancellationReason: o.cancellationReason ?? null,
    giftWrap: o.giftWrap ?? "false",
    giftMessage: o.giftMessage ?? null,
    senderNumber: o.senderNumber ?? null,
    paidAt: o.paidAt ? o.paidAt.toISOString() : null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}
