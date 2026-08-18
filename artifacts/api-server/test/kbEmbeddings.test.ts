/**
 * Phase 2: KB embeddings + background job — source-shape tests.
 *
 * Verifies:
 *   - `kbEmbeddings.ts` exports `generateEntryEmbedding` + `generateEmbeddingsForPendingEntries`.
 *   - Uses the shared `EMBEDDING_MODEL` from `embeddingConfig.ts` (BUG-E1 fix:
 *     defaults to `gemini-embedding-001`, env-configurable). 768 dims.
 *   - Passes `outputDimensionality` explicitly (backward compat with vector(768)).
 *   - Truncates content to 2000 chars.
 *   - Uses `RETRIEVAL_DOCUMENT` task type (asymmetric to query embeddings).
 *   - Updates `embedding_status` on success/failure.
 *   - pgvector format: stores embedding as `[0.1, 0.2, ...]` string with `::vector` cast.
 *   - Rate limit handling (stops on 429).
 *   - `kbEmbeddingJob.ts` exists + calls the batch function.
 *   - Cron endpoint `POST /api/cron/kb-embeddings` is registered.
 *   - The scheduler is registered in `src/index.ts`.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/kbEmbeddings.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

describe("Phase 2: kbEmbeddings.ts lib module", () => {
  const source = readSource("artifacts/api-server/src/lib/kbEmbeddings.ts");

  it("exports generateEntryEmbedding", () => {
    expect(source).toContain("export async function generateEntryEmbedding");
  });

  it("exports generateEmbeddingsForPendingEntries", () => {
    expect(source).toContain("export async function generateEmbeddingsForPendingEntries");
  });

  it("exports the EmbeddingResult + BatchEmbeddingResult types", () => {
    expect(source).toContain("export interface EmbeddingResult");
    expect(source).toContain("export interface BatchEmbeddingResult");
  });

  it("BUG-E1 fix: uses the shared EMBEDDING_MODEL from embeddingConfig.ts (not hardcoded text-embedding-004)", () => {
    // The old code hardcoded "text-embedding-004" (shut down by Google Jan 2026).
    // The new code imports EMBEDDING_MODEL from embeddingConfig.ts (defaults
    // to "gemini-embedding-001", env-configurable via GEMINI_EMBEDDING_MODEL).
    expect(source).toContain("EMBEDDING_MODEL");
    expect(source).toContain('from "./embeddingConfig"');
    expect(source).not.toContain('"text-embedding-004"');
    expect(source).toContain("768");
  });

  it("BUG-E1 fix: passes outputDimensionality explicitly (backward compat with vector(768))", () => {
    // gemini-embedding-001 defaults to 3072 dims. We must explicitly request
    // 768 to match the existing pgvector column.
    expect(source).toContain("outputDimensionality");
    expect(source).toContain("EMBEDDING_DIMENSIONS");
  });

  it("BUG-E1 fix: includes the model name in error logs (for diagnosing deprecations)", () => {
    // The old code logged errors without the model name — operators couldn't
    // tell which model was failing. The new code includes `model: EMBEDDING_MODEL`
    // in the log context.
    expect(source).toMatch(/model:\s*EMBEDDING_MODEL/);
  });

  it("truncates content to 2000 chars (Gemini's embedding token limit)", () => {
    expect(source).toContain("MAX_CONTENT_CHARS");
    expect(source).toContain("2000");
    expect(source).toContain(".slice(0, MAX_CONTENT_CHARS)");
  });

  it("uses RETRIEVAL_DOCUMENT task type (asymmetric to RETRIEVAL_QUERY)", () => {
    expect(source).toContain("RETRIEVAL_DOCUMENT");
  });

  it("uses the lazy GoogleGenAI client pattern (same as embeddingCache.ts)", () => {
    expect(source).toContain("GoogleGenAI");
    expect(source).toContain("getEmbeddingClient");
    expect(source).toContain("GEMINI_API_KEY");
  });

  it("stores embeddings in pgvector format ([0.1, 0.2, ...] string with ::vector cast)", () => {
    expect(source).toContain('[${result.embedding.join(",")}]');
    expect(source).toContain("$1::vector");
  });

  it("updates embedding_status to 'generated' on success", () => {
    expect(source).toContain("embedding_status = 'generated'");
    expect(source).toContain("embedding_generated_at = NOW()");
  });

  it("updates embedding_status to 'failed' on failure (with error message)", () => {
    expect(source).toContain("embedding_status = 'failed'");
    expect(source).toContain("embedding_error");
    expect(source).toContain("LEFT($1, 500)");
  });

  it("rate limit handling: stops processing on 429 (rateLimited: true)", () => {
    expect(source).toContain("429");
    expect(source).toContain("rateLimited");
    expect(source).toContain("break");
  });

  it("fetches pending entries oldest-first (FIFO via created_at ASC)", () => {
    expect(source).toContain("embedding_status = 'pending'");
    expect(source).toContain("ORDER BY created_at ASC");
  });

  it("calls markSourceReadyIfAllEntriesEmbedded after processing", () => {
    expect(source).toContain("markSourceReadyIfAllEntriesEmbedded");
    expect(source).toContain("sourceIdsToCheck");
  });

  it("default batch limit is 10 (configurable, max 50)", () => {
    expect(source).toContain("limit = 10");
    expect(source).toContain("Math.min(Math.max(limit, 1), 50)");
  });
});

describe("Phase 2: kbEmbeddingJob.ts background job", () => {
  const source = readSource("artifacts/api-server/src/jobs/kbEmbeddingJob.ts");

  it("exports runKbEmbeddingJob", () => {
    expect(source).toContain("export async function runKbEmbeddingJob");
  });

  it("imports generateEmbeddingsForPendingEntries from kbEmbeddings", () => {
    expect(source).toContain("generateEmbeddingsForPendingEntries");
    expect(source).toContain("kbEmbeddings");
  });

  it("processes up to 10 entries per run", () => {
    expect(source).toContain("generateEmbeddingsForPendingEntries(10)");
  });

  it("catches errors (never throws — called from setInterval without try/catch)", () => {
    expect(source).toContain("try");
    expect(source).toContain("catch");
    expect(source).toContain("unexpected error");
  });

  it("logs results for observability", () => {
    expect(source).toContain("logger.info");
    expect(source).toContain("processed");
    expect(source).toContain("succeeded");
  });

  it("logs a warning on rate limit", () => {
    expect(source).toContain("rateLimited");
    expect(source).toContain("logger.warn");
  });
});

describe("Phase 2: cron endpoint (routes/cron.ts)", () => {
  const source = readSource("artifacts/api-server/src/routes/cron.ts");

  it("imports runKbEmbeddingJob", () => {
    expect(source).toContain("runKbEmbeddingJob");
    expect(source).toContain("kbEmbeddingJob");
  });

  it("registers POST /cron/kb-embeddings", () => {
    expect(source).toMatch(/router\.post\(\s*["']\/cron\/kb-embeddings["']/);
  });

  it("the endpoint requires cron auth (requireCronAuth)", () => {
    expect(source).toContain("requireCronAuth(req, res)");
  });

  it("NO cron route uses the double /api/ prefix", () => {
    const brokenPattern = /router\.(get|post|put|delete|patch)\(\s*["']\/api\/cron\/kb-embeddings/;
    expect(brokenPattern.test(source)).toBe(false);
  });
});

describe("Phase 2: scheduler registered in src/index.ts", () => {
  const source = readSource("artifacts/api-server/src/index.ts");

  it("imports runKbEmbeddingJob", () => {
    expect(source).toContain("runKbEmbeddingJob");
    expect(source).toContain("kbEmbeddingJob");
  });

  it("defines scheduleKbEmbeddingJob function", () => {
    expect(source).toContain("function scheduleKbEmbeddingJob");
  });

  it("calls scheduleKbEmbeddingJob() in the app.listen callback", () => {
    expect(source).toContain("scheduleKbEmbeddingJob()");
  });

  it("uses a 30-second interval", () => {
    expect(source).toContain("30 * 1000");
  });

  it("delays the first run by 30s (avoids cold-start migration competition)", () => {
    expect(source).toContain("setTimeout");
  });
});
