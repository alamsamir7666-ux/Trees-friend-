const API_BASE = "https://treefriend-api.onrender.com";
const SITE_BASE = "https://treefriend.com";

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

export default {
  async fetch(_request: Request): Promise<Response> {
    try {
      const entries: string[] = [];

      entries.push(urlEntry(`${SITE_BASE}/`, "daily", "1.0"));
      entries.push(urlEntry(`${SITE_BASE}/products`, "daily", "0.9"));
      entries.push(urlEntry(`${SITE_BASE}/blog`, "weekly", "0.6"));
      entries.push(urlEntry(`${SITE_BASE}/track`, "monthly", "0.3"));

      const productsRes = await fetch(`${API_BASE}/api/products?limit=1000`);
      if (productsRes.ok) {
        const data = (await productsRes.json()) as { products?: Product[] };
        const products: Product[] = data.products ?? [];
        for (const p of products) {
          entries.push(
            urlEntry(
              `${SITE_BASE}/products/${p.id}`,
              "weekly",
              "0.8",
              p.updatedAt ? new Date(p.updatedAt).toISOString().split("T")[0] : undefined
            )
          );
        }
      }

      const blogRes = await fetch(`${API_BASE}/api/blog-posts?limit=1000`);
      if (blogRes.ok) {
        const data = (await blogRes.json()) as BlogPost[] | { posts?: BlogPost[] };
        const posts: BlogPost[] = Array.isArray(data) ? data : (data.posts ?? []);
        for (const post of posts) {
          entries.push(
            urlEntry(
              `${SITE_BASE}/blog/${post.slug}`,
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
          "Cache-Control": "public, max-age=3600, s-maxage=3600",
        },
      });
    } catch (err) {
      console.error("[sitemap] generation failed:", err);
      const fallback = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntry(`${SITE_BASE}/`, "daily", "1.0")}
${urlEntry(`${SITE_BASE}/products`, "daily", "0.9")}
</urlset>`;
      return new Response(fallback, {
        status: 200,
        headers: { "Content-Type": "application/xml; charset=utf-8" },
      });
    }
  },
};
