import { isBotRequest, injectMeta, SITE_BASE, API_BASE } from "./_og.js";

interface BlogPost {
  title: string;
  excerpt: string;
  image: string;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userAgent = request.headers.get("user-agent");

    const match = url.pathname.match(/^\/blog\/([^/]+)/);
    const slug = match?.[1];

    const indexHtml = await fetch(`${url.origin}/index.html`).then((r) => r.text());

    if (!isBotRequest(userAgent) || !slug) {
      return new Response(indexHtml, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    try {
      const res = await fetch(`${API_BASE}/api/blog-posts/${slug}`);
      if (!res.ok) {
        return new Response(indexHtml, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      const post = (await res.json()) as BlogPost;

      const html = injectMeta(indexHtml, {
        title: post.title,
        description: post.excerpt,
        image: post.image ?? "/opengraph.jpg",
        url: `${SITE_BASE}/blog/${slug}`,
        type: "article",
      });

      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=300, s-maxage=600",
        },
      });
    } catch (err) {
      console.error("[og-blog] failed:", err);
      return new Response(indexHtml, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
  },
};
