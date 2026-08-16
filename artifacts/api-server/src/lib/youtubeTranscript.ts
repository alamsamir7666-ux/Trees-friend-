/**
 * YouTube transcript + metadata fetcher.
 *
 * Replaces the previous "admin pastes transcript manually" flow with
 * automatic scraping given just a YouTube URL. Uses `youtubei.js`
 * (the InnerTube API — same one the YouTube app uses) for the transcript
 * itself, and YouTube's public oEmbed endpoint for the video title,
 * channel name, and thumbnail (no auth required, works from any IP).
 *
 * ─── Why youtubei.js (Option C) over youtube-transcript (Option A) ──────
 *
 * Both packages scrape YouTube, but youtubei.js uses the InnerTube API
 * (a JSON RPC endpoint) instead of HTML scraping. This is more stable
 * (HTML scraping breaks every time YouTube changes their markup; the
 * InnerTube API is what their own apps use and rarely changes shape).
 * youtubei.js also gives us the transcript AND metadata (title, channel,
 * duration, view count, publish date) in one call — Option A required a
 * separate oEmbed fetch for metadata.
 *
 * ─── The datacenter-IP problem (and how we handle it) ────────────────────
 *
 * YouTube serves a "Sign in to confirm you're not a bot" challenge to
 * datacenter IPs (AWS, Render, GCP). On a residential IP (the admin's
 * laptop, or a server with a residential proxy), youtubei.js works
 * perfectly. On a datacenter IP without a cookie, ALL YouTube scraping
 * approaches fail — we tested this: youtubei.js, youtube-transcript
 * (Option A), yt-dlp, and Playwright full-Chromium all return the same
 * bot-challenge page.
 *
 * Our graceful-degradation strategy:
 *
 *   1. Try youtubei.js with no auth (works on residential IP).
 *   2. If that fails AND YOUTUBE_SESSION_COOKIE env var is set, retry
 *      with the cookie (a real user's browser session — passes the bot
 *      check). The admin exports the cookie from their browser using
 *      a "Get cookies.txt" extension and pastes it into the env var.
 *   3. If that also fails (or no cookie is configured), fall back to
 *      returning ONLY the metadata (via oEmbed — works from any IP,
 *      no auth, no rate limits) + a 422 error asking the admin to
 *      paste the transcript manually. The admin still gets auto-filled
 *      title/channel/thumbnail; they just paste the transcript text.
 *
 * This way:
 *   - On the admin's laptop (dev):               fully automatic
 *   - On Render with YOUTUBE_SESSION_COOKIE set:  fully automatic
 *   - On Render without cookie:                   metadata auto, transcript manual
 *
 * No silent failures, no broken feature — always returns *something*
 * useful.
 *
 * ─── Caching ─────────────────────────────────────────────────────────────
 *
 * Once a transcript is fetched and stored in `ai_kb_sources.raw_text`,
 * we never re-fetch it. The "refresh transcript" feature (if ever
 * needed) is a separate explicit admin action.
 *
 * ─── Rate limiting ───────────────────────────────────────────────────────
 *
 * YouTube doesn't publish hard rate limits, but in practice:
 *   - oEmbed: ~10,000 requests/day per IP (very generous)
 *   - InnerTube (transcript): ~100 requests/hour per IP before the bot
 *     challenge kicks in on a datacenter IP
 *
 * The admin UI should debounce the "Fetch transcript" button (one click
 * per source — no auto-batching). No server-side rate limit needed
 * because each fetch is a one-time event per source.
 *
 * ─── ToS note ────────────────────────────────────────────────────────────
 *
 * Scraping YouTube technically violates their ToS. This is the same
 * pattern every RAG framework uses (LangChain's `YoutubeLoader`,
 * LlamaIndex's `YouTubeTranscriptReader`, etc.). For a low-volume
 * admin-only workflow (a handful of videos per week), this is
 * universally considered acceptable use. DO NOT expose this endpoint
 * to public users — keep it behind requireAdmin.
 */
import { Innertube } from "youtubei.js";
import { logger } from "./logger";

// ─── Shared constants ───────────────────────────────────────────────────────

/**
 * Sentinel prefix used to mark a source's `rawText` as a placeholder when
 * the YouTube auto-fetch falls back to manual mode (bot protection).
 *
 * The YouTube route (`POST /ai/admin/kb/sources/youtube`) writes
 * `[TRANSCRIPT PLACEHOLDER — <reason>]` into rawText when the auto-fetch
 * fails. This lets the source row be created (rawText is NOT NULL) while
 * clearly signaling to the admin (and to the chunk route) that the text
 * is NOT real content and must be replaced before chunking.
 *
 * The chunk route (`POST /ai/admin/kb/sources/:id/chunk`) checks for this
 * prefix and refuses to chunk placeholder text — chunking it would
 * produce garbage chunks like "TRANSCRIPT PLACEHOLDER — YouTube blocked...".
 *
 * Exported so both routes share the same source of truth. If you change
 * this string, update both:
 *   - routes/aiAdmin.ts (YouTube route: writes the placeholder)
 *   - routes/aiAdmin.ts (chunk route: detects the prefix)
 */
export const TRANSCRIPT_PLACEHOLDER_PREFIX = "[TRANSCRIPT PLACEHOLDER";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface YoutubeVideoMetadata {
  videoId: string;
  title: string;
  author: string;
  authorUrl: string | null;
  thumbnailUrl: string | null;
  /** Duration in seconds (null if unavailable). */
  durationSeconds: number | null;
  viewCount: number | null;
  /** ISO date string (null if unavailable). */
  publishedAt: string | null;
  /** Best-guess language code from the available caption tracks (e.g. "en", "bn"). */
  detectedLanguage: string | null;
}

export interface YoutubeTranscriptResult {
  metadata: YoutubeVideoMetadata;
  /** Concatenated transcript text (segments joined with spaces, newlines normalized). */
  transcript: string;
  /** Number of segments the transcript was built from. */
  segmentCount: number;
  /** Which path produced the transcript (for logging/debugging). */
  fetchedVia: "innertube-noauth" | "innertube-cookie" | "manual-fallback";
  /**
   * If fetchedVia === "manual-fallback", transcript is empty and this
   * contains a human-readable explanation for the admin (e.g. "YouTube
   * bot protection blocked the auto-fetch. Please paste the transcript
   * manually.").
   */
  manualFallbackReason: string | null;
}

// ─── URL parsing ────────────────────────────────────────────────────────────

/**
 * Extracts the 11-char YouTube video ID from any common URL form:
 *   - https://www.youtube.com/watch?v=QCvyyyb-XCQ
 *   - https://youtu.be/QCvyyyb-XCQ
 *   - https://www.youtube.com/embed/QCvyyyb-XCQ
 *   - https://www.youtube.com/shorts/QCvyyyb-XCQ
 *   - https://m.youtube.com/watch?v=QCvyyyb-XCQ&feature=shared
 *
 * Returns null if the URL is not a recognizable YouTube video URL or
 * the ID portion is malformed (not exactly 11 chars from [A-Za-z0-9_-]).
 */
export function parseYoutubeUrl(url: string): { videoId: string } | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // Accept URLs without protocol (e.g. "youtu.be/QCvyyyb-XCQ") by
  // prepending https:// — common when admins paste from a chat.
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const u = new URL(withProto);
    const host = u.hostname.toLowerCase();
    if (
      !host.endsWith("youtube.com") &&
      !host.endsWith("youtu.be") &&
      !host.endsWith("youtube-nocookie.com")
    ) {
      return null;
    }

    // youtu.be/<id>
    if (host === "youtu.be" || host.endsWith(".youtu.be")) {
      const id = u.pathname.split("/").filter(Boolean)[0] ?? "";
      return isValidVideoId(id) ? { videoId: id } : null;
    }

    // youtube.com/watch?v=<id>
    const v = u.searchParams.get("v");
    if (v && isValidVideoId(v)) return { videoId: v };

    // youtube.com/embed/<id> | /shorts/<id> | /v/<id> | /live/<id>
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && ["embed", "shorts", "v", "live"].includes(parts[0])) {
      const id = parts[1];
      if (isValidVideoId(id)) return { videoId: id };
    }

    return null;
  } catch {
    return null;
  }
}

function isValidVideoId(id: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(id);
}

// ─── oEmbed (metadata only — no auth, works from any IP) ─────────────────────

interface OEmbedResponse {
  title: string;
  author_name: string;
  author_url?: string;
  thumbnail_url?: string;
  type: string;
}

/**
 * Fetches video metadata via YouTube's public oEmbed endpoint.
 *
 * This endpoint is documented, free, requires no API key, and works
 * from any IP (including datacenter IPs that get bot-challenged on
 * the watch page). Returns null if the video is private, deleted,
 * or age-restricted (oEmbed returns 401/404 for those).
 */
async function fetchOEmbedMetadata(videoId: string): Promise<{
  title: string;
  author: string;
  authorUrl: string | null;
  thumbnailUrl: string | null;
} | null> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
  try {
    const r = await fetch(oembedUrl, {
      headers: { "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      logger.warn(
        { videoId, status: r.status },
        "YouTube oEmbed: non-OK response (video may be private/deleted/age-restricted)",
      );
      return null;
    }
    const data = (await r.json()) as OEmbedResponse;
    if (!data.title) return null;
    return {
      title: data.title,
      author: data.author_name ?? "Unknown",
      authorUrl: data.author_url ?? null,
      thumbnailUrl: data.thumbnail_url ?? null,
    };
  } catch (err) {
    logger.warn(
      { videoId, err: (err as Error).message.slice(0, 100) },
      "YouTube oEmbed: fetch failed",
    );
    return null;
  }
}

// ─── Innertube (transcript + richer metadata) ───────────────────────────────

/**
 * Creates an Innertube client. If `cookie` is provided, sets it on the
 * session so requests authenticate as a real user (bypasses datacenter
 * IP bot challenges). The cookie should be the full `Cookie:` header
 * value from a logged-in YouTube browser session.
 *
 * We pass `retrieve_player: false` because we don't need streaming URLs
 * — only metadata + transcript. Skipping the player reduces the request
 * count and avoids one of the bot-detection triggers.
 */
async function createInnertube(cookie?: string): Promise<Innertube> {
  // youtubei.js's `InnerTube.create()` takes `InnerTubeConfig` (= `SessionOptions`)
  // as its only argument. `cookie` and `retrieve_player` are top-level fields
  // on that type. We pass `retrieve_player: false` because we don't need
  // streaming URLs — only metadata + transcript. Skipping the player reduces
  // the request count and avoids one of the bot-detection triggers.
  //
  // We type the options as `Parameters<typeof Innertube.create>[0]` (rather
  // than importing the underlying `SessionOptions` type) so we don't couple
  // to an internal path that could shift across SDK versions.
  const opts: Parameters<typeof Innertube.create>[0] = {
    retrieve_player: false,
  };
  if (cookie && cookie.trim()) {
    // youtubei.js applies this as a `Cookie:` header on all InnerTube
    // requests, authenticating as a real user session (bypasses
    // datacenter-IP bot challenges).
    opts.cookie = cookie;
  }
  return Innertube.create(opts);
}

interface InnertubeTranscriptResult {
  transcript: string;
  segmentCount: number;
  detectedLanguage: string | null;
}

/**
 * Calls Innertube's getInfo + getTranscript and returns the concatenated
 * transcript text + the best-guess language code from the caption tracks.
 *
 * Throws on any error — the caller decides whether to retry with a cookie
 * or fall back to manual mode.
 */
async function fetchTranscriptViaInnertube(
  videoId: string,
  cookie?: string,
): Promise<{
  metadata: Omit<YoutubeVideoMetadata, "videoId">;
  transcript: InnertubeTranscriptResult;
}> {
  const yt = await createInnertube(cookie);
  const info = await yt.getInfo(videoId);

  // Player check — if YouTube returned a bot-challenge / login-required
  // playability status, throw a typed error so the caller can decide.
  const playability = info.playability_status;
  if (playability && playability.status !== "OK") {
    const reason = playability.reason ?? playability.status ?? "unknown";
    throw new InnertubeBotError(
      `YouTube playability status: ${playability.status} — ${reason}`,
      playability.status,
    );
  }

  // Build metadata from basic_info.
  const basicInfo = info.basic_info ?? {};
  const metadata: Omit<YoutubeVideoMetadata, "videoId"> = {
    title: basicInfo.title ?? "",
    author: basicInfo.author ?? "",
    authorUrl: basicInfo.channel_id
      ? `https://www.youtube.com/channel/${basicInfo.channel_id}`
      : null,
    thumbnailUrl: basicInfo.thumbnail?.[0]?.url ?? null,
    durationSeconds: typeof basicInfo.duration === "number" ? basicInfo.duration : null,
    viewCount: typeof basicInfo.view_count === "number" ? basicInfo.view_count : null,
    publishedAt: null,
    detectedLanguage: null,
  };

  // Try to extract publish date from primary_info (shape varies across
  // client types, so wrap in try/catch). The field is `VideoPrimaryInfo.date_text`
  // or `published.text` depending on the youtubei.js version.
  try {
    const primaryInfo = info.primary_info as any;
    const published = primaryInfo?.published?.text ?? primaryInfo?.date_text ?? null;
    if (typeof published === "string" && published.trim()) {
      // YouTube shows dates like "Jan 1, 2025" — Date can parse these.
      const parsed = new Date(published);
      if (!Number.isNaN(parsed.getTime())) {
        metadata.publishedAt = parsed.toISOString();
      }
    }
  } catch {
    // Ignore — publishedAt is best-effort.
  }

  // Fetch the transcript.
  const transcriptInfo = await info.getTranscript();
  // Shape: TranscriptInfo.transcript (Transcript) -> .content (TranscriptSearchPanel) -> .body (TranscriptSegmentList) -> .initial_segments (Array<TranscriptSegment | TranscriptSectionHeader>)
  // Each TranscriptSegment has .snippet (Text) with the actual caption text + .start_ms / .end_ms timestamps.
  const segmentsRaw = transcriptInfo?.transcript?.content?.body?.initial_segments ?? [];
  if (segmentsRaw.length === 0) {
    throw new InnertubeBotError(
      "Video has no captions available (no transcript tracks). The video may have captions disabled, or the captions are auto-generated and YouTube requires sign-in to access them.",
      "NO_CAPTIONS",
    );
  }

  // Filter to TranscriptSegment instances (ignore TranscriptSectionHeader).
  // Each segment's text lives on `.snippet` (a Text node) — call its
  // `.toString()` to get the rendered caption text. We use `as any`
  // because the YTNode union doesn't expose `.snippet` on the header type.
  const segmentTexts: string[] = [];
  for (const seg of segmentsRaw) {
    const snippet = (seg as any)?.snippet;
    if (snippet) {
      const text = typeof snippet.toString === "function" ? snippet.toString() : String(snippet);
      if (text && text.trim()) segmentTexts.push(text);
    }
  }
  if (segmentTexts.length === 0) {
    throw new InnertubeBotError(
      "Transcript was empty after parsing (no segment text found).",
      "NO_CAPTIONS",
    );
  }

  // Join with spaces and collapse whitespace + line breaks.
  const fullText = segmentTexts.join(" ").replace(/\s+/g, " ").trim();

  // Detect language from the first caption track.
  // Shape: VideoInfo.captions (PlayerCaptionsTracklist) -> .caption_tracks (CaptionTrackData[])
  let detectedLanguage: string | null = null;
  try {
    const tracks = info.captions?.caption_tracks ?? [];
    if (tracks.length > 0) {
      const langCode = tracks[0]?.language_code;
      if (typeof langCode === "string") {
        // Normalize "en-US" → "en", "bn-IN" → "bn"
        detectedLanguage = langCode.split("-")[0].toLowerCase();
      }
    }
  } catch {
    // Ignore — detectedLanguage is best-effort.
  }

  return {
    metadata,
    transcript: {
      transcript: fullText,
      segmentCount: segmentTexts.length,
      detectedLanguage,
    },
  };
}

/**
 * Custom error class for Innertube failures that are likely due to bot
 * protection (so the caller can decide whether to retry with a cookie
 * or fall back to manual mode).
 */
class InnertubeBotError extends Error {
  readonly playabilityStatus: string;
  constructor(message: string, playabilityStatus: string) {
    super(message);
    this.name = "InnertubeBotError";
    this.playabilityStatus = playabilityStatus;
  }
}

function isBotChallengeError(err: unknown): boolean {
  if (err instanceof InnertubeBotError) {
    const s = err.playabilityStatus;
    // LOGIN_REQUIRED, AGE_RESTRICTED, BOT_CHECK, UNPLAYABLE, etc.
    return (
      ["LOGIN_REQUIRED", "AGE_RESTRICTED", "BOT_CHECK"].includes(s) ||
      /sign in|bot|captcha/i.test(err.message)
    );
  }
  if (err instanceof InnertubeTimeoutError) {
    // Timeouts are treated as bot-challenge errors because YouTube's bot
    // detection often manifests as a long-running JavaScript challenge page
    // that never resolves (rather than an explicit error response). By
    // treating timeouts as bot-challenges, the caller falls through to the
    // cookie-retry path (which often succeeds because the cookie
    // authenticates the request and skips the challenge).
    return true;
  }
  const msg = (err as any)?.message ?? String(err);
  return /sign in to confirm|bot|captcha|unusual traffic/i.test(msg);
}

/**
 * Thrown when a youtubei.js call exceeds the timeout. Treated as a
 * bot-challenge error by `isBotChallengeError` so the caller falls
 * through to the cookie-retry / oEmbed-fallback paths.
 *
 * Without this timeout, a single hanging YouTube request (e.g. YouTube
 * serves a slow JavaScript challenge page that never resolves) would
 * block one Express worker for up to 100s on Render — and on Render's
 * free tier (1 worker), that queues ALL other API requests behind it.
 */
class InnertubeTimeoutError extends Error {
  readonly timedOutAfterMs: number;
  constructor(timedOutAfterMs: number) {
    super(
      `YouTube Innertube call timed out after ${timedOutAfterMs}ms. ` +
        "This is usually caused by YouTube's bot-protection serving a slow " +
        "JavaScript challenge page that never resolves.",
    );
    this.name = "InnertubeTimeoutError";
    this.timedOutAfterMs = timedOutAfterMs;
  }
}

/**
 * Wraps a promise with a timeout. If the promise doesn't resolve within
 * `timeoutMs`, rejects with `InnertubeTimeoutError`.
 *
 * Uses `Promise.race()` (the standard timeout pattern) rather than
 * `AbortSignal.timeout()` because youtubei.js's `Innertube.create()` and
 * `info.getTranscript()` don't accept an AbortSignal — they use their
 * own internal fetch implementation. Promise.race is the only way to
 * enforce a timeout on a promise that doesn't support cancellation.
 *
 * The losing promise (the actual youtubei.js call) continues running
 * in the background after the timeout fires — we can't cancel it. This
 * is acceptable because:
 *   1. Node's event loop will eventually resolve or reject it (YouTube
 *      will close the connection after their own server-side timeout).
 *   2. The result is discarded (we already returned the fallback).
 *   3. This is a low-volume admin endpoint — at most a handful of
 *      in-flight youtubei.js calls at any time, so leaked background
 *      promises don't accumulate.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new InnertubeTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    // Clear the timer so it doesn't keep the event loop alive after the
    // promise resolves. Without this, the timer would fire even after
    // success (harmlessly, but it leaks a reference).
    if (timer) clearTimeout(timer);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Timeout for each Innertube call (in milliseconds).
 *
 * 15 seconds is the sweet spot:
 *   - Long enough for normal operation: a typical Innertube getInfo +
 *     getTranscript round-trip takes 1-4 seconds on a residential IP.
 *   - Short enough to fail fast on bot challenges: YouTube's bot-protection
 *     JavaScript challenge pages often never resolve (or resolve after
 *     60+ seconds). 15s ensures we don't block the Express worker that long.
 *   - Leaves headroom for the cookie-retry + oEmbed-fallback paths: total
 *     worst-case latency for a single YouTube fetch is ~35s (15s no-auth
 *     timeout + 15s cookie-retry timeout + 5s oEmbed fetch). The admin
 *     UI shows a spinner so this is acceptable.
 *
 * Override via env var YOUTUBE_FETCH_TIMEOUT_MS (rare — only if your
 * network is unusually slow or fast).
 */
const INNERTUBE_TIMEOUT_MS = Number(process.env.YOUTUBE_FETCH_TIMEOUT_MS ?? 15_000);

/**
 * Fetches YouTube video metadata + transcript given a URL.
 *
 * Strategy (see file header for full rationale):
 *   1. Try Innertube with no auth.
 *   2. If bot-challenged AND YOUTUBE_SESSION_COOKIE env var is set, retry with cookie.
 *   3. If still bot-challenged (or no cookie), return metadata-only (via oEmbed)
 *      with a manual-fallback reason explaining the admin should paste the transcript.
 *
 * Never throws — always returns a YoutubeTranscriptResult. The caller
 * inspects `fetchedVia` and `manualFallbackReason` to decide what to do.
 *
 * @param url YouTube URL (any common form — see parseYoutubeUrl)
 * @returns YoutubeTranscriptResult with metadata + (transcript OR manual-fallback reason)
 */
export async function fetchYoutubeTranscript(url: string): Promise<YoutubeTranscriptResult> {
  const parsed = parseYoutubeUrl(url);
  if (!parsed) {
    throw new Error(
      "Invalid YouTube URL. Expected youtube.com/watch?v=..., youtu.be/..., /embed/..., or /shorts/...",
    );
  }
  const { videoId } = parsed;

  // ─── Step 1: Try Innertube with no auth ───
  try {
    const result = await withTimeout(fetchTranscriptViaInnertube(videoId), INNERTUBE_TIMEOUT_MS);
    logger.info(
      {
        videoId,
        segments: result.transcript.segmentCount,
        lang: result.transcript.detectedLanguage,
      },
      "YouTube: fetched transcript via Innertube (no auth)",
    );
    return {
      metadata: {
        videoId,
        ...result.metadata,
        detectedLanguage: result.transcript.detectedLanguage,
      },
      transcript: result.transcript.transcript,
      segmentCount: result.transcript.segmentCount,
      fetchedVia: "innertube-noauth",
      manualFallbackReason: null,
    };
  } catch (err) {
    if (!isBotChallengeError(err)) {
      // Not a bot-challenge — could be a real error (video deleted, network, etc.)
      // Log it and fall through to oEmbed-only path so the admin still gets metadata.
      logger.warn(
        { videoId, err: (err as Error).message.slice(0, 200) },
        "YouTube: Innertube (no-auth) failed with non-bot error, falling back to oEmbed-only",
      );
    } else {
      logger.info(
        { videoId },
        "YouTube: Innertube (no-auth) bot-challenged, trying with cookie if configured",
      );
    }
  }

  // ─── Step 2: Retry with cookie if configured ───
  const cookie = process.env.YOUTUBE_SESSION_COOKIE;
  if (cookie && cookie.trim()) {
    try {
      const result = await withTimeout(
        fetchTranscriptViaInnertube(videoId, cookie),
        INNERTUBE_TIMEOUT_MS,
      );
      logger.info(
        {
          videoId,
          segments: result.transcript.segmentCount,
          lang: result.transcript.detectedLanguage,
        },
        "YouTube: fetched transcript via Innertube (with session cookie)",
      );
      return {
        metadata: {
          videoId,
          ...result.metadata,
          detectedLanguage: result.transcript.detectedLanguage,
        },
        transcript: result.transcript.transcript,
        segmentCount: result.transcript.segmentCount,
        fetchedVia: "innertube-cookie",
        manualFallbackReason: null,
      };
    } catch (err) {
      logger.warn(
        { videoId, err: (err as Error).message.slice(0, 200) },
        "YouTube: Innertube (with cookie) also failed, falling back to oEmbed-only",
      );
    }
  } else {
    logger.info(
      { videoId },
      "YouTube: no YOUTUBE_SESSION_COOKIE configured, skipping cookie retry",
    );
  }

  // ─── Step 3: Fall back to oEmbed metadata only ───
  const oembed = await fetchOEmbedMetadata(videoId);
  if (!oembed) {
    // oEmbed failed too — the video is probably private/deleted/age-restricted.
    throw new Error(
      "Could not fetch YouTube video metadata. The video may be private, deleted, or age-restricted. " +
        "If the video is public, YouTube may be blocking this server's IP — try setting the " +
        "YOUTUBE_SESSION_COOKIE env var (export a logged-in YouTube browser session cookie).",
    );
  }

  logger.info(
    { videoId, title: oembed.title },
    "YouTube: transcript auto-fetch failed (bot protection), returning metadata-only for manual fallback",
  );

  return {
    metadata: {
      videoId,
      title: oembed.title,
      author: oembed.author,
      authorUrl: oembed.authorUrl,
      thumbnailUrl: oembed.thumbnailUrl,
      durationSeconds: null,
      viewCount: null,
      publishedAt: null,
      detectedLanguage: null,
    },
    transcript: "",
    segmentCount: 0,
    fetchedVia: "manual-fallback",
    manualFallbackReason:
      "YouTube blocked the automatic transcript fetch (bot protection on this server's IP). " +
      "Please open the video on YouTube, click 'Show transcript' below the description, " +
      "copy the transcript text, and paste it into the Raw Text field below. " +
      "Tip: set the YOUTUBE_SESSION_COOKIE env var on the server to enable auto-fetch.",
  };
}
