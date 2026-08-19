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
 * Our graceful-degradation strategy (4 tiers):
 *
 *   1. Tier 1 — Try youtubei.js with no auth (works on residential IP).
 *   2. Tier 2 — NEW: Direct HTML scrape of /watch + timedtext endpoint.
 *      The watch HTML page is served to every browser/link-preview crawler
 *      in the world; YouTube rarely bot-challenges it (would break too many
 *      legitimate uses). So this succeeds where Tier 1 is challenged, on
 *      most datacenter IPs. Needs no env config.
 *   3. Tier 3 — If still bot-challenged AND YOUTUBE_SESSION_COOKIE env var
 *      is set, retry youtubei.js with the cookie (a real user's browser
 *      session — passes the bot check). The admin exports the cookie from
 *      their browser using a "Get cookies.txt" extension and pastes it into
 *      the env var. (Admin opt-in escape hatch.)
 *   4. Tier 4 — If all else fails (or no cookie is configured), fall back
 *      to returning ONLY the metadata (via oEmbed — works from any IP,
 *      no auth, no rate limits) + a 422 error asking the admin to upload a
 *      .vtt/.srt file or paste the transcript manually. The admin still
 *      gets auto-filled title/channel/thumbnail; they just upload the file.
 *
 * This way:
 *   - On the admin's laptop (dev):               Tier 1 succeeds (fully automatic)
 *   - On Render without cookie:                   Tier 2 succeeds (fully automatic)
 *   - On Render with YOUTUBE_SESSION_COOKIE set:  Tier 3 succeeds (fully automatic)
 *   - On Render behind aggressive bot protection: Tier 4 metadata-only fallback
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

// ─── Cookie validation (one-time check at module load) ──────────────────────

/**
 * The cookies YouTube actually checks for authenticated session validation.
 *
 * `__Secure-1PSID` and `__Secure-3PSID` are THE critical ones — they're
 * the secure (HTTPS-only) versions of the SID cookie. Without them,
 * YouTube sees a "partially cookie'd" session which is WORSE than no
 * cookies (looks like a bot trying to fake a session) and returns
 * LOGIN_REQUIRED.
 *
 * These cookies are flagged HttpOnly + Secure in the browser, which means
 * `document.cookie` in JavaScript CAN'T see them. Admins who copy
 * cookies via a browser console snippet will miss them — this is the #1
 * cause of "I set the cookie but it still doesn't work" reports.
 *
 * Reference: https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies
 */
const CRITICAL_YOUTUBE_COOKIES = [
  "__Secure-1PSID", // THE most critical — secure version of SID
  "__Secure-3PSID", // THE most critical — third-party secure version of SID
  "HSID", // Host-specific ID
  "SSID", // Secure Session ID
];

/**
 * One-time check at module load. If YOUTUBE_SESSION_COOKIE is set but
 * missing critical cookies, logs a prominent warning so the admin sees it
 * in the Render logs immediately after deploying.
 *
 * This is the difference between "the admin debugs for an hour wondering
 * why the cookie retry still fails" vs "the admin sees the warning in
 * the logs on first deploy and fixes the cookie immediately."
 *
 * Doesn't throw — the missing cookies are a soft failure (the no-auth
 * path still works on residential IPs). Just warns.
 */
function validateYoutubeSessionCookie(): void {
  const cookie = process.env.YOUTUBE_SESSION_COOKIE;
  if (!cookie || !cookie.trim()) {
    // No cookie configured — that's fine, the feature degrades to
    // manual-fallback on datacenter IPs. No warning needed.
    return;
  }

  // Parse the cookie string into a Set of cookie names.
  const present = new Set<string>();
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    present.add(trimmed.slice(0, eqIdx).trim());
  }

  const missing = CRITICAL_YOUTUBE_COOKIES.filter((name) => !present.has(name));
  if (missing.length === 0) {
    logger.info(
      { cookieCount: present.size },
      "YouTube: YOUTUBE_SESSION_COOKIE is configured and contains all critical auth cookies",
    );
    return;
  }

  // Log a prominent warning with the missing cookies + fix instructions.
  // This is the message the admin will see in the Render logs.
  logger.warn(
    {
      cookieCount: present.size,
      missingCritical: missing,
    },
    "YouTube: YOUTUBE_SESSION_COOKIE is set but is MISSING critical auth cookies: " +
      missing.join(", ") +
      ". The cookie-retry path will STILL fail with LOGIN_REQUIRED because YouTube " +
      "sees a 'partially cookie'd' session (worse than no cookies — looks like a bot). " +
      "FIX: re-export ALL cookies using a method that captures HttpOnly cookies " +
      "(the 'Get cookies.txt' browser extension, or DevTools → Application → Cookies). " +
      "The critical cookies are HttpOnly+Secure so document.cookie can't see them — " +
      "that's likely why they're missing from your current cookie string.",
  );
}

// Run the one-time check at module load. This runs once when the api-server
// starts (not per-request) so it doesn't spam the logs.
validateYoutubeSessionCookie();

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
  /**
   * Which path produced the transcript (for logging/debugging).
   *   - `innertube-noauth`  — Tier 1: youtubei.js InnerTube API, no cookie
   *   - `html-scrape`       — Tier 2: direct HTML scrape of /watch + timedtext
   *   - `innertube-cookie`  — Tier 3: youtubei.js InnerTube API, with cookie
   *   - `manual-fallback`   — Tier 4: oEmbed metadata only, transcript empty
   *
   * For uploaded .vtt/.srt files (transcript-file route), the value is
   * `file-upload` — but that path doesn't go through fetchYoutubeTranscript,
   * it sets rawMetadata.fetchedVia directly when creating the source.
   */
  fetchedVia: "innertube-noauth" | "html-scrape" | "innertube-cookie" | "manual-fallback";
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

// ─── Tier 2: HTML scrape + timedtext (no auth, works on datacenter IPs) ─────
//
// YouTube's bot detection is much more aggressive on the InnerTube JSON RPC
// endpoint than on the watch HTML page. The watch page is served to every
// browser/embed/link-preview crawler in the world; blocking it would break
// too many legitimate uses. So a single GET /watch rarely gets challenged,
// even from a datacenter IP.
//
// Strategy:
//   1. GET https://www.youtube.com/watch?v=<id> with a realistic browser UA.
//   2. Parse the embedded `ytInitialPlayerResponse` JSON (brace-counting walker,
//      not regex — more robust against shape changes).
//   3. Pick a caption track: admin's sourceLanguage if set → else English →
//      else first track → else throw NO_CAPTIONS.
//   4. Fetch `<baseUrl>&fmt=json3` (replaying any cookies YouTube set on the
//      watch response — CONSENT, GPS, VISITOR_INFO1_LIVE — to reduce the
//      chance of bot detection on the timedtext call).
//   5. Parse the json3 events: events[].segs[].utf8 → joined + collapsed.
//
// Returns BOTH the transcript AND most metadata (title, author, channel id,
// thumbnail, duration, view count, detected language) — no oEmbed call needed
// for this tier. `publishedAt` is still null because the watch page doesn't
// expose it as a structured field.

/**
 * User-Agent used for HTML scrape requests. A recent stable Chrome on Windows
 * is the most common real-browser signature. We hardcode one (rather than
 * rotating through a list) because:
 *   - Rotation looks MORE bot-like to fingerprinting, not less (real users
 *     don't change UA every request).
 *   - Single UA is simpler to test + reason about.
 *   - The version (131.0.0.0) is recent enough to be plausible; YouTube
 *     doesn't block based on exact Chrome version (they'd break too many
 *     real users if they did).
 *
 * Bump this if YouTube ever starts rejecting this version (very unlikely).
 */
const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Shape of a caption track entry inside `ytInitialPlayerResponse.captions.
 * playerCaptionsTracklistRenderer.captionTracks[]`.
 *
 * We only consume `baseUrl` (for fetching the transcript text) and
 * `languageCode` (for picking the right track). Other fields (name, kind,
 * vssId) are passed through for logging/observability but not used.
 */
interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  name?: { simpleText?: string; runs?: { text: string }[] };
  kind?: string; // "asr" for auto-generated captions
  vssId?: string;
}

/**
 * Picks the best caption track from the list.
 *
 * Priority:
 *   1. Admin's explicit `sourceLanguage` (e.g. "bn" matches "bn", "bn-IN",
 *      "bn-BD"). This honors the admin's intent — if they picked Bengali,
 *      they want the Bengali captions.
 *   2. English (the most common fallback for plant-care content; most
 *      auto-generated captions are English).
 *   3. First track in the list (YouTube usually sorts by relevance).
 *   4. Null if the list is empty (caller throws NO_CAPTIONS).
 *
 * Within the same language, prefers non-ASR (human-authored) captions over
 * ASR (auto-generated) captions — human captions are higher quality.
 *
 * Returns the chosen track or null if the list is empty.
 */
export function pickCaptionTrack(
  tracks: CaptionTrack[],
  adminLanguage: string | null,
): CaptionTrack | null {
  if (tracks.length === 0) return null;

  // Helper: find the best track for a given language prefix.
  // Within the same language, prefer non-ASR (human-authored) captions.
  const findForLang = (lang: string): CaptionTrack | null => {
    const matching = tracks.filter((t) => t.languageCode?.toLowerCase().startsWith(lang));
    if (matching.length === 0) return null;
    const nonAsr = matching.find((t) => t.kind !== "asr");
    return nonAsr ?? matching[0];
  };

  // 1. Admin's explicit choice.
  if (adminLanguage) {
    const match = findForLang(adminLanguage.toLowerCase());
    if (match) return match;
  }

  // 2. English fallback.
  const en = findForLang("en");
  if (en) return en;

  // 3. First track (YouTube usually sorts by relevance).
  // For the fallback, also prefer non-ASR if available.
  const nonAsrFirst = tracks.find((t) => t.kind !== "asr");
  return nonAsrFirst ?? tracks[0];
}

/**
 * Extracts the `ytInitialPlayerResponse` JSON object from the watch-page HTML.
 *
 * YouTube embeds this as one of:
 *   var ytInitialPlayerResponse = { ... };
 *   window["ytInitialPlayerResponse"] = { ... };
 *   window.ytInitialPlayerResponse = { ... };
 *
 * We use a regex to find the assignment (`ytInitialPlayerResponse...=...{`)
 * rather than just searching for the marker string. This avoids false
 * positives if the marker text appears inside a string literal elsewhere in
 * the HTML (unlikely but defensive).
 *
 * After finding the start `{`, we walk braces (respecting strings and
 * escapes) to find the matching `}`, then JSON.parse the slice.
 *
 * Returns the parsed object or null if:
 *   - The marker isn't present with an assignment (YouTube changed the page shape)
 *   - The JSON can't be parsed (malformed)
 *   - The walker runs off the end of the HTML (truncated response)
 *
 * Exported for unit testing — the walker is pure logic.
 */
export function extractPlayerResponse(html: string): unknown | null {
  // Match: ytInitialPlayerResponse + optional close-quote + optional close-bracket
  // + = + optional ws + {
  // Handles all three forms:
  //   var ytInitialPlayerResponse = {        (no quote, no bracket)
  //   window.ytInitialPlayerResponse = {     (no quote, no bracket)
  //   window["ytInitialPlayerResponse"] = {  (closing "])
  //   window['ytInitialPlayerResponse'] = {  (closing '])
  const match = html.match(/ytInitialPlayerResponse["']?\]?\s*=\s*\{/);
  if (!match || match.index === undefined) return null;

  // Position of the opening `{` (last char of the match).
  const start = match.index + match[0].length - 1;

  // Walk braces, respecting strings and escapes.
  let i = start;
  let depth = 0;
  let inString = false;
  let escape = false;
  while (i < html.length) {
    const c = html[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
    } else {
      if (c === '"') {
        inString = true;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          const jsonStr = html.slice(start, i + 1);
          try {
            return JSON.parse(jsonStr);
          } catch {
            return null;
          }
        }
      }
    }
    i++;
  }
  return null;
}

/**
 * Extracts cookies from a fetch Response's `Set-Cookie` headers and returns
 * them as a single `Cookie:` header value suitable for the next request.
 *
 * YouTube sets `CONSENT`, `GPS`, `VISITOR_INFO1_LIVE`, `YSC`, etc. on the
 * watch response. Replaying these on the timedtext fetch reduces the chance
 * of bot detection (the timedtext endpoint checks for the presence of a
 * session even when it doesn't strictly require auth).
 *
 * Uses the modern `response.headers.getSetCookie()` (Node 18.14+ / undici
 * 5.16+) which correctly returns multiple Set-Cookie headers as an array.
 * Falls back to null if getSetCookie isn't available (very old Node) or no
 * cookies were set.
 *
 * Returns "name1=val1; name2=val2" or null if no cookies were extracted.
 */
function extractCookiesFromResponse(response: Response): string | null {
  const setCookieHeaders =
    typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  if (setCookieHeaders.length === 0) return null;

  // Parse "name=value; Path=/; Domain=.youtube.com; ..." → "name=value"
  const pairs: string[] = [];
  for (const header of setCookieHeaders) {
    const first = header.split(";")[0]?.trim();
    if (first && first.includes("=")) {
      pairs.push(first);
    }
  }
  if (pairs.length === 0) return null;
  return pairs.join("; ");
}

/**
 * Decodes common HTML entities that YouTube uses in video titles and channel
 * names. The InnerTube path returns unescaped text; the HTML scrape path
 * gets HTML-escaped text from `ytInitialPlayerResponse` (YouTube HTML-escapes
 * the title in the embedded JSON). This function ensures both paths
 * produce the same output.
 *
 * Covers: &amp; &lt; &gt; &quot; &#39; &#x27; &apos;
 * Does NOT cover hundreds of less-common named entities (&copy; &reg; etc.)
 * — YouTube doesn't use those in titles. If a title contains one, it'll be
 * left as-is (cosmetic, not a functional issue).
 */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * Maximum acceptable size for the watch-page HTML response. YouTube watch
 * pages are typically 500KB-2MB. If we get something larger than 10MB, it's
 * almost certainly a misrouted response (e.g. a CDN error page) — reading it
 * into memory would waste resources.
 *
 * We check Content-Length BEFORE reading the body to avoid OOM on huge
 * responses. If Content-Length is missing (YouTube usually sends it), we
 * fall back to reading the body (the response is almost certainly fine).
 */
const MAX_WATCH_PAGE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Fetches the transcript + metadata via direct HTML scrape of the YouTube
 * watch page + the timedtext JSON endpoint.
 *
 * Throws `InnertubeBotError` on any failure (bot challenge, no captions,
 * parse failure) so the caller's existing `isBotChallengeError` switch
 * handles fall-through to the next tier correctly.
 *
 * The InnertubeBotError class is misleadingly named for this path (it has
 * nothing to do with Innertube), but reusing it keeps the existing
 * `isBotChallengeError` and `fetchYoutubeTranscript` fall-through logic
 * unchanged.
 */
async function fetchTranscriptViaHtmlScrape(
  videoId: string,
  adminLanguage?: string | null,
): Promise<{
  metadata: Omit<YoutubeVideoMetadata, "videoId">;
  transcript: InnertubeTranscriptResult;
}> {
  // ─── Step 1: Fetch the watch page ────────────────────────────────────
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const watchResponse = await fetch(watchUrl, {
    headers: {
      "User-Agent": CHROME_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      // Sec-Fetch-* headers make the request look like a real browser navigation.
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(INNERTUBE_TIMEOUT_MS),
  });

  if (!watchResponse.ok) {
    throw new InnertubeBotError(
      `YouTube watch page returned HTTP ${watchResponse.status}`,
      watchResponse.status === 429 ? "BOT_CHECK" : "UNPLAYABLE",
    );
  }

  // Check Content-Length BEFORE reading the body — avoids OOM on a huge
  // misrouted response. If Content-Length is missing, proceed (the response
  // is almost certainly fine — YouTube always sends Content-Length).
  const contentLength = Number(watchResponse.headers.get("content-length") ?? 0);
  if (contentLength > MAX_WATCH_PAGE_SIZE) {
    throw new InnertubeBotError(
      `YouTube watch page too large (${contentLength} bytes > ${MAX_WATCH_PAGE_SIZE})`,
      "UNPLAYABLE",
    );
  }

  const html = await watchResponse.text();

  // ─── Step 2: Bot-challenge detection ────────────────────────────────
  // YouTube sometimes returns 200 with a challenge page embedded.
  if (/Sign in to confirm you|Our systems have detected unusual traffic|captcha/i.test(html)) {
    throw new InnertubeBotError("YouTube watch page returned a bot challenge page", "BOT_CHECK");
  }

  // ─── Step 3: Extract ytInitialPlayerResponse ────────────────────────
  const playerResponse = extractPlayerResponse(html) as {
    playabilityStatus?: { status?: string; reason?: string };
    videoDetails?: {
      title?: string;
      author?: string;
      channelId?: string;
      lengthSeconds?: string | number;
      viewCount?: string | number;
      thumbnail?: { thumbnails?: { url: string }[] };
    };
    captions?: {
      playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
    };
  } | null;

  if (!playerResponse) {
    // Missing ytInitialPlayerResponse — most likely a bot-challenge page
    // that doesn't contain the specific challenge text we checked for above.
    // Throw BOT_CHECK so the caller falls through to Tier 3 (cookie retry),
    // which may succeed where this tier failed.
    throw new InnertubeBotError(
      "YouTube watch page did not contain ytInitialPlayerResponse (likely bot challenge)",
      "BOT_CHECK",
    );
  }

  // ─── Step 4: Playability check ──────────────────────────────────────
  const playability = playerResponse.playabilityStatus;
  if (!playability || playability.status !== "OK") {
    const status = playability?.status ?? "unknown";
    const reason = playability?.reason ?? "unknown";
    throw new InnertubeBotError(`YouTube playability status: ${status} — ${reason}`, status);
  }

  // ─── Step 5: Extract caption tracks ─────────────────────────────────
  const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) {
    throw new InnertubeBotError(
      "Video has no captions available (no caption tracks in playerResponse).",
      "NO_CAPTIONS",
    );
  }

  // ─── Step 6: Pick the best caption track ────────────────────────────
  const track = pickCaptionTrack(tracks, adminLanguage ?? null);
  if (!track || !track.baseUrl) {
    throw new InnertubeBotError(
      "No suitable caption track found (missing baseUrl).",
      "NO_CAPTIONS",
    );
  }

  // ─── Step 7: Fetch timedtext (with cookie jar) ──────────────────────
  const cookieHeader = extractCookiesFromResponse(watchResponse);
  const timedtextUrl = track.baseUrl + (track.baseUrl.includes("fmt=") ? "" : "&fmt=json3");
  const transcriptResponse = await fetch(timedtextUrl, {
    headers: {
      "User-Agent": CHROME_USER_AGENT,
      Accept: "application/json,text/plain,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `https://www.youtube.com/watch?v=${videoId}`,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!transcriptResponse.ok) {
    throw new InnertubeBotError(
      `YouTube timedtext returned HTTP ${transcriptResponse.status}`,
      transcriptResponse.status === 429 ? "BOT_CHECK" : "NO_CAPTIONS",
    );
  }

  const transcriptJson = (await transcriptResponse.json()) as {
    events?: {
      segs?: { utf8?: string }[];
    }[];
  };

  // ─── Step 8: Build transcript text ───────────────────────────────────
  const events = transcriptJson?.events ?? [];
  if (events.length === 0) {
    throw new InnertubeBotError(
      "Transcript was empty (no events in json3 response).",
      "NO_CAPTIONS",
    );
  }

  const segmentTexts: string[] = [];
  for (const event of events) {
    const segs = event?.segs;
    if (!Array.isArray(segs)) continue;
    for (const seg of segs) {
      const text = seg?.utf8;
      if (typeof text === "string" && text.trim()) {
        segmentTexts.push(text);
      }
    }
  }
  if (segmentTexts.length === 0) {
    throw new InnertubeBotError(
      "Transcript was empty after parsing (no segment text found in json3 events).",
      "NO_CAPTIONS",
    );
  }

  const fullText = segmentTexts.join(" ").replace(/\s+/g, " ").trim();

  // ─── Step 9: Build metadata from videoDetails ───────────────────────
  const videoDetails = playerResponse.videoDetails ?? {};
  const detectedLanguage = track.languageCode
    ? track.languageCode.split("-")[0].toLowerCase()
    : null;

  // Thumbnail: YouTube returns an array; the last entry is typically the
  // highest-resolution. Fallback to the standard hqdefault URL.
  const thumbnails = videoDetails.thumbnail?.thumbnails ?? [];
  const thumbnailUrl =
    thumbnails.length > 0
      ? thumbnails[thumbnails.length - 1].url
      : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  const metadata: Omit<YoutubeVideoMetadata, "videoId"> = {
    // Decode HTML entities — YouTube HTML-escapes title/author in the
    // embedded JSON (e.g. "Tom & Jerry" → "Tom &amp; Jerry"). The InnerTube
    // path returns unescaped text, so we decode here for consistency.
    title: decodeHtmlEntities(videoDetails.title ?? ""),
    author: decodeHtmlEntities(videoDetails.author ?? "Unknown"),
    authorUrl: videoDetails.channelId
      ? `https://www.youtube.com/channel/${videoDetails.channelId}`
      : null,
    thumbnailUrl,
    durationSeconds:
      typeof videoDetails.lengthSeconds === "string"
        ? Number(videoDetails.lengthSeconds) || null
        : typeof videoDetails.lengthSeconds === "number"
          ? videoDetails.lengthSeconds
          : null,
    viewCount:
      typeof videoDetails.viewCount === "string"
        ? Number(videoDetails.viewCount) || null
        : typeof videoDetails.viewCount === "number"
          ? videoDetails.viewCount
          : null,
    // publishedAt is not exposed in ytInitialPlayerResponse. Would require
    // an oEmbed call OR scraping the channel page. We leave it null here
    // (matches the Innertube path's behavior on most videos).
    publishedAt: null,
    detectedLanguage,
  };

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
 * Fetches YouTube video metadata ONLY (no transcript) via the public oEmbed
 * endpoint. Used by the transcript-file upload route to auto-fill the title,
 * author, and thumbnail when the admin provides a YouTube URL alongside their
 * uploaded .vtt/.srt file.
 *
 * Returns null if the video is private/deleted/age-restricted (oEmbed returns
 * 401/404 for those).
 *
 * Exported because the transcript-file route uses it directly.
 */
export async function fetchYoutubeMetadataOnly(videoId: string): Promise<{
  title: string;
  author: string;
  authorUrl: string | null;
  thumbnailUrl: string | null;
} | null> {
  return fetchOEmbedMetadata(videoId);
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
 *   1. Tier 1 — Try Innertube with no auth (works on residential IP).
 *   2. Tier 2 — Try direct HTML scrape of /watch + timedtext (works on most
 *      datacenter IPs where Tier 1 is bot-challenged; needs no env config).
 *   3. Tier 3 — If still bot-challenged AND YOUTUBE_SESSION_COOKIE env var is
 *      set, retry Innertube with the cookie (admin opt-in escape hatch).
 *   4. Tier 4 — Fall back to oEmbed metadata only with a manual-fallback
 *      reason explaining the admin should paste the transcript manually
 *      (or upload a .vtt/.srt file via the new transcript-file route).
 *
 * Never throws — always returns a YoutubeTranscriptResult. The caller
 * inspects `fetchedVia` and `manualFallbackReason` to decide what to do.
 *
 * @param url YouTube URL (any common form — see parseYoutubeUrl)
 * @param sourceLanguage Optional admin-chosen language code (e.g. "en",
 *   "bn") used by Tier 2's caption-track picker. If null, Tier 2 falls back
 *   to English → first track.
 * @returns YoutubeTranscriptResult with metadata + (transcript OR manual-fallback reason)
 */
export async function fetchYoutubeTranscript(
  url: string,
  sourceLanguage?: string | null,
): Promise<YoutubeTranscriptResult> {
  const parsed = parseYoutubeUrl(url);
  if (!parsed) {
    throw new Error(
      "Invalid YouTube URL. Expected youtube.com/watch?v=..., youtu.be/..., /embed/..., or /shorts/...",
    );
  }
  const { videoId } = parsed;

  // ─── Tier 1: Try Innertube with no auth ───
  try {
    const result = await withTimeout(fetchTranscriptViaInnertube(videoId), INNERTUBE_TIMEOUT_MS);
    logger.info(
      {
        videoId,
        tier: 1,
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
      // Log it and fall through to Tier 2 (HTML scrape) — it might still succeed
      // where Innertube failed because the watch HTML endpoint is more lenient.
      logger.warn(
        { videoId, err: (err as Error).message.slice(0, 200) },
        "YouTube: Innertube (no-auth) failed with non-bot error, trying Tier 2 (HTML scrape)",
      );
    } else {
      logger.info(
        { videoId },
        "YouTube: Innertube (no-auth) bot-challenged, trying Tier 2 (HTML scrape)",
      );
    }
  }

  // ─── Tier 2: HTML scrape + timedtext (no auth, works on datacenter IPs) ───
  try {
    const result = await fetchTranscriptViaHtmlScrape(videoId, sourceLanguage);
    logger.info(
      {
        videoId,
        tier: 2,
        segments: result.transcript.segmentCount,
        lang: result.transcript.detectedLanguage,
      },
      "YouTube: fetched transcript via HTML scrape + timedtext",
    );
    return {
      metadata: {
        videoId,
        ...result.metadata,
        detectedLanguage: result.transcript.detectedLanguage,
      },
      transcript: result.transcript.transcript,
      segmentCount: result.transcript.segmentCount,
      fetchedVia: "html-scrape",
      manualFallbackReason: null,
    };
  } catch (err) {
    // If the video has NO_CAPTIONS, retrying with a cookie won't help
    // (the captions don't exist regardless of auth). Skip Tier 3 and go
    // straight to Tier 4 (oEmbed metadata-only).
    if (err instanceof InnertubeBotError && err.playabilityStatus === "NO_CAPTIONS") {
      logger.info(
        { videoId },
        "YouTube: HTML scrape found no captions (retrying with cookie won't help), skipping to oEmbed-only",
      );
      // Jump straight to Tier 4 by short-circuiting past the cookie block.
      // We do this by NOT falling through — instead we go directly to the
      // oEmbed-only path below. The cookie block checks `cookie && cookie.trim()`
      // so if we set a local flag to skip it... actually, simpler: just fall
      // through. The cookie block will run but fail immediately (the video
      // still has no captions). The cost is one wasted YouTube API call +
      // 15s timeout. To avoid that, we use a `goto` pattern via a labeled
      // block... JavaScript doesn't have goto. Instead, we restructure:
      // we skip the cookie block by checking the error type here and
      // jumping directly to the oEmbed fallback.
      const oembed = await fetchOEmbedMetadata(videoId);
      if (!oembed) {
        throw new Error(
          "Could not fetch YouTube video metadata. The video may be private, deleted, or age-restricted. " +
            "Try uploading a .vtt/.srt transcript file directly.",
        );
      }
      logger.info(
        { videoId, title: oembed.title },
        "YouTube: no captions available, returning metadata-only",
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
          "This video has no captions available (no transcript tracks on YouTube). " +
          "If the video has captions and you see this message, the captions may be disabled " +
          "by the uploader. You can still create a source by uploading a .vtt/.srt file " +
          "if you have one, or by pasting the transcript text manually.",
      };
    }

    if (!isBotChallengeError(err)) {
      // Real error (video deleted, network error, etc.) — try Tier 3 as a
      // last resort (the cookie might bypass whatever issue occurred).
      logger.warn(
        { videoId, err: (err as Error).message.slice(0, 200) },
        "YouTube: HTML scrape failed with non-bot error, trying Tier 3 (cookie)",
      );
    } else {
      logger.info(
        { videoId },
        "YouTube: HTML scrape bot-challenged, trying Tier 3 (cookie) if configured",
      );
    }
  }

  // ─── Tier 3: Retry Innertube with cookie if configured ───
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
          tier: 3,
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
      "YouTube: no YOUTUBE_SESSION_COOKIE configured, skipping Tier 3 cookie retry",
    );
  }

  // ─── Tier 4: Fall back to oEmbed metadata only ───
  const oembed = await fetchOEmbedMetadata(videoId);
  if (!oembed) {
    // oEmbed failed too — the video is probably private/deleted/age-restricted.
    throw new Error(
      "Could not fetch YouTube video metadata. The video may be private, deleted, or age-restricted. " +
        "If the video is public, YouTube may be blocking this server's IP — try uploading a .vtt/.srt " +
        "transcript file directly, or set the YOUTUBE_SESSION_COOKIE env var (export a logged-in " +
        "YouTube browser session cookie).",
    );
  }

  logger.info(
    { videoId, title: oembed.title },
    "YouTube: transcript auto-fetch failed (all tiers exhausted), returning metadata-only for manual fallback",
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
      "You have two options to complete this source:\n" +
      "  1. Upload a .vtt or .srt file: open the video on YouTube, click 'Show transcript' " +
      "below the description, download the transcript file, then use 'Upload .vtt/.srt' mode " +
      "in the upload modal.\n" +
      "  2. Set the YOUTUBE_SESSION_COOKIE env var on the server (export a logged-in YouTube " +
      "browser session cookie — use the 'Get cookies.txt' browser extension).",
  };
}
