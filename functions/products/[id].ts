/**
 * Cloudflare Pages Function — bot detection + OG meta tag injection for
 * product detail pages.
 *
 * Ported from `api/og-product.ts` (Vercel serverless).
 *
 * Route: `/products/:id` (Cloudflare Pages maps the filename
 * `products/[id].ts` to the path `/products/:id`).
 *
 * Behavior:
 *   - Human browsers: return the plain `index.html` shell (SPA hydrates
 *     and fetches product data client-side).
 *   - Bots (Facebook, WhatsApp, Twitter, Google, etc.): fetch the product
 *     from the API, inject OG/Twitter meta tags into `index.html`, return
 *     the modified HTML. This makes social media link previews show the
 *     right product name/image/price without executing JavaScript.
 *
 * Industry-standard pattern — same approach used by Vercel, Netlify, and
 * Cloudflare's own docs for SPA SEO.
 */

import { isBotRequest, injectMeta, getSiteBase, getApiBase, fetchIndexHtml, htmlResponse } from "../_og";

interface Product {
  id: number;
  name: string;
  description: string;
  images: string[];
  listingMinPrice?: number | null;
  listingMaxPrice?: number | null;
}

export const onRequestGet: PagesFunction = async (context) => {
  const { request, env, params } = context;
  const userAgent = request.headers.get("user-agent");
  const id = params.id as string | undefined;

  const indexHtml = await fetchIndexHtml(request, env as Record<string, unknown>);

  // Not a bot, or no product id — return the plain SPA shell.
  if (!isBotRequest(userAgent) || !id) {
    return htmlResponse(indexHtml);
  }

  const siteBase = getSiteBase(request);
  const apiBase = getApiBase(env as Record<string, string | undefined>);

  try {
    const res = await fetch(`${apiBase}/api/products/${id}`);
    if (!res.ok) {
      // Product not found or API error — still return the SPA shell
      // so the client-side 404 page renders correctly.
      return htmlResponse(indexHtml);
    }
    const product = (await res.json()) as Product;
    // Use the lowest listing price if available, fall back to 0.
    const price = product.listingMinPrice ?? 0;

    const html = injectMeta(indexHtml, {
      title: product.name,
      description: product.description || `Buy ${product.name} online at Tree Friend.`,
      image: product.images?.[0] ?? "/opengraph.jpg",
      url: `${siteBase}/products/${product.id}`,
      type: "product",
      priceAmount: price,
      priceCurrency: "BDT",
    }, siteBase);

    return htmlResponse(
      html,
      "public, max-age=300, s-maxage=600",
    );
  } catch (err) {
    console.error("[og-product] failed:", err);
    return htmlResponse(indexHtml);
  }
};
