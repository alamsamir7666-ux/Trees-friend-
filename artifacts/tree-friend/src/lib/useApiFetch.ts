import { useCallback, useRef } from "react";
import { useAuth } from "@clerk/react";
import { getToken as getSharedToken } from "@/lib/getToken";

/**
 * Single source of truth for ad-hoc `fetch()` calls to the Tree Friend API.
 *
 * Why this exists
 * ───────────────
 * Before this hook, the codebase used four different patterns for hitting
 * the backend:
 *   1. `@workspace/api-client-react` generated hooks (TanStack Query-backed)
 *   2. `apiClient.get/post/...` from `@/lib/apiClient`
 *   3. Raw `fetch(\`${VITE_API_BASE_URL}/api/...\`)` with manual
 *      `getToken()` + `Authorization` header
 *   4. Raw `fetch("/api/...")` with no token and no base URL — silently
 *      broken in production (the URL resolves to the SPA shell on Vercel,
 *      so the response is HTML, `.json()` throws, and `.catch(() => {})`
 *      swallows the error). `useLoyalty` and `useReferral` were the
 *      known-broken instances.
 *
 * This hook provides pattern #3 with a single, typed implementation so
 * call sites don't have to re-implement base URL prefixing, Bearer token
 * injection, JSON parsing, and error normalization. Pages that already
 * use the generated client (#1) or `apiClient` (#2) should keep using
 * those — this hook is for the cases where neither fits (file uploads,
 * one-off endpoints not in the OpenAPI spec, etc.).
 *
 * Usage
 * ─────
 *   const apiFetch = useApiFetch();
 *   const res = await apiFetch("/api/pre-orders/my");
 *   if (res.ok) { const data = await res.json(); ... }
 *
 *   // JSON body
 *   await apiFetch("/api/returns", { method: "POST", body: JSON.stringify(payload) });
 *
 *   // FormData (multipart) — Content-Type is auto-set by the browser
 *   await apiFetch("/api/reviews/123", { method: "POST", body: formData });
 *
 * Contract
 * ────────
 * - Path: caller passes the full path including `/api/...`. If a bare
 *   path is passed without a leading slash, one is added. Relative paths
 *   are concatenated onto `VITE_API_BASE_URL`.
 * - Token: pulled from `useAuth().getToken()` (Clerk session token). The
 *   shared `getToken()` from `@/lib/getToken` is also registered on app
 *   boot — we fall back to it if `useAuth()` returns nothing (e.g.
 *   during the brief window before Clerk hydrates).
 * - Headers: `Authorization: Bearer <token>` is set automatically when a
 *   token is available. Caller-supplied headers always win (so callers
 *   can override `Content-Type` for multipart uploads).
 * - Credentials: NOT included by default (Bearer-token auth, no cookies).
 *   Pass `credentials: "include"` in the init to override.
 * - AbortSignal: pass `signal` in the init; the hook handles AbortError
 *   gracefully (returns a Response with `ok: false, status: 0`).
 */
export function useApiFetch() {
  const { getToken: getClerkToken } = useAuth();
  // useAuth() result identity can change on every Clerk re-render; we
  // only need the latest getter, so a ref avoids re-creating apiFetch.
  const getTokenRef = useRef(getClerkToken);
  getTokenRef.current = getClerkToken;

  return useCallback(async function apiFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const base = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
    // Normalize: caller passes "/api/foo" or "api/foo" — we want "/api/foo".
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = `${base}${normalizedPath}`;

    // Resolve the freshest token available. Prefer Clerk's getToken
    // (bound to the current session); fall back to the shared getter
    // (which Clerk sets up once on app boot via setTokenGetter).
    let token: string | null = null;
    try {
      token = (await getTokenRef.current?.()) ?? (await getSharedToken());
    } catch {
      token = null;
    }

    const authHeader: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    // Caller headers override our defaults (so they can set their own
    // Content-Type for multipart, add Accept headers, etc.).
    const headers: Record<string, string> = {
      ...authHeader,
      ...(init.headers as Record<string, string> | undefined),
    };

    try {
      return await fetch(url, { ...init, headers });
    } catch (err) {
      // fetch only throws on network failure or abort. Translate to a
      // synthetic Response so callers can uniformly check `res.ok`.
      if (err instanceof DOMException && err.name === "AbortError") {
        return new Response(null, { status: 0, statusText: "Aborted" });
      }
      return new Response(null, { status: 599, statusText: "Network Error" });
    }
  }, []);
}

/**
 * Convenience wrapper: like `useApiFetch` but parses the JSON body and
 * throws on non-2xx. Use this when you want the data and don't care
 * about inspecting the raw Response.
 *
 *   const apiJson = useApiJson();
 *   const orders = await apiJson<Order[]>("/api/orders");
 */
export function useApiJson() {
  const apiFetch = useApiFetch();
  return useCallback(async function apiJson<T = unknown>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const res = await apiFetch(path, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    }
    return (await res.json()) as T;
  }, [apiFetch]);
}
