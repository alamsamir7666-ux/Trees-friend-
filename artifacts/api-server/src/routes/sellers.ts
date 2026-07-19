import { Router } from "express";
import multerPkg from "multer";
import { v2 as cloudinaryV2 } from "cloudinary";
import { db } from "@workspace/db";
import { sellersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireSellerAccount } from "../middlewares/auth";

cloudinaryV2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadStorage = multerPkg.memoryStorage();
const uploadMiddleware = multerPkg({ storage: uploadStorage, limits: { fileSize: 5 * 1024 * 1024 } });

const router = Router();

const TRIAL_LENGTH_MS = 6 * 30 * 24 * 60 * 60 * 1000; // 6 months (plan doc §1.1, §5.2)

function formatSeller(s: typeof sellersTable.$inferSelect) {
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
    status: s.status,
    subscriptionStatus: s.subscriptionStatus,
    trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
    subscriptionExpiresAt: s.subscriptionExpiresAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/**
 * Returns the current user's seller record, or null if they've never
 * applied. Frontend uses this to decide whether to show "Become a Seller",
 * a pending/rejected status banner, or the seller dashboard entry point.
 */
router.get("/sellers/me", requireAuth, async (req: any, res) => {
  try {
    const [seller] = await db
      .select()
      .from(sellersTable)
      .where(eq(sellersTable.userId, req.dbUser.id))
      .limit(1);

    res.json(seller ? formatSeller(seller) : null);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch seller status" });
  }
});

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
router.post("/sellers", requireAuth, async (req: any, res) => {
  try {
    const [existing] = await db
      .select()
      .from(sellersTable)
      .where(eq(sellersTable.userId, req.dbUser.id))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: "You already have a seller application", seller: formatSeller(existing) });
      return;
    }

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

    if (!businessName || typeof businessName !== "string" || !businessName.trim()) {
      res.status(400).json({ error: "Business name is required" });
      return;
    }
    if (!nurseryName || typeof nurseryName !== "string" || !nurseryName.trim()) {
      res.status(400).json({ error: "Nursery name is required" });
      return;
    }
    if (!ownerName || typeof ownerName !== "string" || !ownerName.trim()) {
      res.status(400).json({ error: "Owner name is required" });
      return;
    }
    if (!contactPhone || typeof contactPhone !== "string" || !contactPhone.trim()) {
      res.status(400).json({ error: "Contact phone is required" });
      return;
    }
    if (!contactEmail || typeof contactEmail !== "string" || !contactEmail.includes("@")) {
      res.status(400).json({ error: "A valid contact email is required" });
      return;
    }
    if (!location || typeof location !== "string" || !location.trim()) {
      res.status(400).json({ error: "Location is required" });
      return;
    }
    if (nurseryImages !== undefined && !Array.isArray(nurseryImages)) {
      res.status(400).json({ error: "nurseryImages must be an array of URLs" });
      return;
    }

    const now = new Date();
    const [seller] = await db
      .insert(sellersTable)
      .values({
        userId: req.dbUser.id,
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
    console.error("Seller application error:", err);
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
router.post("/sellers/upload-verification-doc", requireAuth, uploadMiddleware.single("file"), async (req: any, res) => {
  try {
    const file = req.file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }
    const result = await new Promise<{ secure_url: string }>((resolve, reject) => {
      const stream = cloudinaryV2.uploader.upload_stream(
        { folder: "treefriend/seller-verification" },
        (err, result) => {
          if (err || !result) { console.error("Cloudinary error:", err); return reject(err ?? new Error("Upload failed")); }
          resolve(result as { secure_url: string });
        }
      );
      stream.end(file.buffer);
    });
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error("Seller verification doc upload error:", err);
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
router.patch("/sellers/me", requireSellerAccount, async (req: any, res) => {
  try {
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

    const [updated] = await db
      .update(sellersTable)
      .set(updates)
      .where(eq(sellersTable.id, req.dbSeller!.id))
      .returning();

    res.json(formatSeller(updated));
  } catch (err) {
    console.error("Update seller profile error:", err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

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
router.put("/sellers/me/status", requireSellerAccount, async (req: any, res) => {
  try {
    const { status } = req.body;
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
  } catch (err) {
    console.error("Update seller status error:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
});

export default router;
