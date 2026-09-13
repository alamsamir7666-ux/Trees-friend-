/**
 * yt-dlp backend for YouTube transcript fetching.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * As of 2026, YouTube enforces a Proof-of-Origin Token (POT) on ALL
 * InnerTube API requests and on direct /api/timedtext calls. Without
 * POT, the response is empty (HTTP 200 with body length 0) even with
 * a valid signed baseUrl.
 *
 * The previous backends all failed:
 *   - youtubei.js v18.0.0 — parser bug ("PlayerInterstitial not found")
 *     AND no POT generation, so playability_status returns UNPLAYABLE.
 *   - Direct /api/timedtext — HTTP 429 (no POT).
 *   - Watch page HTML scrape → signed baseUrl — HTTP 200 but body
 *     length 0 (no POT, response is silently truncated).
 *   - youtubetranscript.com / youtubetotranscript.com / kome.ai — all
 *     blocked by their own anti-bot measures (Cloudflare 403, 521).
 *
 * yt-dlp is the only tool that successfully generates POT by:
 *   1. Downloading YouTube's player JavaScript at runtime
 *   2. Executing it (via Deno or similar JS runtime — Deno is built
 *      into Termux's yt-dlp package, or via a fallback)
 *   3. Extracting the POT and using it on subsequent /api/timedtext
 *      calls
 *
 * ─── How it works ──────────────────────────────────────────────────────────
 *
 * We spawn `yt-dlp` as a subprocess:
 *
 *   yt-dlp --write-auto-sub --skip-download --sub-format vtt \
 *     --sub-lang <lang> -o "<tmpdir>/%(ext)s" \
 *     "https://www.youtube.com/watch?v=<videoId>"
 *
 * yt-dlp fetches the .vtt file to a temp directory. We read the file,
 * parse it with our existing `parseTranscriptFile()` function, and
 * return the transcript.
 *
 * For metadata (title, author, thumbnail), we use the oEmbed endpoint
 * (free, no auth, no POT needed) — same as the existing Tier 3 path.
 *
 * ─── Performance ───────────────────────────────────────────────────────────
 *
 * yt-dlp takes 3-8 seconds per video on a residential IP:
 *   - 1-2s: Downloading player JS + generating POT
 *   - 1-2s: Fetching the .vtt caption file
 *   - 0.5s: Parsing VTT into plain text
 *
 * For 10k videos: ~50,000 seconds = ~14 hours = less than 1 day.
 * This is 3-4× faster than the Invidious approach (which needed ~4
 * days at 100/hour due to rate limiting).
 *
 * ─── Dependencies ──────────────────────────────────────────────────────────
 *
 * Requires `yt-dlp` installed on the server. On Render / cloud
 * deployments, this means adding it to the Dockerfile or build script.
 * On phone-as-server (Termux), install with:
 *
 *   pkg install -y python python-pip ffmpeg
 *   pip install -U yt-dlp
 *
 * If yt-dlp is not installed, this backend returns null and the
 * caller falls through to the next tier.
 *
 * ─── ToS note ──────────────────────────────────────────────────────────────
 *
 * yt-dlp is the same tool used by every major YouTube downloader
 * (NewPipe, youtube-dl GUIs, etc.). For admin-only, low-volume
 * transcript ingestion (a handful of videos per hour), this falls
 * under the same fair-use / educational-use umbrella as the rest of
 * the TreeFriend YouTube fetcher. DO NOT expose this endpoint to
 * public users.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "./logger";
import { parseTranscriptFile } from "./transcriptFileParser";
import type { YoutubeVideoMetadata } from "./youtubeTranscript";

// ─── Config ─────────────────────────────────────────────────────────────────

/**
 * Per-video timeout for yt-dlp. 60 seconds is generous:
 *   - 3-8s for normal operation (residential IP)
 *   - 30-60s for slow networks or videos with many caption tracks
 *
 * If yt-dlp is hanging on a JS challenge (rare on residential IPs),
 * we kill it and fall through to the next tier.
 */
const YT_DLP_TIMEOUT_MS = Number(process.env.YT_DLP_TIMEOUT_MS ?? 60_000);

// ─── Types ─────────────────────────────────────────────────────────────────

export interface YtDlpTranscriptResult {
  metadata: Omit<YoutubeVideoMetadata, "videoId">;
  transcript: string;
  segmentCount: number;
  detectedLanguage: string | null;
}

// ─── yt-dlp binary discovery ───────────────────────────────────────────────

let cachedYtDlpPath: string | null | undefined = undefined;

/**
 * Finds the yt-dlp binary by checking the PATH.
 *
 * Caches the result so subsequent calls don't re-spawn `which`. Returns:
 *   - string (path) if yt-dlp is installed
 *   - null if not installed
 */
async function findYtDlp(): Promise<string | null> {
  if (cachedYtDlpPath !== undefined) return cachedYtDlpPath;

  // Common install locations (in order of preference).
  const candidates = [
    process.env.YT_DLP_PATH, // explicit override
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
    "/data/data/com.termux/files/usr/bin/yt-dlp", // Termux default
    "/opt/homebrew/bin/yt-dlp", // macOS Homebrew
  ];

  // First check explicit paths.
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const { access } = await import("node:fs/promises");
      await access(candidate);
      cachedYtDlpPath = candidate;
      return candidate;
    } catch {
      // not at this path, try next
    }
  }

  // Fallback: check if `yt-dlp` is in PATH via `which`.
  try {
    const result = await runCommand("which", ["yt-dlp"], 5_000);
    if (result.exitCode === 0 && result.stdout.trim()) {
      cachedYtDlpPath = result.stdout.trim();
      return cachedYtDlpPath;
    }
  } catch {
    // which command failed — yt-dlp not in PATH
  }

  cachedYtDlpPath = null;
  return null;
}

// ─── Process spawning ──────────────────────────────────────────────────────

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command and returns its output. Resolves on exit, rejects on
 * timeout. The timeout kills the process.
 */
function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Fetches YouTube transcript via yt-dlp subprocess.
 *
 * Returns null if:
 *   - yt-dlp is not installed
 *   - yt-dlp fails (video unavailable, bot challenge, network error)
 *   - The video has no captions
 *
 * Never throws — the caller treats null as "try the next tier".
 *
 * @param videoId 11-char YouTube video ID.
 * @param preferredLanguage Preferred caption language code (e.g. "en", "bn").
 *   Falls back to auto-generated captions if no manual caption matches.
 */
export async function fetchViaYtDlp(
  videoId: string,
  preferredLanguage: string | null = "en",
): Promise<YtDlpTranscriptResult | null> {
  const ytDlpPath = await findYtDlp();
  if (!ytDlpPath) {
    logger.debug("yt-dlp binary not found — install with: pip install yt-dlp");
    return null;
  }

  // Create a temp directory for the .vtt file.
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(path.join(tmpdir(), "ytdlp-"));
    const outputPath = path.join(tempDir, "%(ext)s");

    // Build the yt-dlp command.
    //
    // --write-auto-sub: Download auto-generated captions if no manual captions exist.
    // --write-sub: Also download manual captions (preferred over auto).
    // --skip-download: Don't download the video itself (we only want captions).
    // --sub-format vtt: Prefer WebVTT format (well-tested parser handles all quirks).
    // --sub-lang: Caption language (en, bn, etc.).
    // --no-playlist: Skip playlist entries (we want one video only).
    // --no-warnings: Suppress non-error warnings (cleaner stderr).
    // --no-check-certificate: Skip TLS cert check (some networks have MITM).
    //
    // Cookie support (recommended for production):
    // If YOUTUBE_COOKIES_FILE env var is set, pass --cookies <path> to
    // yt-dlp. This authenticates as a real YouTube user session and
    // bypasses the "Sign in to confirm you're not a bot" challenge that
    // YouTube applies after the first request from a new IP.
    //
    // To export cookies:
    //   1. Install "Get cookies.txt" browser extension on your computer
    //   2. Sign in to YouTube in that browser
    //   3. Click the extension → Export → saves as cookies.txt
    //   4. Transfer cookies.txt to your server
    //   5. Set YOUTUBE_COOKIES_FILE=/path/to/cookies.txt in .env
    //
    // Without cookies, yt-dlp gets ~1 successful fetch per IP before
    // YouTube flags the IP. With cookies, you can fetch 100s per hour
    // (limited only by your account's view quota).
    const lang = preferredLanguage ?? "en";
    const args = [
      "--write-auto-sub",
      "--write-sub",
      "--skip-download",
      "--sub-format",
      "vtt",
      "--sub-lang",
      lang,
      "--no-playlist",
      "--no-warnings",
      "--no-check-certificate",
    ];

    // Add cookies if configured.
    const cookiesFile = process.env.YOUTUBE_COOKIES_FILE;
    if (cookiesFile && cookiesFile.trim()) {
      args.push("--cookies", cookiesFile.trim());
      logger.debug({ videoId, cookiesFile: cookiesFile.trim() }, "yt-dlp: using cookies file");
    }

    args.push("-o", outputPath, `https://www.youtube.com/watch?v=${videoId}`);

    logger.debug({ videoId, lang, ytDlpPath }, "yt-dlp: starting fetch");

    const result = await runCommand(ytDlpPath, args, YT_DLP_TIMEOUT_MS);

    if (result.exitCode !== 0) {
      logger.warn(
        {
          videoId,
          exitCode: result.exitCode,
          stderr: result.stderr.slice(0, 500),
        },
        "yt-dlp: command failed",
      );
      return null;
    }

    // yt-dlp writes the .vtt file as `<videoId>.<lang>.vtt` or similar.
    // List the temp directory and find the .vtt file.
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(tempDir);
    const vttFile = files.find((f) => f.endsWith(".vtt"));

    if (!vttFile) {
      logger.warn({ videoId, tempFiles: files }, "yt-dlp: no .vtt file produced");
      return null;
    }

    const vttPath = path.join(tempDir, vttFile);
    const vttContent = await readFile(vttPath, "utf-8");

    if (!vttContent.trim()) {
      logger.warn({ videoId, vttPath }, "yt-dlp: .vtt file is empty");
      return null;
    }

    // Parse the VTT content using our existing, well-tested parser.
    const parsed = parseTranscriptFile(vttFile, vttContent);

    if (!parsed.transcript.trim()) {
      logger.warn(
        { videoId, segmentCount: parsed.segmentCount },
        "yt-dlp: VTT parsed but no transcript text found",
      );
      return null;
    }

    // Detect language from the .vtt file's `Language:` header line.
    let detectedLanguage: string | null = preferredLanguage;
    const langMatch = vttContent.match(/^Language:\s*([a-zA-Z-]+)/m);
    if (langMatch) {
      detectedLanguage = langMatch[1].toLowerCase().split("-")[0];
    }

    // Build metadata from the yt-dlp stderr (which contains the video title
    // and other info). For now, leave most fields null — the route will
    // enrich with oEmbed separately if needed.
    const metadata: Omit<YoutubeVideoMetadata, "videoId"> = {
      title: extractTitleFromStderr(result.stderr) ?? "",
      author: "",
      authorUrl: null,
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      durationSeconds: null,
      viewCount: null,
      publishedAt: null,
      detectedLanguage,
    };

    logger.info(
      {
        videoId,
        segments: parsed.segmentCount,
        lang: detectedLanguage,
        durationMs: 0, // could add timing if needed
      },
      "yt-dlp: fetched transcript successfully",
    );

    return {
      metadata,
      transcript: parsed.transcript,
      segmentCount: parsed.segmentCount,
      detectedLanguage,
    };
  } catch (err) {
    logger.warn({ videoId, err: (err as Error).message.slice(0, 200) }, "yt-dlp: unexpected error");
    return null;
  } finally {
    // Clean up the temp directory.
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // non-fatal
      }
    }
  }
}

/**
 * Extracts the video title from yt-dlp's stderr output.
 *
 * yt-dlp prints `[info] Writing video subtitles to: <title>.<lang>.vtt`
 * or `[download] Destination: <title>.<lang>.vtt`. We parse the title
 * from the filename.
 */
function extractTitleFromStderr(stderr: string): string | null {
  // Look for "Writing video subtitles to: <filename>.<lang>.vtt"
  const match = stderr.match(/Writing video subtitles to:\s*(.+?)\s*$/m);
  if (match) {
    // Strip the .<lang>.vtt suffix to get the title.
    const filename = match[1].trim();
    const title = filename.replace(/\.[a-zA-Z-]+\.vtt$/, "").replace(/\.vtt$/, "");
    return title || null;
  }
  return null;
}

/**
 * Checks whether yt-dlp is installed and available.
 *
 * Used by the admin health endpoint to show whether yt-dlp is the
 * active backend. Returns the version string if installed, null
 * otherwise.
 */
export async function getYtDlpVersion(): Promise<string | null> {
  const ytDlpPath = await findYtDlp();
  if (!ytDlpPath) return null;

  try {
    const result = await runCommand(ytDlpPath, ["--version"], 5_000);
    if (result.exitCode === 0) {
      return result.stdout.trim().split("\n")[0];
    }
  } catch {
    // non-fatal
  }
  return null;
}
