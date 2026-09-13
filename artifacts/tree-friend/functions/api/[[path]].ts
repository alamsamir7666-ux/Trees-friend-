/**
 * Cloudflare Pages Function — catch-all API proxy to the Render backend.
 *
 * Replaces the Vercel `routes` entry:
 *   `/api/(?!sitemap|og-product|og-blog)(.*) → https://trees-friend-tt53.onrender.com/api/$1`
 *
 * Why this is needed:
 *   The frontend's `apiClient.ts` and `custom-fetch.ts` use relative paths
 *   (e.g. `/api/products`) which work in dev (Vite proxy) but in production
 *   need a server-side proxy to avoid CORS issues and to keep the Render
 *   URL hidden from the browser. Cloudflare's static `_redirects` file
 *   cannot proxy to external hosts — only to local files — so a Pages
 *   Function is required.
 *
 * Route: `/api/*` (the `[[path]].ts` filename creates a catch-all that
 * matches any path under `/api/`). Cloudflare Pages prioritizes more
 * specific routes (`/api/products/[id]`) over this catch-all, but since
 * we don't have any specific `/api/*` Pages Functions, this handles all
 * API traffic.
 *
 * Headers forwarded:
 *   - Authorization (Bearer token from Clerk or guest JWT)
 *   - Content-Type (for POST/PUT/PATCH bodies)
 *   - Cookie (for HttpOnly session cookies used by AI chat SSE)
 *   - User-Agent (for bot detection on API side, if ever needed)
 *
 * Headers NOT forwarded:
 *   - Host (would break the upstream request — fetch sets it automatically)
 *   - Connection (hop-by-hop header, must not be forwarded per RFC 7230)
 *
 * Caching: no caching — every API request is dynamic. The backend
 * already sets appropriate Cache-Control headers per route.
 */

import { getApiBase } from "../../_og";

interface ProxyEnv {
  API_BASE_URL?: string;
  ASSETS?: { fetch: typeof fetch };
  [key: string]: unknown;
}

// Hop-by-hop headers that must NOT be forwarded per RFC 7230 §6.1.
// Forwarding these would break the upstream request or cause undefined
// behavior in the client connection.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export const onRequest: PagesFunction<ProxyEnv> = async (context) => {
  const { request, env, params } = context;
  const apiBase = getApiBase(env);

  // `params.path` is an array when the filename uses `[[]path]` (catch-all).
  // It's a string for single `[path]`. Join with `/` to rebuild the path.
  const pathSegments = params.path;
  const path = Array.isArray(pathSegments)
    ? pathSegments.join("/")
    : (pathSegments as string | undefined) ?? "";

  // Build the upstream URL. The frontend calls `/api/products`, so we
  // proxy to `${apiBase}/api/products` (apiBase already has no trailing
  // slash — see `getApiBase`).
  const url = new URL(request.url);
  const upstreamUrl = `${apiBase}/api/${path}${url.search}`;

  // Clone the request headers and strip hop-by-hop headers before forwarding.
  // This prevents the upstream from receiving a `Host: treefriend.pages.dev`
  // header (which would break virtual-host routing on Render) or a
  // `Connection: keep-alive` header (which Cloudflare's fetch doesn't support).
  const upstreamHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      upstreamHeaders.set(key, value);
    }
  }

  // Build the upstream request — same method, body, and most headers.
  // `redirect: "manual"` so we don't follow redirects upstream (the
  // backend shouldn't redirect, but if it does, we want to pass the
  // 3xx through to the client unchanged).
  const upstreamRequest = new Request(upstreamUrl, {
    method: request.method,
    headers: upstreamHeaders,
    body: request.body,
    redirect: "manual",
  });

  try {
    const upstreamResponse = await fetch(upstreamRequest);

    // Clone the response, stripping hop-by-hop headers again (the upstream
    // may set `Connection` or `Transfer-Encoding` which we shouldn't pass
    // back to the client).
    const responseHeaders = new Headers();
    for (const [key, value] of upstreamResponse.headers.entries()) {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    }

    // Add CORS header so the browser allows the response. Since the
    // frontend and this function are on the same origin (both
    // treefriend.pages.dev), CORS isn't strictly needed — but adding
    // it makes the function reusable if we ever move the frontend to a
    // different domain.
    responseHeaders.set("Access-Control-Allow-Origin", url.origin);

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error("[api-proxy] upstream fetch failed:", err);
    return new Response(
      JSON.stringify({
        error: "Upstream API unavailable",
        message: "The backend API server could not be reached. Please try again in a moment.",
      }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": url.origin,
        },
      },
    );
  }
};
