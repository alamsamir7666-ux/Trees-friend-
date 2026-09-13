/**
 * Shared helpers for Cloudflare Pages Functions — bot detection, HTML meta
 * tag injection, and site/API base URL resolution.
 *
 * Ported from `api/_og.ts` (Vercel serverless) with two key changes:
 *
 * 1. `SITE_BASE` is now derived from the request URL (via `Request.url`)
 *    instead of being hardcoded to `https://treefriend.com`. This makes
 *    OG tags correct on any deployment — `treefriend.pages.dev`, preview
 *    deploys, and future custom domains — without code changes.
 *
 * 2. `API_BASE` is read from the `API_BASE_URL` environment variable
 *    (bound to the Pages Function via the Cloudflare dashboard or
 *    `wrangler.toml`). Falls back to the known Render URL for safety
 *    during the transition period.
 */

// Render API server — used as the fallback when the API_BASE_URL env var
// is not set. Once you set API_BASE_URL in the Cloudflare Pages dashboard,
// this fallback is never used.
const FALLBACK_API_BASE = "https://trees-friend-tt53.onrender.com";

export const SITE_NAME = "Tree Friend";

/**
 * Resolve the site's public base URL from the incoming request.
 *
 * Cloudflare Pages sets `Request.url` to the full public URL (including
 * protocol + host), so we can derive the origin from it. This is
 * preferable to hardcoding a domain — works automatically across
 * `*.pages.dev`, preview deploys, and custom domains.
 */
export function getSiteBase(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

/**
 * Resolve the backend API base URL from the `API_BASE_URL` environment
 * variable. This is set in the Cloudflare Pages dashboard (Settings →
 * Environment variables) and bound to the function via the `env`
 * parameter on `onRequestGet(context)`.
 *
 * Falls back to the known Render URL if unset — keeps the function
 * working during the transition period.
 */
export function getApiBase(env: Record<string, string | undefined>): string {
  return env.API_BASE_URL || FALLBACK_API_BASE;
}

// Comprehensive bot/crawler UA pattern — matches all major social preview
// bots (Facebook, WhatsApp, Telegram, Twitter, LinkedIn, Pinterest,
// Discord, Skype, Slack), search engine crawlers (Google, Bing, Yandex,
// Baidu, DuckDuckGo), and SEO tools (Ahrefs, Semrush).
//
// When a bot is detected, we fetch the product/blog post from the API
// and inject server-side OG meta tags so the bot sees the right preview
// without executing JavaScript. Human browsers get the plain SPA shell.
const BOT_UA_PATTERN =
  /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegrambot|twitterbot|linkedinbot|pinterest|discordbot|skypeuripreview|slackbot|vkshare|w3c_validator|redditbot|embedly|quora link preview|tumblr|nuzzel|outbrain|google-structured-data-testing-tool|applebot|bingbot|yandex|baiduspider|duckduckbot/i;

export function isBotRequest(userAgent: string | null): boolean {
  if (!userAgent) return false;
  return BOT_UA_PATTERN.test(userAgent);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface PageMeta {
  title: string;
  description: string;
  image: string;
  url: string;
  type?: "website" | "product" | "article";
  priceAmount?: number;
  priceCurrency?: string;
}

/**
 * Inject OG/Twitter meta tags + title + canonical into the prebuilt
 * `index.html` shell. Used by the bot-detection Pages Functions
 * (`/products/[id]`, `/blog/[slug]`) so social media link previews
 * show the right title/description/image without executing JS.
 *
 * The regex replacements are intentionally strict — they match the
 * exact meta tag patterns emitted in `index.html` at build time. If
 * you change the meta tag format in `index.html`, update the regexes
 * here to match.
 */
export function injectMeta(html: string, meta: PageMeta, siteBase: string): string {
  const fullTitle = `${meta.title} | ${SITE_NAME}`;
  const description = meta.description.slice(0, 300);
  const image = meta.image.startsWith("http") ? meta.image : `${siteBase}${meta.image}`;

  let out = html;

  out = out.replace(/<title>.*?<\/title>/, `<title>${escapeHtml(fullTitle)}</title>`);
  out = out.replace(
    /<meta name="description" content=".*?"\s*\/>/,
    `<meta name="description" content="${escapeHtml(description)}" />`
  );
  out = out.replace(
    /<meta property="og:title" content=".*?"\s*\/>/,
    `<meta property="og:title" content="${escapeHtml(fullTitle)}" />`
  );
  out = out.replace(
    /<meta property="og:description" content=".*?"\s*\/>/,
    `<meta property="og:description" content="${escapeHtml(description)}" />`
  );
  out = out.replace(
    /<meta property="og:image" content=".*?"\s*\/>/,
    `<meta property="og:image" content="${escapeHtml(image)}" />`
  );
  out = out.replace(
    /<meta name="twitter:title" content=".*?"\s*\/>/,
    `<meta name="twitter:title" content="${escapeHtml(fullTitle)}" />`
  );
  out = out.replace(
    /<meta name="twitter:description" content=".*?"\s*\/>/,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`
  );
  out = out.replace(
    /<meta name="twitter:image" content=".*?"\s*\/>/,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`
  );
  out = out.replace(
    /<link rel="canonical" href=".*?"\s*\/>/,
    `<link rel="canonical" href="${escapeHtml(meta.url)}" />`
  );

  const ogType = meta.type === "product" ? "product" : meta.type === "article" ? "article" : "website";
  out = out.replace(
    /<meta property="og:type" content=".*?"\s*\/>/,
    `<meta property="og:type" content="${ogType}" />`
  );

  // Product price tags (Open Graph product namespace) — only emitted
  // when the caller passes `type: "product"` and a `priceAmount`.
  let priceTags = "";
  if (meta.type === "product" && meta.priceAmount != null) {
    priceTags =
      `\n    <meta property="product:price:amount" content="${meta.priceAmount}" />` +
      `\n    <meta property="product:price:currency" content="${meta.priceCurrency ?? "BDT"}" />`;
  }
  if (priceTags) {
    out = out.replace("</head>", `${priceTags}\n  </head>`);
  }

  return out;
}

/**
 * Fetch the prebuilt `index.html` shell from the Pages static asset
 * store. Cloudflare Pages exposes the asset binding as `env.ASSETS`
 * (an object with a `fetch()` method matching the standard Request/Response
 * interface).
 *
 * We use this instead of `fetch(request.url + "/index.html")` because
 * the latter would make an external HTTP round-trip back to the Pages
 * deployment — slower and unnecessary. `env.ASSETS.fetch()` reads
 * directly from the edge cache.
 */
export async function fetchIndexHtml(
  request: Request,
  env: Record<string, unknown>,
): Promise<string> {
  // Cloudflare Pages binds the static asset store as `env.ASSETS`.
  // The type is `{ fetch: typeof fetch }` — same signature as the
  // global fetch, but reads from the asset store instead of the network.
  const assets = env.ASSETS as { fetch: typeof fetch } | undefined;
  if (!assets) {
    // Fallback: if ASSETS isn't bound (e.g. running locally via
    // `wrangler pages dev` without the assets flag), fall back to an
    // HTTP fetch. This is slower but works in dev.
    const url = new URL(request.url);
    const res = await fetch(`${url.origin}/index.html`);
    return res.text();
  }
  const res = await assets.fetch(new Request("https://placeholder/index.html"));
  return res.text();
}

/**
 * Helper to build a standard HTML response with the right content-type
 * and optional cache headers.
 */
export function htmlResponse(
  html: string,
  cacheControl?: string,
): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...(cacheControl ? { "Cache-Control": cacheControl } : {}),
    },
  });
}
