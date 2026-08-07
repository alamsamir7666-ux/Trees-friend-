export const SITE_BASE = "https://treefriend.com";
export const API_BASE = "https://treefriend-api.onrender.com";
export const SITE_NAME = "Tree Friend";

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

function absoluteImage(image: string): string {
  return image.startsWith("http") ? image : `${SITE_BASE}${image}`;
}

export function injectMeta(html: string, meta: PageMeta): string {
  const fullTitle = `${meta.title} | ${SITE_NAME}`;
  const description = meta.description.slice(0, 300);
  const image = absoluteImage(meta.image);

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
