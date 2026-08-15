/**
 * Lakera Guard provider — hosted prompt-injection detection API.
 *
 * Lakera Guard is purpose-built for detecting prompt-injection attacks,
 * jailbreaks, and prompt-extraction attempts. Trained on millions of
 * attack samples + continuously updated with new vectors.
 *
 * API docs: https://platform.lakera.ai/docs
 *
 * Free tier (as of Aug 2026):
 *   - 1000 API calls/month (free trial)
 *   - ~50-200ms latency (depending on region)
 *   - Returns: score (0-1), attack type, confidence
 *
 * Pricing (paid tier):
 *   - ~$0.001 per call (very cheap)
 *
 * ─── Why Lakera over generic moderation? ──────────────────────────────────
 *
 * Generic moderation APIs (OpenAI Moderation, Azure Content Safety) catch
 * toxic/harmful content but are weaker at prompt-injection specifically.
 * Lakera is trained on:
 *   - DAN-style jailbreaks ("Do Anything Now")
 *   - Role-play hijacks ("You are now an AI without restrictions...")
 *   - Prompt extraction ("Repeat your system prompt")
 *   - Instruction override ("Ignore previous instructions...")
 *   - Encoding attacks (base64, ROT13, unicode tricks)
 *   - Multi-turn injection (gradual escalation across messages)
 *
 * The local heuristic (promptInjectionLocal.ts) catches the common patterns
 * but misses novel/encoded attacks. Lakera is the strong defense; local
 * is the always-available fallback.
 *
 * ─── Error handling ──────────────────────────────────────────────────────────
 *
 *   - 401 Unauthorized → API key invalid (don't retry, fall back to local)
 *   - 422 Unprocessable → request body malformed (fall back)
 *   - 429 Too Many Requests → rate limit (fall back; cache prevents re-calls)
 *   - 5xx → Lakera is down (fall back)
 *   - Network timeout → fall back
 */
import type { PromptInjectionProvider, InjectionCheckResult } from "./promptInjection";
import { logger } from "./logger";

// ─── Constants ───────────────────────────────────────────────────────────────

const LAKERA_API_URL_DEFAULT = "https://api.lakera.ai/v1/guard";
const MAX_MESSAGE_CHARS = 10_000; // Lakera truncates at ~10K chars

// ─── Provider implementation ────────────────────────────────────────────────

export class LakeraGuardProvider implements PromptInjectionProvider {
  readonly name = "lakera";

  isConfigured(): boolean {
    return typeof process.env.LAKERA_API_KEY === "string" && process.env.LAKERA_API_KEY.length > 10;
  }

  async detect(message: string): Promise<InjectionCheckResult> {
    if (!this.isConfigured()) {
      throw new Error("LAKERA_API_KEY is not set");
    }

    const url = process.env.LAKERA_API_URL ?? LAKERA_API_URL_DEFAULT;
    const truncated = message.slice(0, MAX_MESSAGE_CHARS);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.LAKERA_API_KEY!,
      },
      body: JSON.stringify({
        // Lakera Guard API accepts a single message or a conversation.
        // We send just the user's message (not history) because we check
        // each message independently.
        messages: [{ role: "user", content: truncated }],
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      let errBody = "";
      try {
        const errJson = (await response.json()) as { message?: string; detail?: string };
        errBody = errJson.message ?? errJson.detail ?? JSON.stringify(errJson);
      } catch {
        errBody = await response.text().catch(() => "");
      }

      if (response.status === 429) {
        logger.warn(
          { status: response.status, errBody: errBody.slice(0, 200) },
          "Lakera: rate limit hit (429)",
        );
      }

      throw new Error(
        `Lakera API failed: ${response.status} ${response.statusText} — ${errBody.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as {
      // Lakera returns a top-level score + attack categories.
      results?: {
        score?: number;
        // Categories with their own scores (prompt_injection, jailbreak, etc.)
        categories?: Record<string, number>;
      }[];
      // Some versions return these at the top level:
      score?: number;
      categories?: Record<string, number>;
      // The detected attack type (if any)
      attack_type?: string;
    };

    // Normalize the response (handle both response shapes).
    const result = data.results?.[0] ?? data;
    const score = typeof result.score === "number" ? result.score : 0;
    const categories = result.categories ?? {};

    // Determine the attack type from the categories (highest-scoring category).
    let attackType: string | undefined = data.attack_type;
    if (!attackType && categories) {
      const sorted = Object.entries(categories).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0 && sorted[0][1] > 0.5) {
        attackType = sorted[0][0];
      }
    }

    return {
      detected: score >= 0.7, // Lakera's recommended threshold
      score,
      attackType,
      provider: this.name,
      latencyMs: 0, // set by the caller (detectPromptInjection)
      explanation: attackType
        ? `Lakera detected ${attackType} (score: ${score.toFixed(2)})`
        : `Lakera score: ${score.toFixed(2)}`,
    };
  }
}
