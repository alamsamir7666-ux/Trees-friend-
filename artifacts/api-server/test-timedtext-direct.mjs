/**
 * Test direct YouTube timedtext endpoint — bypasses youtubei.js entirely.
 *
 * YouTube's `/api/timedtext` endpoint returns caption text directly if
 * you have the right params. We try multiple param combinations to find
 * one that works without a Proof-of-Origin Token (POT).
 *
 * If any of these work, we can write a Cloudflare Worker that uses
 * the same approach — no youtubei.js needed, no Invidious needed,
 * works on any IP.
 *
 * Run from the api-server directory:
 *   node test-timedtext-direct.mjs
 */
import https from "node:https";

const videoId = "dQw4w9WgXcQ";

const endpoints = [
  // Variant 1: standard timedtext with params
  `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=vtt`,
  // Variant 2: with kind=asr (auto-generated captions)
  `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr&fmt=vtt`,
  // Variant 3: list available caption tracks first
  `https://www.youtube.com/api/timedtext?v=${videoId}&type=list`,
  // Variant 4: with explicit client
  `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3`,
];

function fetchUrl(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", (err) => resolve({ status: 0, body: err.message }));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ status: 0, body: "timeout" });
    });
  });
}

console.log(`Testing direct timedtext endpoint with video: ${videoId}`);
console.log(`Node version: ${process.version}`);
console.log("=========================================\n");

for (let i = 0; i < endpoints.length; i++) {
  const url = endpoints[i];
  console.log(`--- Variant ${i + 1} ---`);
  console.log(`URL: ${url.slice(0, 100)}...`);
  const result = await fetchUrl(url);
  console.log(`Status: ${result.status}`);
  console.log(`Body (first 300 chars): ${result.body.slice(0, 300)}`);
  if (result.body) {
    console.log(`Body length: ${result.body.length}`);
  }
  console.log("");
}

// Also try fetching the watch page and looking for caption tracks in the HTML
console.log("--- Variant 5: Watch page HTML scrape ---");
const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
console.log(`URL: ${watchUrl}`);
const watchResult = await fetchUrl(watchUrl);
console.log(`Status: ${watchResult.status}`);
if (watchResult.body) {
  // Look for "captionTracks" in the HTML
  const match = watchResult.body.match(/"captionTracks":(\[.*?\])/);
  if (match) {
    console.log(`✓ Found captionTracks in watch page HTML!`);
    console.log(`Caption tracks: ${match[1].slice(0, 500)}`);
    try {
      const tracks = JSON.parse(match[1]);
      console.log(`\nParsed ${tracks.length} caption track(s):`);
      for (const t of tracks) {
        console.log(`  - ${t.name?.simpleText ?? t.name} (${t.languageCode})`);
        console.log(`    baseUrl: ${t.baseUrl?.slice(0, 100)}...`);
      }
      if (tracks.length > 0 && tracks[0].baseUrl) {
        console.log("\n--- Variant 6: Fetch caption content via baseUrl ---");
        const captionResult = await fetchUrl(tracks[0].baseUrl);
        console.log(`Status: ${captionResult.status}`);
        console.log(`Body (first 500 chars): ${captionResult.body.slice(0, 500)}`);
      }
    } catch (e) {
      console.log(`Parse error: ${e.message}`);
    }
  } else {
    console.log(`✗ No captionTracks found in watch page HTML`);
    // Check for bot challenge indicators
    if (watchResult.body.includes("Sign in to confirm")) {
      console.log(`✗ Bot challenge detected in watch page`);
    } else if (watchResult.body.includes("PlayerInterstitial")) {
      console.log(`! PlayerInterstitial found in watch page`);
    }
  }
}
