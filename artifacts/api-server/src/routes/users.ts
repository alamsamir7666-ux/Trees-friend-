import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, addressesTable, reviewsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

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

router.get("/users/me", requireAuth, async (req: any, res) => {
  try {
    res.json(formatUser(req.dbUser));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

router.put("/users/me", requireAuth, async (req: any, res) => {
  try {
    const { firstName, lastName, phone, email } = req.body;

    // Input validation
    if (firstName !== undefined && typeof firstName !== "string") {
      res.status(400).json({ error: "Invalid firstName" });
      return;
    }
    if (lastName !== undefined && typeof lastName !== "string") {
      res.status(400).json({ error: "Invalid lastName" });
      return;
    }
    if (phone !== undefined && phone !== null && phone !== "") {
      // Validate Bangladesh phone format (optional)
      if (typeof phone !== "string" || phone.length > 20) {
        res.status(400).json({ error: "Invalid phone number" });
        return;
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (firstName !== undefined) updates.firstName = firstName?.trim() || null;
    if (lastName !== undefined) updates.lastName = lastName?.trim() || null;
    if (phone !== undefined) updates.phone = phone?.trim() || null;
    if (
      email !== undefined &&
      email &&
      !email.endsWith("@clerk.user") &&
      email.includes("@")
    ) {
      updates.email = email.trim();
    }

    const [updated] = await db
      .update(usersTable)
      .set(updates)
      .where(eq(usersTable.id, req.dbUser.id))
      .returning();

    // Back-fill userName on existing reviews when a real name becomes available
    const newFirst = (
      (firstName ?? req.dbUser.firstName) ?? ""
    ).trim();
    const newLast = (
      (lastName ?? req.dbUser.lastName) ?? ""
    ).trim();
    const fullName = `${newFirst} ${newLast}`.trim();

    if (fullName) {
      await db
        .update(reviewsTable)
        .set({ userName: fullName })
        .where(eq(reviewsTable.userId, req.userId));
    }

    res.json(formatUser(updated));
  } catch (err) {
    res.status(500).json({ error: "Failed to update profile" });
  }
});

router.get("/users/me/addresses", requireAuth, async (req: any, res) => {
  try {
    const addresses = await db
      .select()
      .from(addressesTable)
      .where(eq(addressesTable.userId, req.userId));
    res.json(addresses.map(formatAddress));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch addresses" });
  }
});

router.post("/users/me/addresses", requireAuth, async (req: any, res) => {
  try {
    const {
      fullName,
      phone,
      street,
      city,
      district,
      postalCode,
      isDefault,
    } = req.body;

    // Validate required fields
    if (!fullName?.trim()) {
      res.status(400).json({ error: "Full name is required" });
      return;
    }
    if (!street?.trim()) {
      res.status(400).json({ error: "Street address is required" });
      return;
    }
    if (!city?.trim()) {
      res.status(400).json({ error: "City is required" });
      return;
    }

    // Check address limit (prevent abuse)
    const existing = await db
      .select({ id: addressesTable.id })
      .from(addressesTable)
      .where(eq(addressesTable.userId, req.userId));

    if (existing.length >= 10) {
      res.status(400).json({ error: "Maximum of 10 addresses allowed" });
      return;
    }

    if (isDefault) {
      await db
        .update(addressesTable)
        .set({ isDefault: false })
        .where(eq(addressesTable.userId, req.userId));
    }

    const [address] = await db
      .insert(addressesTable)
      .values({
        userId: req.userId,
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
  } catch (err) {
    res.status(500).json({ error: "Failed to add address" });
  }
});

router.put("/users/me/addresses/:id", requireAuth, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid address ID" });
      return;
    }
    const {
      fullName,
      phone,
      street,
      city,
      district,
      postalCode,
      isDefault,
    } = req.body;

    // Verify ownership
    const [existing] = await db
      .select({ id: addressesTable.id })
      .from(addressesTable)
      .where(
        and(
          eq(addressesTable.id, id),
          eq(addressesTable.userId, req.userId),
        ),
      )
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Address not found" });
      return;
    }

    if (isDefault) {
      await db
        .update(addressesTable)
        .set({ isDefault: false })
        .where(eq(addressesTable.userId, req.userId));
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
      .where(
        and(
          eq(addressesTable.id, id),
          eq(addressesTable.userId, req.userId),
        ),
      )
      .returning();

    res.json(formatAddress(updated));
  } catch (err) {
    res.status(500).json({ error: "Failed to update address" });
  }
});

router.delete("/users/me/addresses/:id", requireAuth, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: "Invalid address ID" });
      return;
    }
    await db
      .delete(addressesTable)
      .where(
        and(
          eq(addressesTable.id, id),
          eq(addressesTable.userId, req.userId),
        ),
      );
    res.json({ message: "Address deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete address" });
  }
});

export default router;
