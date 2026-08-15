import { asyncHandler } from "../lib/errors";
import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, addressesTable, reviewsTable, isValidBdPhone } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import {
  UpdateMeBody,
  AddAddressBody,
  UpdateAddressBody,
  UpdateAddressParams,
  DeleteAddressParams,
} from "@workspace/api-zod";
import { validateBody, validateParams } from "../lib/validateRequest";
import type { ApiRequest } from "../types/apiRequest";
import type { z } from "zod";

const router = Router();

function formatUser(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    clerkId: u.clerkId,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    phone: u.phone,
    role: u.role,
    isBlocked: u.isBlocked,
    createdAt: u.createdAt.toISOString(),
  };
}

function formatAddress(a: typeof addressesTable.$inferSelect) {
  return {
    id: a.id,
    userId: a.userId,
    fullName: a.fullName,
    phone: a.phone,
    street: a.street,
    city: a.city,
    district: a.district,
    postalCode: a.postalCode,
    isDefault: a.isDefault,
  };
}

router.get(
  "/users/me",
  requireAuth,
  asyncHandler(async (req: ApiRequest, res) => {
    res.json(formatUser(req.dbUser!));
  }),
);

// CQ-4: typed req.body via ApiRequest —
// replaces `req: any`. req.userId and req.dbUser are now typed (non-optional).
router.put(
  "/users/me",
  requireAuth,
  validateBody(UpdateMeBody, "UpdateMeBody"),
  async (req: ApiRequest<z.infer<typeof UpdateMeBody>>, res) => {
    try {
      // P0-1: body shape validated by Zod (UpdateMeBody — firstName,
      // lastName, phone, email). All four are optional & nullable so a
      // client can clear any field by sending null. Email is sent by the
      // frontend ProfileSync component on every Clerk profile change.
      const { firstName, lastName, phone, email } = req.body;

      // VAL-3: validate BD phone format using the shared isValidBdPhone()
      // from @workspace/db (same function sellerPayoutAccounts.ts uses).
      // Phone may be empty string (to clear) but never an invalid format.
      if (phone !== undefined && phone !== null && phone.trim() !== "") {
        if (!isValidBdPhone(phone)) {
          res
            .status(400)
            .json({
              error: "Phone number must be a valid Bangladeshi mobile number (e.g. 01712345678)",
            });
          return;
        }
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (firstName !== undefined) updates.firstName = firstName?.trim() || null;
      if (lastName !== undefined) updates.lastName = lastName?.trim() || null;
      if (phone !== undefined) updates.phone = phone?.trim() || null;
      // Email: Clerk's synthetic "@clerk.user" identifiers (used for
      // OAuth-only accounts that have no real email) are NOT persisted —
      // we keep the previous real email on file. Only real addresses
      // containing "@" and not ending in "@clerk.user" are written.
      if (email !== undefined && email && !email.endsWith("@clerk.user") && email.includes("@")) {
        updates.email = email.trim();
      }

      const [updated] = await db
        .update(usersTable)
        .set(updates)
        .where(eq(usersTable.id, req.dbUser!.id))
        .returning();

      // Back-fill userName on existing reviews when a real name becomes available
      const newFirst = (firstName ?? req.dbUser!.firstName ?? "").trim();
      const newLast = (lastName ?? req.dbUser!.lastName ?? "").trim();
      const fullName = `${newFirst} ${newLast}`.trim();

      if (fullName) {
        await db
          .update(reviewsTable)
          .set({ userName: fullName })
          .where(eq(reviewsTable.userId, req.userId!));
      }

      res.json(formatUser(updated));
    } catch (_err) {
      res.status(500).json({ error: "Failed to update profile" });
    }
  },
);

router.get(
  "/users/me/addresses",
  requireAuth,
  asyncHandler(async (req: ApiRequest, res) => {
    const addresses = await db
      .select()
      .from(addressesTable)
      .where(eq(addressesTable.userId, req.userId!));
    res.json(addresses.map(formatAddress));
  }),
);

router.post(
  "/users/me/addresses",
  requireAuth,
  validateBody(AddAddressBody, "AddAddressBody"),
  async (req: ApiRequest<z.infer<typeof AddAddressBody>>, res) => {
    try {
      const { fullName, phone, street, city, district, postalCode, isDefault } = req.body as any;

      // P0-1: input shape now validated by Zod (AddAddressBody). VAL-3: also
      // validates BD phone format using the shared isValidBdPhone() (same
      // function used by sellerPayoutAccounts and PUT /users/me above).
      if (!isValidBdPhone(phone)) {
        res
          .status(400)
          .json({
            error: "Phone number must be a valid Bangladeshi mobile number (e.g. 01712345678)",
          });
        return;
      }

      // Check address limit (prevent abuse)
      const existing = await db
        .select({ id: addressesTable.id })
        .from(addressesTable)
        .where(eq(addressesTable.userId, req.userId!));

      if (existing.length >= 10) {
        res.status(400).json({ error: "Maximum of 10 addresses allowed" });
        return;
      }

      if (isDefault) {
        await db
          .update(addressesTable)
          .set({ isDefault: false })
          .where(eq(addressesTable.userId, req.userId!));
      }

      const [address] = await db
        .insert(addressesTable)
        .values({
          userId: req.userId!,
          fullName: fullName.trim(),
          phone: phone?.trim() ?? "",
          street: street.trim(),
          city: city.trim(),
          district: district?.trim() ?? "",
          postalCode: postalCode?.trim() ?? null,
          isDefault: isDefault ?? false,
        })
        .returning();

      res.status(201).json(formatAddress(address));
    } catch (_err) {
      res.status(500).json({ error: "Failed to add address" });
    }
  },
);

router.put(
  "/users/me/addresses/:id",
  requireAuth,
  validateParams(UpdateAddressParams, "UpdateAddressParams"),
  validateBody(UpdateAddressBody, "UpdateAddressBody"),
  async (req: ApiRequest<z.infer<typeof UpdateAddressBody>>, res) => {
    try {
      const id = req.params.id as unknown as number; // P0-1: validated + coerced to number by UpdateAddressParams
      const { fullName, phone, street, city, district, postalCode, isDefault } = req.body as any;

      // Verify ownership
      const [existing] = await db
        .select({ id: addressesTable.id })
        .from(addressesTable)
        .where(and(eq(addressesTable.id, id), eq(addressesTable.userId, req.userId!)))
        .limit(1);

      if (!existing) {
        res.status(404).json({ error: "Address not found" });
        return;
      }

      if (isDefault) {
        await db
          .update(addressesTable)
          .set({ isDefault: false })
          .where(eq(addressesTable.userId, req.userId!));
      }

      const [updated] = await db
        .update(addressesTable)
        .set({
          fullName: fullName?.trim(),
          phone: phone?.trim(),
          street: street?.trim(),
          city: city?.trim(),
          district: district?.trim(),
          postalCode: postalCode?.trim() ?? null,
          isDefault: isDefault ?? false,
        })
        .where(and(eq(addressesTable.id, id), eq(addressesTable.userId, req.userId!)))
        .returning();

      res.json(formatAddress(updated));
    } catch (_err) {
      res.status(500).json({ error: "Failed to update address" });
    }
  },
);

router.delete(
  "/users/me/addresses/:id",
  requireAuth,
  validateParams(DeleteAddressParams, "DeleteAddressParams"),
  async (req: ApiRequest, res) => {
    try {
      const id = req.params.id as unknown as number; // P0-1: validated + coerced to number by DeleteAddressParams
      await db
        .delete(addressesTable)
        .where(and(eq(addressesTable.id, id), eq(addressesTable.userId, req.userId!)));
      res.json({ message: "Address deleted" });
    } catch (_err) {
      res.status(500).json({ error: "Failed to delete address" });
    }
  },
);

export default router;
