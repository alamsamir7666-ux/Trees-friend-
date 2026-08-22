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
  type?: "website" | "product" | "article";
  noIndex?: boolean;
  priceAmount?: number;
  priceCurrency?: string;
  /** ISO 8601 publish time for articles (e.g. "2025-08-01T00:00:00Z"). */
  publishedTime?: string;
  /** Section / category for articles (e.g. "Plant Care Tips"). */
  section?: string;
  /** Author name for articles (e.g. "Tree Friend Editorial"). */
  author?: string;
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

  // Canonical URL (also used for og:url below).
  const canonicalUrl = window.location.href.split("?")[0]; // Strip query params from canonical

  // Open Graph
  setMeta("og:title", title, true);
  setMeta("og:description", description, true);
  setMeta("og:image", image.startsWith("http") ? image : `https://treefriend.com${image}`, true);
  setMeta("og:url", canonicalUrl, true);
  setMeta(
    "og:type",
    opts.type === "product" ? "product" : opts.type === "article" ? "article" : "website",
    true,
  );
  setMeta("og:site_name", SITE_NAME, true);

  // Product price (Open Graph product namespace) — only when supplied
  if (opts.type === "product" && opts.priceAmount != null) {
    setMeta("product:price:amount", String(opts.priceAmount), true);
    setMeta("product:price:currency", opts.priceCurrency ?? "BDT", true);
  }

  // Article-specific OG tags (Open Graph article namespace).
  // https://ogp.me/#type_article — only emitted when the page declares
  // itself as an article, and only for fields that have a value.
  if (opts.type === "article") {
    if (opts.publishedTime) {
      setMeta("article:published_time", opts.publishedTime, true);
    }
    if (opts.section) {
      setMeta("article:section", opts.section, true);
    }
    if (opts.author) {
      setMeta("article:author", opts.author, true);
    }
  }

  // Twitter Card — always set `twitter:card` so crawlers render the right
  // card type. `summary_large_image` when there's a real image (which is
  // always, since we fall back to DEFAULT_IMAGE); `summary` only if the
  // caller explicitly passes a falsy image — but since `image` always
  // resolves to at least DEFAULT_IMAGE, we use summary_large_image.
  setMeta("twitter:card", "summary_large_image");
  setMeta("twitter:title", title);
  setMeta("twitter:description", description);
  setMeta("twitter:image", image.startsWith("http") ? image : `https://treefriend.com${image}`);

  // Canonical link tag
  let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.rel = "canonical";
    document.head.appendChild(canonical);
  }
  canonical.href = canonicalUrl;

  // Cleanup: remove stale article-specific tags when navigating away from
  // an article to a non-article page (e.g. article → product detail).
  // Without this, `article:published_time` from the previous page would
  // persist in <head> and misrepresent the current page to crawlers.
  if (opts.type !== "article") {
    for (const tag of ["article:published_time", "article:section", "article:author"]) {
      const el = document.querySelector<HTMLMetaElement>(`meta[property="${tag}"]`);
      if (el) el.remove();
    }
  }
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

