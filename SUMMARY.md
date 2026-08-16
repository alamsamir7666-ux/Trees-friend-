# Summary — BUG-I4 + BUG-I5 Fix

## Problem

Two HIGH-severity bugs in the Trees-friend monorepo, both stemming from
the same architectural flaw: **the system prompt is built ONCE per HTTP
request, but the LLM may make multiple tool-call rounds inside that
request, and the prompt's dynamic blocks (`{{tone}}`, `{{knowledge}}`)
become stale or wrong as the conversation evolves**.

1. **BUG-I4** — The tone profile was locked to the auto-inject top
   entry's creator. If the LLM later called `search_knowledge_base` and
   got entries from a DIFFERENT creator, the response would adopt
   Creator A's tone while citing Creator B's content — mismatched
   attribution.

2. **BUG-I5** — The system prompt was NOT rebuilt between tool-call
   rounds. If the LLM called `search_knowledge_base({query: "mango"})`
   in round 1 and `search_knowledge_base({query: "neem"})` in round 2,
   the system prompt's `{{knowledge}}` block still reflected the
   ORIGINAL user message — the LLM had to mentally merge stale
   auto-inject context with fresh tool results.

## Files Changed

| File                                                    | Status   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifacts/api-server/src/lib/kbToneProfiles.ts`        | Modified | BUG-I4: `formatToneBlockForPrompt` now includes a rule that the tone applies ONLY to auto-injected entries; for tool-returned entries from a different creator, use NEUTRAL tone. References the `tone_locked_creator` field.                                                                                                                                                                                                                                 |
| `artifacts/api-server/src/lib/aiTools.ts`               | Modified | BUG-I4: added `ToolContext` interface + `ChatTools` interface + `ToolExecutor` type. `executeTool` + `searchKb` accept `context?: ToolContext`. `searchKb` returns `tone_locked_creator: context?.toneLockedCreatorName ?? null` in the response envelope. Tool description mentions `tone_locked_creator` + neutral tone rule.                                                                                                                               |
| `artifacts/api-server/src/lib/aiContext.ts`             | Modified | BUG-I5: added `clearKbBlockFromPrompt(systemPrompt)` — finds the `KNOWLEDGE BASE CONTEXT (...)` header, replaces the block with a "cleared — see tool results above" marker. Does NOT touch the `TONE MATCHING` block. Uses regex to find the next section boundary.                                                                                                                                                                                          |
| `artifacts/api-server/src/lib/aiRouter.ts`              | Modified | BUG-I5: `streamChat` now accepts `systemPrompt: string \| (() => string)` (getter support) + `onToolRoundComplete?: (round, toolCalls) => string \| void` callback. Added `OnToolRoundComplete` + `SystemPromptSource` exported types. Forwards both to `streamGeminiChat` / `streamGroqChat`.                                                                                                                                                                |
| `artifacts/api-server/src/lib/gemini.ts`                | Modified | BUG-I5: `streamGeminiChat` accepts the getter + `onToolRoundComplete`. Refreshes `config.systemInstruction` before each round via `resolveSystemPrompt()`. Calls `onToolRoundComplete(round + 1, currentSignatures)` after `budget.recordRound`. Imports `ToolCallSignature`.                                                                                                                                                                                 |
| `artifacts/api-server/src/lib/groq.ts`                  | Modified | BUG-I5: same as gemini.ts — accepts getter + `onToolRoundComplete`, refreshes `messages[0]` (system message) before each round, calls `onToolRoundComplete` after the tool round.                                                                                                                                                                                                                                                                             |
| `artifacts/api-server/src/routes/ai.ts`                 | Modified | BUG-I4: wraps `executeTool` in a closure that captures `kbContext.toneCreator?.creatorId/Name` as `ToolContext`. BUG-I5: declares `let currentSystemPrompt = systemPrompt`, passes `() => currentSystemPrompt` getter to `streamChat`, defines `onToolRoundComplete` callback that clears the `{{knowledge}}` block after the first `search_knowledge_base` call. Cache key (BUG-2) still uses the ORIGINAL `systemPrompt` const (NOT `currentSystemPrompt`). |
| `artifacts/api-server/test/toneScoping.test.ts`         | **New**  | 26 tests: tone block scoping, `ToolContext` interface, `ChatTools.execute` signature, `executeTool` passes context, `searchKb` returns `tone_locked_creator`, route captures tone context, tool description mentions tone, gemini.ts/groq.ts unmodified (closure approach).                                                                                                                                                                                   |
| `artifacts/api-server/test/systemPromptRebuild.test.ts` | **New**  | 38 tests: `streamChat` getter + `onToolRoundComplete`, `clearKbBlockFromPrompt` exported + finds KB header + replaces with marker + doesn't touch TONE MATCHING, route declares `currentSystemPrompt` + passes getter + callback, gemini.ts/groq.ts call `onToolRoundComplete`, cache key uses ORIGINAL `systemPrompt`, behavioral tests for `clearKbBlockFromPrompt`.                                                                                        |
| `artifacts/api-server/test/kbSearch.test.ts`            | Modified | Updated 1 test that asserted on `searchKb(args)` to reflect the new `searchKb(args, userId, context)` signature (BUG-I4 fix).                                                                                                                                                                                                                                                                                                                                 |

## Architecture Decisions

1. **Per-Citation Tone Scoping** (BUG-I4) — Anthropic pattern: scope
   tone instructions to specific source materials; don't apply one
   source's tone to another's content. Implemented via prompt text
   (rule in `formatToneBlockForPrompt`) + tool result envelope metadata
   (`tone_locked_creator` field — OpenAI function-calling best practice).

2. **Closure Approach for ToolContext** (BUG-I4) — `routes/ai.ts` wraps
   `executeTool` in a closure that captures the tone-locked creator info.
   `gemini.ts`/`groq.ts` don't need to know about `ToolContext` — they
   just call `tools.execute(name, args, userId)` with 3 args, and the
   closure adds the 4th (context) automatically. Cleaner than threading
   `ToolContext` through every layer.

3. **Mutable Prompt via Closure Capture** (BUG-I5) — The route passes
   `() => currentSystemPrompt` (a getter) instead of a string. The
   `onToolRoundComplete` callback mutates `currentSystemPrompt` in the
   route's closure, and the getter returns the updated value on the next
   call. Standard JavaScript closure pattern (React `useState` setter,
   Redux `getState()`).

4. **Clear, Don't Recompute** (BUG-I5) — After the first
   `search_knowledge_base` call, the auto-inject `{{knowledge}}` block
   is CLEARED (replaced with a marker), not recomputed with the tool's
   query. Recomputing would be expensive (another DB query + reranker
   call per round). The tool results are now the primary source —
   keeping the auto-inject block would create the Anthropic Contextual
   Retrieval anti-pattern: "stale auto-inject context mixed with fresh
   tool results".

5. **Cache Key Preserves Original Prompt** (BUG-I5) — The cache key
   (BUG-2) still uses the ORIGINAL `systemPrompt` const (with the KB
   block), NOT `currentSystemPrompt` (which gets cleared mid-stream).
   This is critical: the cache lookup at the start of the request used
   the original prompt, so the cache write at the end must use the same
   key. Verified via test.

6. **Tone Block Persists Across Rounds** (BUG-I5) — `clearKbBlockFromPrompt`
   only clears the `KNOWLEDGE BASE CONTEXT` block, NOT the `TONE MATCHING`
   block. Tone persists across tool rounds (the tone-locked creator
   doesn't change mid-request). The LLM should still apply the tone-locked
   creator's style, but for tool-returned entries from a different
   creator, use neutral tone (per BUG-I4 fix).

## Test Results

- **New tests**: 64/64 passing across 2 new test files
  (`toneScoping.test.ts` 26, `systemPromptRebuild.test.ts` 38).
- **Existing tests**: 1106/1106 pass (excluding 3 pre-existing
  `kbToneProfiles.test.ts` failures + 13 DB-integration test files
  requiring localhost Postgres — all pre-existing, not caused by this
  fix). Updated 1 test in `kbSearch.test.ts` for the new `searchKb`
  signature.
- **Typecheck**: `pnpm typecheck` + `pnpm typecheck:test` +
  `pnpm typecheck:libs` all pass with zero errors.
- **Lint**: 0 errors on modified files (53 warnings, all pre-existing
  `any` types in error-access patterns + non-null assertions in tests).
