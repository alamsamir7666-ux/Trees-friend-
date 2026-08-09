import { asyncHandler } from "../lib/errors";
import { Router } from "express";
import { db } from "@workspace/db";
import { sellersTable, sellerPaymentConfigsTable, sellerCourierConfigsTable, sellerListingsTable } from "@workspace/db";
import { eq, desc, and, ne, count } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import { logAudit } from "../lib/audit";
import { maskCredential } from "../lib/credentialEncryption";
import { formatSeller } from "../lib/formatters";
import {
  ApproveSellerParams,
  RejectSellerParams,
  RejectSellerBody,
  SuspendSellerParams,
  VerifySellerParams,
  RejectSellerVerificationParams,
  RejectSellerVerificationBody,
} from "@workspace/api-zod";
import { validateBody, validateParams } from "../lib/validateRequest";
import type { ApiRequest } from "../types/apiRequest";

const router = Router();

const VALID_SELLER_STATUSES = ["pending_verification", "active", "suspended", "vacation"];

/**
 * Admin: list sellers, optionally filtered by status. Defaults to no
 * filter (all sellers) since admin needs to see the full picture, unlike
 * the subscription queue which defaults to trial+active.
 *
 * Pagination: `limit` (default 20, max 100) and `offset` (default 0).
 * The frontend tab badge counts come from the separate /counts endpoint
 * below (single request for all 4 statuses) rather than a header on
 * this response, so this endpoint just returns the page slice as a flat
 * array -- keeps the response shape compatible with the orval-generated
 * client which types this as Seller[].
 */
router.get("/admin/sellers", requireAdmin, asyncHandler(async (req, res) => {
  const { status } = req.query as { status?: string };
  const rawLimit = parseInt(req.query.limit as string, 10);
  const rawOffset = parseInt(req.query.offset as string, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  const sellers = await db
    .select()
    .from(sellersTable)
    .where(status && VALID_SELLER_STATUSES.includes(status) ? eq(sellersTable.status, status) : undefined)
    .orderBy(desc(sellersTable.createdAt))
    .limit(limit)
    .offset(offset);

  res.json(sellers.map(formatSeller));
}));

/**
 * Admin: per-status seller counts in a single request. Returns
 * { pending_verification, active, suspended, vacation } -- used by the
 * Sellers tab to render the count badge on each status tab without
 * fetching every seller. Counts only valid statuses; any row with an
 * unexpected status is excluded (defensive -- the schema enum should
 * make this impossible, but the DB is the source of truth).
 */
router.get("/admin/sellers/counts", requireAdmin, asyncHandler(async (_req, res) => {
  const rows = await db
    .select({ status: sellersTable.status, n: count() })
    .from(sellersTable)
    .groupBy(sellersTable.status);
  const out: Record<string, number> = {
    pending_verification: 0,
    active: 0,
    suspended: 0,
    vacation: 0,
  };
  for (const r of rows) {
    if (VALID_SELLER_STATUSES.includes(r.status)) {
      out[r.status] = Number(r.n) || 0;
    }
  }
  res.json(out);
}));

/**
 * Admin: approve a pending_verification seller -> active. This is a manual
 * document review (plan doc §9: "No automated KYC/business verification --
 * manual admin review only"), so this route just flips status; the actual
 * review happens by the admin looking at nidOrTradeLicenseUrl/
 * nurseryImages before clicking approve, not inside this endpoint.
 */
router.put("/admin/sellers/:id/approve", requireAdmin, validateParams(ApproveSellerParams, "ApproveSellerParams"), async (req: ApiRequest, res) => {
  try {
    const id = req.params.id as unknown as number;  // P0-1: validated + coerced to number

    const [existing] = await db.select().from(sellersTable).where(eq(sellersTable.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Seller not found" });
      return;
    }
    if (existing.status !== "pending_verification") {
      res.status(400).json({ error: `Cannot approve a seller with status "${existing.status}"` });
      return;
    }

    const [seller] = await db
      .update(sellersTable)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(sellersTable.id, id))
      .returning();

    await logAudit({
      adminId: req.userId!,
      adminEmail: req.dbUser?.email ?? undefined,
      action: "seller.approved",
      targetType: "seller",
      targetId: String(id),
      before: { status: existing.status },
      after: { status: "active" },
    });

    res.json(formatSeller(seller));
  } catch (err) {
    res.status(500).json({ error: "Failed to approve seller" });
  }
});

/**
 * Admin: reject a pending_verification seller application. The current
 * status enum (pending_verification | active | suspended | vacation) has
 * no distinct "rejected" state, so rejection is recorded via the audit
 * log's `after.reason` rather than a status the frontend would need to
 * special-case. The sellers row itself is deleted so the user can
 * re-apply cleanly instead of being stuck in a rejected-but-can't-reapply
 * limbo. Deletion is safe here because a never-approved seller can't yet
 * have any seller_listings rows depending on it.
 */
router.put("/admin/sellers/:id/reject", requireAdmin, validateParams(RejectSellerParams, "RejectSellerParams"), validateBody(RejectSellerBody, "RejectSellerBody"), async (req: ApiRequest, res) => {
  try {
    const id = req.params.id as unknown as number;  // P0-1: validated + coerced to number
    const { reason } = (req.body ?? {}) as { reason?: string };

    const [existing] = await db.select().from(sellersTable).where(eq(sellersTable.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Seller not found" });
      return;
    }
    if (existing.status !== "pending_verification") {
      res.status(400).json({ error: `Cannot reject a seller with status "${existing.status}"` });
      return;
    }

    await db.delete(sellersTable).where(eq(sellersTable.id, id));

    await logAudit({
      adminId: req.userId!,
      adminEmail: req.dbUser?.email ?? undefined,
      action: "seller.rejected",
      targetType: "seller",
      targetId: String(id),
      before: { status: existing.status, businessName: existing.businessName },
      after: { reason: reason ?? null },
    });

    res.json(formatSeller(existing));
  } catch (err) {
    res.status(500).json({ error: "Failed to reject seller" });
  }
});

/**
 * Admin: suspend an active seller. Distinct from subscription-expiry
 * hiding (jobs/sellerSubscriptionJob.ts) -- this is a deliberate admin
 * trust/policy action (e.g. a complaint, a ToS violation), not a billing
 * lapse. Listing-visibility enforcement for suspension itself is not
 * wired here; this route only flips sellers.status. Buyer-facing seller-
 * listing queries (phase 2) must check sellers.status = "active" as part
 * of their visibility filter, the same way they'll check
 * seller_listings.visibility.
 */
router.put("/admin/sellers/:id/suspend", requireAdmin, validateParams(SuspendSellerParams, "SuspendSellerParams"), async (req: ApiRequest, res) => {
  try {
    const id = req.params.id as unknown as number;  // P0-1: validated + coerced to number

    const [existing] = await db.select().from(sellersTable).where(eq(sellersTable.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Seller not found" });
      return;
    }
    if (existing.status !== "active") {
      res.status(400).json({ error: `Cannot suspend a seller with status "${existing.status}"` });
      return;
    }

    const [seller] = await db
      .update(sellersTable)
      .set({ status: "suspended", updatedAt: new Date() })
      .where(eq(sellersTable.id, id))
      .returning();

    await logAudit({
      adminId: req.userId!,
      adminEmail: req.dbUser?.email ?? undefined,
      action: "seller.suspended",
      targetType: "seller",
      targetId: String(id),
      before: { status: "active" },
      after: { status: "suspended" },
    });

    res.json(formatSeller(seller));
  } catch (err) {
    res.status(500).json({ error: "Failed to suspend seller" });
  }
});

/* -------------------------------------------------------------------- */
/* Payment / courier config verification (plan doc §7, §8 — this is the */
/* "safer default" verification flow chosen for the ambiguity flagged   */
/* in PHASE5_HANDOFF.md: a manual admin-review toggle, not a live       */
/* bKash/Pathao/Steadfast credential check. No sandbox credentials      */
/* exist in this environment to build or test a real API round trip     */
/* against, and the plan doc's own §4 "Business Verification" entry     */
/* ("manual admin review of uploaded docs -- not automated KYC") is the */
/* closest existing precedent in this codebase, so this mirrors that    */
/* pattern rather than inventing a live-check flow with nothing to      */
/* verify it against. An admin is expected to confirm the seller's      */
/* bKash/Pathao/Steadfast credentials work by some means outside this   */
/* system (e.g. a manual test transaction) before clicking verify --    */
/* this route only flips the flag and audit-logs who did it and when.   */
/* -------------------------------------------------------------------- */

function formatPaymentConfig(c: typeof sellerPaymentConfigsTable.$inferSelect) {
  return {
    id: c.id,
    sellerId: c.sellerId,
    provider: c.provider,
    merchantAppKeyMasked: maskCredential(c.merchantAppKey),
    merchantAppSecretMasked: maskCredential(c.merchantAppSecret),
    merchantUsernameMasked: maskCredential(c.merchantUsername),
    merchantPasswordMasked: maskCredential(c.merchantPassword),
    isVerified: c.isVerified,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function formatCourierConfig(c: typeof sellerCourierConfigsTable.$inferSelect) {
  return {
    id: c.id,
    sellerId: c.sellerId,
    provider: c.provider,
    apiKeyMasked: maskCredential(c.apiKey),
    apiSecretMasked: maskCredential(c.apiSecret),
    storeId: c.storeId,
    isVerified: c.isVerified,
    createdAt: c.createdAt.toISOString(),
  };
}

/**
 * Admin: list payment configs pending review, optionally including
 * already-verified ones. Defaults to unverified-only (the actual review
 * queue an admin needs); ?verified=true returns verified configs instead,
 * so the same list endpoint can back both an "awaiting review" and an
 * "already verified" admin view without two separate routes.
 */
router.get("/admin/seller-payment-configs", requireAdmin, asyncHandler(async (req, res) => {
  const { verified } = req.query as { verified?: string };
  const wantVerified = verified === "true";

  const configs = await db
    .select()
    .from(sellerPaymentConfigsTable)
    .where(eq(sellerPaymentConfigsTable.isVerified, wantVerified))
    .orderBy(desc(sellerPaymentConfigsTable.updatedAt));

  res.json(configs.map(formatPaymentConfig));
}));

/**
 * Admin: mark a seller's bKash payment config as verified. This is the
 * only place isVerified is ever set true for seller_payment_configs --
 * routes/sellerPaymentConfigs.ts itself never does this (see that file's
 * doc comment). Once true, routes/sellerListings.ts and routes/orders.ts
 * both immediately allow that seller's "advance"/"both" paymentMethod and
 * "bkash" checkout requests -- there is no separate propagation step,
 * both routes check isVerified live on every relevant write/checkout.
 */
router.put("/admin/seller-payment-configs/:id/verify", requireAdmin, asyncHandler(async (req: ApiRequest, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid payment config id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(sellerPaymentConfigsTable)
    .where(eq(sellerPaymentConfigsTable.id, id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Payment config not found" });
    return;
  }
  if (existing.isVerified) {
    res.status(400).json({ error: "Payment config is already verified" });
    return;
  }

  const [config] = await db
    .update(sellerPaymentConfigsTable)
    .set({ isVerified: true, updatedAt: new Date() })
    .where(eq(sellerPaymentConfigsTable.id, id))
    .returning();

  await logAudit({
    adminId: req.userId!,
    adminEmail: req.dbUser?.email ?? undefined,
    action: "sellerPaymentConfig.verified",
    targetType: "sellerPaymentConfig",
    targetId: String(id),
    before: { isVerified: false, sellerId: existing.sellerId },
    after: { isVerified: true },
  });

  res.json(formatPaymentConfig(config));
}));

/**
 * Admin: revoke verification on a payment config (e.g. a later complaint,
 * or credentials found to no longer work). Does not delete the row, but
 * does reconcile this seller's seller_listings: any listing still claiming
 * paymentMethod "advance"/"both" is flipped to "cod", since the config
 * backing that claim is no longer verified.
 *
 * Preferred the smaller, non-destructive fix over anything fancier: since
 * routes/cart.ts's cart response now exposes seller.hasVerifiedPaymentConfig
 * live (Part B1) and CheckoutPage.tsx already excludes bkash whenever that's
 * false, checkout is money-safe regardless of what a listing's own
 * paymentMethod field says. This reconciliation exists only to keep a
 * listing's *displayed* state honest for the seller and any buyer browsing
 * it, not to enforce correctness at checkout (that's already covered).
 * Flipping to "cod" is a single UPDATE ... WHERE seller_id = :id AND
 * payment_method != 'cod' at each call site (here and the DELETE route in
 * routes/sellerPaymentConfigs.ts) -- no per-row loop, no extra locking
 * concern beyond what a normal single-statement UPDATE already has.
 *
 * Known tradeoff, flagged rather than silently accepted: a seller whose
 * listing was "both" (COD + advance) loses that listing's COD-and-advance
 * state and is left with plain "cod" -- there is no way to represent
 * "advance disabled, but keep remembering this seller intended both" in
 * the current schema (paymentMethod is a single text enum column, not two
 * separate booleans), so a seller who re-verifies later must manually set
 * "both" again on any listing where they want advance re-enabled, rather
 * than it auto-restoring. This was accepted as intentional and
 * low-stakes: it discards a preference, not data the seller can't easily
 * re-enter, and the alternative (a separate "previously offered advance"
 * flag) is exactly the kind of schema growth Part C explicitly avoided that
 * class of extra complexity for. routes/orders.ts's checkout-time re-check
 * still means the unverify itself takes effect immediately for new orders
 * even without this reconciliation; this only fixes what a listing shows.
 */
router.put("/admin/seller-payment-configs/:id/unverify", requireAdmin, asyncHandler(async (req: ApiRequest, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid payment config id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(sellerPaymentConfigsTable)
    .where(eq(sellerPaymentConfigsTable.id, id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Payment config not found" });
    return;
  }
  if (!existing.isVerified) {
    res.status(400).json({ error: "Payment config is not currently verified" });
    return;
  }

  const [config] = await db
    .update(sellerPaymentConfigsTable)
    .set({ isVerified: false, updatedAt: new Date() })
    .where(eq(sellerPaymentConfigsTable.id, id))
    .returning();

  await db
    .update(sellerListingsTable)
    .set({ paymentMethod: "cod" })
    .where(and(eq(sellerListingsTable.sellerId, existing.sellerId), ne(sellerListingsTable.paymentMethod, "cod")));

  await logAudit({
    adminId: req.userId!,
    adminEmail: req.dbUser?.email ?? undefined,
    action: "sellerPaymentConfig.unverified",
    targetType: "sellerPaymentConfig",
    targetId: String(id),
    before: { isVerified: true, sellerId: existing.sellerId },
    after: { isVerified: false },
  });

  res.json(formatPaymentConfig(config));
}));

/**
 * Admin: list courier configs pending review / already verified. Same
 * shape and defaulting convention as the payment-config list above.
 */
router.get("/admin/seller-courier-configs", requireAdmin, asyncHandler(async (req, res) => {
  const { verified } = req.query as { verified?: string };
  const wantVerified = verified === "true";

  const configs = await db
    .select()
    .from(sellerCourierConfigsTable)
    .where(eq(sellerCourierConfigsTable.isVerified, wantVerified))
    .orderBy(desc(sellerCourierConfigsTable.createdAt));

  res.json(configs.map(formatCourierConfig));
}));

/**
 * Admin: mark a seller's courier config as verified. Same manual-toggle
 * convention as payment-config verification above -- no live Pathao/
 * Steadfast API check. As of Phase 7, POST /seller/orders/:orderId/book-
 * courier in orderShipments.ts DOES gate on isVerified (mirrors payment
 * config enforcement) -- this toggle is now a hard prerequisite for a
 * seller to book real courier shipments, not just a dashboard display
 * flag.
 */
router.put("/admin/seller-courier-configs/:id/verify", requireAdmin, asyncHandler(async (req: ApiRequest, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid courier config id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(sellerCourierConfigsTable)
    .where(eq(sellerCourierConfigsTable.id, id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Courier config not found" });
    return;
  }
  if (existing.isVerified) {
    res.status(400).json({ error: "Courier config is already verified" });
    return;
  }

  const [config] = await db
    .update(sellerCourierConfigsTable)
    .set({ isVerified: true })
    .where(eq(sellerCourierConfigsTable.id, id))
    .returning();

  await logAudit({
    adminId: req.userId!,
    adminEmail: req.dbUser?.email ?? undefined,
    action: "sellerCourierConfig.verified",
    targetType: "sellerCourierConfig",
    targetId: String(id),
    before: { isVerified: false, sellerId: existing.sellerId },
    after: { isVerified: true },
  });

  res.json(formatCourierConfig(config));
}));

/**
 * Admin: revoke verification on a courier config. Same rationale as
 * unverify-payment-config above.
 */
router.put("/admin/seller-courier-configs/:id/unverify", requireAdmin, asyncHandler(async (req: ApiRequest, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid courier config id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(sellerCourierConfigsTable)
    .where(eq(sellerCourierConfigsTable.id, id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Courier config not found" });
    return;
  }
  if (!existing.isVerified) {
    res.status(400).json({ error: "Courier config is not currently verified" });
    return;
  }

  const [config] = await db
    .update(sellerCourierConfigsTable)
    .set({ isVerified: false })
    .where(eq(sellerCourierConfigsTable.id, id))
    .returning();

  await logAudit({
    adminId: req.userId!,
    adminEmail: req.dbUser?.email ?? undefined,
    action: "sellerCourierConfig.unverified",
    targetType: "sellerCourierConfig",
    targetId: String(id),
    before: { isVerified: true, sellerId: existing.sellerId },
    after: { isVerified: false },
  });

  res.json(formatCourierConfig(config));
}));

/* -------------------------------------------------------------------- */
/* Verified-seller badge (public trust checkmark, separate from account */
/* status above -- see sellers.ts schema doc comment). A seller requests */
/* this via POST /sellers/me/request-verification; these two routes are */
/* the admin decision on that request. Same manual-review, audit-logged */
/* convention as the payment/courier config verify toggles above.       */
/* -------------------------------------------------------------------- */

/**
 * Admin: list sellers with a pending verification badge request. Defaults
 * to "requested" (the actual review queue) but accepts any of the four
 * verificationRequestStatus values so the admin panel can also show
 * approved/rejected history.
 */
router.get("/admin/seller-verification-requests", requireAdmin, asyncHandler(async (req, res) => {
  const { status } = req.query as { status?: string };
  const VALID = ["none", "requested", "approved", "rejected"];
  const filterStatus = status && VALID.includes(status) ? status : "requested";

  const sellers = await db
    .select()
    .from(sellersTable)
    .where(eq(sellersTable.verificationRequestStatus, filterStatus))
    .orderBy(desc(sellersTable.verificationRequestedAt));

  res.json(sellers.map(formatSeller));
}));

/**
 * Admin: approve a seller's pending verification request -> isVerified =
 * true. Only valid from verificationRequestStatus = "requested" -- can't
 * approve a request that was never made (or already decided) without first
 * going back through the seller re-requesting.
 */
router.put("/admin/sellers/:id/verify", requireAdmin, validateParams(VerifySellerParams, "VerifySellerParams"), async (req: ApiRequest, res) => {
  try {
    const id = req.params.id as unknown as number;  // P0-1: validated + coerced to number

    const [existing] = await db.select().from(sellersTable).where(eq(sellersTable.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Seller not found" });
      return;
    }
    if (existing.verificationRequestStatus !== "requested") {
      res.status(400).json({
        error: `Cannot approve verification from status "${existing.verificationRequestStatus}"`,
      });
      return;
    }

    const [seller] = await db
      .update(sellersTable)
      .set({
        isVerified: true,
        verificationRequestStatus: "approved",
        verificationDecidedAt: new Date(),
        verificationRejectionReason: null,
        updatedAt: new Date(),
      })
      .where(eq(sellersTable.id, id))
      .returning();

    await logAudit({
      adminId: req.userId!,
      adminEmail: req.dbUser?.email ?? undefined,
      action: "seller.verified",
      targetType: "seller",
      targetId: String(id),
      before: { isVerified: false, verificationRequestStatus: existing.verificationRequestStatus },
      after: { isVerified: true, verificationRequestStatus: "approved" },
    });

    res.json(formatSeller(seller));
  } catch (err) {
    res.status(500).json({ error: "Failed to verify seller" });
  }
});

/**
 * Admin: reject a seller's pending verification request. Unlike the
 * initial-application reject above, this does NOT delete the seller row --
 * the seller is a normal active seller either way, just not (yet) badge-
 * verified -- it only records the decision + an optional reason the seller
 * can see on their dashboard before deciding whether to re-request.
 */
router.put("/admin/sellers/:id/reject-verification", requireAdmin, validateParams(RejectSellerVerificationParams, "RejectSellerVerificationParams"), validateBody(RejectSellerVerificationBody, "RejectSellerVerificationBody"), async (req: ApiRequest, res) => {
  try {
    const id = req.params.id as unknown as number;  // P0-1: validated + coerced to number
    const { reason } = (req.body ?? {}) as { reason?: string };

    const [existing] = await db.select().from(sellersTable).where(eq(sellersTable.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Seller not found" });
      return;
    }
    if (existing.verificationRequestStatus !== "requested") {
      res.status(400).json({
        error: `Cannot reject verification from status "${existing.verificationRequestStatus}"`,
      });
      return;
    }

    const [seller] = await db
      .update(sellersTable)
      .set({
        isVerified: false,
        verificationRequestStatus: "rejected",
        verificationDecidedAt: new Date(),
        verificationRejectionReason: reason?.trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(sellersTable.id, id))
      .returning();

    await logAudit({
      adminId: req.userId!,
      adminEmail: req.dbUser?.email ?? undefined,
      action: "seller.verificationRejected",
      targetType: "seller",
      targetId: String(id),
      before: { verificationRequestStatus: existing.verificationRequestStatus },
      after: { verificationRequestStatus: "rejected", reason: reason ?? null },
    });

    res.json(formatSeller(seller));
  } catch (err) {
    res.status(500).json({ error: "Failed to reject verification" });
  }
});

export default router;
