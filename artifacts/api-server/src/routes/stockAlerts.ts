import { Router } from "express";
import { db } from "@workspace/db";
import { stockAlertsTable, productsTable, productVariantsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { sendStockAlertEmail } from "../lib/email";
import { sendWhatsAppStockAlert } from "../lib/whatsapp";

const router = Router();

router.post("/stock-alerts", async (req, res) => {
  try {
    const { productId, variantId, email } = req.body;
    if (!productId || isNaN(Number(productId))) {
      res.status(400).json({ error: "Valid product ID is required" });
      return;
    }
    if (!variantId || isNaN(Number(variantId))) {
      res.status(400).json({ error: "Please select an option (e.g. Seed, Sapling, Grafted, Potted)" });
      return;
    }
    if (!email) {
      res.status(400).json({ error: "Email or phone is required" });
      return;
    }
    const isPhone = email.endsWith("@phone.notify");
    if (!isPhone && !email.includes("@")) {
      res.status(400).json({ error: "Valid email is required" });
      return;
    }

    const [product] = await db
      .select({ id: productsTable.id, name: productsTable.name })
      .from(productsTable)
      .where(eq(productsTable.id, Number(productId)))
      .limit(1);

    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    const [variant] = await db
      .select({ id: productVariantsTable.id, stock: productVariantsTable.stock, productId: productVariantsTable.productId })
      .from(productVariantsTable)
      .where(eq(productVariantsTable.id, Number(variantId)))
      .limit(1);

    if (!variant || variant.productId !== product.id) {
      res.status(404).json({ error: "Variant not found for this product" });
      return;
    }
    if (variant.stock > 0) {
      res.status(400).json({ error: "This option is already in stock" });
      return;
    }

    // Prevent duplicate alerts
    const existing = await db
      .select({ id: stockAlertsTable.id })
      .from(stockAlertsTable)
      .where(
        and(
          eq(stockAlertsTable.variantId, Number(variantId)),
          eq(stockAlertsTable.email, email.toLowerCase().trim()),
          eq(stockAlertsTable.notified, false),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      res.json({ message: "You are already on the waitlist for this option" });
      return;
    }

    await db.insert(stockAlertsTable).values({
      productId: Number(productId),
      variantId: Number(variantId),
      email: email.toLowerCase().trim(),
    });

    res.status(201).json({ message: "You will be notified when this option is back in stock" });
  } catch {
    res.status(500).json({ error: "Failed to register stock alert" });
  }
});

/**
 * Called whenever admin updates a product's variant stock to > 0.
 * Notifies all subscribers waiting on that specific variant.
 */
export async function notifyStockAlerts(productId: number, productName: string, variantId?: number) {
  try {
    const conditions = variantId != null
      ? and(eq(stockAlertsTable.productId, productId), eq(stockAlertsTable.variantId, variantId), eq(stockAlertsTable.notified, false))
      : and(eq(stockAlertsTable.productId, productId), eq(stockAlertsTable.notified, false));

    const alerts = await db
      .select()
      .from(stockAlertsTable)
      .where(conditions);

    for (const alert of alerts) {
      console.log("[stock-alert] Processing alert:", alert.email);
      if (alert.email.endsWith("@phone.notify")) {
        const phone = alert.email.replace("@phone.notify", "");
        console.log("[stock-alert] Sending WhatsApp to:", phone);
        await sendWhatsAppStockAlert({ phone, productName, productId });
      } else {
        await sendStockAlertEmail({ to: alert.email, productName });
      }
      await db
        .update(stockAlertsTable)
        .set({ notified: true })
        .where(eq(stockAlertsTable.id, alert.id));
    }
  } catch (err) {
    console.error("[stock-alert] notifyStockAlerts failed:", err);
    throw err;
  }
}

export default router;
