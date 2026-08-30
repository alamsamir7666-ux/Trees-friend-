/**
 * Moved here (Part 1 of the post-Phase-9 backlog) from
 * artifacts/api-server/src/routes/orders.ts, where it was a module-local
 * function. It's still exported from orders.ts (that file re-exports it)
 * so the existing call site there is unchanged.
 *
 * Original doc comment, preserved: given a flat list of resolved lines
 * (each already tagged with sellerId -- null for admin-direct), groups
 * them by (sellerId, paymentMethod) and computes one order's worth of
 * items[]/subtotal per group. Both the guest and authenticated checkout
 * paths in orders.ts use this so the split-by-(seller×method) behavior
 * can't drift between them.
 *
 * Discount (coupon + loyalty) assignment: a platform-wide coupon or
 * loyalty redemption is NOT pro-rated across every resulting order -- it
 * is applied in full to exactly ONE resulting order (the largest by
 * subtotal), and the others show no discount. This avoids partial-discount
 * reconciliation problems if one of the split orders is later cancelled.
 * Caller passes the total discount amount to allocate; this function picks
 * the largest group and assigns it there.
 *
 * targetSellerId (optional, added alongside seller-scoped coupons):
 * defaults to undefined, which preserves the original "largest group"
 * behavior above -- this is what a platform-wide discount (loyalty
 * redemption, or a coupon with couponsTable.sellerId === null) should use.
 *
 * When a coupon IS seller-scoped, the caller must pass that coupon's
 * sellerId here instead of leaving it to "largest group". Without this,
 * a coupon created by Seller A would get handed to whichever seller
 * happens to have the biggest subtotal in a mixed cart -- e.g. Seller B --
 * discounting a sale Seller A has nothing to do with. The caller is
 * responsible for having already verified that targetSellerId actually
 * appears in `lines` (see requireCartHasSeller below); if it doesn't,
 * every group's discountAmount comes back 0 rather than silently falling
 * back to "largest group", since that fallback is exactly the bug this
 * parameter exists to prevent.
 *
 * Grouping key change (checkout-session refactor): previously grouped by
 * `sellerId` only (one order per seller). Now groups by `(sellerId,
 * paymentMethod)` — one order per (seller × payment method) combo. This
 * means a single seller with both COD and Advance items in the cart
 * produces TWO orders: one COD order and one bKash order. All sibling
 * orders from the same checkout share a `checkoutSessionId` so the buyer
 * can see them together in one UI.
 */
export function groupBySellerAndAllocateDiscount<
  L extends { sellerId: number | null; lineTotal: number; paymentMethod: string },
>(lines: L[], totalDiscount: number, targetSellerId?: number | null) {
  // Group by (sellerId, paymentMethod) — one order per combo. A seller
  // with both COD and Advance items splits into two groups.
  const groups = new Map<string, L[]>();
  for (const line of lines) {
    const key = `${line.sellerId ?? "null"}::${line.paymentMethod}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(line);
  }

  const groupList = Array.from(groups.entries()).map(([key, groupLines]) => {
    const [sellerIdStr, paymentMethod] = key.split("::");
    const sellerId = sellerIdStr === "null" ? null : Number(sellerIdStr);
    return {
      sellerId,
      paymentMethod,
      lines: groupLines,
      subtotal: groupLines.reduce((s, l) => s + l.lineTotal, 0),
    };
  });

  let targetIdx = -1;
  if (targetSellerId !== undefined) {
    // Seller-scoped coupon: only ever discount that seller's own group(s).
    // A seller with both COD + Advance groups: the discount lands on the
    // LARGER of the two (by subtotal) — same "largest group" logic, scoped
    // to just that seller's groups. No fallback to other sellers.
    const sellerGroupIdxs = groupList
      .map((g, i) => (g.sellerId === targetSellerId ? i : -1))
      .filter((i) => i >= 0);
    if (sellerGroupIdxs.length === 0) {
      targetIdx = -1;
    } else {
      targetIdx = sellerGroupIdxs[0];
      for (let i = 1; i < sellerGroupIdxs.length; i++) {
        if (groupList[sellerGroupIdxs[i]].subtotal > groupList[targetIdx].subtotal) {
          targetIdx = sellerGroupIdxs[i];
        }
      }
    }
  } else {
    // Platform-wide discount (no seller to target): original behavior --
    // assign the full discount to the single largest-subtotal group.
    targetIdx = 0;
    for (let i = 1; i < groupList.length; i++) {
      if (groupList[i].subtotal > groupList[targetIdx].subtotal) targetIdx = i;
    }
  }

  return groupList.map((g, i) => ({
    ...g,
    discountAmount: i === targetIdx ? Math.min(totalDiscount, g.subtotal) : 0,
  }));
}
