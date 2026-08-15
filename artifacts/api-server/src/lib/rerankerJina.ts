/**
 * Jina Reranker v2 provider.
 *
 * Jina AI's `jina-reranker-v2-base-multilingual` is the open-source
 * alternative to Cohere Rerank. Supports 100+ languages including Bangla.
 *
 * API docs: https://jina.ai/reranker/
 * Source code: https://huggingface.co/jinaai/jina-reranker-v2-base-multilingual
 *
 * Free tier (as of Aug 2026):
 *   - 1M tokens/month free (hosted API)
 *   - Self-hostable via HuggingFace Transformers / sentence-transformers
 *   - Rate limit: 500 requests/minute on free tier
 *
 * Pricing (paid tier):
 *   - $0.02 per 1M tokens (extremely cheap)
 *
 * ─── When to use Jina over Cohere ──────────────────────────────────────────
 *
 *   1. You want to self-host (no API key, no data leaving your network)
 *   2. You've exceeded Cohere's free tier (1000 calls/month)
 *   3. You want better Bangla quality (Jina is competitive with Cohere
 *      on Bangla, sometimes better)
 *
 * The provider chain (reranker.ts) tries Cohere first because Cohere has
 * slightly better benchmark scores on average. But Jina is a fully
 * production-grade alternative — not a toy fallback.
 *
 * ─── Self-hosting note ──────────────────────────────────────────────────────
 *
 * If you set JINA_RERANKER_URL to a self-hosted endpoint (e.g. a
 * HuggingFace Inference Endpoint or a local sentence-transformers server),
 * this provider will use it. The endpoint must accept the same request
 * format as Jina's hosted API:
 *   POST /v1/rerank
 *   { model, query, documents, top_n }
 *   → { results: [{ index, relevance_score }] }
 *
 * See: https://huggingface.co/jinaai/jina-reranker-v2-base-multilingual#usage
 */
import type { RerankerProvider, RerankDocument, RerankResult } from "./reranker";
import { logger } from "./logger";

// ─── Constants ───────────────────────────────────────────────────────────────

const JINA_RERANK_URL_DEFAULT = "https://api.jina.ai/v1/rerank";
const JINA_MODEL = "jina-reranker-v2-base-multilingual";
const MAX_DOCS_PER_CALL = 100; // Jina's API limit

// ─── Provider implementation ────────────────────────────────────────────────

export class JinaRerankerProvider implements RerankerProvider {
  readonly name = "jina";

  /**
   * True if either JINA_API_KEY is set (hosted) OR JINA_RERANKER_URL is set
   * (self-hosted, may not need an API key).
   */
  isConfigured(): boolean {
    const hasApiKey =
      typeof process.env.JINA_API_KEY === "string" && process.env.JINA_API_KEY.length > 10;
    const hasCustomUrl =
      typeof process.env.JINA_RERANKER_URL === "string" && process.env.JINA_RERANKER_URL.length > 0;
    return hasApiKey || hasCustomUrl;
  }

  async rerank(query: string, documents: RerankDocument[], topN: number): Promise<RerankResult[]> {
    const hasApiKey =
      typeof process.env.JINA_API_KEY === "string" && process.env.JINA_API_KEY.length > 10;
    const url = process.env.JINA_RERANKER_URL ?? JINA_RERANK_URL_DEFAULT;

    if (!this.isConfigured()) {
      throw new Error("JINA_API_KEY (or JINA_RERANKER_URL) is not set");
    }
    if (documents.length === 0) {
      return [];
    }

    const docsToRerank = documents.slice(0, MAX_DOCS_PER_CALL);
    const docTexts = docsToRerank.map((d) => d.text);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (hasApiKey) {
      headers["Authorization"] = `Bearer ${process.env.JINA_API_KEY}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: JINA_MODEL,
        query: query.slice(0, 2000),
        documents: docTexts,
        top_n: Math.min(topN, docsToRerank.length),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      let errBody = "";
      try {
        const errJson = (await response.json()) as {
          message?: string;
          detail?: string;
          title?: string;
        };
        errBody = errJson.message ?? errJson.detail ?? errJson.title ?? JSON.stringify(errJson);
      } catch {
        errBody = await response.text().catch(() => "");
      }

      if (response.status === 429) {
        logger.warn(
          { status: response.status, errBody: errBody.slice(0, 200) },
          "Jina rerank: rate limit hit (429)",
        );
      }

      throw new Error(
        `Jina rerank failed: ${response.status} ${response.statusText} — ${errBody.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as {
      results: {
        index: number;
        relevance_score: number; // 0-1
      }[];
      usage?: { total_tokens?: number };
    };

    const results: RerankResult[] = data.results.map((r) => ({
      id: docsToRerank[r.index]?.id ?? 0,
      score: r.relevance_score,
      provider: this.name,
    }));

    if (data.usage?.total_tokens) {
      logger.debug(
        { tokens: data.usage.total_tokens, docCount: docsToRerank.length, model: JINA_MODEL },
        "Jina rerank: token usage",
      );
    }

    return results;
  }
}
