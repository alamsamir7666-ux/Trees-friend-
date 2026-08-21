/**
 * Transcript file parser (.vtt + .srt).
 *
 * Used by the POST /ai/admin/kb/sources/transcript-file route to convert
 * an uploaded .vtt or .srt file into plain text suitable for the KB
 * ingestion pipeline (raw_text → chunk → embed → activate).
 *
 * ─── Why this exists ─────────────────────────────────────────────────────
 *
 * The YouTube auto-fetcher (`fetchYoutubeTranscript`) has 4 tiers but all
 * of them can fail on locked-down videos (age-restricted, region-locked,
 * member-only, etc.) or behind aggressive bot protection. When that
 * happens, the admin's only recourse today is the "manual paste" path —
 * they have to open YouTube's transcript viewer, copy the text, and paste
 * it into a textarea.
 *
 * The transcript-file upload is a friendlier variant: the admin downloads
 * a .vtt or .srt file (using YouTube's "Show transcript → 3-dot menu →
 * Toggle timestamps → copy/paste into a .txt file", OR using any browser
 * extension that exports captions), then uploads the file. We parse the
 * structured format and produce clean plain text — no manual stripping of
 * timestamps or cue numbers.
 *
 * ─── Format support ──────────────────────────────────────────────────────
 *
 * WebVTT (.vtt) — the W3C standard. YouTube's transcript viewer produces
 * this format when "Toggle timestamps" is OFF, but most browser extensions
 * produce proper .vtt with timestamps (which we strip).
 *
 * SubRip (.srt) — the legacy format. Older browser extensions and most
 * subtitle download sites still use this. Differs from .vtt only in:
 *   - No `WEBVTT` header
 *   - Comma in timestamps (`00:00:01,000`) instead of period (`00:00:01.000`)
 *   - Cue blocks separated by blank lines (same as .vtt)
 *   - Cue identifier is always a number (in .vtt it can be any string)
 *
 * Both formats use the same block-and-cue structure, so we share the parsing
 * logic between them.
 *
 * ─── Output shape ───────────────────────────────────────────────────────
 *
 * Returns `{ transcript, segmentCount, format }`:
 *   - `transcript` — plain text, segments joined with spaces, all whitespace
 *     collapsed (matches the InnerTube path's behavior so the rest of the
 *     pipeline sees a consistent shape regardless of source).
 *   - `segmentCount` — number of cue blocks that contributed text. Useful
 *     for the admin UI to show "Parsed 247 segments from .vtt file".
 *   - `format` — "vtt" or "srt" (detected from filename or content sniffing).
 *
 * ─── Robustness ─────────────────────────────────────────────────────────
 *
 * Real-world .vtt/.srt files have lots of quirks:
 *   - BOM (byte order mark) at the start
 *   - CRLF, LF, or CR line endings
 *   - Cue identifiers (numbers or arbitrary strings)
 *   - VTT cue tags (<c>, <i>, <b>, <u>, <v>, <lang>) inside text
 *   - NOTE blocks (VTT-only)
 *   - STYLE blocks (VTT-only)
 *   - REGION blocks (VTT-only)
 *   - Multi-line cues
 *   - Empty cues (just a timestamp, no text)
 *
 * We handle all of these. The parser is defensive — it never throws on
 * malformed input; it just returns what it could extract (possibly empty).
 * The route validates that the result is non-empty before creating a source.
 *
 * ─── Pure logic (no I/O) ─────────────────────────────────────────────────
 *
 * This module is pure: takes a string, returns a string. No file I/O, no
 * network calls, no env dependencies. This makes it trivially unit-testable.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type TranscriptFormat = "vtt" | "srt";

export interface ParsedTranscript {
  /** Plain text — cues joined with spaces, whitespace collapsed. */
  transcript: string;
  /** Number of cue blocks that contributed text. */
  segmentCount: number;
  /** Detected format ("vtt" or "srt"). */
  format: TranscriptFormat;
}

// ─── Format detection ────────────────────────────────────────────────────────

/**
 * Detects the transcript format from the filename extension, with content
 * sniffing as a fallback (in case the filename doesn't have an extension,
 * or the admin uploaded a .txt file containing .vtt content — common when
 * they paste into Notepad).
 *
 * Detection priority:
 *   1. Filename extension (.vtt → "vtt", .srt → "srt")
 *   2. Content starts with `WEBVTT` → "vtt" (case-insensitive, after BOM trim)
 *   3. Otherwise → "srt" (legacy default — SRT is the lowest-common-denominator
 *      format; if the content is malformed .vtt, treating it as .srt usually
 *      still extracts the text because the cue-block structure is the same)
 */
export function detectFormat(filename: string, content: string): TranscriptFormat {
  const lower = filename.toLowerCase();

  // 1. Filename extension.
  if (lower.endsWith(".vtt")) return "vtt";
  if (lower.endsWith(".srt")) return "srt";

  // 2. Content sniffing.
  // Strip BOM + leading whitespace before checking the WEBVTT header.
  const sniff = content.replace(/^\uFEFF/, "").trimStart();
  if (sniff.startsWith("WEBVTT")) return "vtt";

  // 3. Default to .srt.
  return "srt";
}

// ─── Cue tag stripper ─────────────────────────────────────────────────────────

/**
 * Strips VTT inline cue tags from a text line.
 *
 * Matches only recognized VTT cue tags (per the W3C WebVTT spec):
 *   - <c>, </c>, <c.class.name>       (class tag, with optional class names)
 *   - <i>, </i>                        (italic)
 *   - <b>, </b>                        (bold)
 *   - <u>, </u>                        (underline)
 *   - <v>, </v>, <v Name>             (voice tag, with optional speaker name)
 *   - <lang>, </lang>, <lang en>      (language tag, with optional code)
 *   - <HH:MM:SS.mmm> or <MM:SS.mmm>  (timestamp tag for karaoke-style cues)
 *
 * Does NOT strip literal `<` or `>` characters that appear in caption text
 * (e.g. "3 < 5" or "price > $10"). The old regex `/<[^>]+>/g` would have
 * mangled those — this specific regex only matches valid VTT tag patterns.
 *
 * Note: SRT files don't use cue tags, but stripping them is a no-op for
 * plain text (the regex doesn't match anything), so we run the stripper
 * unconditionally for simplicity.
 */
function stripCueTags(line: string): string {
  return line.replace(
    /<\/?(?:c|i|b|u|v|lang)(?:\s[^>]*)?(?:\.[^>]*)?>|<(?:\d{1,2}:)?\d{1,2}:\d{2}\.\d{3}>/g,
    "",
  );
}

// ─── Cue block splitter ─────────────────────────────────────────────────────

/**
 * Splits the transcript content into cue blocks.
 *
 * Both .vtt and .srt use the same block structure:
 *
 *   [optional cue identifier]
 *   timestamp line (00:00:01.000 --> 00:00:03.000)
 *   text line 1
 *   text line 2 (optional)
 *
 *   [next cue block...]
 *
 * Blocks are separated by one or more blank lines. CRLF, LF, and CR line
 * endings are all normalized to LF before splitting so the rest of the
 * parser doesn't have to handle multiple conventions.
 *
 * Returns an array of cue blocks, where each block is an array of lines.
 */
function splitCueBlocks(content: string): string[][] {
  // Strip BOM.
  const text = content.replace(/^\uFEFF/, "");

  // Normalize line endings to LF.
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Split into blocks on blank lines (one or more).
  // We use a regex that matches two-or-more consecutive newlines, possibly
  // with whitespace in between (handles trailing whitespace on lines).
  const blocks = normalized.split(/\n[ \t]*\n+/);

  // Each block becomes an array of lines (split on single \n).
  return blocks
    .map((block) => block.split("\n").filter((line) => line.trim().length > 0))
    .filter((lines) => lines.length > 0);
}

// ─── Timestamp line detection ────────────────────────────────────────────────

/**
 * Detects whether a line is a VTT/SRT timestamp line.
 *
 * VTT: `00:00:01.000 --> 00:00:03.000` (or `HH:MM:SS.mmm --> HH:MM:SS.mmm`)
 *      Can also have cue settings after the timestamp: `... line:90%`
 * SRT: `00:00:01,000 --> 00:00:03,000` (comma in milliseconds)
 *
 * We match the `-->` arrow as the canonical signal — it's present in both
 * formats and unambiguous. The actual timestamp format is lenient.
 */
function isTimestampLine(line: string): boolean {
  return line.includes("-->");
}

// ─── Header block detection (VTT-only) ───────────────────────────────────────

/**
 * Detects VTT header blocks that should be skipped (not parsed as cues).
 *
 * VTT files start with a `WEBVTT` header block that may contain:
 *   - `NOTE` blocks (comments)
 *   - `STYLE` blocks (CSS for cue styling)
 *   - `REGION` blocks (cue region definitions)
 *
 * All of these have their keyword on the first line of the block.
 */
function isVttHeaderBlock(lines: string[]): boolean {
  if (lines.length === 0) return false;
  const firstLine = lines[0].trim().toUpperCase();
  return (
    firstLine.startsWith("WEBVTT") ||
    firstLine.startsWith("NOTE") ||
    firstLine.startsWith("STYLE") ||
    firstLine.startsWith("REGION")
  );
}

// ─── Cue text extractor ─────────────────────────────────────────────────────

/**
 * Extracts the text lines from a cue block, skipping:
 *   - The cue identifier (if present — line(s) before the timestamp line)
 *   - The timestamp line itself
 *
 * Returns an array of cue text lines (with cue tags stripped).
 *
 * For both .vtt and .srt, the structure is:
 *   [optional cue identifier]
 *   timestamp line (contains -->)
 *   text line 1
 *   text line 2 (optional)
 *
 * So we find the timestamp line, then return everything after it.
 */
function extractCueTextLines(lines: string[]): string[] {
  // Find the timestamp line.
  let tsIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isTimestampLine(lines[i])) {
      tsIdx = i;
      break;
    }
  }
  if (tsIdx === -1) return [];

  // Return everything after the timestamp line, with cue tags stripped.
  return lines
    .slice(tsIdx + 1)
    .map(stripCueTags)
    .map((line) => line.trim());
}

// ─── Public: parseTranscriptFile ─────────────────────────────────────────────

/**
 * Parses a .vtt or .srt transcript file into plain text.
 *
 * @param filename The original filename (used for format detection).
 *   Accepts .vtt, .srt, or any extension (falls back to content sniffing).
 * @param content The file contents as a UTF-8 string.
 * @returns ParsedTranscript with the plain transcript text + segment count
 *   + detected format. Never throws — returns an empty transcript if
 *   parsing extracts nothing.
 */
export function parseTranscriptFile(filename: string, content: string): ParsedTranscript {
  const format = detectFormat(filename, content);

  // Strip BOM and split into cue blocks.
  const blocks = splitCueBlocks(content);

  const segmentTexts: string[] = [];

  for (const lines of blocks) {
    // Skip VTT header / NOTE / STYLE / REGION blocks.
    if (format === "vtt" && isVttHeaderBlock(lines)) continue;

    const textLines = extractCueTextLines(lines);
    for (const line of textLines) {
      if (line) {
        segmentTexts.push(line);
      }
    }
  }

  // Join with spaces + collapse whitespace (matches InnerTube path behavior).
  const transcript = segmentTexts.join(" ").replace(/\s+/g, " ").trim();

  return {
    transcript,
    segmentCount: segmentTexts.length,
    format,
  };
}
