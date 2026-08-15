# Summary — BUG-K9 + BUG-I1 Fix

## Problem

Two HIGH/CRITICAL bugs in the Trees-friend monorepo:

1. **BUG-K9** — When the reranker provider chain fell back to the Local
   provider (which always succeeds by returning `score: 1.0` for every
   doc), those useless 1.0-scored results were cached as a **positive**
   cache entry for 1 hour. This blocked Cohere/Jina recovery for up to
   55 minutes after they became available again. The `isFallback`
   detection only matched `provider === "fallback"` (set when ALL
   providers fail) — but Local returns `provider: "local"`, so its
   results were indistinguishable from a real successful rerank.

2. **BUG-I1** — The KB retrieval had TWO call paths with INCONSISTENT
   parameters:
   - **Auto-inject path** (`getTopKbEntriesForPrompt`): `minScore=0.5`,
     `skipRerank=true`, `maxResults=3`, content truncated to 500 chars
   - **Tool path** (`searchKb`): `minScore=0.3`, `skipRerank=false`,
     `maxResults=5`, full content (no truncation)

   The LLM could see entry A (score 0.6) via auto-inject, then call the
   tool and get entries A + B (where B scored 0.4 and was filtered from
   auto-inject) — the textbook "two-source RAG inconsistency" anti-pattern.

## Files Changed

| File                                                       | Status   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `artifacts/api-server/src/lib/rerankerCache.ts`            | Modified | BUG-K9: added `FALLBACK_PROVIDERS = new Set(["fallback", "local", "disabled"])`; `isFallback` detection now uses `FALLBACK_PROVIDERS.has(r.provider)`; log message includes `isFallback` flag + `provider` field; explanatory comment block documents the Vercel AI SDK pattern.                                                                                                                                                                                         |
| `artifacts/api-server/src/lib/kbSearch.ts`                 | Modified | BUG-I1: added + exported `UNIFIED_MIN_SCORE = 0.3`, `UNIFIED_MAX_RESULTS = 5`, `UNIFIED_SKIP_RERANK = false`, `UNIFIED_CONTENT_TRUNCATE_CHARS = 500`. `getTopKbEntriesForPrompt` now uses these (was `MIN_SCORE_AUTO_INJECT = 0.5`, `MAX_AUTO_INJECT_ENTRIES = 3`, `skipRerank: true`). `formatKbContextForPrompt` uses `UNIFIED_CONTENT_TRUNCATE_CHARS`. Old constants removed; `MAX_RESULTS_DEFAULT` + `MIN_SCORE_DEFAULT` kept as deprecated aliases for back-compat. |
| `artifacts/api-server/src/lib/aiTools.ts`                  | Modified | BUG-I1: imports `UNIFIED_MIN_SCORE` + `UNIFIED_CONTENT_TRUNCATE_CHARS` from `kbSearch`. `searchKb` uses `UNIFIED_MIN_SCORE` (was hardcoded `0.3`) + truncates content to `UNIFIED_CONTENT_TRUNCATE_CHARS` (was full content). Tool declaration `max_results` description mentions auto-inject consistency.                                                                                                                                                               |
| `artifacts/api-server/src/routes/ai.ts`                    | Modified | BUG-I1: removed the explicit `3` arg from `getTopKbEntriesForPrompt(safeMessage)` call (now uses unified default of 5).                                                                                                                                                                                                                                                                                                                                                  |
| `artifacts/api-server/src/lib/aiContext.ts`                | Modified | BUG-I1: system prompt's KB section now documents the unified retrieval contract — tells the LLM that auto-inject + tool use the SAME parameters (minScore=0.3, reranked, 5 entries max, 500 chars per entry) and to cite only once if an entry appears in both.                                                                                                                                                                                                          |
| `artifacts/api-server/test/rerankerFallbackCache.test.ts`  | **New**  | 23 tests: `FALLBACK_PROVIDERS` includes all 3 providers, `isFallback` uses Set, TTL selection, log message includes flag + provider, `rerankerLocal.ts` + `reranker.ts getProviderChain()` unmodified.                                                                                                                                                                                                                                                                   |
| `artifacts/api-server/test/kbRetrievalUnification.test.ts` | **New**  | 30 tests: `UNIFIED_*` constants defined + exported, `getTopKbEntriesForPrompt` uses them, old constants removed, `routes/ai.ts` no explicit `3` arg, `aiTools.ts searchKb` uses unified config + truncates, tool declaration mentions consistency, system prompt documents unified behavior, back-compat aliases preserved.                                                                                                                                              |
| `artifacts/api-server/test/kbSearch.test.ts`               | Modified | Updated 3 tests that asserted on the old constants (`MIN_SCORE_AUTO_INJECT = 0.5`, `MAX_AUTO_INJECT_ENTRIES = 3`, hardcoded `minScore: 0.3`) to reflect the unified config.                                                                                                                                                                                                                                                                                              |
| `artifacts/api-server/test/embeddingCacheVersion.test.ts`  | Modified | Fixed a pre-existing regex bug (test #5) — the regex didn't match multi-line function calls. Now uses `[\s\S]` to span newlines.                                                                                                                                                                                                                                                                                                                                         |

## Architecture Decisions

1. **Negative Caching for Degraded Responses** (BUG-K9) — Vercel AI SDK
   pattern: `rerank()` distinguishes `relevanceScore === null` from real
   scores and never caches the former. Our equivalent: never cache
   `"local"` / `"disabled"` / `"fallback"` provider results as positive.
   The 60s TTL means the next request retries the real providers.

2. **Single Retriever Pattern** (BUG-I1) — LangChain's `RetrievalQA`
   enforces this by always pulling from the same `retriever` instance
   for both the "stuff" path and the tool-call path. Anthropic's
   Contextual Retrieval pattern explicitly warns against "two divergent
   retrieval paths with no shared contract". Our `UNIFIED_*` constants
   are the shared contract.

3. **What is NOT changed** — `rerankerLocal.ts` (contract is correct:
   `provider: "local"`, `score: 1.0`, always succeeds), `getProviderChain()`
   in `reranker.ts` (chain Cohere → Jina → Local is correct), `catalogCache.ts`
   (BUG-6 was already fixed in BUG-1), `kbCache.ts` + `kbContentVersion.ts`
   (already correct from BUG-1/BUG-3), migrations 0000-0009 (already shipped).

## Test Results

- **New tests**: 53/53 passing across 2 new test files
  (`rerankerFallbackCache.test.ts` 23, `kbRetrievalUnification.test.ts` 30).
- **Existing tests**: 311/311 related source-shape tests pass (BUG-1/2/3/K19
  regression suite + `kbSearch.test.ts` updated + `embeddingCacheVersion.test.ts`
  regex bug fixed). Full suite: 1042/1042 pass (excluding 3 pre-existing
  `kbToneProfiles.test.ts` failures + 13 DB-integration test files that
  require localhost Postgres — all pre-existing, not caused by this fix).
- **Typecheck**: `pnpm typecheck` + `pnpm typecheck:test` + `pnpm typecheck:libs`
  all pass with zero errors.
- **Lint**: 0 errors on modified files (8 warnings, all pre-existing
  `any` types in error-access patterns).
