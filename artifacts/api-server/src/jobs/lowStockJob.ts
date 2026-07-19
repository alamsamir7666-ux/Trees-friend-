import { db } from "@workspace/db";
import { productsTable, productVariantsTable } from "@workspace/db";
import { lte, eq, inArray } from "drizzle-orm";
import { Resend } from "resend";

const LOW_STOCK_THRESHOLD = parseInt(process.env.LOW_STOCK_THRESHOLD ?? "5");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "";

export async function runLowStockAlert() {
  if (!ADMIN_EMAIL) return;
  try {
    const lowStockVariants = await db
      .select({ id: productVariantsTable.id, productId: productVariantsTable.productId, name: productVariantsTable.name, stock: productVariantsTable.stock })
      .from(productVariantsTable)
      .where(lte(productVariantsTable.stock, LOW_STOCK_THRESHOLD));

    if (lowStockVariants.length === 0) return;

    const productIds = [...new Set(lowStockVariants.map((v) => v.productId))];
    const products = await db
      .select({ id: productsTable.id, name: productsTable.name })
      .from(productsTable)
      .where(inArray(productsTable.id, productIds));
    const productNameById = new Map(products.map((p) => [p.id, p.name]));

    const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
    if (!resend) return;

    const rows = lowStockVariants
      .map((v) => {
        const productName = productNameById.get(v.productId) ?? "Unknown product";
        const label = `${productName} (${v.name})`;
        return `<tr><td style="padding:6px 12px;border-bottom:1px solid #f3f4f6;">${label}</td><td style="padding:6px 12px;text-align:center;font-weight:600;color:${v.stock === 0 ? "#dc2626" : "#d97706"};">${v.stock === 0 ? "Out of Stock" : `${v.stock} left`}</td></tr>`;
      })
      .join("");

    await resend.emails.send({
      from: "Tree Friend Alerts <noreply@treefriend.com>",
      to: [ADMIN_EMAIL],
      subject: `⚠️ Low Stock Alert — ${lowStockVariants.length} variant(s) need restocking`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;"><h2>Low Stock Alert</h2><table style="width:100%;border-collapse:collapse;"><thead><tr style="background:#fdf2f8;"><th style="padding:8px 12px;text-align:left;">Product (Variant)</th><th style="padding:8px 12px;text-align:center;">Stock</th></tr></thead><tbody>${rows}</tbody></table><p><a href="${process.env.APP_URL ?? ""}/admin" style="color:#f43f5e;">Go to Admin Dashboard →</a></p></div>`,
    });

    console.log(`[low-stock] Alert sent for ${lowStockVariants.length} variants`);
  } catch (err) {
    console.error("[low-stock] Job failed:", err);
  }
}
