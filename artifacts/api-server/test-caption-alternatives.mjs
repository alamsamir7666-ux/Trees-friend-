/**
 * Test alternative caption-fetching approaches.
 *
 * Previous tests confirmed:
 *   - Direct /api/timedtext → HTTP 429 (blocked)
 *   - Watch page HTML scrape → HTTP 200 with signed baseUrl ✓
 *   - Signed baseUrl → HTTP 200 with EMPTY body (POT missing)
 *
 * This test tries:
 *   1. Fetch baseUrl WITH cookies from watch page (PREF, VISITOR_INFO)
 *   2. youtubetranscript.com free API (handles POT internally)
 *
 * Run from the api-server directory:
 *   node test-caption-alternatives.mjs
 */
import https from "node:https";

const videoId = "dQw4w9WgXcQ";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

function fetchUrl(url, options = {}) {
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: options.method || "GET",
      headers: { ...HEADERS, ...(options.headers || {}) },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          body: data,
          headers: res.headers,
          cookies: parseCookies(res.headers["set-cookie"] || []),
        }),
      );
    });
    req.on("error", (err) => resolve({ status: 0, body: err.message, headers: {}, cookies: {} }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ status: 0, body: "timeout", headers: {}, cookies: {} });
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function parseCookies(setCookieHeaders) {
  const cookies = {};
  for (const header of setCookieHeaders) {
    const match = header.match(/^([^=]+)=([^;]*)/);
    if (match) cookies[match[1].trim()] = match[2];
  }
  return cookies;
}

function cookieString(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

console.log(`Testing alternative caption approaches with video: ${videoId}`);
console.log(`Node version: ${process.version}`);
console.log("=========================================\n");

// ─── Approach 1: Watch page + cookies + signed baseUrl ───────────────────
console.log("[Approach 1] Watch page + cookies + signed baseUrl");
console.log("---");
const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
const watchResult = await fetchUrl(watchUrl);
console.log(`Watch page status: ${watchResult.status}`);
console.log(`Cookies received:`, Object.keys(watchResult.cookies));

if (watchResult.status !== 200) {
  console.log("✗ Watch page failed");
} else {
  const match = watchResult.body.match(/"captionTracks":(\[.*?\])/);
  if (!match) {
    console.log("✗ No captionTracks in watch page");
  } else {
    const decodedJson = match[1].replace(/\\u0026/g, "&");
    const tracks = JSON.parse(decodedJson);
    const englishTrack = tracks.find((t) => t.languageCode === "en") || tracks[0];
    console.log(`Found ${tracks.length} tracks, using: ${englishTrack.languageCode}`);

    // Fetch caption WITH cookies
    const captionUrl = `${englishTrack.baseUrl}&fmt=vtt`;
    console.log(`Fetching with cookies...`);
    const captionResult = await fetchUrl(captionUrl, {
      headers: {
        Cookie: cookieString(watchResult.cookies),
        Referer: watchUrl,
        Origin: "https://www.youtube.com",
      },
    });
    console.log(`Status: ${captionResult.status}`);
    console.log(`Body length: ${captionResult.body?.length ?? 0}`);
    console.log(`Body (first 500 chars):`);
    console.log(captionResult.body?.slice(0, 500) ?? "(empty)");
    if (captionResult.body?.startsWith("WEBVTT")) {
      console.log(`\n✓✓✓ Approach 1 WORKS! Got VTT caption content.`);
    }
  }
}

console.log("\n=========================================\n");

// ─── Approach 2: youtubetranscript.com free API ───────────────────────────
console.log("[Approach 2] youtubetranscript.com free API");
console.log("---");
const ytTranscriptUrl = `https://youtubetranscript.com/?server_vid2=${videoId}`;
console.log(`URL: ${ytTranscriptUrl}`);
const ytResult = await fetchUrl(ytTranscriptUrl, {
  headers: {
    Referer: "https://youtubetranscript.com/",
  },
});
console.log(`Status: ${ytResult.status}`);
console.log(`Body length: ${ytResult.body?.length ?? 0}`);
console.log(`Body (first 800 chars):`);
console.log(ytResult.body?.slice(0, 800) ?? "(empty)");
if (ytResult.body && ytResult.body.length > 100 && ytResult.body.includes("<text")) {
  console.log(`\n✓✓✓ Approach 2 WORKS! Got XML transcript content.`);
}

console.log("\n=========================================\n");

// ─── Approach 3: youtubetranscript.com XML API (different endpoint) ──────
console.log("[Approach 3] youtubetranscript.com XML API");
console.log("---");
const xmlUrl = `https://youtubetranscript.com/?server_vid2=${videoId}&type=xml`;
console.log(`URL: ${xmlUrl}`);
const xmlResult = await fetchUrl(xmlUrl);
console.log(`Status: ${xmlResult.status}`);
console.log(`Body (first 800 chars):`);
console.log(xmlResult.body?.slice(0, 800) ?? "(empty)");
