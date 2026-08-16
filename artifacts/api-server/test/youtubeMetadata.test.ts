/**
 * Unit tests for the `parseYoutubeMetadata` defensive parser.
 *
 * The parser itself lives in `artifacts/tree-friend/src/lib/kbApi.ts`
 * (frontend package). We can't import it directly from the api-server's
 * vitest because the frontend file imports `@/lib/useApiFetch` (a Vite
 * path alias that doesn't resolve under Node/vitest).
 *
 * Solution: re-implement the parser inline here as a test fixture. The
 * function is small (~10 lines, no dependencies) and stable. A comment
 * at the top of the source file points back here so any future edits
 * keep the two in sync.
 *
 * If you edit `parseYoutubeMetadata` in kbApi.ts, edit the local copy
 * below too.
 */
import { describe, expect, it } from "vitest";

interface YoutubeSourceMetadata {
  videoId: string;
  author: string;
  authorUrl: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  viewCount: number | null;
  detectedLanguage: string | null;
  fetchedVia: string;
  fetchedAt: string;
}

// ─── Local copy of parseYoutubeMetadata from kbApi.ts ───────────────────────
// Keep in sync with artifacts/tree-friend/src/lib/kbApi.ts:parseYoutubeMetadata.
function parseYoutubeMetadata(rawMetadata: string | null): YoutubeSourceMetadata | null {
  if (!rawMetadata) return null;
  try {
    const parsed = JSON.parse(rawMetadata) as Partial<YoutubeSourceMetadata>;
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

describe("parseYoutubeMetadata (defensive parser)", () => {
  it("returns null for null rawMetadata (manual/blog/facebook sources)", () => {
    expect(parseYoutubeMetadata(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseYoutubeMetadata("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseYoutubeMetadata("{not valid json")).toBeNull();
    expect(parseYoutubeMetadata("}invalid{")).toBeNull();
    expect(parseYoutubeMetadata("[1,2,3]")).toBeNull(); // valid JSON but wrong shape
  });

  it("returns null if parsed object is missing videoId", () => {
    // Defensive — guards against future schema drift where the metadata
    // shape changes but old cached sources still have the old shape.
    expect(parseYoutubeMetadata(JSON.stringify({ author: "some channel" }))).toBeNull();
    expect(parseYoutubeMetadata(JSON.stringify({ videoId: 123 }))).toBeNull(); // wrong type
    expect(parseYoutubeMetadata(JSON.stringify({ videoId: null }))).toBeNull();
  });

  it("parses a fully-populated YouTube metadata object", () => {
    const metadata: YoutubeSourceMetadata = {
      videoId: "QCvyyyb-XCQ",
      author: "Garden Tricks",
      authorUrl: "https://www.youtube.com/@GardenTricks",
      thumbnailUrl: "https://i.ytimg.com/vi/QCvyyyb-XCQ/hqdefault.jpg",
      durationSeconds: 612,
      viewCount: 1583421,
      detectedLanguage: "en",
      fetchedVia: "innertube-noauth",
      fetchedAt: "2026-08-16T10:30:00.000Z",
    };
    const result = parseYoutubeMetadata(JSON.stringify(metadata));
    expect(result).toEqual(metadata);
  });

  it("fills defaults for missing optional fields (manual-fallback path)", () => {
    // The manual-fallback path produces minimal metadata — only videoId +
    // author are guaranteed. detectedLanguage is null (no transcript was
    // fetched), durationSeconds and viewCount are null (oEmbed doesn't
    // return them). The parser should fill sensible defaults rather than
    // crash.
    const minimal: YoutubeSourceMetadata = {
      videoId: "QCvyyyb-XCQ",
      author: "Garden Tricks",
      authorUrl: null,
      thumbnailUrl: "https://i.ytimg.com/vi/QCvyyyb-XCQ/hqdefault.jpg",
      durationSeconds: null,
      viewCount: null,
      detectedLanguage: null,
      fetchedVia: "manual-fallback",
      fetchedAt: "2026-08-16T10:30:00.000Z",
    };
    const result = parseYoutubeMetadata(JSON.stringify(minimal));
    expect(result).toEqual(minimal);
  });

  it("fills defaults when fields are entirely absent (forward-compat)", () => {
    // If we add new required fields to YoutubeSourceMetadata in a future
    // version, old cached sources won't have them. The parser fills safe
    // defaults so the admin UI doesn't crash on old data.
    const sparse = {
      videoId: "QCvyyyb-XCQ",
      // everything else missing
    };
    const result = parseYoutubeMetadata(JSON.stringify(sparse));
    expect(result).not.toBeNull();
    expect(result?.videoId).toBe("QCvyyyb-XCQ");
    expect(result?.author).toBe("Unknown");
    expect(result?.authorUrl).toBeNull();
    expect(result?.thumbnailUrl).toBeNull();
    expect(result?.durationSeconds).toBeNull();
    expect(result?.viewCount).toBeNull();
    expect(result?.detectedLanguage).toBeNull();
    expect(result?.fetchedVia).toBe("unknown");
    expect(result?.fetchedAt).toBe(new Date(0).toISOString());
  });

  it("handles very long JSON strings (no truncation at parse time)", () => {
    // The backend caps rawMetadata JSON at 16KB before storing. The parser
    // should still handle the full string without issue.
    const longAuthor = "x".repeat(1000);
    const metadata: YoutubeSourceMetadata = {
      videoId: "QCvyyyb-XCQ",
      author: longAuthor,
      authorUrl: null,
      thumbnailUrl: null,
      durationSeconds: null,
      viewCount: null,
      detectedLanguage: null,
      fetchedVia: "innertube-noauth",
      fetchedAt: "2026-08-16T10:30:00.000Z",
    };
    const result = parseYoutubeMetadata(JSON.stringify(metadata));
    expect(result?.author).toBe(longAuthor);
    expect(result?.author.length).toBe(1000);
  });
});
