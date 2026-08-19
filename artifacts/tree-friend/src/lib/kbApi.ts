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
export async function fetchKbCategories(apiFetch: ApiFetch): Promise<KbCategory[]> {
  const res = await apiFetch("/api/ai/admin/kb/categories");
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { categories: KbCategory[]; count: number };
  return data.categories;
}

/**
 * Returns the nested category tree (root nodes with `children` arrays).
 * Children are sorted by name on the backend.
 */
export async function fetchKbCategoryTree(apiFetch: ApiFetch): Promise<KbCategoryNode[]> {
  const res = await apiFetch("/api/ai/admin/kb/categories/tree");
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { tree: KbCategoryNode[]; count: number };
  return data.tree;
}

/**
 * Fetches a single category by id.
 */
export async function fetchKbCategory(apiFetch: ApiFetch, id: number): Promise<KbCategory> {
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
export async function deleteKbCategory(apiFetch: ApiFetch, id: number): Promise<void> {
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

/**
 * Structured YouTube metadata stored in `KbSource.rawMetadata` (JSON string).
 *
 * The backend (`POST /ai/admin/kb/sources/youtube`) populates this when
 * auto-fetching a YouTube video. Use `parseYoutubeMetadata(source.rawMetadata)`
 * to safely extract it — returns null for non-YouTube sources or if the
 * JSON is malformed (defensive parse).
 */
export interface YoutubeSourceMetadata {
  videoId: string;
  author: string;
  authorUrl: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  viewCount: number | null;
  detectedLanguage: string | null;
  /** How the transcript was obtained: innertube-noauth | innertube-cookie | manual-fallback */
  fetchedVia: string;
  /** ISO timestamp of when the transcript was fetched. */
  fetchedAt: string;
}

/**
 * Safely parses the `rawMetadata` JSON string on a KB source into a typed
 * `YoutubeSourceMetadata` object. Returns null if:
 *   - `rawMetadata` is null (manual/blog/facebook sources have no metadata)
 *   - The JSON is malformed
 *   - The parsed object doesn't have the expected `videoId` field
 *     (defensive — guards against future schema drift)
 *
 * Use this in the admin UI to render the YouTube thumbnail + channel link
 * without re-fetching from YouTube.
 */
export function parseYoutubeMetadata(rawMetadata: string | null): YoutubeSourceMetadata | null {
  if (!rawMetadata) return null;
  try {
    const parsed = JSON.parse(rawMetadata) as Partial<YoutubeSourceMetadata>;
    // Defensive: require at least `videoId` to consider it valid YouTube
    // metadata. Other fields may be null (e.g. on manual-fallback path,
    // detectedLanguage is null because no transcript was fetched).
    if (!parsed || typeof parsed.videoId !== "string") return null;
    return {
      videoId: parsed.videoId,
      author: parsed.author ?? "Unknown",
      authorUrl: parsed.authorUrl ?? null,
      thumbnailUrl: parsed.thumbnailUrl ?? null,
      durationSeconds: parsed.durationSeconds ?? null,
      viewCount: parsed.viewCount ?? null,
      detectedLanguage: parsed.detectedLanguage ?? null,
      fetchedVia: parsed.fetchedVia ?? "unknown",
      fetchedAt: parsed.fetchedAt ?? new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
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
  /**
   * Optional raw text update. The backend rejects this with 409 if the
   * source already has entries (changing rawText would invalidate the
   * derived chunks). The edit modal disables the rawText field when
   * entryCount > 0 so the admin never hits this error in normal use.
   *
   * When rawText IS updated, the backend also resets chunking metadata
   * (processing_status → 'pending', chunking_method/model/chunked_at →
   * NULL) so the admin can re-chunk from the new text.
   */
  rawText?: string;
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

export async function fetchKbSource(apiFetch: ApiFetch, id: number): Promise<KbSourceWithEntries> {
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

export async function chunkSourceWithAI(apiFetch: ApiFetch, id: number): Promise<KbChunkResult> {
  const res = await apiFetch(`/api/ai/admin/kb/sources/${id}/chunk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as KbChunkResult;
}

// ─── YouTube auto-fetch ────────────────────────────────────────────────────

export interface YoutubeSourceCreateInput {
  url: string;
  creatorId?: number | null;
  sourceLanguage?: "en" | "bn" | "banglish";
}

/**
 * Result of POST /api/ai/admin/kb/sources/youtube.
 *
 * The route always returns 201 with a created source — even when the
 * auto-fetch failed (bot protection). In that case `manualFallback` is
 * populated and `transcript` is null. The admin then needs to edit the
 * source and paste the transcript manually.
 */
export interface YoutubeSourceCreateResult {
  source: KbSource;
  /** Present only when the transcript was auto-fetched successfully. */
  transcript?: {
    /**
     * Which tier produced the transcript.
     *   - `innertube-noauth`  — Tier 1: youtubei.js InnerTube API, no cookie
     *   - `html-scrape`       — Tier 2: direct HTML scrape of /watch + timedtext
     *   - `innertube-cookie`  — Tier 3: youtubei.js InnerTube API, with cookie
     *   - `manual-fallback`   — Tier 4: metadata only, transcript empty
     */
    fetchedVia: "innertube-noauth" | "html-scrape" | "innertube-cookie" | "manual-fallback";
    segmentCount: number;
    detectedLanguage: string | null;
  };
  /** Present only when the admin needs to paste the transcript manually. */
  manualFallback?: {
    reason: string;
    transcriptUrl: string;
    videoId: string;
    thumbnailUrl: string | null;
  };
}

/**
 * Creates a KB source from a YouTube URL by auto-fetching the transcript +
 * metadata server-side. Uses youtubei.js (InnerTube API) with a YOUTUBE_SESSION_COOKIE
 * fallback for datacenter IPs that get bot-challenged.
 *
 * On bot-challenge (no cookie or cookie also failed), the route still
 * creates a source row with metadata only — `manualFallback` is populated
 * and the admin needs to edit the source to paste the transcript manually.
 */
export async function createKbSourceFromYoutube(
  apiFetch: ApiFetch,
  input: YoutubeSourceCreateInput,
): Promise<YoutubeSourceCreateResult> {
  const res = await apiFetch("/api/ai/admin/kb/sources/youtube", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as YoutubeSourceCreateResult;
}

// ─── Upload .vtt/.srt file ──────────────────────────────────────────────────

/**
 * Input for the transcript-file upload route.
 *
 * The admin downloads a .vtt or .srt file from YouTube (via "Show transcript
 * → 3-dot menu → Toggle timestamps → copy/paste", OR using a browser
 * extension that exports captions), then uploads it. The server parses the
 * structured format into plain text + creates a source row.
 *
 * `url` is optional but recommended — when provided, the server:
 *   1. Dedups against existing sources (URL UNIQUE index)
 *   2. Auto-fetches metadata via oEmbed (title, author, thumbnail) — no
 *      auth, no bot detection, works from any IP
 *
 * If `url` is omitted, the filename is used as the title and "Unknown" as
 * the author. The source still works fine for chunking + embedding.
 */
export interface TranscriptFileCreateInput {
  /** Optional YouTube URL — for metadata enrichment + dedup. */
  url?: string;
  /** Original filename — used for format detection (.vtt vs .srt). */
  filename: string;
  /** The file's text contents (read via FileReader.readAsText in the UI). */
  fileContent: string;
  /** Optional creator ID. */
  creatorId?: number | null;
  /** Source language (defaults to "en"). */
  sourceLanguage?: "en" | "bn" | "banglish";
}

/**
 * Result of POST /api/ai/admin/kb/sources/transcript-file.
 *
 * Always returns a source + transcript info (the route either succeeds with
 * 201, or fails with 4xx — there's no "manual fallback" path because the
 * admin has already provided the transcript file directly).
 */
export interface TranscriptFileCreateResult {
  source: KbSource;
  transcript: {
    /** Detected format ("vtt" or "srt"). */
    format: "vtt" | "srt";
    /** Number of cue blocks that contributed text. */
    segmentCount: number;
  };
}

/**
 * Creates a KB source from an uploaded .vtt or .srt transcript file.
 *
 * This is the "third mode" of KB ingestion — used when the YouTube
 * auto-fetcher fails (bot protection, age-restricted video, etc.). The
 * admin downloads the transcript file manually and uploads it here.
 *
 * The server parses the structured format into plain text, then creates a
 * `source_type = "youtube"` source row (so YouTube attribution is preserved
 * if a URL was provided). The rest of the pipeline (chunk → embed →
 * activate) is unchanged.
 */
export async function createKbSourceFromTranscriptFile(
  apiFetch: ApiFetch,
  input: TranscriptFileCreateInput,
): Promise<TranscriptFileCreateResult> {
  const res = await apiFetch("/api/ai/admin/kb/sources/transcript-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as TranscriptFileCreateResult;
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

// ═══════════════════════════════════════════════════════════════════════════
// ─── Phase 3: KB Insights + Search Tester ──────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// ─── Insights types ───────────────────────────────────────────────────────────

export interface KbInsights {
  totalEntries: number;
  activeEntries: number;
  entriesWithEmbeddings: number;
  entriesByCategory: { categoryName: string; count: number }[];
  entriesByCreator: { creatorName: string; count: number }[];
  hitRate: {
    totalAssistantMessages: number;
    kbHits: number;
    toolCalls: number;
    contextInjected: number;
    hitRatePercent: number; // e.g. 42.5
  };
}

// ─── Search tester types ─────────────────────────────────────────────────────

export interface KbSearchTestResult {
  id: number;
  title: string;
  content: string;
  score: number;
  breakdown: {
    semantic: number;
    keyword: number;
    authority: number;
    priority: number;
    recency: number;
  };
  creator: string | null;
  category: string | null;
  source: string | null;
  sourceType: string | null;
  keywords: string[];
}

export interface KbSearchTestResponse {
  query: string;
  results: KbSearchTestResult[];
  count: number;
}

// ─── API functions ────────────────────────────────────────────────────────────

export async function fetchKbInsights(apiFetch: ApiFetch): Promise<KbInsights> {
  const res = await apiFetch("/api/ai/admin/kb/insights");
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as KbInsights;
}

export async function testKbSearch(
  apiFetch: ApiFetch,
  query: string,
  filters?: {
    categoryId?: number;
    productSlug?: string;
    maxResults?: number;
  },
): Promise<KbSearchTestResponse> {
  const res = await apiFetch("/api/ai/admin/kb/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      categoryId: filters?.categoryId,
      productSlug: filters?.productSlug,
      maxResults: filters?.maxResults,
    }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as KbSearchTestResponse;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── Phase 4: Tone Profile Management ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// ─── Tone profile types ───────────────────────────────────────────────────────

export interface ToneProfile {
  adjectives: string[];
  sentenceStyle: string;
  vocabularyLevel: string;
  greetingStyle: string;
  examplePhrases: string[];
  toneSummary: string;
}

export interface KbToneProfileResponse {
  creatorId: number;
  creatorName: string;
  entryCount: number;
  hasProfile: boolean;
  profile: ToneProfile | null;
  toneMatchPercentage: number;
  threshold: number;
  needsRegeneration: boolean;
  regenerationReason: string;
  lastGeneratedAt: string | null;
  lastGeneratedEntryCount: number | null;
  lastGeneratedModel: string | null;
}

export interface KbToneProfileStatus {
  id: number;
  name: string;
  slug: string;
  entryCount: number;
  isActive: boolean;
  hasProfile: boolean;
  toneMatchEligible: boolean;
  toneMatchPercentage: number | null;
  effectivePercentage: number;
  lastGeneratedAt: string | null;
  lastGeneratedEntryCount: number | null;
  lastGeneratedModel: string | null;
  needsRegeneration: boolean;
}

export interface KbToneProfilesStatusResponse {
  threshold: number;
  defaultPercentage: number;
  regenerationDelta: number;
  creators: KbToneProfileStatus[];
}

// ─── Tone API functions ───────────────────────────────────────────────────────

export async function fetchToneProfile(
  apiFetch: ApiFetch,
  creatorId: number,
): Promise<KbToneProfileResponse> {
  const res = await apiFetch(`/api/ai/admin/kb/creators/${creatorId}/tone-profile`);
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as KbToneProfileResponse;
}

export async function generateToneProfile(
  apiFetch: ApiFetch,
  creatorId: number,
): Promise<{ ok: boolean; message?: string }> {
  const res = await apiFetch(`/api/ai/admin/kb/creators/${creatorId}/tone-profile/generate`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as { ok: boolean; message?: string };
}

export async function setToneMatchPercentage(
  apiFetch: ApiFetch,
  creatorId: number,
  percentage: number | null,
): Promise<{ ok: boolean; toneMatchPercentage: number | null; effectivePercentage: number }> {
  const res = await apiFetch(`/api/ai/admin/kb/creators/${creatorId}/tone-percentage`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ percentage }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as {
    ok: boolean;
    toneMatchPercentage: number | null;
    effectivePercentage: number;
  };
}

export async function fetchToneProfileStatus(
  apiFetch: ApiFetch,
): Promise<KbToneProfilesStatusResponse> {
  const res = await apiFetch("/api/ai/admin/kb/tone-profiles/status");
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as KbToneProfilesStatusResponse;
}
