import { Router } from "express";
import { db } from "@workspace/db";
import {
  abandonedCartsTable,
  cartItemsTable,
  productsTable,
  productVariantsTable,
  usersTable,
} from "@workspace/db";
import { eq, lt, and, isNull } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { sendAbandonedCartEmail } from "../lib/email";

const router = Router();

/**
 * Called by the frontend whenever cart changes (add/remove).
 * Upserts the abandoned cart snapshot for this user.
 */
router.post("/abandoned-cart/sync", requireAuth, async (req: any, res) => {
  try {
    const items = await db
      .select({ cart: cartItemsTable, product: productsTable, variant: productVariantsTable })
      .from(cartItemsTable)
      .innerJoin(productsTable, eq(cartItemsTable.productId, productsTable.id))
      .innerJoin(productVariantsTable, eq(cartItemsTable.variantId, productVariantsTable.id))
      .where(eq(cartItemsTable.userId, req.userId));

    if (items.length === 0) {
      // Cart empty — remove abandoned cart record
      await db
        .delete(abandonedCartsTable)
        .where(eq(abandonedCartsTable.userId, req.userId));
      res.json({ ok: true });
      return;
    }

    const snapshot = items.map(({ cart, product, variant }) => ({
      productId: product.id,
      variantId: variant.id,
      quantity: cart.quantity,
      name: `${product.name} (${variant.name})`,
      price: Number(variant.discountPrice ?? variant.price),
      image: (product.images as string[])[0] ?? "",
    }));

    const email = req.dbUser?.email?.endsWith("@clerk.user")
      ? null
      : req.dbUser?.email ?? null;

    await db
      .insert(abandonedCartsTable)
      .values({
        userId: req.userId,
        email,
        items: snapshot,
        recovered: false,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: abandonedCartsTable.userId,
        set: {
          email,
          items: snapshot,
          recovered: false,
          emailSentAt: null, // reset so new email can be sent after 24h
          updatedAt: new Date(),
        },
      });

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to sync cart" });
  }
});

/**
 * Mark abandoned cart as recovered (called when order is placed).
 */
router.post("/abandoned-cart/recover", requireAuth, async (req: any, res) => {
  try {
    await db
      .update(abandonedCartsTable)
      .set({ recovered: true })
      .where(eq(abandonedCartsTable.userId, req.userId));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to mark recovered" });
  }
});

/**
 * Admin: Get all unrecovered abandoned carts (for dashboard insight).
 */
router.get("/admin/abandoned-carts", async (_req, res) => {
  try {
    const carts = await db
      .select()
      .from(abandonedCartsTable)
      .where(eq(abandonedCartsTable.recovered, false));

    res.json(
      carts.map((c) => ({
        id: c.id,
        userId: c.userId,
        email: c.email,
        items: c.items,
        emailSentAt: c.emailSentAt?.toISOString() ?? null,
        updatedAt: c.updatedAt.toISOString(),
      })),
    );
  } catch {
    res.status(500).json({ error: "Failed to fetch abandoned carts" });
  }
});

/**
 * Background job: Send recovery emails to carts abandoned 24+ hours ago.
 * Call this from a cron job or scheduled task.
 */
export async function runAbandonedCartJob() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h ago
  try {
    const eligibleCarts = await db
      .select()
      .from(abandonedCartsTable)
      .where(
        and(
          eq(abandonedCartsTable.recovered, false),
          isNull(abandonedCartsTable.emailSentAt),
          lt(abandonedCartsTable.updatedAt, cutoff),
        ),
      );

    for (const cart of eligibleCarts) {
      if (!cart.email || !cart.items?.length) continue;

      // Get user name
      const [user] = await db
        .select({ firstName: usersTable.firstName })
        .from(usersTable)
        .where(eq(usersTable.clerkId, cart.userId))
        .limit(1);

      await sendAbandonedCartEmail({
        to: cart.email,
        name: user?.firstName ?? "there",
        items: cart.items as any[],
      });

      await db
        .update(abandonedCartsTable)
        .set({ emailSentAt: new Date() })
        .where(eq(abandonedCartsTable.id, cart.id));
    }

    console.log(`[abandoned-cart] Processed ${eligibleCarts.length} carts`);
  } catch (err) {
    console.error("[abandoned-cart] Job failed:", err);
  }
}

export default router;
