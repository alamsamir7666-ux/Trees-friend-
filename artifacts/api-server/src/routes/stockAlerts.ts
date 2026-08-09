import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { stockAlertsTable, productsTable, productVariantsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { stockAlertLimiter } from "../middlewares/rateLimiter";
import { validateBody } from "../lib/validateRequest";
import { asyncHandler, HttpError } from "../lib/errors";
import { notifyStockAlerts } from "../lib/stockAlerts";

// Re-export for backward compat — routes/products.ts imports this from
// "./stockAlerts". New code should import from "../lib/stockAlerts".
export { notifyStockAlerts };

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

router.post(
  "/stock-alerts",
  stockAlertLimiter,
  validateBody(CreateStockAlertBody, "CreateStockAlertBody"),
  asyncHandler(async (req, res) => {
    const { productId, variantId, email } = req.body;
    const isPhone = email.endsWith("@phone.notify");
    if (!isPhone && !email.includes("@")) {
      throw new HttpError(400, "Valid email is required");
    }

    const [product] = await db
      .select({ id: productsTable.id, name: productsTable.name })
      .from(productsTable)
      .where(eq(productsTable.id, productId))
      .limit(1);

    if (!product) throw new HttpError(404, "Product not found");

    const [variant] = await db
      .select({ id: productVariantsTable.id, stock: productVariantsTable.stock, productId: productVariantsTable.productId })
      .from(productVariantsTable)
      .where(eq(productVariantsTable.id, variantId))
      .limit(1);

    if (!variant || variant.productId !== product.id) {
      throw new HttpError(404, "Variant not found for this product");
    }
    if (variant.stock > 0) {
      throw new HttpError(400, "This option is already in stock");
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
  }),
);

export default router;
