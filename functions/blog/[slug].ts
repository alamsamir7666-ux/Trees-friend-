/**
 * Cloudflare Pages Function — bot detection + OG meta tag injection for
 * blog article pages.
 *
 * Ported from `api/og-blog.ts` (Vercel serverless).
 *
 * Route: `/blog/:slug` (Cloudflare Pages maps the filename
 * `blog/[slug].ts` to the path `/blog/:slug`).
 *
 * Behavior mirrors `products/[id].ts` — human browsers get the plain SPA
 * shell, bots get the shell with injected OG/Twitter meta tags so social
 * media link previews show the right blog post title/excerpt/image.
 */

import { isBotRequest, injectMeta, getSiteBase, getApiBase, fetchIndexHtml, htmlResponse } from "../_og";

interface BlogPost {
  title: string;
  excerpt: string;
  image: string;
}

export const onRequestGet: PagesFunction = async (context) => {
  const { request, env, params } = context;
  const userAgent = request.headers.get("user-agent");
  const slug = params.slug as string | undefined;

  const indexHtml = await fetchIndexHtml(request, env as Record<string, unknown>);

  if (!isBotRequest(userAgent) || !slug) {
    return htmlResponse(indexHtml);
  }

  const siteBase = getSiteBase(request);
  const apiBase = getApiBase(env as Record<string, string | undefined>);

  try {
    const res = await fetch(`${apiBase}/api/blog-posts/${slug}`);
    if (!res.ok) {
      return htmlResponse(indexHtml);
    }
    const post = (await res.json()) as BlogPost;

    const html = injectMeta(indexHtml, {
      title: post.title,
      description: post.excerpt || "Read the latest from Tree Friend.",
      image: post.image ?? "/opengraph.jpg",
      url: `${siteBase}/blog/${slug}`,
      type: "article",
    }, siteBase);

    return htmlResponse(
      html,
      "public, max-age=300, s-maxage=600",
    );
  } catch (err) {
    console.error("[og-blog] failed:", err);
    return htmlResponse(indexHtml);
  }
};
