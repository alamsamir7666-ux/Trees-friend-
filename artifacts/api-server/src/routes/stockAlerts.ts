import { Router } from "express";
import { db } from "@workspace/db";
import { stockAlertsTable, productsTable, productVariantsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { sendStockAlertEmail } from "../lib/email";
import { sendWhatsAppStockAlert } from "../lib/whatsapp";
import { stockAlertLimiter } from "../middlewares/rateLimiter";
import { z } from "zod";
import { validateBody } from "../lib/validateRequest";
import { logger } from "../lib/logger";

const router = Router();

// P0-1: hand-authored schema (OpenAPI spec doesn't cover this route).
//productId and variantId use coerce.number() because the frontend may send
// them as strings or numbers depending on the call site. email is a string
// with a basic presence check; the route's existing email/phone format
// validation (below) is kept as a business rule since the schema can't
// express "email OR phone-notify format".
const CreateStockAlertBody = z.object({
  productId: z.coerce.number(),
  variantId: z.coerce.number(),
  email: z.string(),
});

router.post("/stock-alerts", stockAlertLimiter, validateBody(CreateStockAlertBody, "CreateStockAlertBody"), async (req, res) => {
  try {
    // P0-1: body shape now validated by Zod (CreateStockAlertBody).
    // productId/variantId are coerced to numbers; email is a string.
    // The hand-rolled isNaN checks are superseded. The email format
    // business rule (email must contain @ or end with @phone.notify) is
    // kept below — Zod validates shape, this validates semantics.
    const { productId, variantId, email } = req.body;
    const isPhone = email.endsWith("@phone.notify");
    if (!isPhone && !email.includes("@")) {
      res.status(400).json({ error: "Valid email is required" });
      return;
    }

    const [product] = await db
      .select({ id: productsTable.id, name: productsTable.name })
      .from(productsTable)
      .where(eq(productsTable.id, productId))
      .limit(1);

    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    const [variant] = await db
      .select({ id: productVariantsTable.id, stock: productVariantsTable.stock, productId: productVariantsTable.productId })
      .from(productVariantsTable)
      .where(eq(productVariantsTable.id, variantId))
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
          eq(stockAlertsTable.variantId, variantId),
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
      productId,
      variantId,
      email: email.toLowerCase().trim(),
    });

    res.status(201).json({ message: "You will be notified when this option is back in stock" });
  } catch (err) {
    logger.error({ err }, "Route handler error");
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
      logger.info({ data: alert.email }, "[stock-alert] Processing alert");
      if (alert.email.endsWith("@phone.notify")) {
        const phone = alert.email.replace("@phone.notify", "");
        logger.info({ data: phone }, "[stock-alert] Sending WhatsApp to");
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
    logger.error({ err: err }, "[stock-alert] notifyStockAlerts failed");
    throw err;
  }
}

export default router;
