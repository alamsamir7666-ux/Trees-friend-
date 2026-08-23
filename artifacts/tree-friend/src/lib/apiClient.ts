import { getToken } from "@/lib/getToken";
import { getGuestToken, tryRefreshGuestToken } from "@/hooks/useGuestSession";

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

type RequestConfig = {
  method?: string;
  headers?: Record<string, string>;
  data?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
};

// Every backend route is mounted under /api (see artifacts/api-server/src/app.ts:
// `app.use("/api", router)`). Callers pass paths without the prefix (e.g.
// "/conversations"), and it's applied here exactly once. This is the single
// source of truth for the prefix, so no call site can accidentally omit it —
// that class of bug (an apiClient.* call silently 404ing because it forgot
// "/api") is why this normalization exists.
function withApiPrefix(url: string): string {
  return url.startsWith("/api/") || url === "/api" ? url : `/api${url.startsWith("/") ? url : `/${url}`}`;
}

/**
 * Guest 401 interceptor — when a request returns 401 and the buyer has a
 * guest session (not a Clerk session), this tries to refresh the guest
 * access token using the stored refresh token. If the refresh succeeds,
 * the original request is retried with the new access token.
 *
 * If the refresh fails (refresh token expired, 7 days elapsed), the guest
 * session is cleared and the 401 error is propagated — the caller (or
 * the TanStack Query error boundary) should show the OTP modal so the
 * buyer can re-verify their phone.
 *
 * This is NOT applied to:
 *   - Requests to /auth/guest-otp/* (these endpoints manage the token
 *     lifecycle themselves — refreshing a refresh would be circular)
 *   - Clerk-authenticated requests (those use Clerk's own session refresh,
 *     not this guest refresh)
 */
const GUEST_AUTH_PATHS = ["/auth/guest-otp/send", "/auth/guest-otp/verify", "/auth/guest-otp/refresh"];

function isGuestAuthPath(url: string): boolean {
  return GUEST_AUTH_PATHS.some((path) => url.includes(path));
}

async function request<T = unknown>(url: string, config: RequestConfig = {}): Promise<{ data: T }> {
  const { method = "GET", headers = {}, data, params } = config;

  let fullUrl = `${BASE_URL}${withApiPrefix(url)}`;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const qsStr = qs.toString();
    if (qsStr) fullUrl += `?${qsStr}`;
  }

  const token = await getToken();
  const authHeader: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const res = await fetch(fullUrl, {
    method,
    headers: { "Content-Type": "application/json", ...authHeader, ...headers },
    body: data != null ? JSON.stringify(data) : undefined,
  });

  // ── Guest 401 interceptor ──────────────────────────────────────────────
  //
  // If the request returned 401 AND the buyer has a guest session (not a
  // Clerk session) AND this isn't a guest-auth endpoint (avoid circular
  // refresh), try to refresh the guest access token and retry the request.
  //
  // This handles the "30-minute cliff" where a buyer shops for >30 min and
  // their access token expires. Without this interceptor, every API call
  // starts returning 401 with no recovery — the buyer sees a broken cart.
  // With this interceptor, the refresh happens silently and the buyer
  // sees no interruption.
  if (res.status === 401 && !isGuestAuthPath(url) && getGuestToken()) {
    // The buyer is a guest with an expired access token.
    // Try to refresh using the stored refresh token.
    const newToken = await tryRefreshGuestToken();
    if (newToken) {
      // Refresh succeeded — retry the original request with the new token.
      const retryRes = await fetch(fullUrl, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${newToken}`, ...headers },
        body: data != null ? JSON.stringify(data) : undefined,
      });

      if (!retryRes.ok) {
        const text = await retryRes.text().catch(() => "");
        throw new Error(`HTTP ${retryRes.status}: ${text}`);
      }

      const retryJson = await retryRes.json().catch(() => null);
      return { data: retryJson as T };
    }
    // Refresh failed (refresh token expired). The guest session has been
    // cleared by tryRefreshGuestToken. Fall through to the error below —
    // the caller should show the OTP modal.
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const json = await res.json().catch(() => null);
  return { data: json as T };
}

export const apiClient = {
  get: <T = unknown>(url: string, config?: Omit<RequestConfig, "method" | "data">) =>
    request<T>(url, { ...config, method: "GET" }),
  post: <T = unknown>(url: string, data?: unknown, config?: Omit<RequestConfig, "method" | "data">) =>
    request<T>(url, { ...config, method: "POST", data }),
  put: <T = unknown>(url: string, data?: unknown, config?: Omit<RequestConfig, "method" | "data">) =>
    request<T>(url, { ...config, method: "PUT", data }),
  patch: <T = unknown>(url: string, data?: unknown, config?: Omit<RequestConfig, "method" | "data">) =>
    request<T>(url, { ...config, method: "PATCH", data }),
  delete: <T = unknown>(url: string, config?: Omit<RequestConfig, "method" | "data">) =>
    request<T>(url, { ...config, method: "DELETE" }),
};
