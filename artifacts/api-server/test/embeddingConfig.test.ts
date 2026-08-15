/**
 * BUG-E1 fix: embedding configuration tests.
 *
 * Verifies that the shared `embeddingConfig.ts` module:
 *   - Exports the correct default model (gemini-embedding-001).
 *   - Exports the correct default dimensions (768).
 *   - Exports the correct task types (RETRIEVAL_QUERY + RETRIEVAL_DOCUMENT).
 *   - Exports the max input chars (2000).
 *   - Reads the model from the GEMINI_EMBEDDING_MODEL env var.
 *   - Reads the dimensions from the GEMINI_EMBEDDING_DIMENSIONS env var.
 *   - Does NOT reference the deprecated text-embedding-004 model.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/embeddingConfig.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

const REPO_ROOT = "/home/z/my-project/Trees-friend-";

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

describe("BUG-E1 fix: embeddingConfig.ts source shape", () => {
  const source = readSource("artifacts/api-server/src/lib/embeddingConfig.ts");

  it("exports EMBEDDING_MODEL", () => {
    expect(source).toMatch(/export\s+const\s+EMBEDDING_MODEL/);
  });

  it("exports EMBEDDING_DIMENSIONS", () => {
    expect(source).toMatch(/export\s+const\s+EMBEDDING_DIMENSIONS/);
  });

  it("exports TASK_TYPE_QUERY", () => {
    expect(source).toMatch(/export\s+const\s+TASK_TYPE_QUERY/);
  });

  it("exports TASK_TYPE_DOCUMENT", () => {
    expect(source).toMatch(/export\s+const\s+TASK_TYPE_DOCUMENT/);
  });

  it("exports MAX_EMBEDDING_INPUT_CHARS", () => {
    expect(source).toMatch(/export\s+const\s+MAX_EMBEDDING_INPUT_CHARS/);
  });
});

describe("BUG-E1 fix: default model is gemini-embedding-001 (not text-embedding-004)", () => {
  const source = readSource("artifacts/api-server/src/lib/embeddingConfig.ts");

  it("defaults to gemini-embedding-001", () => {
    // The env-var fallback must be "gemini-embedding-001" — the current
    // production model (text-embedding-004 was shut down Jan 14, 2026).
    expect(source).toContain('"gemini-embedding-001"');
  });

  it("is env-configurable via GEMINI_EMBEDDING_MODEL", () => {
    expect(source).toMatch(/process\.env\.GEMINI_EMBEDDING_MODEL/);
  });

  it("does NOT default to the deprecated text-embedding-004", () => {
    // The old model may appear in comments (explaining the history), but
    // must NOT appear as the default value in the env-var fallback.
    expect(source).not.toMatch(/\?\?\s*"text-embedding-004"/);
  });
});

describe("BUG-E1 fix: default dimensions are 768 (backward compat)", () => {
  const source = readSource("artifacts/api-server/src/lib/embeddingConfig.ts");

  it("defaults to 768 dimensions", () => {
    expect(source).toMatch(/\?\?\s*768/);
  });

  it("is env-configurable via GEMINI_EMBEDDING_DIMENSIONS", () => {
    expect(source).toMatch(/process\.env\.GEMINI_EMBEDDING_DIMENSIONS/);
  });
});

describe("BUG-E1 fix: task types are correct", () => {
  const source = readSource("artifacts/api-server/src/lib/embeddingConfig.ts");

  it('TASK_TYPE_QUERY is "RETRIEVAL_QUERY"', () => {
    expect(source).toContain('"RETRIEVAL_QUERY"');
  });

  it('TASK_TYPE_DOCUMENT is "RETRIEVAL_DOCUMENT"', () => {
    expect(source).toContain('"RETRIEVAL_DOCUMENT"');
  });
});

describe("BUG-E1 fix: behavioral test — env var overrides default model", () => {
  // We can't easily test env-var override at import time (the module is
  // imported once + cached). Instead, verify the source code pattern:
  // the env var is checked BEFORE the default.
  const source = readSource("artifacts/api-server/src/lib/embeddingConfig.ts");

  it("the env var is checked first, then the default", () => {
    // The pattern must be: process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-001"
    expect(source).toMatch(/process\.env\.GEMINI_EMBEDDING_MODEL\s*\?\?\s*"gemini-embedding-001"/);
  });
});

describe("BUG-E1 fix: all embedding callers import from embeddingConfig.ts", () => {
  // Verify all 3 files that call embedContent import the shared config.
  const files = [
    "artifacts/api-server/src/lib/kbEmbeddings.ts",
    "artifacts/api-server/src/lib/kbSearch.ts",
    "artifacts/api-server/src/lib/embeddingCache.ts",
  ];

  for (const file of files) {
    it(`${file} imports from embeddingConfig.ts`, () => {
      const source = readSource(file);
      expect(source).toContain('from "./embeddingConfig"');
    });

    it(`${file} does NOT hardcode text-embedding-004`, () => {
      const source = readSource(file);
      // The old model name may appear in comments explaining the BUG-E1
      // fix history, but must NOT appear as a string literal being assigned
      // to a constant. We check it's not in a `const X = "text-embedding-004"`
      // pattern.
      expect(source).not.toMatch(/=\s*"text-embedding-004"/);
    });

    it(`${file} passes outputDimensionality explicitly`, () => {
      const source = readSource(file);
      expect(source).toContain("outputDimensionality");
    });
  }
});

describe("BUG-E1 fix: no remaining hardcoded text-embedding-004 in source", () => {
  // Scan all .ts files in src/lib/ for any remaining hardcoded references.
  // Comments mentioning the old model (for historical context) are OK —
  // we only flag executable assignments.
  const libDir = `${REPO_ROOT}/artifacts/api-server/src/lib`;
  const files = fs.readdirSync(libDir).filter((f) => f.endsWith(".ts"));

  for (const file of files) {
    it(`${file} does not assign "text-embedding-004" to a constant`, () => {
      const source = fs.readFileSync(`${libDir}/${file}`, "utf8");
      // Match: const X = "text-embedding-004" or = 'text-embedding-004'
      // (executable assignments, not comments).
      const codeOnly = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        .join("\n");
      expect(codeOnly).not.toMatch(/=\s*["']text-embedding-004["']/);
    });
  }
});
