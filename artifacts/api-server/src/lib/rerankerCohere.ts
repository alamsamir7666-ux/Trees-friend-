/**
 * Cohere Rerank v3 provider.
 *
 * Cohere's rerank-multilingual-v3.0 is the industry-standard multilingual
 * reranker — supports 100+ languages including Bangla. Trained on
 * multilingual web data + cross-lingual retrieval benchmarks.
 *
 * API docs: https://docs.cohere.com/reference/rerank
 *
 * Free tier (as of Aug 2026):
 *   - 1000 rerank calls/month for free (trial key)
 *   - 100 documents per call (we use top-20 → well within)
 *   - Rate limit: 100 requests/minute
 *   - Network: ~200-500ms latency (depending on region)
 *
 * Pricing (paid tier):
 *   - $2.00 per 1000 rerank calls (very cheap)
 *
 * ─── Why Cohere is the default (vs Jina) ──────────────────────────────────
 *
 *   1. Best multilingual quality on benchmarks (BEIR, MIRACL)
 *   2. Best Bangla support (critical for a BD product)
 *   3. Hosted API — no infrastructure to manage
 *   4. Generous free tier (1000 calls/month covers ~30 chats/day)
 *
 * Jina is a strong second choice (open-source, self-hostable) — see
 * rerankerJina.ts. The local fallback (rerankerLocal.ts) just returns
 * the original order.
 *
 * ─── Error handling ──────────────────────────────────────────────────────────
 *
 * Cohere API errors we handle:
 *   - 401 Unauthorized → API key invalid (don't retry, fall back)
 *   - 422 Unprocessable → request body malformed (don't retry, fall back)
 *   - 429 Too Many Requests → rate limit (fall back to next provider;
 *     the cache will prevent re-calling Cohere for the same query)
 *   - 5xx → Cohere is down (fall back to next provider)
 *   - Network timeout → fall back to next provider
 *
 * We don't retry within this provider — the provider chain in reranker.ts
 * handles fallback. Retrying would just burn the rate limit faster.
 */
import type { RerankerProvider, RerankDocument, RerankResult } from "./reranker";
import { logger } from "./logger";

// ─── Constants ───────────────────────────────────────────────────────────────

const COHERE_RERANK_URL = "https://api.cohere.ai/v1/rerank";
const COHERE_MODEL = "rerank-multilingual-v3.0"; // supports Bangla
const MAX_DOCS_PER_CALL = 100; // Cohere API limit

// ─── Provider implementation ────────────────────────────────────────────────

export class CohereRerankerProvider implements RerankerProvider {
  readonly name = "cohere";

  isConfigured(): boolean {
    return typeof process.env.COHERE_API_KEY === "string" && process.env.COHERE_API_KEY.length > 10;
  }

  async rerank(query: string, documents: RerankDocument[], topN: number): Promise<RerankResult[]> {
    if (!this.isConfigured()) {
      throw new Error("COHERE_API_KEY is not set");
    }
    if (documents.length === 0) {
      return [];
    }

    // Cohere caps at 100 docs per call. If we have more, truncate (the
    // first-pass retrieval should already limit to ~20, but defensive).
    const docsToRerank = documents.slice(0, MAX_DOCS_PER_CALL);

    // Cohere expects documents as strings (not objects with ids). We map
    // back to our ids via the index in the response.
    const docTexts = docsToRerank.map((d) => d.text);

    const response = await fetch(COHERE_RERANK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
        "X-Client-Name": "treefriend-bot", // Cohere uses this for analytics
      },
      body: JSON.stringify({
        model: COHERE_MODEL,
        query: query.slice(0, 2000), // Cohere truncates at 2048 chars
        documents: docTexts,
        top_n: Math.min(topN, docsToRerank.length),
        return_documents: false, // we only need indices + scores, not the text back
        max_chunks_per_doc: 1024, // Cohere splits long docs into chunks; cap for cost
      }),
      // The outer withTimeout in reranker.ts handles the abort, but we set
      // a signal here too for defense-in-depth.
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // Parse the error body for a more useful log message.
      let errBody = "";
      try {
        const errJson = (await response.json()) as { message?: string; detail?: string };
        errBody = errJson.message ?? errJson.detail ?? JSON.stringify(errJson);
      } catch {
        errBody = await response.text().catch(() => "");
      }

      const err = new Error(
        `Cohere rerank failed: ${response.status} ${response.statusText} — ${errBody.slice(0, 200)}`,
      );

      // 429 is the most common error — log at warn level, not error.
      if (response.status === 429) {
        logger.warn(
          { status: response.status, errBody: errBody.slice(0, 200) },
          "Cohere rerank: rate limit hit (429)",
        );
      }

      throw err;
    }

    const data = (await response.json()) as {
      results: {
        index: number; // 0-based index into the documents array
        relevance_score: number; // 0-1 (Cohere normalizes)
      }[];
      // Cohere returns these for billing/observability:
      meta?: {
        billed_units?: { rerank_units?: number };
        tokens?: { input_tokens?: number; output_tokens?: number };
      };
    };

    // Map Cohere's response back to our document ids.
    // data.results is already sorted by relevance_score descending, but
    // we re-sort in the rerank() wrapper for safety.
    const results: RerankResult[] = data.results.map((r) => ({
      id: docsToRerank[r.index]?.id ?? 0,
      score: r.relevance_score,
      provider: this.name,
    }));

    // Log cost for observability (Cohere bills per rerank unit).
    if (data.meta?.billed_units?.rerank_units) {
      logger.debug(
        {
          billedUnits: data.meta.billed_units.rerank_units,
          docCount: docsToRerank.length,
          model: COHERE_MODEL,
        },
        "Cohere rerank: billing info",
      );
    }

    return results;
  }
}
