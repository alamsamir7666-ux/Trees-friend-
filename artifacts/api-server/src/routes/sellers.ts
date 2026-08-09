import { asyncHandler } from "../lib/errors";
import { logger } from "../lib/logger";
import { Router } from "express";
import multerPkg from "multer";
import { cloudinary, deleteCloudinaryAssets, cleanupRemovedImages } from "../lib/cloudinary";
import { formatSeller } from "../lib/formatters";
import { db } from "@workspace/db";
import {
  sellersTable,
  sellerListingsTable,
  reviewsTable,
  followsTable,
} from "@workspace/db";
import { eq, and, sql, desc, isNull } from "drizzle-orm";
import { requireAuth, requireSellerAccount } from "../middlewares/auth";
import { BecomeSellerBody } from "@workspace/api-zod";
import { validateBody } from "../lib/validateRequest";
import type { ApiRequest } from "../types/apiRequest";
import type { z } from "zod";

// Use the shared Cloudinary singleton from lib/cloudinary.ts (configured once
// at module load).

const uploadStorage = multerPkg.memoryStorage();
const uploadMiddleware = multerPkg({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  // MIME filter: allow images + PDFs for verification docs (NID, trade license).
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype.startsWith("image/") || file.mimetype === "application/pdf";
    if (ok) {
      cb(null, true);
    } else {
      cb(new Error("Only image or PDF files are allowed"));
    }
  },
});

const router = Router();

const TRIAL_LENGTH_MS = 6 * 30 * 24 * 60 * 60 * 1000; // 6 months (plan doc §1.1, §5.2)

/**
 * Returns the current user's seller record, or null if they've never
 * applied. Frontend uses this to decide whether to show "Become a Seller",
 * a pending/rejected status banner, or the seller dashboard entry point.
 */
router.get("/sellers/me", requireAuth, asyncHandler(async (req: ApiRequest, res) => {
  const [seller] = await db
    .select()
    .from(sellersTable)
    .where(eq(sellersTable.userId, req.dbUser!.id))
    .limit(1);

  res.json(seller ? formatSeller(seller) : null);
}));

/**
 * Apply to become a seller. Per plan doc §5.1-2: additive to the user (does
 * NOT touch users.role), creates a sellers row in pending_verification with
 * a 6-month trial clock starting now. Only businessName/nurseryName/
 * ownerName/contactPhone/contactEmail/location are required at signup --
 * nidOrTradeLicenseUrl and nurseryImages can be attached via the upload
 * endpoint below before or after this call, since a seller may want to
 * submit the application first and add documents after.
 *
 * status, subscriptionStatus, trialEndsAt, subscriptionExpiresAt, and
 * userId are always server-derived here, never taken from the request
 * body -- an applicant must not be able to set their own verification
 * status or trial dates.
 */
router.post("/sellers", requireAuth, validateBody(BecomeSellerBody, "BecomeSellerBody"), async (req: ApiRequest<z.infer<typeof BecomeSellerBody>>, res) => {
  try {
    const [existing] = await db
      .select()
      .from(sellersTable)
      .where(eq(sellersTable.userId, req.dbUser!.id))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: "You already have a seller application", seller: formatSeller(existing) });
      return;
    }

    // P0-1: body shape now validated by Zod (BecomeSellerBody). The
    // hand-rolled typeof/trim checks for each required field are
    // superseded — Zod enforces string type and presence at the schema
    // level. The contactEmail.includes("@") business rule is kept
    // because the schema only requires a string (not a valid email
    // format — the spec deliberately allows free-text contact emails
    // since sellers may use non-standard email formats).
    const {
      businessName,
      nurseryName,
      ownerName,
      contactPhone,
      contactEmail,
      location,
      description,
      nidOrTradeLicenseUrl,
      nurseryImages,
    } = req.body;

    if (!contactEmail || !contactEmail.includes("@")) {
      res.status(400).json({ error: "A valid contact email is required" });
      return;
    }

    const now = new Date();
    const [seller] = await db
      .insert(sellersTable)
      .values({
        userId: req.dbUser!.id,
        businessName: businessName.trim(),
        nurseryName: nurseryName.trim(),
        ownerName: ownerName.trim(),
        contactPhone: contactPhone.trim(),
        contactEmail: contactEmail.trim(),
        location: location.trim(),
        description: description?.trim() || null,
        nidOrTradeLicenseUrl: nidOrTradeLicenseUrl || null,
        nurseryImages: Array.isArray(nurseryImages) ? nurseryImages : [],
        status: "pending_verification",
        subscriptionStatus: "trial",
        trialEndsAt: new Date(now.getTime() + TRIAL_LENGTH_MS),
        subscriptionExpiresAt: null,
      })
      .returning();

    res.status(201).json(formatSeller(seller));
  } catch (err) {
    logger.error({ err: err }, "Seller application error");
    res.status(500).json({ error: "Failed to submit seller application" });
  }
});

/**
 * Upload a trade license/NID image or a nursery photo for a seller
 * application. Any authenticated user can call this (not admin-gated,
 * unlike /assets/upload and /products/upload-image) since applicants
 * upload their own verification documents before they're an approved
 * seller. Returns a URL the client then includes in the POST /sellers
 * body or a later profile update -- this endpoint does not itself write
 * to the sellers table.
 */
router.post("/sellers/upload-verification-doc", requireAuth, uploadMiddleware.single("file"), async (req: ApiRequest, res) => {
  try {
    const file = req.file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }
    const result = await new Promise<{ secure_url: string }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "treefriend/seller-verification", resource_type: "auto" },
        (err, result) => {
          if (err || !result) { logger.error({ err: err }, "Cloudinary error"); return reject(err ?? new Error("Upload failed")); }
          resolve(result as { secure_url: string });
        }
      );
      stream.end(file.buffer);
    });
    res.json({ url: result.secure_url });
  } catch (err) {
    logger.error({ err: err }, "Seller verification doc upload error");
    res.status(500).json({ error: "Upload failed" });
  }
});

/**
 * Seller: update own business/nursery profile fields (plan §4 item 1,
 * "Business Profile / Nursery Profile" -- post-approval self-service
 * editing, distinct from the initial application in POST /sellers above).
 *
 * Uses requireSellerAccount, NOT requireSeller -- a pending_verification
 * seller should be able to fix a typo in their application while awaiting
 * review, and a vacationing seller should be able to update contact info
 * without first having to come off vacation. Every field is optional
 * (partial update); status/subscriptionStatus/trial/subscription dates are
 * never accepted here, same server-derived-only rule as POST /sellers --
 * a seller cannot approve, verify, or extend their own trial by PATCHing
 * this endpoint, request body fields outside the allow-list below are
 * silently ignored rather than erroring, since the client only ever sends
 * the profile-editable subset.
 */
router.patch("/sellers/me", requireSellerAccount, asyncHandler(async (req: ApiRequest, res) => {
  const {
    businessName,
    nurseryName,
    ownerName,
    contactPhone,
    contactEmail,
    location,
    description,
    nidOrTradeLicenseUrl,
    nurseryImages,
    logoUrl,
  } = req.body as Partial<typeof sellersTable.$inferInsert>;

  if (businessName !== undefined && (typeof businessName !== "string" || !businessName.trim())) {
    res.status(400).json({ error: "Business name cannot be empty" });
    return;
  }
  if (nurseryName !== undefined && (typeof nurseryName !== "string" || !nurseryName.trim())) {
    res.status(400).json({ error: "Nursery name cannot be empty" });
    return;
  }
  if (ownerName !== undefined && (typeof ownerName !== "string" || !ownerName.trim())) {
    res.status(400).json({ error: "Owner name cannot be empty" });
    return;
  }
  if (contactPhone !== undefined && (typeof contactPhone !== "string" || !contactPhone.trim())) {
    res.status(400).json({ error: "Contact phone cannot be empty" });
    return;
  }
  if (contactEmail !== undefined && (typeof contactEmail !== "string" || !contactEmail.includes("@"))) {
    res.status(400).json({ error: "A valid contact email is required" });
    return;
  }
  if (location !== undefined && (typeof location !== "string" || !location.trim())) {
    res.status(400).json({ error: "Location cannot be empty" });
    return;
  }
  if (nurseryImages !== undefined && !Array.isArray(nurseryImages)) {
    res.status(400).json({ error: "nurseryImages must be an array of URLs" });
    return;
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (businessName !== undefined) updates.businessName = businessName.trim();
  if (nurseryName !== undefined) updates.nurseryName = nurseryName.trim();
  if (ownerName !== undefined) updates.ownerName = ownerName.trim();
  if (contactPhone !== undefined) updates.contactPhone = contactPhone.trim();
  if (contactEmail !== undefined) updates.contactEmail = contactEmail.trim();
  if (location !== undefined) updates.location = location.trim();
  if (description !== undefined) updates.description = description?.trim() || null;
  if (nidOrTradeLicenseUrl !== undefined) updates.nidOrTradeLicenseUrl = nidOrTradeLicenseUrl || null;
  if (nurseryImages !== undefined) updates.nurseryImages = nurseryImages;
  if (logoUrl !== undefined) updates.logoUrl = logoUrl || null;

  const previousNurseryImages = req.dbSeller!.nurseryImages ?? [];
  const previousLogoUrl = req.dbSeller!.logoUrl ?? null;

  const [updated] = await db
    .update(sellersTable)
    .set(updates)
    .where(eq(sellersTable.id, req.dbSeller!.id))
    .returning();

  // Best-effort cleanup after the DB write succeeds. Runs only for the
  // fields this request actually touched, and never blocks/fails the
  // response -- the profile is already saved either way.
  if (nurseryImages !== undefined) {
    cleanupRemovedImages(previousNurseryImages, nurseryImages).catch(() => {});
  }
  if (logoUrl !== undefined && previousLogoUrl && previousLogoUrl !== logoUrl) {
    deleteCloudinaryAssets([previousLogoUrl]).catch(() => {});
  }

  res.json(formatSeller(updated));
}));

/**
 * Seller: toggle own vacation mode (plan §4 item 3). Only "active" and
 * "vacation" are accepted here -- a seller can put themselves on vacation
 * or take themselves off, but cannot self-approve out of
 * pending_verification or self-reinstate out of an admin suspension by
 * hitting this route; those stay admin-only (see adminSellers.ts).
 *
 * Uses requireSellerAccount so the toggle stays reachable while on
 * vacation (see requireSellerAccount's comment in middlewares/auth.ts).
 * Rejects the transition if the seller isn't currently in "active" or
 * "vacation" -- e.g. a pending_verification or suspended seller cannot use
 * this route to jump straight to "active" themselves.
 *
 * No change needed on the buyer-facing side: products/:productId/seller-
 * listings in sellerListings.ts already filters sellers.status = "active",
 * so a vacationing seller's listings stop appearing there automatically.
 */
router.put("/sellers/me/status", requireSellerAccount, asyncHandler(async (req: ApiRequest, res) => {
  const { status } = req.body as { status?: string };
  if (status !== "active" && status !== "vacation") {
    res.status(400).json({ error: 'status must be "active" or "vacation"' });
    return;
  }

  const current = req.dbSeller!.status;
  if (current !== "active" && current !== "vacation") {
    res.status(400).json({
      error: `Cannot change status from "${current}" here. This toggle only switches between "active" and "vacation".`,
    });
    return;
  }
  if (current === status) {
    res.status(400).json({ error: `Seller is already "${status}"` });
    return;
  }

  const [updated] = await db
    .update(sellersTable)
    .set({ status, updatedAt: new Date() })
    .where(eq(sellersTable.id, req.dbSeller!.id))
    .returning();

  res.json(formatSeller(updated));
}));

/**
 * Seller: request the public "verified seller" badge (separate from
 * account status -- see sellers.ts schema doc comment). Only a seller with
 * status = "active" can request this; a seller still pending initial
 * account approval, suspended, or on vacation has nothing to "verify" yet.
 * Only allowed when verificationRequestStatus is "none" or "rejected" --
 * once "requested", re-submitting is a no-op (admin needs to decide first),
 * and once "approved" there's nothing left to request. A rejected seller
 * CAN re-request (e.g. after fixing whatever the rejection reason called
 * out), which clears the old rejection reason.
 */
router.post("/sellers/me/request-verification", requireSellerAccount, asyncHandler(async (req: ApiRequest, res) => {
  const seller = req.dbSeller!;
  if (seller.status !== "active") {
    res.status(400).json({ error: "Only active sellers can request verification" });
    return;
  }
  if (seller.verificationRequestStatus === "requested") {
    res.status(400).json({ error: "Verification request already pending" });
    return;
  }
  if (seller.verificationRequestStatus === "approved") {
    res.status(400).json({ error: "Seller is already verified" });
    return;
  }

  const [updated] = await db
    .update(sellersTable)
    .set({
      verificationRequestStatus: "requested",
      verificationRequestedAt: new Date(),
      verificationDecidedAt: null,
      verificationRejectionReason: null,
      updatedAt: new Date(),
    })
    .where(eq(sellersTable.id, seller.id))
    .returning();

  res.json(formatSeller(updated));
}));

/**
 * The current authenticated buyer's followed-sellers list, for the
 * Profile page's "Following" section (count + store cards). Returns the
 * same public-safe seller shape as GET /sellers/:id (minus the aggregate
 * stats, which that page doesn't need per-card) so the frontend can render
 * a logo/name/verified/location card and link straight to /store/:id.
 *
 * MUST be registered before GET /sellers/:id below -- Express matches
 * :id against any path segment, so "/sellers/following/mine" would
 * otherwise be swallowed by that handler with id="following" and 400 on
 * the parseInt guard. This is the same static-before-dynamic ordering
 * already used for /sellers/me elsewhere in this file.
 */
router.get("/sellers/following/mine", requireAuth, asyncHandler(async (req: ApiRequest, res) => {
  const rows = await db
    .select({ seller: sellersTable })
    .from(followsTable)
    .innerJoin(sellersTable, eq(followsTable.sellerId, sellersTable.id))
    .where(and(eq(followsTable.userId, req.userId!), eq(sellersTable.status, "active")))
    .orderBy(desc(followsTable.createdAt));

  res.json(
    rows.map(({ seller }) => ({
      id: seller.id,
      businessName: seller.businessName,
      nurseryName: seller.nurseryName,
      location: seller.location,
      isVerified: seller.isVerified,
      logoUrl: seller.logoUrl,
    })),
  );
}));

/**
 * Public, unauthenticated seller profile for the buyer-facing Seller Store
 * Page (reached from "View Store" on SellerListingDetailPage). Deliberately
 * NOT gated behind requireAuth -- unlike /sellers/me (the seller's own
 * dashboard view with NID/phone/verification internals), this returns only
 * the subset already considered public elsewhere (matches
 * SellerListingCardSellerInfo's fields: id/businessName/nurseryName/
 * location/isVerified/logoUrl), plus description and createdAt for the
 * "About Store" / "Member since" sections, and the aggregate stats the
 * design's stats row needs.
 *
 * 404s for any seller that isn't status="active" -- same gate the
 * listings/reviews routes below use, so a suspended/pending seller's store
 * page isn't independently reachable by guessing its id, matching how a
 * de-listed seller's cards already don't appear buyer-side.
 *
 * followerCount is always included (public count, like a social profile's
 * follower count); isFollowing is intentionally NOT included here since
 * this route has no auth context -- see GET /sellers/:id/follow below for
 * the logged-in viewer's own follow state, kept as a separate authed call
 * the same way review eligibility is split from the public review list.
 */
router.get("/sellers/:id", asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid seller id" });
    return;
  }

  const [seller] = await db
    .select()
    .from(sellersTable)
    .where(and(eq(sellersTable.id, id), eq(sellersTable.status, "active"), isNull(sellersTable.deletedAt)))
    .limit(1);

  if (!seller) {
    res.status(404).json({ error: "Seller not found" });
    return;
  }

  const [productCountRow, reviewStatsRow, followerCountRow] = await Promise.all([
    db
      .select({ count: sql<string>`COUNT(*)` })
      .from(sellerListingsTable)
      .where(
        and(
          eq(sellerListingsTable.sellerId, id),
          eq(sellerListingsTable.visibility, "public"),
          eq(sellerListingsTable.approvalStatus, "approved"),
        ),
      ),
    db
      .select({ avg: sql<string>`COALESCE(AVG(${reviewsTable.rating}), 0)`, count: sql<string>`COUNT(*)` })
      .from(reviewsTable)
      .where(eq(reviewsTable.sellerId, id)),
    db
      .select({ count: sql<string>`COUNT(*)` })
      .from(followsTable)
      .where(eq(followsTable.sellerId, id)),
  ]);

  res.json({
    id: seller.id,
    businessName: seller.businessName,
    nurseryName: seller.nurseryName,
    location: seller.location,
    description: seller.description,
    isVerified: seller.isVerified,
    logoUrl: seller.logoUrl,
    // Expose nurseryImages so the buyer-facing Seller Store Page can render
    // the first one as a cover image. Falls back to a gradient on the
    // client when the array is empty (most sellers won't have uploaded
    // nursery photos yet). See SellerStorePage.tsx hero block.
    nurseryImages: seller.nurseryImages ?? [],
    createdAt: seller.createdAt.toISOString(),
    productCount: Number(productCountRow[0]?.count ?? 0),
    rating: Number(Number(reviewStatsRow[0]?.avg ?? 0).toFixed(1)),
    reviewCount: Number(reviewStatsRow[0]?.count ?? 0),
    followerCount: Number(followerCountRow[0]?.count ?? 0),
  });
}));

/**
 * The logged-in viewer's own follow state for this seller -- split out
 * from the public GET /sellers/:id above the same way review eligibility
 * is split from the public review list (see reviews.ts), since "am I
 * following this?" is per-viewer and the profile route above has no auth
 * context. Returns false (not a 401) when logged out, since the Store Page
 * shows the Follow button to guests too (it just prompts sign-in on tap,
 * same pattern as the wishlist heart button elsewhere).
 */
router.get("/sellers/:id/follow", requireAuth, asyncHandler(async (req: ApiRequest, res) => {
  const sellerId = parseInt(req.params.id);
  if (isNaN(sellerId) || sellerId <= 0) {
    res.status(400).json({ error: "Invalid seller id" });
    return;
  }

  const [existing] = await db
    .select({ id: followsTable.id })
    .from(followsTable)
    .where(and(eq(followsTable.userId, req.userId!), eq(followsTable.sellerId, sellerId)))
    .limit(1);

  res.json({ isFollowing: !!existing });
}));

/**
 * Follow a seller. Idempotent -- following an already-followed seller
 * just returns the existing row rather than erroring, since the frontend
 * button toggles optimistically and a duplicate click (e.g. a fast
 * double-tap before the mutation settles) shouldn't surface an error to
 * the buyer. Relies on follows_user_seller_unique (see follows.ts) rather
 * than a SELECT-then-INSERT check to avoid a race between concurrent
 * requests from the same user.
 */
router.post("/sellers/:id/follow", requireAuth, asyncHandler(async (req: ApiRequest, res) => {
  const sellerId = parseInt(req.params.id);
  if (isNaN(sellerId) || sellerId <= 0) {
    res.status(400).json({ error: "Invalid seller id" });
    return;
  }

  const [seller] = await db
    .select({ id: sellersTable.id })
    .from(sellersTable)
    .where(and(eq(sellersTable.id, sellerId), eq(sellersTable.status, "active")))
    .limit(1);
  if (!seller) {
    res.status(404).json({ error: "Seller not found" });
    return;
  }

  await db
    .insert(followsTable)
    .values({ userId: req.userId!, sellerId })
    .onConflictDoNothing({ target: [followsTable.userId, followsTable.sellerId] });

  res.json({ isFollowing: true });
}));

/**
 * Unfollow a seller. Also idempotent (unfollowing a seller you don't
 * follow is a no-op success, not a 404) -- same double-tap/optimistic-UI
 * reasoning as the follow route above.
 */
router.delete("/sellers/:id/follow", requireAuth, asyncHandler(async (req: ApiRequest, res) => {
  const sellerId = parseInt(req.params.id);
  if (isNaN(sellerId) || sellerId <= 0) {
    res.status(400).json({ error: "Invalid seller id" });
    return;
  }

  await db
    .delete(followsTable)
    .where(and(eq(followsTable.userId, req.userId!), eq(followsTable.sellerId, sellerId)));

  res.json({ isFollowing: false });
}));

export default router;
