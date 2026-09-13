/**
 * Test youtubei.js with different InnerTube clients.
 *
 * YouTube's WEB client often returns "UNPLAYABLE" for unauthenticated
 * InnerTube API requests (even on residential IPs) since late 2025.
 * Different clients (ANDROID, IOS, TV_EMBEDDED, WEB_EMBEDDED) have
 * different anti-scraping behaviors — some bypass the UNPLAYABLE check.
 *
 * Run from the api-server directory:
 *   node test-youtubei-clients.mjs
 */
import { Innertube } from "youtubei.js";

const videoId = "dQw4w9WgXcQ";
const clients = ["WEB", "ANDROID", "IOS", "TV_EMBEDDED", "WEB_EMBEDDED"];

console.log(`Testing youtubei.js with video: ${videoId}`);
console.log(`Node version: ${process.version}`);
console.log(`Platform: ${process.platform} ${process.arch}`);
console.log("=========================================\n");

for (const client of clients) {
  console.log(`--- Testing client: ${client} ---`);
  try {
    const yt = await Innertube.create({
      retrieve_player: false,
      client_type: client,
    });
    console.log(`  ✓ Client created`);

    const info = await yt.getInfo(videoId);
    const playability = info.playability_status;

    console.log(`  Title: ${info.basic_info?.title}`);
    console.log(`  Author: ${info.basic_info?.author}`);
    console.log(`  Playability: ${playability?.status} — ${playability?.reason ?? "OK"}`);

    if (playability?.status === "OK") {
      console.log(`  🎉 SUCCESS with ${client}! Trying transcript...`);
      try {
        const transcriptInfo = await info.getTranscript();
        const segments = transcriptInfo?.transcript?.content?.body?.initial_segments ?? [];
        console.log(`  ✓ Transcript: ${segments.length} segments`);

        if (segments.length > 0) {
          const firstText = segments[0]?.snippet?.toString() ?? "";
          console.log(`  First segment: "${firstText}"`);
          console.log(`\n✓✓✓ WORKING CLIENT: ${client} ✅✓✓`);
          process.exit(0);
        }
      } catch (err) {
        console.log(`  ✗ Transcript fetch failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.log(`  ✗ Client failed: ${err.message?.slice(0, 200)}`);
  }
  console.log("");
}

console.log("=========================================");
console.log("✗ No client worked. YouTube is blocking all InnerTube clients.");
console.log("Recommended: self-host Invidious (see docs/INVIDIOUS_DEPLOYMENT.md)");
console.log("or use the manual .vtt upload path.");
process.exit(1);
