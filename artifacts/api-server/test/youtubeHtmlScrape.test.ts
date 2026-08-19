/**
 * Unit tests for the Tier 2 HTML scrape helpers in lib/youtubeTranscript.ts:
 *   - `extractPlayerResponse`  (brace-counting JSON walker)
 *   - `pickCaptionTrack`       (caption-track priority logic)
 *
 * The full `fetchTranscriptViaHtmlScrape()` function hits live YouTube and
 * can't be unit-tested deterministically (it gets bot-challenged on CI).
 * These pure helpers ARE testable — we feed them fixture HTML / track lists
 * and verify the parsing + selection logic.
 *
 * Pattern mirrors the existing youtubeTranscript.test.ts and
 * youtubeCookieValidator.test.ts files.
 */
import { describe, expect, it } from "vitest";
import { extractPlayerResponse, pickCaptionTrack } from "../src/lib/youtubeTranscript";

// ─── extractPlayerResponse ───────────────────────────────────────────────────

describe("extractPlayerResponse", () => {
  it("returns null when the marker is absent", () => {
    expect(extractPlayerResponse("<html>no marker here</html>")).toBeNull();
  });

  it("returns null when the marker has no following `{`", () => {
    expect(extractPlayerResponse("var ytInitialPlayerResponse = ;")).toBeNull();
  });

  it("extracts a simple flat JSON object", () => {
    const html = `<script>var ytInitialPlayerResponse = {"status":"OK","videoId":"abc123"};</script>`;
    const result = extractPlayerResponse(html) as { status: string; videoId: string } | null;
    expect(result).toEqual({ status: "OK", videoId: "abc123" });
  });

  it("extracts a nested JSON object", () => {
    const html = `var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},"videoDetails":{"title":"Test Video","author":"Test Channel"}};`;
    const result = extractPlayerResponse(html) as {
      playabilityStatus: { status: string };
      videoDetails: { title: string; author: string };
    } | null;
    expect(result).toEqual({
      playabilityStatus: { status: "OK" },
      videoDetails: { title: "Test Video", author: "Test Channel" },
    });
  });

  it("handles braces inside string values (not as depth counters)", () => {
    // The value "}{" inside a string should NOT confuse the brace counter.
    const html = `var ytInitialPlayerResponse = {"weird":"}{","status":"OK"};`;
    const result = extractPlayerResponse(html) as { weird: string; status: string } | null;
    expect(result).toEqual({ weird: "}{", status: "OK" });
  });

  it("handles escaped quotes inside string values", () => {
    const html = `var ytInitialPlayerResponse = {"quote":"He said \\"hi\\"","status":"OK"};`;
    const result = extractPlayerResponse(html) as { quote: string; status: string } | null;
    expect(result).toEqual({ quote: 'He said "hi"', status: "OK" });
  });

  it("handles escaped backslashes inside string values", () => {
    // Path-like string with backslashes — shouldn't break the parser.
    const html = `var ytInitialPlayerResponse = {"path":"C:\\\\Users\\\\test","status":"OK"};`;
    const result = extractPlayerResponse(html) as { path: string; status: string } | null;
    expect(result?.status).toBe("OK");
    expect(result?.path).toBe("C:\\Users\\test");
  });

  it("extracts the FIRST ytInitialPlayerResponse occurrence", () => {
    // Real YouTube pages sometimes have multiple ytInitialPlayerResponse
    // markers (legacy + new layout). We want the first one.
    const html =
      `var ytInitialPlayerResponse = {"version":1};` +
      `var ytInitialPlayerResponse = {"version":2};`;
    const result = extractPlayerResponse(html) as { version: number } | null;
    expect(result?.version).toBe(1);
  });

  it("returns null when JSON is malformed (unclosed brace)", () => {
    const html = `var ytInitialPlayerResponse = {"status":"OK"`;
    expect(extractPlayerResponse(html)).toBeNull();
  });

  it("returns null when the walker runs off the end (truncated response)", () => {
    // HTML ends mid-JSON without the closing brace.
    const html = `var ytInitialPlayerResponse = {"a":{"b":"c"`;
    expect(extractPlayerResponse(html)).toBeNull();
  });

  // ─── Regex-based marker matching (avoids false positives) ──────────────

  it("does NOT match when the marker appears inside a string literal", () => {
    // The marker text "ytInitialPlayerResponse" appears inside a JS string
    // literal, but NOT as an assignment. The regex requires `= {` after the
    // marker, so this should return null.
    const html = `var someVar = "ytInitialPlayerResponse is great";`;
    expect(extractPlayerResponse(html)).toBeNull();
  });

  it("does NOT match when the marker is referenced but not assigned", () => {
    // E.g. `if (typeof ytInitialPlayerResponse !== 'undefined')` — no assignment.
    const html = `if (typeof ytInitialPlayerResponse !== 'undefined') { console.log('ok'); }`;
    expect(extractPlayerResponse(html)).toBeNull();
  });

  it("matches the window['ytInitialPlayerResponse'] = { form", () => {
    // YouTube sometimes uses bracket notation for the assignment.
    const html = `window["ytInitialPlayerResponse"] = {"status":"OK"};`;
    const result = extractPlayerResponse(html) as { status: string } | null;
    expect(result).toEqual({ status: "OK" });
  });

  it("matches the window.ytInitialPlayerResponse = { form", () => {
    // YouTube sometimes uses dot notation.
    const html = `window.ytInitialPlayerResponse = {"status":"OK"};`;
    const result = extractPlayerResponse(html) as { status: string } | null;
    expect(result).toEqual({ status: "OK" });
  });

  it("matches with extra whitespace around the equals sign", () => {
    const html = `var ytInitialPlayerResponse   =   {"status":"OK"};`;
    const result = extractPlayerResponse(html) as { status: string } | null;
    expect(result).toEqual({ status: "OK" });
  });

  it("matches with no whitespace around the equals sign", () => {
    const html = `var ytInitialPlayerResponse={"status":"OK"};`;
    const result = extractPlayerResponse(html) as { status: string } | null;
    expect(result).toEqual({ status: "OK" });
  });

  it("extracts from a realistic-shaped watch-page fragment", () => {
    // A trimmed-down version of what the real YouTube watch page returns.
    const html = `
<!DOCTYPE html>
<html>
<head><title>How to Water Mango Trees - YouTube</title></head>
<body>
<script>var ytInitialData = {"frameworkUpdates":{}};</script>
<script>var ytInitialPlayerResponse = {"responseContext":{"serviceTrackingParams":[]},"playabilityStatus":{"status":"OK","playableInEmbed":true},"videoDetails":{"videoId":"QCvyyyb-XCQ","title":"How to Water Mango Trees","lengthSeconds":"612","keywords":["mango","watering"],"channelId":"UC12345","isOwnerViewing":false,"shortDescription":"A guide.","viewCount":"1583421","author":"Garden Tricks","thumbnail":{"thumbnails":[{"url":"https://i.ytimg.com/vi/QCvyyyb-XCQ/default.jpg","width":120},{"url":"https://i.ytimg.com/vi/QCvyyyb-XCQ/hqdefault.jpg","width":480}]},"allowRatings":true,"viewCountRange":"0-10"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=QCvyyyb-XCQ&lang=en&fmt=json3","name":{"simpleText":"English"},"vssId":"a.en","languageCode":"en","kind":"asr","isTranslatable":true}],"defaultAudioTrackIndex":0}}};</script>
</body>
</html>`;
    const result = extractPlayerResponse(html) as {
      playabilityStatus: { status: string };
      videoDetails: { videoId: string; title: string; author: string };
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: { baseUrl: string; languageCode: string; kind: string }[];
        };
      };
    } | null;
    expect(result).not.toBeNull();
    expect(result?.playabilityStatus.status).toBe("OK");
    expect(result?.videoDetails.title).toBe("How to Water Mango Trees");
    expect(result?.videoDetails.author).toBe("Garden Tricks");
    expect(result?.captions.playerCaptionsTracklistRenderer.captionTracks).toHaveLength(1);
    expect(result?.captions.playerCaptionsTracklistRenderer.captionTracks[0].languageCode).toBe(
      "en",
    );
  });
});

// ─── pickCaptionTrack ────────────────────────────────────────────────────────

describe("pickCaptionTrack", () => {
  // Test fixture: tracks for a video with English + Bengali captions.
  const tracksEnBn = [
    { baseUrl: "https://example.com/timedtext?lang=en", languageCode: "en" },
    { baseUrl: "https://example.com/timedtext?lang=bn", languageCode: "bn" },
  ];

  it("returns null for an empty track list", () => {
    expect(pickCaptionTrack([], null)).toBeNull();
  });

  it("honors admin's explicit language choice when present", () => {
    const result = pickCaptionTrack(tracksEnBn, "bn");
    expect(result?.languageCode).toBe("bn");
  });

  it("falls back to English when admin's choice is not available", () => {
    // Admin wants French, but the video only has English + Bengali.
    const result = pickCaptionTrack(tracksEnBn, "fr");
    expect(result?.languageCode).toBe("en");
  });

  it("falls back to English when adminLanguage is null", () => {
    const result = pickCaptionTrack(tracksEnBn, null);
    expect(result?.languageCode).toBe("en");
  });

  it("falls back to English when adminLanguage is empty string", () => {
    const result = pickCaptionTrack(tracksEnBn, "");
    expect(result?.languageCode).toBe("en");
  });

  it("returns first track when no English track is available", () => {
    const tracks = [
      { baseUrl: "https://example.com/timedtext?lang=bn", languageCode: "bn" },
      { baseUrl: "https://example.com/timedtext?lang=hi", languageCode: "hi" },
    ];
    const result = pickCaptionTrack(tracks, null);
    expect(result?.languageCode).toBe("bn");
  });

  it("matches language code with region suffix (en-US → en)", () => {
    const tracks = [
      { baseUrl: "https://example.com/timedtext?lang=en-US", languageCode: "en-US" },
      { baseUrl: "https://example.com/timedtext?lang=bn", languageCode: "bn" },
    ];
    const result = pickCaptionTrack(tracks, "en");
    expect(result?.languageCode).toBe("en-US");
  });

  it("matches language code with region suffix (bn-IN → bn)", () => {
    const tracks = [
      { baseUrl: "https://example.com/timedtext?lang=en", languageCode: "en" },
      { baseUrl: "https://example.com/timedtext?lang=bn-IN", languageCode: "bn-IN" },
    ];
    const result = pickCaptionTrack(tracks, "bn");
    expect(result?.languageCode).toBe("bn-IN");
  });

  it("is case-insensitive on the admin's language choice", () => {
    // Admin passes "BN" (uppercase) — should still match "bn" track.
    const result = pickCaptionTrack(tracksEnBn, "BN");
    expect(result?.languageCode).toBe("bn");
  });

  it("is case-insensitive on track language codes", () => {
    const tracks = [{ baseUrl: "https://example.com/timedtext?lang=EN", languageCode: "EN" }];
    const result = pickCaptionTrack(tracks, "en");
    expect(result?.languageCode).toBe("EN");
  });

  it("returns the first track when admin language is null and no English is present", () => {
    // Edge case: video with only exotic languages, no English fallback.
    const tracks = [
      { baseUrl: "https://example.com/timedtext?lang=ja", languageCode: "ja" },
      { baseUrl: "https://example.com/timedtext?lang=ko", languageCode: "ko" },
    ];
    const result = pickCaptionTrack(tracks, null);
    expect(result?.languageCode).toBe("ja"); // YouTube usually sorts by relevance
  });

  // ─── ASR preference tests (industry-standard: prefer human captions) ───

  it("prefers non-ASR (human-authored) tracks within the same language", () => {
    // Both tracks are English: one ASR (auto-generated), one human-authored.
    // Should pick the human-authored one (higher quality).
    const tracks = [
      {
        baseUrl: "https://example.com/timedtext?lang=en&kind=asr",
        languageCode: "en",
        kind: "asr",
      },
      { baseUrl: "https://example.com/timedtext?lang=en", languageCode: "en" },
    ];
    const result = pickCaptionTrack(tracks, "en");
    expect(result?.kind).toBeUndefined(); // the non-ASR track
  });

  it("falls back to ASR track if no human-authored track is available", () => {
    // Only ASR track available — should still return it.
    const tracks = [
      {
        baseUrl: "https://example.com/timedtext?lang=en&kind=asr",
        languageCode: "en",
        kind: "asr",
      },
    ];
    const result = pickCaptionTrack(tracks, "en");
    expect(result?.kind).toBe("asr");
  });

  it("prefers non-ASR for admin's chosen language even when English ASR exists first", () => {
    // Admin wants Bengali. Both Bengali (human) and English (ASR) tracks exist.
    // Should pick the Bengali human track (admin's explicit language takes priority,
    // and within Bengali, non-ASR is preferred).
    const tracks = [
      {
        baseUrl: "https://example.com/timedtext?lang=en&kind=asr",
        languageCode: "en",
        kind: "asr",
      },
      { baseUrl: "https://example.com/timedtext?lang=bn", languageCode: "bn" },
    ];
    const result = pickCaptionTrack(tracks, "bn");
    expect(result?.languageCode).toBe("bn");
    expect(result?.kind).toBeUndefined();
  });

  it("prefers non-ASR in the no-English-fallback path too", () => {
    // No admin language, no English. Two Japanese tracks: ASR + human.
    // Should prefer the human-authored one.
    const tracks = [
      {
        baseUrl: "https://example.com/timedtext?lang=ja&kind=asr",
        languageCode: "ja",
        kind: "asr",
      },
      { baseUrl: "https://example.com/timedtext?lang=ja", languageCode: "ja" },
    ];
    const result = pickCaptionTrack(tracks, null);
    expect(result?.languageCode).toBe("ja");
    expect(result?.kind).toBeUndefined();
  });
});
