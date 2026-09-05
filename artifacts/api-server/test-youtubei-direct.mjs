/**
 * Quick test of youtubei.js InnerTube API — bypasses the api-server
 * and calls the library directly. Helps isolate whether the issue is
 * with the library itself or with the api-server's wiring.
 *
 * Run from the api-server directory:
 *   set -a && source .env && set +a
 *   node test-youtubei-direct.mjs
 */
import { Innertube } from "youtubei.js";

async function main() {
  const videoId = "dQw4w9WgXcQ"; // Rick Astley — guaranteed captions
  console.log(`Testing youtubei.js with video: ${videoId}`);
  console.log(`Node version: ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log("---");

  try {
    console.log("[1/3] Creating Innertube client...");
    const yt = await Innertube.create({ retrieve_player: false });
    console.log("  ✓ Innertube client created");

    console.log("[2/3] Fetching video info...");
    const info = await yt.getInfo(videoId);
    console.log("  ✓ Video info fetched");
    console.log(`  Title: ${info.basic_info?.title}`);
    console.log(`  Author: ${info.basic_info?.author}`);

    const playability = info.playability_status;
    console.log(`  Playability: ${playability?.status} — ${playability?.reason ?? "OK"}`);

    if (playability && playability.status !== "OK") {
      console.log("  ✗ Video is not playable — bot challenge or login required");
      process.exit(1);
    }

    console.log("[3/3] Fetching transcript...");
    const transcriptInfo = await info.getTranscript();
    const segments = transcriptInfo?.transcript?.content?.body?.initial_segments ?? [];
    console.log(`  ✓ Transcript fetched with ${segments.length} segments`);

    if (segments.length === 0) {
      console.log("  ✗ No segments found — video has no captions");
      process.exit(1);
    }

    // Print first 3 segment texts as proof
    const firstTexts = segments.slice(0, 3).map((s) => {
      const snippet = s?.snippet;
      return snippet ? (typeof snippet.toString === "function" ? snippet.toString() : String(snippet)) : "";
    }).filter(Boolean);
    console.log("  First segments:", firstTexts);
    console.log("---");
    console.log("✓ SUCCESS — youtubei.js works on this Node version");
  } catch (err) {
    console.log("---");
    console.log("✗ FAILED with error:");
    console.log("  Name:", err?.name);
    console.log("  Message:", err?.message);
    console.log("  Code:", err?.code);
    console.log("  Stack (first 5 lines):");
    if (err?.stack) {
      err.stack.split("\n").slice(0, 5).forEach((line) => console.log("   ", line));
    }
    console.log("");
    console.log("  Full error object:");
    console.log(" ", err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
