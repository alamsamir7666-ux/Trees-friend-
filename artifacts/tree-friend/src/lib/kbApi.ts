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

// ═══════════════════════════════════════════════════════════════════════════
// ─── Phase 2: Creators, Sources, Entries ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// ─── Creator types ───────────────────────────────────────────────────────────

export interface KbCreator {
  id: number;
  name: string;
  slug: string;
  sourceType: "youtube" | "blog" | "facebook" | "manual";
  profileUrl: string | null;
  entryCount: number;
  toneProfile: string | null;
  toneProfileUpdatedAt: string | null;
  toneMatchPercentage: number | null;
  isFeatured: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KbCreatorCreateInput {
  name: string;
  slug: string;
  sourceType: string;
  profileUrl?: string | null;
}

export interface KbCreatorUpdateInput {
  name?: string;
  profileUrl?: string | null;
  isActive?: boolean;
  isFeatured?: boolean;
}

// ─── Source types ────────────────────────────────────────────────────────────

export interface KbSource {
  id: number;
  creatorId: number | null;
  sourceType: string;
  sourceUrl: string | null;
  sourceTitle: string;
  sourceLanguage: "en" | "bn" | "banglish";
  sourcePublishedAt: string | null;
  rawText: string;
  rawMetadata: string | null;
  processingStatus: "pending" | "chunking" | "embedding" | "ready" | "failed";
  chunkingMethod: "ai" | "manual" | null;
  chunkingModel: string | null;
  chunkedAt: string | null;
  chunkingError: string | null;
  entryCount: number;
  createdAt: string;
}

export interface KbEntry {
  id: number;
  sourceId: number;
  creatorId: number | null;
  categoryId: number | null;
  productId: number | null;
  title: string;
  content: string;
  contentSummary: string | null;
  keywords: string[];
  chunkIndex: number;
  chunkStartOffset: number | null;
  chunkEndOffset: number | null;
  priority: number;
  isActive: boolean;
  versionNumber: number;
  embeddingStatus: "pending" | "generated" | "failed";
  embeddingError: string | null;
  embeddingGeneratedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KbSourceWithEntries extends KbSource {
  entries: KbEntry[];
  creator: KbCreator | null;
}

export interface KbSourceCreateInput {
  creatorId?: number | null;
  sourceType: string;
  sourceUrl?: string | null;
  sourceTitle: string;
  sourceLanguage: string;
  sourcePublishedAt?: string | null;
  rawText: string;
}

export interface KbSourceUpdateInput {
  sourceTitle?: string;
  sourceUrl?: string | null;
  creatorId?: number | null;
  sourcePublishedAt?: string | null;
}

export interface KbSourceFilters {
  creatorId?: number;
  language?: string;
  processingStatus?: string;
  limit?: number;
  offset?: number;
}

export interface KbSourceListResult {
  sources: KbSource[];
  total: number;
}

// ─── Entry types ─────────────────────────────────────────────────────────────

export interface KbEntryCreateInput {
  sourceId: number;
  title: string;
  content: string;
  keywords?: string[];
  categoryId?: number | null;
  productId?: number | null;
  priority?: number;
  isActive?: boolean;
}

export interface KbEntryUpdateInput {
  title?: string;
  content?: string;
  keywords?: string[];
  categoryId?: number | null;
  productId?: number | null;
  priority?: number;
}

export interface KbEntryFilters {
  sourceId?: number;
  categoryId?: number;
  creatorId?: number;
  productId?: number;
  isActive?: boolean;
  embeddingStatus?: string;
  limit?: number;
  offset?: number;
}

export interface KbEntryListResult {
  entries: KbEntry[];
  total: number;
}

export interface KbChunkSuggestion {
  title: string;
  content: string;
  keywords: string[];
}

export interface KbChunkResult {
  chunks: KbChunkSuggestion[];
  model: string;
  count: number;
}

export interface KbBatchEntryInput {
  title: string;
  content: string;
  keywords?: string[];
  categoryId?: number | null;
  productId?: number | null;
  priority?: number;
  chunkIndex?: number;
}

// ─── Creator API functions ───────────────────────────────────────────────────

export async function fetchKbCreators(apiFetch: ApiFetch): Promise<KbCreator[]> {
  const res = await apiFetch("/api/ai/admin/kb/creators");
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { creators: KbCreator[]; count: number };
  return data.creators;
}

export async function createKbCreator(
  apiFetch: ApiFetch,
  input: KbCreatorCreateInput,
): Promise<KbCreator> {
  const res = await apiFetch("/api/ai/admin/kb/creators", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { creator: KbCreator };
  return data.creator;
}

export async function updateKbCreator(
  apiFetch: ApiFetch,
  id: number,
  input: KbCreatorUpdateInput,
): Promise<KbCreator> {
  const res = await apiFetch(`/api/ai/admin/kb/creators/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { creator: KbCreator };
  return data.creator;
}

export async function deleteKbCreator(apiFetch: ApiFetch, id: number): Promise<void> {
  const res = await apiFetch(`/api/ai/admin/kb/creators/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await parseError(res));
}

// ─── Source API functions ────────────────────────────────────────────────────

export async function fetchKbSources(
  apiFetch: ApiFetch,
  filters?: KbSourceFilters,
): Promise<KbSourceListResult> {
  const params = new URLSearchParams();
  if (filters?.creatorId !== undefined) params.set("creatorId", String(filters.creatorId));
  if (filters?.language) params.set("language", filters.language);
  if (filters?.processingStatus) params.set("processingStatus", filters.processingStatus);
  if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters?.offset !== undefined) params.set("offset", String(filters.offset));
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await apiFetch(`/api/ai/admin/kb/sources${qs}`);
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as KbSourceListResult;
}

export async function fetchKbSource(
  apiFetch: ApiFetch,
  id: number,
): Promise<KbSourceWithEntries> {
  const res = await apiFetch(`/api/ai/admin/kb/sources/${id}`);
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { source: KbSourceWithEntries };
  return data.source;
}

export async function createKbSource(
  apiFetch: ApiFetch,
  input: KbSourceCreateInput,
): Promise<KbSource> {
  const res = await apiFetch("/api/ai/admin/kb/sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { source: KbSource };
  return data.source;
}

export async function updateKbSource(
  apiFetch: ApiFetch,
  id: number,
  input: KbSourceUpdateInput,
): Promise<KbSource> {
  const res = await apiFetch(`/api/ai/admin/kb/sources/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { source: KbSource };
  return data.source;
}

export async function deleteKbSource(apiFetch: ApiFetch, id: number): Promise<void> {
  const res = await apiFetch(`/api/ai/admin/kb/sources/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await parseError(res));
}

export async function chunkSourceWithAI(
  apiFetch: ApiFetch,
  id: number,
): Promise<KbChunkResult> {
  const res = await apiFetch(`/api/ai/admin/kb/sources/${id}/chunk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as KbChunkResult;
}

export async function createKbEntriesBatch(
  apiFetch: ApiFetch,
  sourceId: number,
  entries: KbBatchEntryInput[],
  method: "ai" | "manual" = "manual",
): Promise<{ createdIds: number[]; count: number }> {
  const res = await apiFetch(`/api/ai/admin/kb/sources/${sourceId}/entries/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries, method }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as { createdIds: number[]; count: number };
}

// ─── Entry API functions ─────────────────────────────────────────────────────

export async function fetchKbEntries(
  apiFetch: ApiFetch,
  filters?: KbEntryFilters,
): Promise<KbEntryListResult> {
  const params = new URLSearchParams();
  if (filters?.sourceId !== undefined) params.set("sourceId", String(filters.sourceId));
  if (filters?.categoryId !== undefined) params.set("categoryId", String(filters.categoryId));
  if (filters?.creatorId !== undefined) params.set("creatorId", String(filters.creatorId));
  if (filters?.productId !== undefined) params.set("productId", String(filters.productId));
  if (filters?.isActive !== undefined) params.set("isActive", String(filters.isActive));
  if (filters?.embeddingStatus) params.set("embeddingStatus", filters.embeddingStatus);
  if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters?.offset !== undefined) params.set("offset", String(filters.offset));
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await apiFetch(`/api/ai/admin/kb/entries${qs}`);
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as KbEntryListResult;
}

export async function fetchKbEntry(apiFetch: ApiFetch, id: number): Promise<KbEntry> {
  const res = await apiFetch(`/api/ai/admin/kb/entries/${id}`);
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { entry: KbEntry };
  return data.entry;
}

export async function createKbEntry(
  apiFetch: ApiFetch,
  input: KbEntryCreateInput,
): Promise<KbEntry> {
  const res = await apiFetch("/api/ai/admin/kb/entries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { entry: KbEntry };
  return data.entry;
}

export async function updateKbEntry(
  apiFetch: ApiFetch,
  id: number,
  input: KbEntryUpdateInput,
): Promise<KbEntry> {
  const res = await apiFetch(`/api/ai/admin/kb/entries/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { entry: KbEntry };
  return data.entry;
}

export async function activateKbEntry(apiFetch: ApiFetch, id: number): Promise<void> {
  const res = await apiFetch(`/api/ai/admin/kb/entries/${id}/activate`, { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res));
}

export async function deactivateKbEntry(apiFetch: ApiFetch, id: number): Promise<void> {
  const res = await apiFetch(`/api/ai/admin/kb/entries/${id}/deactivate`, { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res));
}

export async function deleteKbEntry(apiFetch: ApiFetch, id: number): Promise<void> {
  const res = await apiFetch(`/api/ai/admin/kb/entries/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await parseError(res));
}
