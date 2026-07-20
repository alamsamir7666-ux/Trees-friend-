/**
 * Moved here (Part 1 of the post-Phase-9 backlog) from
 * artifacts/api-server/src/routes/orders.ts, where it was a module-local
 * function. It's still exported from orders.ts (that file re-exports it)
 * so the existing call site there is unchanged.
 *
 * It was moved rather than simply marked `export` in place because
 * orders.ts transitively imports ../middlewares/auth (-> ./mobileJwt,
 * which throws at module-load time if MOBILE_JWT_SECRET isn't set),
 * ../lib/email (resend), and ./loyalty. This function itself has none of
 * those dependencies -- it's pure and synchronous, no `db`, no I/O -- so
 * there's no reason a consumer that only wants this function (like
 * scripts/src/verify-seller-marketplace.ts) should have to pull in or
 * satisfy any of that. Living in @workspace/db/logic alongside
 * hasVerifiedPaymentConfig keeps both of this backlog item's extracted
 * functions in one predictable place.
 *
 * Original doc comment, preserved: given a flat list of resolved lines
 * (each already tagged with sellerId -- null for admin-direct), groups
 * them by seller and computes one order's worth of items[]/subtotal per
 * group. Both the guest and authenticated checkout paths in orders.ts use
 * this so the split-by-seller behavior can't drift between them.
 *
 * Discount (coupon + loyalty) assignment: a platform-wide coupon or
 * loyalty redemption is NOT pro-rated across every resulting order -- it
 * is applied in full to exactly ONE resulting order (the largest by
 * subtotal), and the others show no discount. This avoids partial-discount
 * reconciliation problems if one of the split orders is later cancelled.
 * Caller passes the total discount amount to allocate; this function picks
 * the largest group and assigns it there.
 */
export function groupBySellerAndAllocateDiscount<
  L extends { sellerId: number | null; lineTotal: number },
>(lines: L[], totalDiscount: number) {
  const groups = new Map<number | null, L[]>();
  for (const line of lines) {
    const key = line.sellerId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(line);
  }

  const groupList = Array.from(groups.entries()).map(([sellerId, groupLines]) => ({
    sellerId,
    lines: groupLines,
    subtotal: groupLines.reduce((s, l) => s + l.lineTotal, 0),
  }));

  // Assign the full discount to the single largest-subtotal group.
  let largestIdx = 0;
  for (let i = 1; i < groupList.length; i++) {
    if (groupList[i].subtotal > groupList[largestIdx].subtotal) largestIdx = i;
  }

  return groupList.map((g, i) => ({
    ...g,
    discountAmount: i === largestIdx ? Math.min(totalDiscount, g.subtotal) : 0,
  }));
}
