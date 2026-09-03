/**
 * Unit tests for the pure parsing logic in lib/youtubeInvidious.ts.
 *
 * These tests cover the parsing functions only (no network, no circuit
 * breaker, no I/O). The full `fetchViaInvidious()` function hits the
 * live Invidious API and can't be unit-tested deterministically (and
 * public instances are flaky — see the module header for details).
 *
 * The strategy mirrors the existing test patterns in this repo:
 *   - youtubeTranscript.test.ts — tests parseYoutubeUrl (pure logic)
 *   - transcriptFileParser.test.ts — tests VTT/SRT parsing (pure logic)
 *   - youtubeMetadata.test.ts — tests defensive metadata parser (pure)
 *
 * Tested functions:
 *   - pickBestCaption(captions, preferredLanguage)
 *   - resolveCaptionUrl(caption, instanceUrl)
 *   - extractLanguageCode(caption)
 *   - parseInvidiousMetadata(data, videoId)
 */
import { describe, expect, it } from "vitest";
import {
  pickBestCaption,
  resolveCaptionUrl,
  extractLanguageCode,
  parseInvidiousMetadata,
} from "../src/lib/youtubeInvidious";
import type { InvidiousThumbnail, InvidiousVideoResponse } from "../src/lib/youtubeInvidious";

// ─── pickBestCaption ───────────────────────────────────────────────────────

describe("pickBestCaption", () => {
  it("returns null when captions array is null", () => {
    expect(pickBestCaption(null, "en")).toBeNull();
  });

  it("returns null when captions array is undefined", () => {
    expect(pickBestCaption(undefined, "en")).toBeNull();
  });

  it("returns null when captions array is empty", () => {
    expect(pickBestCaption([], "en")).toBeNull();
  });

  it("returns the first caption when no preferred language is given", () => {
    const captions = [
      { label: "English", language_code: "en" },
      { label: "Bangla", language_code: "bn" },
    ];
    const result = pickBestCaption(captions, null);
    expect(result?.label).toBe("English");
  });

  it("matches exact language code (en === en)", () => {
    const captions = [
      { label: "Bangla", language_code: "bn" },
      { label: "English", language_code: "en" },
      { label: "Spanish", language_code: "es" },
    ];
    const result = pickBestCaption(captions, "en");
    expect(result?.language_code).toBe("en");
  });

  it("matches language prefix (en-US starts with en)", () => {
    const captions = [
      { label: "Bangla", language_code: "bn-IN" },
      { label: "English (US)", language_code: "en-US" },
    ];
    const result = pickBestCaption(captions, "en");
    expect(result?.language_code).toBe("en-US");
  });

  it("matches Bangla (bn === bn)", () => {
    const captions = [
      { label: "English", language_code: "en" },
      { label: "Bangla", language_code: "bn" },
    ];
    const result = pickBestCaption(captions, "bn");
    expect(result?.language_code).toBe("bn");
  });

  it("is case-insensitive on the preferred language (EN matches en)", () => {
    const captions = [
      { label: "Bangla", language_code: "bn" },
      { label: "English", language_code: "en" },
    ];
    const result = pickBestCaption(captions, "EN");
    expect(result?.language_code).toBe("en");
  });

  it("is case-insensitive on caption language codes (EN matches en)", () => {
    const captions = [{ label: "English", language_code: "EN" }];
    const result = pickBestCaption(captions, "en");
    expect(result?.language_code).toBe("EN");
  });

  it("prefers non-auto-generated captions over auto-generated when no language match", () => {
    const captions = [
      { label: "English (auto-generated)", language_code: "en" },
      { label: "Bangla", language_code: "bn" },
      { label: "Spanish (auto-generated)", language_code: "es" },
    ];
    // Preferred language "fr" doesn't match any — fall back to first non-auto.
    const result = pickBestCaption(captions, "fr");
    expect(result?.label).toBe("Bangla");
  });

  it("prefers language match over non-auto (language wins)", () => {
    const captions = [
      { label: "Bangla (auto-generated)", language_code: "bn" },
      { label: "English", language_code: "en" }, // non-auto but wrong language
    ];
    // Bangla matches preferred "bn" even though it's auto-generated.
    const result = pickBestCaption(captions, "bn");
    expect(result?.language_code).toBe("bn");
  });

  it("falls back to first caption when all are auto-generated and no language match", () => {
    const captions = [
      { label: "English (auto-generated)", language_code: "en" },
      { label: "Spanish (auto-generated)", language_code: "es" },
    ];
    const result = pickBestCaption(captions, "fr");
    expect(result?.label).toBe("English (auto-generated)");
  });

  it("handles camelCase languageCode field (newer API shape)", () => {
    const captions = [
      { label: "English", languageCode: "en" }, // camelCase, not snake_case
    ];
    const result = pickBestCaption(captions, "en");
    expect(result).not.toBeNull();
  });

  it("treats undefined captions entries gracefully", () => {
    // Defensive: array contains null/undefined entries. The function
    // should filter them out and pick the valid entry.
    const captions: (InvidiousCaption | null | undefined)[] = [
      undefined,
      { label: "English", language_code: "en" },
      null,
    ];
    const result = pickBestCaption(captions, "en");
    expect(result).not.toBeNull();
    expect(result?.language_code).toBe("en");
  });

  it("returns null when all captions entries are null/undefined", () => {
    const captions: (InvidiousCaption | null | undefined)[] = [null, undefined, null];
    expect(pickBestCaption(captions, "en")).toBeNull();
  });
});

// ─── resolveCaptionUrl ─────────────────────────────────────────────────────

describe("resolveCaptionUrl", () => {
  it("returns absolute URL as-is (url field)", () => {
    const caption = { url: "https://example.com/api/v1/captions/abc?label=en" };
    expect(resolveCaptionUrl(caption, "https://inv.example.com")).toBe(
      "https://example.com/api/v1/captions/abc?label=en",
    );
  });

  it("prepends instance URL for relative path (url field)", () => {
    const caption = { url: "/api/v1/captions/abc?label=en&format=vtt" };
    expect(resolveCaptionUrl(caption, "https://inv.example.com")).toBe(
      "https://inv.example.com/api/v1/captions/abc?label=en&format=vtt",
    );
  });

  it("falls back to vtt field (older API shape)", () => {
    const caption = { vtt: "https://example.com/captions.vtt" };
    expect(resolveCaptionUrl(caption, "https://inv.example.com")).toBe(
      "https://example.com/captions.vtt",
    );
  });

  it("falls back to srt field (older API shape)", () => {
    const caption = { srt: "https://example.com/captions.srt" };
    expect(resolveCaptionUrl(caption, "https://inv.example.com")).toBe(
      "https://example.com/captions.srt",
    );
  });

  it("prefers url over vtt over srt when multiple are present", () => {
    const caption = {
      url: "https://first.com/url",
      vtt: "https://second.com/vtt",
      srt: "https://third.com/srt",
    };
    expect(resolveCaptionUrl(caption, "https://inv.example.com")).toBe("https://first.com/url");
  });

  it("returns null when no URL field is present", () => {
    const caption = { label: "English", language_code: "en" };
    expect(resolveCaptionUrl(caption, "https://inv.example.com")).toBeNull();
  });

  it("returns null when caption is empty object", () => {
    expect(resolveCaptionUrl({}, "https://inv.example.com")).toBeNull();
  });

  it("handles relative path with vtt field", () => {
    const caption = { vtt: "/captions/abc.vtt" };
    expect(resolveCaptionUrl(caption, "https://inv.example.com")).toBe(
      "https://inv.example.com/captions/abc.vtt",
    );
  });

  it("strips nothing from absolute URLs with subpaths", () => {
    const caption = { url: "https://cdn.example.com/path/to/captions" };
    expect(resolveCaptionUrl(caption, "https://inv.example.com")).toBe(
      "https://cdn.example.com/path/to/captions",
    );
  });
});

// ─── extractLanguageCode ──────────────────────────────────────────────────

describe("extractLanguageCode", () => {
  it("extracts language_code (snake_case)", () => {
    expect(extractLanguageCode({ language_code: "en" })).toBe("en");
  });

  it("extracts languageCode (camelCase)", () => {
    expect(extractLanguageCode({ languageCode: "en" })).toBe("en");
  });

  it("prefers snake_case over camelCase (when both present)", () => {
    // Unlikely in practice, but tests the precedence in our code.
    expect(extractLanguageCode({ language_code: "en", languageCode: "bn" })).toBe("en");
  });

  it("normalizes en-US to en", () => {
    expect(extractLanguageCode({ language_code: "en-US" })).toBe("en");
  });

  it("normalizes bn-IN to bn", () => {
    expect(extractLanguageCode({ language_code: "bn-IN" })).toBe("bn");
  });

  it("normalizes to lowercase (EN-US → en)", () => {
    expect(extractLanguageCode({ language_code: "EN-US" })).toBe("en");
  });

  it("returns null when neither field is present", () => {
    expect(extractLanguageCode({ label: "English" })).toBeNull();
  });

  it("returns null when language_code is empty string", () => {
    expect(extractLanguageCode({ language_code: "" })).toBeNull();
  });

  it("returns null when language_code is not a string (number)", () => {
    // Defensive: bad input shape — TS would normally reject, but a runtime
    // JSON.parse could produce this. The function should handle it.
    const caption = { language_code: 123 as unknown as string };
    expect(extractLanguageCode(caption)).toBeNull();
  });

  it("returns null when caption is empty object", () => {
    expect(extractLanguageCode({})).toBeNull();
  });

  it("handles language_code with just a region (no hyphen)", () => {
    // Some instances return "enUS" without a hyphen — we don't split
    // this, just lowercase it. (Unlikely but defensive.)
    expect(extractLanguageCode({ language_code: "enUS" })).toBe("enus");
  });
});

// ─── parseInvidiousMetadata ────────────────────────────────────────────────

describe("parseInvidiousMetadata", () => {
  const videoId = "QCvyyyb-XCQ";

  it("returns null for null input", () => {
    expect(parseInvidiousMetadata(null as unknown as Record<string, unknown>, videoId)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(
      parseInvidiousMetadata(undefined as unknown as Record<string, unknown>, videoId),
    ).toBeNull();
  });

  it("parses a fully-populated response", () => {
    const data = {
      videoId,
      title: "Mango Tree Care Guide",
      author: "Garden Tricks",
      authorUrl: "https://inv.example.com/channel/UC123",
      authorThumbnails: [
        { url: "https://inv.example.com/thumb-low.jpg", width: 100 },
        { url: "https://inv.example.com/thumb-high.jpg", width: 800 },
      ],
      lengthSeconds: 612,
      viewCount: 1583421,
      descriptionText: "A complete guide to growing mango trees.",
      captions: [],
    };
    const result = parseInvidiousMetadata(data, videoId);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Mango Tree Care Guide");
    expect(result?.author).toBe("Garden Tricks");
    expect(result?.authorUrl).toBe("https://inv.example.com/channel/UC123");
    expect(result?.thumbnailUrl).toBe("https://inv.example.com/thumb-high.jpg"); // highest-res
    expect(result?.durationSeconds).toBe(612);
    expect(result?.viewCount).toBe(1583421);
    expect(result?.publishedAt).toBeNull(); // always null — see comment
    expect(result?.detectedLanguage).toBeNull(); // filled in by caller after pickBestCaption
  });

  it("picks the highest-resolution thumbnail (sorts by width descending)", () => {
    const data = {
      title: "Test",
      authorThumbnails: [
        { url: "https://inv.example.com/720.jpg", width: 720 },
        { url: "https://inv.example.com/1080.jpg", width: 1080 },
        { url: "https://inv.example.com/240.jpg", width: 240 },
      ],
    };
    const result = parseInvidiousMetadata(data, videoId);
    expect(result?.thumbnailUrl).toBe("https://inv.example.com/1080.jpg");
  });

  it("returns null thumbnailUrl when authorThumbnails is empty", () => {
    const data = { title: "Test", authorThumbnails: [] };
    const result = parseInvidiousMetadata(data, videoId);
    expect(result?.thumbnailUrl).toBeNull();
  });

  it("returns null thumbnailUrl when authorThumbnails is missing", () => {
    const data = { title: "Test" };
    const result = parseInvidiousMetadata(data, videoId);
    expect(result?.thumbnailUrl).toBeNull();
  });

  it("skips thumbnails with non-string url", () => {
    const data: Partial<InvidiousVideoResponse> = {
      title: "Test",
      authorThumbnails: [
        { url: 123 as unknown as string, width: 100 }, // bad
        { width: 200 } as InvidiousThumbnail, // missing url
        { url: "https://inv.example.com/good.jpg", width: 800 }, // good
      ],
    };
    const result = parseInvidiousMetadata(data, videoId);
    expect(result?.thumbnailUrl).toBe("https://inv.example.com/good.jpg");
  });

  it("handles missing title (defaults to empty string)", () => {
    const data = { author: "Some channel" };
    const result = parseInvidiousMetadata(data, videoId);
    expect(result?.title).toBe("");
  });

  it("handles empty-string title (defaults to empty string)", () => {
    const data = { title: "   " };
    const result = parseInvidiousMetadata(data, videoId);
    expect(result?.title).toBe("");
  });

  it("handles missing author (defaults to empty string)", () => {
    const data = { title: "Test" };
    const result = parseInvidiousMetadata(data, videoId);
    expect(result?.author).toBe("");
  });

  it("handles non-number lengthSeconds (defaults to null)", () => {
    const data: Partial<InvidiousVideoResponse> = {
      title: "Test",
      lengthSeconds: "612" as unknown as number, // string, not number
    };
    const result = parseInvidiousMetadata(data, videoId);
    expect(result?.durationSeconds).toBeNull();
  });

  it("handles non-number viewCount (defaults to null)", () => {
    const data: Partial<InvidiousVideoResponse> = {
      title: "Test",
      viewCount: "1.5M" as unknown as number, // string, not number
    };
    const result = parseInvidiousMetadata(data, videoId);
    expect(result?.viewCount).toBeNull();
  });

  it("handles missing authorUrl (defaults to null)", () => {
    const data = { title: "Test", author: "Some channel" };
    const result = parseInvidiousMetadata(data, videoId);
    expect(result?.authorUrl).toBeNull();
  });

  it("handles non-string authorUrl (defaults to null)", () => {
    const data: Partial<InvidiousVideoResponse> = {
      title: "Test",
      authorUrl: 123 as unknown as string,
    };
    const result = parseInvidiousMetadata(data, videoId);
    expect(result?.authorUrl).toBeNull();
  });

  it("always returns publishedAt: null (not provided by Invidious videos endpoint)", () => {
    const data = { title: "Test", published: "2025-01-01" }; // 'published' is not consumed
    const result = parseInvidiousMetadata(data, videoId);
    expect(result?.publishedAt).toBeNull();
  });

  it("always returns detectedLanguage: null (filled in by caller after pickBestCaption)", () => {
    const data = {
      title: "Test",
      captions: [{ language_code: "en" }],
    };
    const result = parseInvidiousMetadata(data, videoId);
    expect(result?.detectedLanguage).toBeNull();
  });

  it("handles response with only the required videoId field", () => {
    // Minimum viable response — everything else defaults.
    const data = { videoId };
    const result = parseInvidiousMetadata(data, videoId);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("");
    expect(result?.author).toBe("");
    expect(result?.authorUrl).toBeNull();
    expect(result?.thumbnailUrl).toBeNull();
    expect(result?.durationSeconds).toBeNull();
    expect(result?.viewCount).toBeNull();
    expect(result?.publishedAt).toBeNull();
    expect(result?.detectedLanguage).toBeNull();
  });

  it("handles empty object input", () => {
    const result = parseInvidiousMetadata({}, videoId);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("");
    expect(result?.author).toBe("");
  });

  it("ignores extra fields it doesn't recognize", () => {
    const data = {
      title: "Test",
      author: "Channel",
      someFutureField: "value",
      keywords: ["mango", "tree"],
      recommendedVideos: [],
    };
    const result = parseInvidiousMetadata(data, videoId);
    expect(result?.title).toBe("Test");
    expect(result?.author).toBe("Channel");
  });
});
