/**
 * Test whether we can run Invidious directly on the phone via Termux.
 *
 * Invidious is written in Crystal (compiled language) — it can't run
 * directly in Termux without a Crystal compiler. BUT we can try:
 *
 *   1. Run Invidious via Docker (Termux has no Docker — Android kernel
 *      doesn't support it)
 *   2. Run Invidious via a pre-compiled binary (Crystal static binaries
 *      for arm64 exist but require glibc; Termux uses bionic libc)
 *   3. Use a different YouTube-transcript library that handles POT
 *
 * This test tries option 3 — alternative libraries on npm that may have
 * already solved the POT problem:
 *
 *   - youtube-transcript (npm) — fetches via timedtext with POT
 *   - youtube-captions-scraper (npm) — alternative approach
 *   - get-youtube-captions (npm) — yet another approach
 *
 * Run from the api-server directory:
 *   node test-alt-libs.mjs
 */
import https from "node:https";

const videoId = "dQw4w9WgXcQ";

function fetchUrl(url, options = {}) {
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: options.method || "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        ...(options.headers || {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on("error", (err) => resolve({ status: 0, body: err.message, headers: {} }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ status: 0, body: "timeout", headers: {} });
    });
    req.end();
  });
}

console.log(`Testing alternative approaches with video: ${videoId}`);
console.log(`Node version: ${process.version}`);
console.log("=========================================\n");

// ─── Approach A: youtubetotranscript.com (different service) ───────────────
console.log("[Approach A] youtubetotranscript.com");
console.log("---");
const ytttUrl = `https://youtubetotranscript.com/transcript_video.aspx?video_url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${videoId}`;
console.log(`URL: ${ytttUrl.slice(0, 100)}...`);
const ytttResult = await fetchUrl(ytttUrl);
console.log(`Status: ${ytttResult.status}`);
console.log(`Body length: ${ytttResult.body?.length ?? 0}`);
if (ytttResult.body) {
  // Check for transcript text in the HTML response
  const textMatch = ytttResult.body.match(/<div[^>]*id="transcript"[^>]*>([\s\S]*?)<\/div>/i);
  if (textMatch) {
    console.log(`✓ Found transcript div!`);
    console.log(`Transcript (first 800 chars):`);
    console.log(textMatch[1].replace(/<[^>]+>/g, "").trim().slice(0, 800));
  } else {
    console.log(`Body (first 500 chars):`);
    console.log(ytttResult.body.slice(0, 500));
  }
}

console.log("\n=========================================\n");

// ─── Approach B: kome.ai YouTube transcript API ────────────────────────────
console.log("[Approach B] kome.ai/tools/youtube-transcript");
console.log("---");
const komeUrl = `https://api.kome.ai/api/tools/youtube-transcripts?video_id=${videoId}`;
console.log(`URL: ${komeUrl}`);
const komeResult = await fetchUrl(komeUrl, {
  headers: {
    Accept: "application/json",
    Origin: "https://kome.ai",
    Referer: "https://kome.ai/tools/youtube-transcript",
  },
});
console.log(`Status: ${komeResult.status}`);
console.log(`Body length: ${komeResult.body?.length ?? 0}`);
console.log(`Body (first 800 chars):`);
console.log(komeResult.body?.slice(0, 800) ?? "(empty)");

console.log("\n=========================================\n");

// ─── Approach C: scrapbox.io YouTube transcript API ──────────────────────
console.log("[Approach C] tactor.app YouTube transcript");
console.log("---");
const tactorUrl = `https://api.tactor.com/api/v1/youtube-transcript?videoId=${videoId}`;
console.log(`URL: ${tactorUrl}`);
const tactorResult = await fetchUrl(tactorUrl, {
  headers: {
    Accept: "application/json",
  },
});
console.log(`Status: ${tactorResult.status}`);
console.log(`Body length: ${tactorResult.body?.length ?? 0}`);
console.log(`Body (first 800 chars):`);
console.log(tactorResult.body?.slice(0, 800) ?? "(empty)");
