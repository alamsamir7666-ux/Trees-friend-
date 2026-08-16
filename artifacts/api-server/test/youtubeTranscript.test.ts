/**
 * Unit tests for `parseYoutubeUrl` in lib/youtubeTranscript.ts.
 *
 * The full `fetchYoutubeTranscript()` function hits the live YouTube API
 * and can't be unit-tested deterministically (and from datacenter IPs it
 * gets bot-challenged). But `parseYoutubeUrl` is pure logic — given a
 * string, return a video ID or null — so it has full coverage.
 *
 * The strategy mirrors the existing test pattern in this repo
 * (e.g. bm25TriggerOrder.test.ts): no DB, no network, just pure assertions.
 */
import { describe, expect, it } from "vitest";
import { parseYoutubeUrl } from "../src/lib/youtubeTranscript";

describe("parseYoutubeUrl", () => {
  const VALID_ID = "QCvyyyb-XCQ";
  const VALID_URLS: [string, string][] = [
    [`https://www.youtube.com/watch?v=${VALID_ID}`, VALID_ID],
    [`https://youtube.com/watch?v=${VALID_ID}`, VALID_ID],
    [`https://m.youtube.com/watch?v=${VALID_ID}`, VALID_ID],
    [`https://youtu.be/${VALID_ID}`, VALID_ID],
    [`https://www.youtube.com/embed/${VALID_ID}`, VALID_ID],
    [`https://www.youtube.com/shorts/${VALID_ID}`, VALID_ID],
    [`https://www.youtube.com/v/${VALID_ID}`, VALID_ID],
    [`https://www.youtube.com/live/${VALID_ID}`, VALID_ID],
    [`https://www.youtube-nocookie.com/embed/${VALID_ID}`, VALID_ID],
    // URL without protocol — admin pastes from a chat
    [`youtu.be/${VALID_ID}`, VALID_ID],
    [`youtube.com/watch?v=${VALID_ID}`, VALID_ID],
    // URL with extra query params
    [`https://www.youtube.com/watch?v=${VALID_ID}&feature=shared&t=120`, VALID_ID],
    [`https://www.youtube.com/watch?v=${VALID_ID}&hl=en`, VALID_ID],
    // URL with tracking params
    [`https://youtu.be/${VALID_ID}?si=abc123&utm_source=whatsapp`, VALID_ID],
  ];

  for (const [input, expectedId] of VALID_URLS) {
    it(`parses ${input}`, () => {
      const result = parseYoutubeUrl(input);
      expect(result).toEqual({ videoId: expectedId });
    });
  }

  const INVALID_INPUTS: string[] = [
    "",
    "   ",
    "not a url at all",
    "https://example.com/watch?v=abc",
    "https://vimeo.com/123456789",
    // Wrong host (looks similar but isn't youtube)
    "https://youtube.evil.com/watch?v=QCvyyyb-XCQ",
    // ID too short (need 11 chars)
    "https://youtu.be/short",
    // ID too long
    "https://youtu.be/QCvyyyb-XCQextra",
    // ID has invalid chars (space, !)
    "https://youtu.be/QCvyyyb-X!",
    // Vimeo-style URL
    "https://vimeo.com/QCvyyyb-XCQ",
    // Empty ID
    "https://youtu.be/",
    "https://www.youtube.com/watch?v=",
  ];

  for (const input of INVALID_INPUTS) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      const result = parseYoutubeUrl(input);
      expect(result).toBeNull();
    });
  }

  it("handles whitespace-padded URLs", () => {
    expect(parseYoutubeUrl(`  https://youtu.be/${VALID_ID}  `)).toEqual({ videoId: VALID_ID });
  });

  it("accepts http (not just https)", () => {
    expect(parseYoutubeUrl(`http://youtu.be/${VALID_ID}`)).toEqual({ videoId: VALID_ID });
  });

  it("is case-sensitive on the video ID (YouTube IDs ARE case-sensitive)", () => {
    // YouTube video IDs use [A-Za-z0-9_-] — case matters. Our regex
    // correctly accepts both upper and lower case.
    expect(parseYoutubeUrl("https://youtu.be/qCvyyYb-XCQ")).toEqual({ videoId: "qCvyyYb-XCQ" });
  });
});
