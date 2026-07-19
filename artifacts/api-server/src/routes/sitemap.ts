import { Router } from "express";
import { db } from "@workspace/db";
import { productsTable, categoriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

const APP_URL = process.env.APP_URL ?? "https://treefriend.com";

function toXmlDate(d: Date) {
  return d.toISOString().split("T")[0];
}

router.get("/sitemap.xml", async (_req, res) => {
  try {
    const [products, categories] = await Promise.all([
      db
        .select({ id: productsTable.id, updatedAt: productsTable.updatedAt })
        .from(productsTable),
      db.select({ slug: categoriesTable.slug }).from(categoriesTable),
    ]);

    const staticPages = [
      { url: "", priority: "1.0", changefreq: "daily" },
      { url: "/products", priority: "0.9", changefreq: "daily" },
      { url: "/track", priority: "0.5", changefreq: "monthly" },
    ];

    const categoryUrls = categories.map((c) => ({
      url: `/products?category=${c.slug}`,
      priority: "0.8",
      changefreq: "weekly",
    }));

    const productUrls = products.map((p) => ({
      url: `/products/${p.id}`,
      priority: "0.7",
      changefreq: "weekly",
      lastmod: p.updatedAt ? toXmlDate(p.updatedAt) : undefined,
    }));

    const allUrls = [...staticPages, ...categoryUrls, ...productUrls];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allUrls
  .map(
    (u) => `  <url>
    <loc>${APP_URL}${u.url}</loc>
    ${u ? `<lastmod>${u}</lastmod>` : ""}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`,
  )
  .join("\n")}
</urlset>`;

    res.setHeader("Content-Type", "application/xml");
    res.setHeader("Cache-Control", "public, max-age=3600"); // Cache 1 hour
    res.send(xml);
  } catch {
    res.status(500).send("Failed to generate sitemap");
  }
});

export default router;
