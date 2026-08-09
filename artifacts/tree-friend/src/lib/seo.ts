/**
 * SEO utility - update document.title and meta tags dynamically.
 * Since this is a SPA (no SSR), we do this client-side.
 * For proper server-side SEO, consider migrating to Next.js.
 */

import { useEffect } from "react";

const DEFAULT_TITLE = "Tree Friend - Trees & Plants for Every Home | Bangladesh";
const DEFAULT_DESCRIPTION =
  "Shop fruit trees, indoor plants, and saplings in Bangladesh. Quality plants from trusted nurseries, fair pricing, delivered responsibly.";
const DEFAULT_IMAGE = "/opengraph.jpg";
const SITE_NAME = "Tree Friend";

interface SEOOptions {
  title?: string;
  description?: string;
  image?: string;
  type?: "website" | "product";
  noIndex?: boolean;
  priceAmount?: number;
  priceCurrency?: string;
}

function setMeta(name: string, content: string, property = false) {
  const attr = property ? "property" : "name";
  let el = document.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

export function updateSEO(opts: SEOOptions = {}) {
  const title = opts.title
    ? `${opts.title} | ${SITE_NAME}`
    : DEFAULT_TITLE;
  const description = opts.description ?? DEFAULT_DESCRIPTION;
  const image = opts.image ?? DEFAULT_IMAGE;

  // Title
  document.title = title;

  // Meta description
  setMeta("description", description);

  // Robots
  if (opts.noIndex) {
    setMeta("robots", "noindex, nofollow");
  } else {
    setMeta("robots", "index, follow");
  }

  // Open Graph
  setMeta("og:title", title, true);
  setMeta("og:description", description, true);
  setMeta("og:image", image.startsWith("http") ? image : `https://treefriend.com${image}`, true);
  setMeta("og:type", opts.type === "product" ? "product" : "website", true);
  setMeta("og:site_name", SITE_NAME, true);

  // Product price (Open Graph product namespace) — only when supplied
  if (opts.type === "product" && opts.priceAmount != null) {
    setMeta("product:price:amount", String(opts.priceAmount), true);
    setMeta("product:price:currency", opts.priceCurrency ?? "BDT", true);
  }

  // Twitter
  setMeta("twitter:title", title);
  setMeta("twitter:description", description);
  setMeta("twitter:image", image.startsWith("http") ? image : `https://treefriend.com${image}`);

  // Canonical
  let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.rel = "canonical";
    document.head.appendChild(canonical);
  }
  canonical.href = window.location.href.split("?")[0]; // Strip query params from canonical
}

/**
 * React hook for updating SEO meta tags. Wraps `updateSEO` in `useEffect`
 * so the side effect runs after render (in the commit phase), not during
 * render. Calling `updateSEO` directly during render is an anti-pattern
 * that can cause issues with React's concurrent rendering and hydration.
 *
 * Usage:
 *   function MyPage() {
 *     useSEO({ title: "My Page", description: "..." });
 *     return <div>...</div>;
 *   }
 *
 * The effect re-runs only when the options actually change (shallow compare
 * via JSON.stringify — fine for SEO options which are small plain objects).
 */
export function useSEO(opts: SEOOptions = {}) {
  // Stringify opts so the effect only re-runs when they actually change.
  // JSON.stringify is fine here — opts is a small plain object.
  const serialized = JSON.stringify(opts);
  useEffect(() => {
    updateSEO(JSON.parse(serialized));
  }, [serialized]);
}

