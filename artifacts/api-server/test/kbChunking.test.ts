/**
 * Phase 2: KB AI chunking — source-shape tests.
 *
 * Verifies:
 *   - `kbChunking.ts` exports `chunkTextWithAI`.
 *   - The chunking prompt mentions "plant care" + "JSON array".
 *   - Language gating is documented in the code.
 *   - Error handling for malformed JSON is present.
 *   - Multi-segment chunking (for texts > 30K chars) is present.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/kbChunking.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

const REPO_ROOT = "/home/z/my-project/Trees-friend-";

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

describe("Phase 2: kbChunking.ts lib module", () => {
  const source = readSource("artifacts/api-server/src/lib/kbChunking.ts");

  it("exports chunkTextWithAI", () => {
    expect(source).toContain("export async function chunkTextWithAI");
  });

  it("exports the ChunkSuggestion type", () => {
    expect(source).toContain("export interface ChunkSuggestion");
  });

  it("exports the ChunkResult type (union of success + error)", () => {
    expect(source).toContain("export type ChunkResult");
  });

  it("uses Gemini via getClient + callWithFallback from gemini.ts", () => {
    expect(source).toContain("getClient");
    expect(source).toContain("callWithFallback");
    expect(source).toContain("isGeminiConfigured");
  });

  it("the chunking prompt mentions plant care + JSON array format", () => {
    expect(source).toContain("plant care");
    expect(source).toContain("JSON array");
  });

  it("the prompt instructs to return empty array for non-plant content", () => {
    expect(source).toContain("return an empty array");
    expect(source).toContain("not about plants");
  });

  it("the prompt specifies 200-500 words per chunk", () => {
    expect(source).toContain("200-500 words");
  });

  it("the prompt specifies 3-7 keywords per chunk", () => {
    expect(source).toContain("3-7");
    expect(source).toContain("keywords");
  });

  it("uses responseMimeType application/json for guaranteed JSON", () => {
    expect(source).toContain('responseMimeType: "application/json"');
  });

  it("uses low temperature (0.3) for structured output", () => {
    expect(source).toContain("temperature: CHUNKING_TEMPERATURE");
    expect(source).toContain("CHUNKING_TEMPERATURE = 0.3");
  });

  it("uses maxOutputTokens 8192 (enough for 7-10 chunks)", () => {
    expect(source).toContain("maxOutputTokens: MAX_OUTPUT_TOKENS");
    expect(source).toContain("MAX_OUTPUT_TOKENS = 8192");
  });

  it("has language gating documented (English only)", () => {
    expect(source).toContain("English only");
    expect(source).toContain("sourceLanguage === \"en\"");
  });

  it("has error handling for malformed JSON (parseChunkResponse)", () => {
    expect(source).toContain("parseChunkResponse");
    expect(source).toContain("JSON.parse");
    expect(source).toContain("malformed");
  });

  it("returns { error } on Gemini not configured", () => {
    expect(source).toContain("Gemini API key not set");
  });

  it("returns { error } on rate limit (429)", () => {
    expect(source).toContain("429");
    expect(source).toContain("rate limit");
  });

  it("has multi-segment chunking for texts > 30K chars (splitIntoSegments)", () => {
    expect(source).toContain("splitIntoSegments");
    expect(source).toContain("MAX_TEXT_PER_CALL");
    expect(source).toContain("30_000");
  });

  it("splits segments at paragraph boundaries (prefers \\n\\n)", () => {
    expect(source).toContain('lastIndexOf("\\n\\n"');
  });

  it("truncates chunk content to preserve original wording (no paraphrase)", () => {
    expect(source).toContain("preserve the original wording");
  });
});

describe("Phase 2: kbChunking route integration (aiAdmin.ts)", () => {
  const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");

  it("imports chunkTextWithAI from kbChunking", () => {
    expect(source).toContain("chunkTextWithAI");
    expect(source).toContain("kbChunking");
  });

  it("the chunk endpoint marks source status as 'chunking' before the AI call", () => {
    expect(source).toContain('updateProcessingStatus(id, "chunking")');
  });

  it("the chunk endpoint records chunking metadata (method=ai, model) on success", () => {
    expect(source).toContain('updateChunkingMetadata(id, "ai"');
  });

  it("the chunk endpoint returns 422 on failure (with error message)", () => {
    expect(source).toContain("422");
    expect(source).toContain("result.error");
  });
});
