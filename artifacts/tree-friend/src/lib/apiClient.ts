import { getToken } from "@/lib/getToken";

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
