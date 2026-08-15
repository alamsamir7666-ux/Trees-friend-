/**
 * Local reranker — graceful degradation fallback.
 *
 * When no external reranker is configured (or all external providers fail),
 * we use this provider. It does NOT actually rerank — it returns the
 * documents in their original order with a neutral score.
 *
 * This is the "no gaps" guarantee: the KB search pipeline NEVER blocks on
 * reranker downtime. The first-pass score (BM25 + semantic + authority) is
 * still good — reranking is a quality bonus, not a correctness requirement.
 *
 * ─── Why not implement a local cross-encoder? ──────────────────────────────
 *
 * A real local cross-encoder (e.g. bge-reranker-v2-m3 via sentence-transformers
 * or transformers.js) would require:
 *   - Downloading a ~600MB model on first use
 *   - ~200ms inference per document (CPU-bound)
 *   - 2-4GB RAM for the model weights
 *
 * That's too heavy for a Node.js process. The right way to do local
 * reranking is via a Python sidecar (FastAPI + sentence-transformers) or
 * a dedicated inference server (Triton, vLLM).
 *
 * If you want this, set up a sidecar + use the Jina provider with
 * JINA_RERANKER_URL pointing to your sidecar's /v1/rerank endpoint. The
 * Jina provider accepts any OpenAI-compatible rerank API.
 *
 * For now, this local provider is the honest fallback: "no reranking
 * applied, returning first-pass order." The logs make this clear so
 * operators know to configure an external provider.
 *
 * ─── Score normalization ────────────────────────────────────────────────────
 *
 * External providers (Cohere, Jina) return scores in [0, 1]. The local
 * provider returns 1.0 for all documents — this means "best possible
 * score" but doesn't actually distinguish between them. The rerank()
 * wrapper sorts by score descending, so all documents tie + remain in
 * their original (first-pass) order.
 *
 * This is correct behavior: if we can't rerank, the first-pass order is
 * our best guess.
 */
import type { RerankerProvider, RerankDocument, RerankResult } from "./reranker";
import { logger } from "./logger";

export class LocalRerankerProvider implements RerankerProvider {
  readonly name = "local";

  isConfigured(): boolean {
    // Always "configured" — it's the fallback of last resort.
    return true;
  }

  async rerank(query: string, documents: RerankDocument[], topN: number): Promise<RerankResult[]> {
    // Log at info level so operators can see when they're hitting the fallback.
    // This is not a warning — it's expected when no external provider is
    // configured. But if an external provider IS configured and we end up
    // here, the warning was already logged by the rerank() wrapper.
    logger.info(
      { queryPreview: query.slice(0, 80), docCount: documents.length },
      "Local reranker: returning first-pass order (no external reranker applied)",
    );

    // Return all documents with a neutral score of 1.0, in their original order.
    // The rerank() wrapper takes topN + sorts by score (which is a no-op here
    // since all scores are equal).
    return documents.slice(0, topN).map((d) => ({
      id: d.id,
      score: 1.0,
      provider: this.name,
    }));
  }
}
