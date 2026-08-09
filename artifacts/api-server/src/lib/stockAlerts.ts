/**
 * Stock alert notification logic.
 *
 * EXTRACTED from routes/stockAlerts.ts so that:
 *  • The logic is reusable from non-HTTP contexts (cron jobs, CLI scripts,
 *    admin tools) without importing Express.
 *  • The logic is unit-testable in isolation.
 *  • Routes/products.ts imports this — decoupling route files from each other
 *    (the audit flagged "business logic exported from route files" as a
 *    code smell because it couples route files together).
 */

import { logger } from "./logger";
import { db } from "@workspace/db";
import { stockAlertsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { sendStockAlertEmail } from "./email";
import { sendWhatsAppStockAlert } from "./whatsapp";

/**
 * Notify all subscribers waiting on a specific variant (or all variants of a
 * product) when stock becomes available. Called whenever admin updates a
 * product's variant stock to > 0 (from routes/products.ts).
 *
 * Idempotent: only alerts where `notified = false` are processed, and each
 * is marked `notified = true` immediately after the notification is sent.
 * A failure in sending one alert does NOT block the others — each iteration
 * is independent.
 *
 * Throws if the underlying DB query fails (so the caller can decide whether
 * to retry). Individual notification failures (email/WhatsApp) are logged
 * but do NOT throw — `sendStockAlertEmail` and `sendWhatsAppStockAlert`
 * already swallow their own errors internally.
 */
export async function notifyStockAlerts(productId: number, productName: string, variantId?: number): Promise<void> {
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
    logger.error({ err, productId, variantId }, "[stock-alert] notifyStockAlerts failed");
    throw err;
  }
}
