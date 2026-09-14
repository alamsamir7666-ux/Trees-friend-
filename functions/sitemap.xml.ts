/**
 * Cloudflare Pages Function — dynamic sitemap.xml generator.
 *
 * Ported from `api/sitemap.ts` (Vercel serverless). Fetches all products
 * and blog posts from the backend API and builds a sitemap.xml with
 * <url> entries for each.
 *
 * Route: `/sitemap.xml` (Cloudflare Pages maps the filename
 * `sitemap.xml.ts` to the path `/sitemap.xml`).
 *
 * Caching: 1 hour at the edge (s-maxage=3600), 5 minutes in the browser
 * (max-age=300). The sitemap doesn't change often, so aggressive caching
 * is safe and reduces load on the API server.
 */

import { getSiteBase, getApiBase } from "./_og";

interface Product {
  id: number;
  updatedAt?: string;
}

interface BlogPost {
  slug: string;
  updatedAt?: string;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function urlEntry(loc: string, changefreq: string, priority: string, lastmod?: string): string {
  return `  <url>
    <loc>${escapeXml(loc)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

export const onRequestGet: PagesFunction = async (context) => {
  const { request, env } = context;
  const siteBase = getSiteBase(request);
  const apiBase = getApiBase(env as Record<string, string | undefined>);

  try {
    const entries: string[] = [];

    // Static pages — always present, fixed priority.
    entries.push(urlEntry(`${siteBase}/`, "daily", "1.0"));
    entries.push(urlEntry(`${siteBase}/products`, "daily", "0.9"));
    entries.push(urlEntry(`${siteBase}/blog`, "weekly", "0.6"));
    entries.push(urlEntry(`${siteBase}/track`, "monthly", "0.3"));

    // Product URLs — fetch all products (up to 1000) and emit one <url>
    // per product. `lastmod` uses the product's `updatedAt` timestamp
    // so crawlers know when to re-crawl.
    const productsRes = await fetch(`${apiBase}/api/products?limit=1000`);
    if (productsRes.ok) {
      const data = (await productsRes.json()) as { products?: Product[] };
      const products: Product[] = data.products ?? [];
      for (const p of products) {
        entries.push(
          urlEntry(
            `${siteBase}/products/${p.id}`,
            "weekly",
            "0.8",
            p.updatedAt ? new Date(p.updatedAt).toISOString().split("T")[0] : undefined
          )
        );
      }
    }

    // Blog post URLs — same pattern as products.
    const blogRes = await fetch(`${apiBase}/api/blog-posts?limit=1000`);
    if (blogRes.ok) {
      const data = (await blogRes.json()) as BlogPost[] | { posts?: BlogPost[] };
      const posts: BlogPost[] = Array.isArray(data) ? data : (data.posts ?? []);
      for (const post of posts) {
        entries.push(
          urlEntry(
            `${siteBase}/blog/${post.slug}`,
            "monthly",
            "0.5",
            post.updatedAt ? new Date(post.updatedAt).toISOString().split("T")[0] : undefined
          )
        );
      }
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>`;

    return new Response(xml, {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=3600",
      },
    });
  } catch (err) {
    console.error("[sitemap] generation failed:", err);
    // Fallback: emit a minimal sitemap with just the static pages so
    // crawlers don't get a 500. The full sitemap will regenerate on
    // the next request.
    const fallback = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntry(`${siteBase}/`, "daily", "1.0")}
${urlEntry(`${siteBase}/products`, "daily", "0.9")}
</urlset>`;
    return new Response(fallback, {
      status: 200,
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
  }
};
