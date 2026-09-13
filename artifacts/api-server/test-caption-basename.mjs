/**
 * Test fetching YouTube captions via the watch-page-extracted baseUrl.
 *
 * Previous test (test-timedtext-direct.mjs) found that:
 *   - Direct /api/timedtext calls → HTTP 429 (blocked, no POT)
 *   - Watch page HTML scrape → HTTP 200 with signed baseUrl
 *   - But fetching via the signed baseUrl → ALSO got HTTP 429
 *
 * The 429 on the signed baseUrl is suspicious — likely because:
 *   1. The \u0026 in HTML JSON wasn't decoded to &
 *   2. Or YouTube requires the same User-Agent that fetched the watch page
 *
 * This test fixes both: properly decodes \u0026 → & and reuses the same
 * User-Agent + headers that successfully fetched the watch page.
 *
 * Run from the api-server directory:
 *   node test-caption-basename.mjs
 */
import https from "node:https";

const videoId = "dQw4w9WgXcQ";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  Referer: `https://www.youtube.com/watch?v=${videoId}`,
};

function fetchUrl(url, extraHeaders = {}) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { ...HEADERS, ...extraHeaders } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on("error", (err) => resolve({ status: 0, body: err.message, headers: {} }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ status: 0, body: "timeout", headers: {} });
    });
  });
}

console.log(`Testing caption baseUrl fetch with video: ${videoId}`);
console.log(`Node version: ${process.version}`);
console.log("=========================================\n");

// Step 1: Fetch the watch page
console.log("[1] Fetching watch page HTML...");
const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
const watchResult = await fetchUrl(watchUrl);
console.log(`  Status: ${watchResult.status}`);

if (watchResult.status !== 200) {
  console.log(`✗ Watch page fetch failed`);
  process.exit(1);
}

// Extract captionTracks JSON from the watch page
const match = watchResult.body.match(/"captionTracks":(\[.*?\])/);
if (!match) {
  console.log(`✗ No captionTracks found in watch page`);
  process.exit(1);
}

// Decode \u0026 → & in the JSON string before parsing
const decodedJson = match[1].replace(/\\u0026/g, "&");
let tracks;
try {
  tracks = JSON.parse(decodedJson);
} catch (e) {
  console.log(`✗ JSON parse error: ${e.message}`);
  console.log(`First 200 chars of decoded JSON: ${decodedJson.slice(0, 200)}`);
  process.exit(1);
}

console.log(`  ✓ Found ${tracks.length} caption track(s)`);
console.log(`  Languages: ${tracks.map((t) => t.languageCode).join(", ")}`);

// Step 2: Try fetching the English caption via its baseUrl
const englishTrack = tracks.find((t) => t.languageCode === "en") || tracks[0];
console.log(`\n[2] Fetching caption content via baseUrl...`);
console.log(`  Track: ${englishTrack.name?.simpleText} (${englishTrack.languageCode})`);
console.log(`  baseUrl (decoded): ${englishTrack.baseUrl.slice(0, 200)}...`);

// The baseUrl already contains & (after JSON.parse decoded \u0026)
// Append &fmt=vtt to get VTT format
const captionUrl = `${englishTrack.baseUrl}&fmt=vtt`;
console.log(`  Full URL: ${captionUrl.slice(0, 250)}...`);

const captionResult = await fetchUrl(captionUrl, {
  Accept: "text/vtt,*/*;q=0.1",
});
console.log(`\n  Status: ${captionResult.status}`);
console.log(`  Body length: ${captionResult.body?.length ?? 0}`);
console.log(`  Body (first 500 chars):`);
console.log(`  ---`);
console.log(captionResult.body?.slice(0, 500) ?? "(empty)");
console.log(`  ---`);

if (captionResult.status === 200 && captionResult.body?.startsWith("WEBVTT")) {
  console.log(`\n✓✓✓ SUCCESS — got VTT caption content!`);
  console.log(`This approach works. We'll build the production fetcher on this.`);
  // Count cue blocks
  const cueCount = (captionResult.body.match(/^\d{2}:\d{2}/gm) || []).length;
  console.log(`Approximate cue count: ${cueCount}`);
} else if (captionResult.status === 200 && captionResult.body?.length > 0) {
  console.log(`\n? Got 200 but body doesn't start with WEBVTT — checking format...`);
  console.log(`Content-Type: ${captionResult.headers["content-type"]}`);
} else {
  console.log(`\n✗ Caption fetch failed (HTTP ${captionResult.status})`);
  console.log(`Response headers:`, captionResult.headers);
  // Try without &fmt=vtt
  console.log(`\n[3] Trying without &fmt=vtt...`);
  const result2 = await fetchUrl(englishTrack.baseUrl);
  console.log(`  Status: ${result2.status}`);
  console.log(`  Body (first 500 chars):`);
  console.log(`  ---`);
  console.log(result2.body?.slice(0, 500) ?? "(empty)");
  console.log(`  ---`);
}
