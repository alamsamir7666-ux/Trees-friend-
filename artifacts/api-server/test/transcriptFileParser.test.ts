/**
 * Unit tests for lib/transcriptFileParser.ts.
 *
 * Tests the .vtt + .srt parsing logic with realistic fixture files (BOM,
 * CRLF line endings, cue tags, NOTE blocks, multi-line cues, etc.).
 */
import { describe, expect, it } from "vitest";
import { parseTranscriptFile, detectFormat } from "../src/lib/transcriptFileParser";

// ─── detectFormat ────────────────────────────────────────────────────────────

describe("detectFormat", () => {
  it("detects .vtt from filename extension", () => {
    expect(detectFormat("video.vtt", "")).toBe("vtt");
  });

  it("detects .srt from filename extension", () => {
    expect(detectFormat("video.srt", "")).toBe("srt");
  });

  it("is case-insensitive on filename extension", () => {
    expect(detectFormat("VIDEO.VTT", "")).toBe("vtt");
    expect(detectFormat("VIDEO.SRT", "")).toBe("srt");
  });

  it("falls back to content sniffing (WEBVTT header → vtt)", () => {
    expect(detectFormat("video.txt", "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello")).toBe("vtt");
  });

  it("falls back to content sniffing (no WEBVTT header → srt)", () => {
    expect(detectFormat("video.txt", "1\n00:00:01,000 --> 00:00:03,000\nHello")).toBe("srt");
  });

  it("defaults to srt when no extension and no WEBVTT header", () => {
    expect(detectFormat("video", "1\n00:00:01,000 --> 00:00:03,000\nHello")).toBe("srt");
  });

  it("handles BOM-prefixed content", () => {
    expect(detectFormat("video.txt", "\uFEFFWEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello")).toBe(
      "vtt",
    );
  });

  it("handles filename with path components", () => {
    expect(detectFormat("/tmp/uploads/Mango Care.vtt", "")).toBe("vtt");
  });
});

// ─── parseTranscriptFile: VTT format ─────────────────────────────────────────

describe("parseTranscriptFile: VTT", () => {
  const SAMPLE_VTT = `WEBVTT

NOTE This is a comment block.
It should be skipped entirely.

00:00:01.000 --> 00:00:03.000
Welcome to the mango care guide.

00:00:03.500 --> 00:00:06.000
Today we'll talk about <i>watering</i> mango trees.

00:00:06.500 --> 00:00:09.000
<c.colorE5E5E5>In summer</c>, water deeply once a week.

00:00:09.500 --> 00:00:12.000
Thank you for watching!
`;

  it("parses a standard .vtt file", () => {
    const result = parseTranscriptFile("test.vtt", SAMPLE_VTT);
    expect(result.format).toBe("vtt");
    expect(result.segmentCount).toBe(4);
    expect(result.transcript).toContain("Welcome to the mango care guide.");
    expect(result.transcript).toContain("watering"); // <i> tag stripped
    expect(result.transcript).toContain("In summer"); // <c> tag stripped
    expect(result.transcript).not.toContain("<i>");
    expect(result.transcript).not.toContain("<c.");
    expect(result.transcript).not.toContain("NOTE");
    expect(result.transcript).not.toContain("-->");
  });

  it("joins cues with single spaces (collapses whitespace)", () => {
    const result = parseTranscriptFile("test.vtt", SAMPLE_VTT);
    // No double spaces, no newlines in the output.
    expect(result.transcript).not.toMatch(/\s{2,}/);
    expect(result.transcript).not.toMatch(/\n/);
  });

  it("handles multi-line cues", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
Line one.
Line two.
`;
    const result = parseTranscriptFile("test.vtt", vtt);
    expect(result.segmentCount).toBe(2); // 2 lines = 2 segments
    expect(result.transcript).toBe("Line one. Line two.");
  });

  it("skips STYLE blocks", () => {
    const vtt = `WEBVTT

STYLE
::cue(c.colorE5E5E5) { color: rgb(229, 229, 229); }

00:00:01.000 --> 00:00:03.000
Hello world.
`;
    const result = parseTranscriptFile("test.vtt", vtt);
    expect(result.segmentCount).toBe(1);
    expect(result.transcript).toBe("Hello world.");
    expect(result.transcript).not.toContain("STYLE");
    expect(result.transcript).not.toContain("::cue");
  });

  it("skips REGION blocks", () => {
    const vtt = `WEBVTT

REGION
id:bottom width:40% lines:3 viewportanchor:100%,100% anchor:bottom

00:00:01.000 --> 00:00:03.000
Hello region.
`;
    const result = parseTranscriptFile("test.vtt", vtt);
    expect(result.segmentCount).toBe(1);
    expect(result.transcript).toBe("Hello region.");
    expect(result.transcript).not.toContain("REGION");
  });

  it("handles BOM-prefixed files", () => {
    const vttWithBom = "\uFEFF" + SAMPLE_VTT;
    const result = parseTranscriptFile("test.vtt", vttWithBom);
    expect(result.segmentCount).toBe(4);
    expect(result.transcript).toContain("Welcome");
  });

  it("handles CRLF line endings", () => {
    const vttCrlf = SAMPLE_VTT.replace(/\n/g, "\r\n");
    const result = parseTranscriptFile("test.vtt", vttCrlf);
    expect(result.segmentCount).toBe(4);
    expect(result.transcript).toContain("Welcome");
  });

  it("handles CR-only line endings (old Mac style)", () => {
    const vttCr = SAMPLE_VTT.replace(/\n/g, "\r");
    const result = parseTranscriptFile("test.vtt", vttCr);
    expect(result.segmentCount).toBe(4);
    expect(result.transcript).toContain("Welcome");
  });

  it("handles cues with explicit cue identifiers", () => {
    const vtt = `WEBVTT

intro
00:00:01.000 --> 00:00:03.000
Welcome.

main
00:00:03.500 --> 00:00:06.000
Now the main content.
`;
    const result = parseTranscriptFile("test.vtt", vtt);
    expect(result.segmentCount).toBe(2);
    expect(result.transcript).toBe("Welcome. Now the main content.");
  });

  it("handles timestamp tags inside text", () => {
    // <00:00:01.000>word — used for karaoke-style captions
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
<00:00:01.000>Hello <00:00:01.500>world
`;
    const result = parseTranscriptFile("test.vtt", vtt);
    expect(result.transcript).toBe("Hello world");
  });

  it("handles <v> voice tags", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
<v Bob>Hello, I'm Bob</v>
<v Alice>Hi Bob!</v>
`;
    const result = parseTranscriptFile("test.vtt", vtt);
    expect(result.transcript).toBe("Hello, I'm Bob Hi Bob!");
  });

  it("returns empty transcript for VTT with no cues", () => {
    const vtt = `WEBVTT

NOTE Just a comment, no actual cues.
`;
    const result = parseTranscriptFile("test.vtt", vtt);
    expect(result.transcript).toBe("");
    expect(result.segmentCount).toBe(0);
  });

  it("returns empty transcript for empty content", () => {
    const result = parseTranscriptFile("test.vtt", "");
    expect(result.transcript).toBe("");
    expect(result.segmentCount).toBe(0);
  });

  it("returns empty transcript for WEBVTT-only file", () => {
    const result = parseTranscriptFile("test.vtt", "WEBVTT\n");
    expect(result.transcript).toBe("");
    expect(result.segmentCount).toBe(0);
  });

  it("strips <b>, <u>, <lang> tags too", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
<b>Bold</b> <u>underline</u> <lang en>English</lang>
`;
    const result = parseTranscriptFile("test.vtt", vtt);
    expect(result.transcript).toBe("Bold underline English");
  });

  // ─── Specific cue tag stripping (doesn't mangle literal < or >) ────────

  it("preserves literal < and > characters in caption text", () => {
    // Caption text contains a comparison operator — should NOT be stripped.
    // The old regex `/<[^>]+>/g` would have mangled this; the new specific
    // regex only matches recognized VTT cue tags.
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
If x is less than 5, use 3 < 5 comparison.
`;
    const result = parseTranscriptFile("test.vtt", vtt);
    expect(result.transcript).toContain("3 < 5");
  });

  it("preserves 'price > $10' style text", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
Items with price > $10 are premium.
`;
    const result = parseTranscriptFile("test.vtt", vtt);
    expect(result.transcript).toContain("price > $10");
  });

  it("strips <c.class.name> tags (class with dots)", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
<c.colorE5E5E5.large>Hello</c> world
`;
    const result = parseTranscriptFile("test.vtt", vtt);
    expect(result.transcript).toBe("Hello world");
  });

  it("strips <v Speaker Name> voice tags", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
<v John Doe>Hello everyone</v>
`;
    const result = parseTranscriptFile("test.vtt", vtt);
    expect(result.transcript).toBe("Hello everyone");
  });

  it("strips <lang en> tags with language code", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
<lang en>Hello</lang>
`;
    const result = parseTranscriptFile("test.vtt", vtt);
    expect(result.transcript).toBe("Hello");
  });

  it("strips short timestamp tags (<MM:SS.mmm>)", () => {
    // Karaoke-style captions with short timestamp tags (no hours).
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
<00:01.000>Hello <00:01.500>world
`;
    const result = parseTranscriptFile("test.vtt", vtt);
    expect(result.transcript).toBe("Hello world");
  });
});

// ─── parseTranscriptFile: SRT format ─────────────────────────────────────────

describe("parseTranscriptFile: SRT", () => {
  const SAMPLE_SRT = `1
00:00:01,000 --> 00:00:03,000
Welcome to the mango care guide.

2
00:00:03,500 --> 00:00:06,000
Today we'll talk about watering mango trees.

3
00:00:06,500 --> 00:00:09,000
In summer, water deeply once a week.

4
00:00:09,500 --> 00:00:12,000
Thank you for watching!
`;

  it("parses a standard .srt file", () => {
    const result = parseTranscriptFile("test.srt", SAMPLE_SRT);
    expect(result.format).toBe("srt");
    expect(result.segmentCount).toBe(4);
    expect(result.transcript).toContain("Welcome to the mango care guide.");
    expect(result.transcript).toContain("watering mango trees.");
    expect(result.transcript).not.toContain("-->");
    expect(result.transcript).not.toMatch(/^\d+$/m); // No cue numbers
  });

  it("joins cues with single spaces (collapses whitespace)", () => {
    const result = parseTranscriptFile("test.srt", SAMPLE_SRT);
    expect(result.transcript).not.toMatch(/\s{2,}/);
    expect(result.transcript).not.toMatch(/\n/);
  });

  it("handles multi-line cues", () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
Line one.
Line two.
`;
    const result = parseTranscriptFile("test.srt", srt);
    expect(result.segmentCount).toBe(2);
    expect(result.transcript).toBe("Line one. Line two.");
  });

  it("handles BOM-prefixed files", () => {
    const srtWithBom = "\uFEFF" + SAMPLE_SRT;
    const result = parseTranscriptFile("test.srt", srtWithBom);
    expect(result.segmentCount).toBe(4);
    expect(result.transcript).toContain("Welcome");
  });

  it("handles CRLF line endings", () => {
    const srtCrlf = SAMPLE_SRT.replace(/\n/g, "\r\n");
    const result = parseTranscriptFile("test.srt", srtCrlf);
    expect(result.segmentCount).toBe(4);
    expect(result.transcript).toContain("Welcome");
  });

  it("handles missing cue numbers (some files omit them)", () => {
    // Some .srt files have cues without leading numbers — the parser
    // should still find the timestamp line and extract text after it.
    const srt = `00:00:01,000 --> 00:00:03,000
Welcome.

00:00:03,500 --> 00:00:06,000
Goodbye.
`;
    const result = parseTranscriptFile("test.srt", srt);
    expect(result.segmentCount).toBe(2);
    expect(result.transcript).toBe("Welcome. Goodbye.");
  });

  it("returns empty transcript for SRT with no cues", () => {
    const result = parseTranscriptFile("test.srt", "");
    expect(result.transcript).toBe("");
    expect(result.segmentCount).toBe(0);
  });

  it("returns empty transcript for content with no timestamp lines", () => {
    const result = parseTranscriptFile("test.srt", "Some text\nthat isn't a transcript");
    expect(result.transcript).toBe("");
    expect(result.segmentCount).toBe(0);
  });

  it("preserves text that looks like numbers (e.g. 'year 2024')", () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
The year 2024 was great.
`;
    const result = parseTranscriptFile("test.srt", srt);
    expect(result.transcript).toBe("The year 2024 was great.");
  });

  it("handles large files (1000 cues) without issues", () => {
    let srt = "";
    for (let i = 1; i <= 1000; i++) {
      srt += `${i}\n00:00:${String(i).padStart(2, "0")},000 --> 00:00:${String(i + 1).padStart(2, "0")},000\nCue ${i}\n\n`;
    }
    const result = parseTranscriptFile("big.srt", srt);
    expect(result.segmentCount).toBe(1000);
    expect(result.transcript.startsWith("Cue 1")).toBe(true);
    expect(result.transcript.endsWith("Cue 1000")).toBe(true);
  });
});

// ─── parseTranscriptFile: content-sniffed format ───────────────────────────

describe("parseTranscriptFile: content sniffing", () => {
  it("detects VTT from content when filename is .txt", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n";
    const result = parseTranscriptFile("transcript.txt", vtt);
    expect(result.format).toBe("vtt");
    expect(result.transcript).toBe("Hello");
  });

  it("detects SRT from content when filename is .txt (no WEBVTT header)", () => {
    const srt = "1\n00:00:01,000 --> 00:00:03,000\nHello\n";
    const result = parseTranscriptFile("transcript.txt", srt);
    expect(result.format).toBe("srt");
    expect(result.transcript).toBe("Hello");
  });
});

// ─── parseTranscriptFile: real-world YouTube .vtt samples ───────────────────

describe("parseTranscriptFile: real-world YouTube VTT", () => {
  // This is the actual shape of what YouTube returns from the
  // "Show transcript" → download as .vtt path (slightly simplified).
  const YOUTUBE_VTT = `WEBVTT
Kind: captions
Language: en

00:00:00.210 --> 00:00:02.760
hey everyone welcome back to the channel

00:00:02.760 --> 00:00:05.490
today I want to talk about growing
mango trees in your backyard

00:00:05.490 --> 00:00:07.770
specifically how to water them during
the dry season

00:00:07.770 --> 00:00:10.050
let's get into it

00:00:10.050 --> 00:00:12.790
so the first thing you need to know is
that mango trees are drought tolerant

00:00:12.790 --> 00:00:15.640
but they still need water especially
when they're young
`;

  it("parses a realistic YouTube .vtt file", () => {
    const result = parseTranscriptFile("mango-care.vtt", YOUTUBE_VTT);
    expect(result.format).toBe("vtt");
    expect(result.segmentCount).toBeGreaterThan(5);
    expect(result.transcript).toContain("hey everyone welcome back to the channel");
    expect(result.transcript).toContain("mango trees are drought tolerant");
    expect(result.transcript).not.toContain("Kind:");
    expect(result.transcript).not.toContain("Language:");
    expect(result.transcript).not.toContain("-->");
  });

  it("collapses multi-line cues into single text blocks", () => {
    const result = parseTranscriptFile("mango-care.vtt", YOUTUBE_VTT);
    // No mid-text line breaks (whitespace is collapsed).
    expect(result.transcript).not.toMatch(/\n/);
    // No double spaces (whitespace normalized).
    expect(result.transcript).not.toMatch(/\s{2,}/);
  });
});
