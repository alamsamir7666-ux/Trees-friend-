/**
 * Knowledge Base admin API client.
 *
 * Thin wrapper around `useApiFetch` for the KB category endpoints in
 * routes/aiAdmin.ts. Each function takes the apiFetch callable (returned
 * by the `useApiFetch` hook) so the caller controls authentication +
 * base URL resolution. Errors are thrown with the server's `error`
 * message if present, so callers can display them directly.
 *
 * Type definitions mirror the backend's `KbCategory` / `KbCategoryNode`
 * interfaces (see artifacts/api-server/src/lib/kbCategories.ts).
 *
 * Usage:
 *   const apiFetch = useApiFetch();
 *   const categories = await fetchKbCategories(apiFetch);
 *   const created = await createKbCategory(apiFetch, { name, slug });
 */
import type { useApiFetch } from "@/lib/useApiFetch";

type ApiFetch = ReturnType<typeof useApiFetch>;

// ─── Types ───────────────────────────────────────────────────────────────────
// Mirror the backend interfaces in kbCategories.ts. Kept in sync manually
// (the frontend doesn't import from the api-server package — it's not a
// workspace dependency). If the backend types change, update these too.

export interface KbCategory {
  id: number;
  parentId: number | null;
  name: string;
  slug: string;
  description: string | null;
  path: string;
  depth: number;
  isActive: boolean;
  entryCount: number;
  createdAt: string; // ISO string (JSON-serialized Date)
  updatedAt: string;
}

export interface KbCategoryNode extends KbCategory {
  children: KbCategoryNode[];
}

export interface KbCategoryCreateInput {
  name: string;
  slug: string;
  description?: string | null;
  parentId?: number | null;
}

export interface KbCategoryUpdateInput {
  name?: string;
  slug?: string;
  description?: string | null;
  isActive?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parses a JSON error response. The backend returns `{ error: string }`
 * on all non-2xx responses — we extract that message, or fall back to the
 * HTTP status text if the body isn't JSON (e.g. a 502 from a proxy).
 */
async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // Body wasn't JSON — fall through to statusText.
  }
  return `HTTP ${res.status}: ${res.statusText || "Request failed"}`;
}

// ─── API functions ───────────────────────────────────────────────────────────

/**
 * Lists all KB categories (active + inactive), flat, ordered by path ASC.
 * Each row includes a denormalized `entryCount`.
 */
export async function fetchKbCategories(
  apiFetch: ApiFetch,
): Promise<KbCategory[]> {
  const res = await apiFetch("/api/ai/admin/kb/categories");
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { categories: KbCategory[]; count: number };
  return data.categories;
}

/**
 * Returns the nested category tree (root nodes with `children` arrays).
 * Children are sorted by name on the backend.
 */
export async function fetchKbCategoryTree(
  apiFetch: ApiFetch,
): Promise<KbCategoryNode[]> {
  const res = await apiFetch("/api/ai/admin/kb/categories/tree");
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { tree: KbCategoryNode[]; count: number };
  return data.tree;
}

/**
 * Fetches a single category by id.
 */
export async function fetchKbCategory(
  apiFetch: ApiFetch,
  id: number,
): Promise<KbCategory> {
  const res = await apiFetch(`/api/ai/admin/kb/categories/${id}`);
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { category: KbCategory };
  return data.category;
}

/**
 * Creates a new category. Throws on slug conflict, parent-not-found, or
 * validation error (the server returns 409 with a descriptive message).
 */
export async function createKbCategory(
  apiFetch: ApiFetch,
  input: KbCategoryCreateInput,
): Promise<KbCategory> {
  const res = await apiFetch("/api/ai/admin/kb/categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { category: KbCategory };
  return data.category;
}

/**
 * Updates a category. Pass only the fields you want to change. To clear
 * the description, pass `description: null`.
 */
export async function updateKbCategory(
  apiFetch: ApiFetch,
  id: number,
  input: KbCategoryUpdateInput,
): Promise<KbCategory> {
  const res = await apiFetch(`/api/ai/admin/kb/categories/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { category: KbCategory };
  return data.category;
}

/**
 * Moves a category to a new parent. Pass `parentId: null` to make it a
 * root. Throws on cycle (moving a category into its own descendant) or
 * if the new parent doesn't exist.
 */
export async function moveKbCategory(
  apiFetch: ApiFetch,
  id: number,
  parentId: number | null,
): Promise<void> {
  const res = await apiFetch(`/api/ai/admin/kb/categories/${id}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentId }),
  });
  if (!res.ok) throw new Error(await parseError(res));
}

/**
 * Deletes a category. Throws (with the server's error message) if the
 * category or any descendant has entries — the admin must move or delete
 * the entries first. On success, the delete cascades to descendants.
 */
export async function deleteKbCategory(
  apiFetch: ApiFetch,
  id: number,
): Promise<void> {
  const res = await apiFetch(`/api/ai/admin/kb/categories/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await parseError(res));
}

// ─── Slug helper ─────────────────────────────────────────────────────────────
/**
 * Auto-generates a slug from a name (lowercase, hyphens, no special chars).
 * Matches the backend's SLUG_REGEX (`/^[a-z0-9-]+$/`). Used by the modal
 * to pre-fill the slug field as the admin types the name.
 */
export function autoSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
