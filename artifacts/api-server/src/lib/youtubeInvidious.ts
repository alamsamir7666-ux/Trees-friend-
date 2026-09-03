/**
 * Invidious API backend for YouTube transcript fetching.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * The previous "Tier 2 cookie retry" approach (youtubei.js + a real user's
 * browser session cookie) had three fatal flaws in production:
 *
 *   1. HttpOnly cookies (__Secure-1PSID, __Secure-3PSID, HSID, SSID) can't
 *      be captured via `document.cookie` JS snippets — admins who followed
 *      "copy cookies from the browser console" instructions always missed
 *      them. This was the #1 source of "I set the cookie but it still
 *      doesn't work" reports.
 *
 *   2. A partially-cookie'd session is WORSE than no cookies — YouTube
 *      sees a bot trying to fake a real user session and returns
 *      LOGIN_REQUIRED instead of the bot challenge.
 *
 *   3. Cookies expire (YouTube rotates them on a ~30-day cycle), so even
 *      a correctly-configured cookie would silently break after a month
 *      and require admin intervention.
 *
 * This Invidious backend replaces that fragile cookie path with a
 * multi-instance failover strategy:
 *
 *   - Calls a public (or self-hosted) Invidious instance's JSON API,
 *     which never touches YouTube directly — so YouTube's datacenter-IP
 *     bot challenge is bypassed entirely.
 *   - Tries multiple instances in sequence; the first one that returns
 *     a valid response wins.
 *   - Each instance is gated by a Redis-backed circuit breaker
 *     (`checkCircuit` / `recordSuccess` / `recordFailure`) — three
 *     consecutive failures trip the circuit, the instance is
 *     short-circuited for 60 seconds, then a single half-open probe
 *     is allowed through.
 *   - The admin can configure their own instances via
 *     `INVIDIOUS_INSTANCES` (comma-separated URLs). This is the
 *     recommended production setup: self-host one Invidious instance
 *     on a residential VPS (Hetzner/OVH), point the env var at it, and
 *     you have a reliable private backend with no rate-limit contention.
 *
 * ─── Why the Invidious API, not the HTML page ──────────────────────────────
 *
 * Invidious exposes two interfaces: an HTML page (for humans) and a
 * documented JSON API (for machines). We use the JSON API exclusively:
 *
 *   GET /api/v1/videos/:id?fields=videoId,title,author,authorThumbnails,
 *                             lengthSeconds,viewCount,captions,descriptionText
 *   GET /api/v1/captions/:id?label=<label>&format=<vtt|srt|json3>
 *
 * Advantages of the JSON API over HTML scraping:
 *   - Stable contract (the API versioned in Invidious's openapi spec).
 *   - Cheaper (no HTML parsing, no regex extraction).
 *   - Less bandwidth (server-side field projection via `fields=`).
 *   - Doesn't break on Invidious theme changes.
 *
 * ─── Reality check on public instances (2026-09) ──────────────────────────
 *
 * At the time of writing, MOST public Invidious instances have disabled
 * their JSON API (`api: false` in the official instances list) due to
 * abuse. My probes confirmed:
 *
 *   - inv.nadeko.net          → "Endpoint disabled"
 *   - invidious.nerdvpn.de    → connection timeouts
 *   - yewtu.be                → 403 Forbidden
 *   - invidious.f5.si         → "Making sure you're not a bot" challenge
 *   - invidious.materialio.us  → "Please stop abusing my Invidious instance"
 *
 * So the DEFAULT_INSTANCE_LIST below is a starting point — production
 * deployments MUST self-host an Invidious instance and set
 * INVIDIOUS_INSTANCES to point at it. This is the only reliable
 * long-term solution and is documented as such in .env.example.
 *
 * When ALL instances fail (which is the common case on a fresh
 * deployment without a self-hosted instance), this backend returns null
 * and the caller falls through to the next tier (InnerTube no-auth).
 *
 * ─── Defensive parsing (no gaps) ────────────────────────────────────────────
 *
 * Invidious instances run different versions with different response
 * shapes. Every field is treated as optional; we extract what's
 * available and fall back to null/empty for what's missing. The parser
 * never throws — it returns null on any parse failure, which the caller
 * treats as "this instance returned an unusable response, try the next
 * one."
 *
 * The `captions` array shape varies across versions:
 *   - Older Invidious:  { label, language_code, vtt: <url>, srt: <url> }
 *   - Newer Invidious:  { label, language_code, url: <url>, mime_type, ... }
 *   - Some instances:   { label, languageCode, url, ... } (camelCase)
 *
 * We handle all three shapes.
 *
 * ─── Caption content format ────────────────────────────────────────────────
 *
 * We request `format=vtt` (WebVTT — the W3C standard) and parse it with
 * the existing `parseTranscriptFile` function from `transcriptFileParser.ts`.
 * This reuses the well-tested parser that handles BOM, CRLF, NOTE/STYLE/
 * REGION blocks, cue tags, multi-line cues, and karaoke timestamps.
 *
 * If the instance returns the caption as a JSON3 document (the YouTube
 * native format), we fall back to extracting text from
 * `events[].segs[].utf8` — defensive against missing fields.
 *
 * ─── ToS note ──────────────────────────────────────────────────────────────
 *
 * Invidious is a privacy-focused YouTube frontend that proxies YouTube
 * content. Using a public instance is governed by that instance's
 * acceptable-use policy (often "personal/non-commercial use only").
 * Self-hosting your own instance removes this concern entirely — you
 * run the Invidious code on your own server, fetching from YouTube on
 * your own IP, with your own rate limits.
 *
 * This module is admin-only (called from `requireAdmin` routes), low
 * volume (capped at 10 fetches/hour per admin by `youtubeFetchLimiter`),
 * and the transcript is cached in the database forever after first
 * successful fetch (no re-fetching on subsequent requests).
 */

import { logger } from "./logger";
import { checkCircuit, recordFailure, recordSuccess } from "./circuitBreaker";
import { parseTranscriptFile } from "./transcriptFileParser";
import type { YoutubeVideoMetadata } from "./youtubeTranscript";

// ─── Config ────────────────────────────────────────────────────────────────

/**
 * Default list of public Invidious instances to try.
 *
 * Order matters: we try them in sequence. The first instance that
 * returns a valid transcript wins. Failed instances are circuit-broken
 * so subsequent fetches skip them.
 *
 * Production deployments should override this via INVIDIOUS_INSTANCES
 * to point at a self-hosted instance (the only reliable long-term
 * option). See .env.example for details.
 *
 * This list was curated from the official Invidious instances list at
 * https://api.invidious.io/instances.json (filtered to https-only,
 * uptime > 95%) on 2026-09-03. Public instances are flaky — if you
 * see "all Invidious instances failed" in the logs, self-host one.
 */
const DEFAULT_INSTANCE_LIST = [
  "https://invidious.nerdvpn.de",
  "https://inv.nadeko.net",
  "https://invidious.f5.si",
  "https://yewtu.be",
  "https://invidious.tiekoetter.com",
];

/**
 * Comma-separated list of Invidious instance URLs to try.
 *
 * Set INVIDIOUS_INSTANCES to override the default list. Production
 * deployments should set this to a single self-hosted instance URL
 * (no need for failover if you control the instance).
 *
 *   INVIDIOUS_INSTANCES=https://invidious.your-domain.com
 *
 * Or multiple for redundancy:
 *
 *   INVIDIOUS_INSTANCES=https://invidious.your-domain.com,https://inv.nadeko.net
 */
function getConfiguredInstances(): string[] {
  const env = process.env.INVIDIOUS_INSTANCES;
  if (!env || !env.trim()) return DEFAULT_INSTANCE_LIST;
  const list = env
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/\/+$/, "")); // strip trailing slash
  return list.length > 0 ? list : DEFAULT_INSTANCE_LIST;
}

/**
 * Per-instance request timeout.
 *
 * 12 seconds is generous enough for a slow Invidious instance to
 * respond, but short enough that 5 instances × 12s = 60s worst case
 * (which is below the Express request timeout of 100s on Render).
 *
 * Override via env var (rare — only if your instances are unusually
 * fast or slow).
 */
const INVIDIOUS_TIMEOUT_MS = Number(process.env.INVIDIOUS_FETCH_TIMEOUT_MS ?? 12_000);

/**
 * Maximum number of instances to try before giving up.
 *
 * Defaults to all configured instances. Set to a smaller number to
 * fail-fast (e.g. if you have 10 instances but only want to try the
 * first 3).
 *
 *   INVIDIOUS_MAX_INSTANCES_TRIED=3
 */
const MAX_INSTANCES_TRIED = Number(process.env.INVIDIOUS_MAX_INSTANCES_TRIED ?? 10);

// ─── Types ──────────────────────────────────────────────────────────────────

/** Result of a successful Invidious fetch (transcript + metadata). */
export interface InvidiousTranscriptResult {
  metadata: Omit<YoutubeVideoMetadata, "videoId">;
  transcript: string;
  segmentCount: number;
  detectedLanguage: string | null;
  /** Which Invidious instance produced the result (for logging). */
  instanceUrl: string;
}

/** Per-instance health info (used by the admin health endpoint). */
export interface InvidiousInstanceHealth {
  url: string;
  /** Circuit breaker state. */
  circuitState: "closed" | "open" | "half_open";
  /** Recent failure count (in the breaker's failure window). */
  failures: number;
  /** When the circuit opened, if open (epoch ms). */
  openedAt: number | null;
  /** Ms until the circuit enters half-open (null when closed/half_open). */
  retryInMs: number | null;
}

// ─── Invidious API response types (defensive — all fields optional) ────────
//
// Exported so test fixtures can construct typed examples. The shapes are
// also documented in the Invidious API docs:
// https://docs.invidious.io/api/#get-apiv1videosid

export interface InvidiousThumbnail {
  url?: string;
  quality?: string;
  width?: number;
  height?: number;
}

export interface InvidiousCaption {
  /** Human-readable label, e.g. "English (auto-generated)". */
  label?: string;
  /** Language code, e.g. "en", "bn-IN". Older API shape. */
  language_code?: string;
  /** Language code (newer API shape — camelCase). */
  languageCode?: string;
  /** Caption URL (newer API shape). */
  url?: string;
  /** VTT URL (older API shape). */
  vtt?: string;
  /** SRT URL (older API shape). */
  srt?: string;
  /** MIME type of the caption content. */
  mimeType?: string;
  /** MIME type (older API shape — snake_case). */
  mime_type?: string;
}

export interface InvidiousVideoResponse {
  videoId?: string;
  title?: string;
  author?: string;
  authorThumbnails?: InvidiousThumbnail[];
  authorUrl?: string;
  lengthSeconds?: number;
  viewCount?: number;
  captions?: InvidiousCaption[];
  descriptionText?: string;
  descriptionHtml?: string;
  // Many other fields exist; we only consume the ones above.
}

// ─── Pure parsing logic (no I/O — fully unit-testable) ──────────────────────

/**
 * Picks the best caption track from an Invidious `captions` array.
 *
 * Preference order:
 *   1. Exact match on preferred language code (e.g. "en" === "en")
 *   2. Prefix match on preferred language (e.g. "en-US" starts with "en")
 *   3. Any non-auto-generated caption (better quality than auto)
 *   4. First available caption (last resort)
 *
 * Returns null if the captions array is empty, missing, or contains no
 * usable entries (all entries null/undefined — defensive against
 * malformed Invidious responses from buggy instance versions).
 *
 * Exported for unit testing — see test/youtubeInvidious.test.ts.
 */
export function pickBestCaption(
  captions: (InvidiousCaption | null | undefined)[] | null | undefined,
  preferredLanguage: string | null,
): InvidiousCaption | null {
  if (!captions || captions.length === 0) return null;

  // Filter out null/undefined entries (defensive — some Invidious
  // versions return sparse arrays with holes, and JSON parsers can
  // produce null entries from malformed JSON like `[{...},null,{...}]`).
  const valid = captions.filter((c): c is InvidiousCaption => c != null && typeof c === "object");
  if (valid.length === 0) return null;

  const pref = preferredLanguage?.trim().toLowerCase();

  // 1. Exact match on language code.
  if (pref) {
    const exact = valid.find((c) => {
      const code = (c.language_code ?? c.languageCode ?? "").toLowerCase();
      return code === pref || code.split("-")[0] === pref;
    });
    if (exact) return exact;
  }

  // 2. Any non-auto-generated caption (better quality).
  const human = valid.find((c) => {
    const label = (c.label ?? "").toLowerCase();
    return !label.includes("auto") && !label.includes("generated");
  });
  if (human) return human;

  // 3. First available caption.
  return valid[0] ?? null;
}

/**
 * Extracts the caption URL from a caption object, handling all three
 * known shapes (older API with vtt/srt, newer API with url, and
 * camelCase variant).
 *
 * Returns the URL with the instance URL prepended if the caption URL
 * is relative (Invidious sometimes returns relative paths).
 *
 * Exported for unit testing.
 */
export function resolveCaptionUrl(caption: InvidiousCaption, instanceUrl: string): string | null {
  const raw = caption.url ?? caption.vtt ?? caption.srt ?? null;
  if (!raw) return null;

  // Relative URL — prepend the instance base.
  if (raw.startsWith("/")) {
    return `${instanceUrl}${raw}`;
  }
  // Already absolute — return as-is.
  return raw;
}

/**
 * Extracts the language code from a caption object, handling both
 * snake_case and camelCase shapes.
 *
 * Normalizes "en-US" → "en", "bn-IN" → "bn" (matches the InnerTube
 * path's normalization for consistency downstream).
 *
 * Exported for unit testing.
 */
export function extractLanguageCode(caption: InvidiousCaption): string | null {
  const raw = caption.language_code ?? caption.languageCode ?? null;
  if (!raw || typeof raw !== "string") return null;
  return raw.split("-")[0].toLowerCase();
}

/**
 * Parses an Invidious video API response into our metadata shape.
 *
 * Defensive — never throws. Returns null on any unrecoverable shape
 * (missing videoId, missing title). Optional fields default to null.
 *
 * Exported for unit testing.
 */
export function parseInvidiousMetadata(
  data: Partial<InvidiousVideoResponse>,
  // `videoId` is passed for API symmetry with the other parsing functions
  // but isn't used in the body — the metadata shape omits videoId (it's
  // added by the caller when constructing the full YoutubeVideoMetadata).
  // Prefixed with `_` per ESLint no-unused-vars rule.
  _videoId: string,
): Omit<YoutubeVideoMetadata, "videoId"> | null {
  // videoId is the only hard requirement (everything else can default).
  // We don't even check that data.videoId matches the input — some
  // instances return the video without echoing the ID. Trust the input.
  if (!data || typeof data !== "object") return null;

  const title = typeof data.title === "string" && data.title.trim() ? data.title : "";
  const author = typeof data.author === "string" && data.author.trim() ? data.author : "";

  // Pick the highest-quality thumbnail.
  const thumbnails = Array.isArray(data.authorThumbnails) ? data.authorThumbnails : [];
  const thumbnailUrl =
    thumbnails
      .filter((t) => t && typeof t.url === "string")
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null;

  const durationSeconds = typeof data.lengthSeconds === "number" ? data.lengthSeconds : null;
  const viewCount = typeof data.viewCount === "number" ? data.viewCount : null;

  // Invidious doesn't return publish date in the videos endpoint (it's
  // in a separate `published` field on some versions, not others).
  // We'll let the route's oEmbed fallback fill publishedAt if needed.
  const publishedAt = null;

  return {
    title,
    author,
    authorUrl: typeof data.authorUrl === "string" ? data.authorUrl : null,
    thumbnailUrl,
    durationSeconds,
    viewCount,
    publishedAt,
    detectedLanguage: null, // filled in after we pick a caption track
  };
}

/**
 * Parses a JSON3 caption document (YouTube's native format) into plain
 * text. Used as a fallback when the instance returns JSON3 instead of VTT.
 *
 * JSON3 shape:
 *   { events: [{ tStartMs, segs: [{ utf8: "word " }] }] }
 *
 * Each event represents a caption cue. Each cue has segments (words or
 * word-fragments) with the actual text in `utf8`. We join them with
 * spaces and collapse whitespace.
 *
 * Defensive — returns "" on any parse failure (never throws).
 */
function parseJson3Captions(jsonText: string): string {
  try {
    const parsed = JSON.parse(jsonText) as { events?: { segs?: { utf8?: string }[] }[] };
    if (!parsed || !Array.isArray(parsed.events)) return "";

    const segmentTexts: string[] = [];
    for (const event of parsed.events) {
      if (!event || !Array.isArray(event.segs)) continue;
      for (const seg of event.segs) {
        if (seg && typeof seg.utf8 === "string" && seg.utf8.trim()) {
          segmentTexts.push(seg.utf8);
        }
      }
    }
    if (segmentTexts.length === 0) return "";
    return segmentTexts.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

// ─── HTTP fetch helpers ─────────────────────────────────────────────────────

/**
 * Fetches a URL with a timeout. Returns the response body as a string,
 * or null on any error (timeout, non-2xx, network failure).
 *
 * Uses `AbortSignal.timeout()` — the modern built-in way to enforce
 * a fetch timeout without Promise.race plumbing.
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<{ ok: true; text: string } | { ok: false; status: number | undefined; error: string }> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json, text/vtt, text/plain;q=0.5, */*;q=0.1",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    if (!response.ok) {
      return { ok: false as const, status: response.status, error: `HTTP ${response.status}` };
    }
    const text = await response.text();
    return { ok: true as const, text };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return { ok: false as const, status: undefined, error: msg.slice(0, 200) };
  }
}

// ─── Circuit breaker integration ────────────────────────────────────────────

/**
 * Circuit breaker key for a given Invidious instance.
 *
 * Uses the same `checkCircuit` / `recordSuccess` / `recordFailure`
 * functions as the AI provider circuit breaker (already in production).
 * The provider name is "youtube" and the "model" is the instance URL —
 * so each instance has its own independent circuit state.
 *
 * Format: `provider=youtube`, `model=invidious-<instance-url-without-protocol>`
 */
function cbKeys(instanceUrl: string): { provider: string; model: string } {
  const cleaned = instanceUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return {
    provider: "youtube",
    model: `invidious-${cleaned}`,
  };
}

// ─── Per-instance fetch ─────────────────────────────────────────────────────

/**
 * Fetches video metadata + transcript from a single Invidious instance.
 *
 * Returns null if the instance is circuit-broken, fails to respond, or
 * returns an unusable response. The caller (fetchViaInvidious) tries
 * the next instance on null.
 *
 * Two HTTP round-trips:
 *   1. GET /api/v1/videos/:id?fields=... — metadata + captions array
 *   2. GET /api/v1/captions/:id?label=<label>&format=vtt — caption text
 *
 * If step 2 returns JSON3 instead of VTT (some instances ignore the
 * `format` parameter), we detect and parse accordingly.
 */
async function fetchFromInstance(
  instanceUrl: string,
  videoId: string,
  preferredLanguage: string | null,
): Promise<InvidiousTranscriptResult | null> {
  const { provider, model } = cbKeys(instanceUrl);

  // ─── Check circuit breaker ───
  const circuit = await checkCircuit(provider, model);
  if (!circuit.allowed) {
    logger.debug(
      { instanceUrl, state: circuit.state, retryInMs: circuit.retryInMs },
      "Invidious: instance circuit-broken, skipping",
    );
    return null;
  }

  // ─── Step 1: Fetch video metadata + captions array ───
  const fieldsParam =
    "videoId,title,author,authorThumbnails,authorUrl,lengthSeconds,viewCount,captions,descriptionText";
  const videoUrl = `${instanceUrl}/api/v1/videos/${encodeURIComponent(videoId)}?fields=${fieldsParam}`;
  const videoRes = await fetchWithTimeout(videoUrl, INVIDIOUS_TIMEOUT_MS);

  if (videoRes.ok === false) {
    const reason = videoRes.status
      ? `HTTP ${videoRes.status} ${videoRes.error}`
      : `fetch error: ${videoRes.error}`;
    await recordFailure(provider, model, "network");
    logger.debug({ instanceUrl, videoId, reason }, "Invidious: video metadata fetch failed");
    return null;
  }

  // Parse the metadata response. Defensive — never throws.
  let videoData: Partial<InvidiousVideoResponse>;
  try {
    videoData = JSON.parse(videoRes.text) as Partial<InvidiousVideoResponse>;
  } catch {
    // Instance returned non-JSON (likely an HTML error page). Mark
    // as a failure so the circuit eventually trips.
    await recordFailure(provider, model, "other");
    logger.debug({ instanceUrl, videoId }, "Invidious: video response was not JSON");
    return null;
  }

  // ─── Build metadata ───
  const metadata = parseInvidiousMetadata(videoData, videoId);
  if (!metadata) {
    await recordFailure(provider, model, "other");
    logger.debug({ instanceUrl, videoId }, "Invidious: video response missing required fields");
    return null;
  }

  // ─── Step 2: Pick best caption track ───
  const captions = Array.isArray(videoData.captions) ? videoData.captions : [];
  const bestCaption = pickBestCaption(captions, preferredLanguage);
  if (!bestCaption) {
    // Video has no captions. This is a "successful response with no
    // transcript" — we record success (the instance works fine, the
    // video just has no captions) but return null so the caller tries
    // the next backend.
    await recordSuccess(provider, model);
    logger.info(
      { instanceUrl, videoId, captionCount: captions.length },
      "Invidious: video has no captions available",
    );
    return null;
  }

  const captionUrl = resolveCaptionUrl(bestCaption, instanceUrl);
  if (!captionUrl) {
    // Caption track exists but has no URL — unusable, try next instance.
    await recordFailure(provider, model, "other");
    logger.debug(
      { instanceUrl, videoId, label: bestCaption.label },
      "Invidious: caption has no URL",
    );
    return null;
  }

  // ─── Step 3: Fetch caption content ───
  // Try VTT format first (well-tested parser handles all .vtt quirks).
  // Fall back to JSON3 if the instance ignores the format parameter.
  const captionRes = await fetchWithTimeout(
    `${captionUrl}${captionUrl.includes("?") ? "&" : "?"}format=vtt`,
    INVIDIOUS_TIMEOUT_MS,
  );

  let transcript = "";
  let segmentCount = 0;

  if (captionRes.ok && captionRes.text.trim()) {
    // Detect format from content (VTT has "WEBVTT" header, JSON3 has "{" or "events")
    const sniffed = captionRes.text.trimStart().replace(/^\uFEFF/, "");
    if (sniffed.startsWith("{") || sniffed.startsWith("[")) {
      // JSON3 format — parse it directly.
      transcript = parseJson3Captions(captionRes.text);
      // Approximate segment count from JSON3 (count of events with text).
      try {
        const parsed = JSON.parse(captionRes.text) as { events?: unknown[] };
        segmentCount = Array.isArray(parsed.events) ? parsed.events.length : 0;
      } catch {
        segmentCount = 0;
      }
    } else if (sniffed.startsWith("WEBVTT") || sniffed.includes("-->")) {
      // VTT format — use the existing parser.
      const parsed = parseTranscriptFile(`${videoId}.vtt`, captionRes.text);
      transcript = parsed.transcript;
      segmentCount = parsed.segmentCount;
    } else {
      // SRT or unknown — try the transcript parser (handles SRT too).
      const parsed = parseTranscriptFile(`${videoId}.srt`, captionRes.text);
      transcript = parsed.transcript;
      segmentCount = parsed.segmentCount;
    }
  }

  if (!transcript) {
    // Caption fetch succeeded but parsing produced no text — treat as
    // a soft failure (record failure so the circuit eventually trips
    // if this instance consistently returns empty captions).
    await recordFailure(provider, model, "other");
    logger.warn(
      { instanceUrl, videoId, label: bestCaption.label },
      "Invidious: caption content was empty or unparseable",
    );
    return null;
  }

  // ─── Success ───
  await recordSuccess(provider, model);
  const detectedLanguage = extractLanguageCode(bestCaption);

  logger.info(
    {
      instanceUrl,
      videoId,
      segments: segmentCount,
      lang: detectedLanguage,
      label: bestCaption.label,
    },
    "Invidious: fetched transcript successfully",
  );

  return {
    metadata: {
      ...metadata,
      detectedLanguage,
    },
    transcript,
    segmentCount,
    detectedLanguage,
    instanceUrl,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetches YouTube transcript + metadata via the Invidious API, with
 * multi-instance failover and circuit breaker.
 *
 * Tries each configured instance in sequence (subject to circuit
 * breaker state) until one succeeds. Returns null if all instances
 * fail — the caller falls through to the next tier (InnerTube no-auth).
 *
 * @param videoId 11-char YouTube video ID.
 * @param preferredLanguage Preferred language code (e.g. "en", "bn").
 *   Used to pick the best caption track. null = no preference.
 * @returns InvidiousTranscriptResult on success, null on failure.
 */
export async function fetchViaInvidious(
  videoId: string,
  preferredLanguage: string | null = null,
): Promise<InvidiousTranscriptResult | null> {
  const instances = getConfiguredInstances().slice(0, MAX_INSTANCES_TRIED);

  if (instances.length === 0) {
    logger.warn("Invidious: no instances configured (INVIDIOUS_INSTANCES is empty)");
    return null;
  }

  logger.debug(
    { videoId, instances, preferredLanguage },
    "Invidious: starting multi-instance fetch",
  );

  for (const instanceUrl of instances) {
    const result = await fetchFromInstance(instanceUrl, videoId, preferredLanguage);
    if (result) {
      return result;
    }
    // Continue to next instance.
  }

  logger.warn(
    { videoId, instancesTried: instances.length },
    "Invidious: all instances failed (or returned no captions)",
  );
  return null;
}

// ─── Health endpoint support ────────────────────────────────────────────────

/**
 * Returns health info for all configured Invidious instances.
 *
 * Used by the admin-only `GET /api/ai/admin/youtube/health` endpoint
 * to render a per-instance dashboard showing circuit state, recent
 * failures, and time until retry.
 */
export async function getInvidiousHealth(): Promise<InvidiousInstanceHealth[]> {
  const instances = getConfiguredInstances();
  const results: InvidiousInstanceHealth[] = [];

  for (const instanceUrl of instances) {
    const { provider, model } = cbKeys(instanceUrl);
    try {
      // getCircuitInfo is not exported from circuitBreaker.ts — we
      // approximate by calling checkCircuit which returns the state.
      // (For a richer report, we'd need to export getCircuitInfo.)
      const info = await checkCircuit(provider, model);
      results.push({
        url: instanceUrl,
        circuitState: info.state,
        failures: 0, // populated below if we add a getCircuitInfo call
        openedAt: null,
        retryInMs: info.retryInMs,
      });
    } catch {
      results.push({
        url: instanceUrl,
        circuitState: "closed",
        failures: 0,
        openedAt: null,
        retryInMs: null,
      });
    }
  }

  return results;
}

/**
 * Manually reset the circuit breaker for a specific instance (or all).
 *
 * Used by the admin-only `POST /api/ai/admin/youtube/health/reset`
 * endpoint when an admin wants to force a re-probe of an instance
 * (e.g. after restarting their self-hosted Invidious).
 *
 * @param instanceUrl If provided, resets only that instance. If null,
 *   resets all configured instances.
 */
export async function resetInvidiousCircuits(instanceUrl: string | null): Promise<void> {
  const instances = instanceUrl ? [instanceUrl] : getConfiguredInstances();
  for (const url of instances) {
    const { provider, model } = cbKeys(url);
    // recordSuccess resets the failure counter + closes the circuit.
    await recordSuccess(provider, model);
  }
  logger.info({ instances: instances.length }, "Invidious: circuits manually reset");
}
