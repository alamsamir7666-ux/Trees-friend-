/**
 * groqModels.ts — P2 #13: shared Groq model capabilities registry.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 *
 * The `GROQ_MODELS_WITH_JSON_SCHEMA` set was previously DUPLICATED across 4
 * files:
 *   - structuredOutput.ts (for structured followups generation)
 *   - outputSafety.ts (for Constitutional AI safety check)
 *   - topicClassifier.ts (for on-topic/off-topic classification)
 *   - promptInjectionLLM.ts (for prompt-injection LLM classifier)
 *
 * Each file had its own copy of the set + its own `supportsGroqJsonSchema()`
 * helper. This caused DRIFT — when a new Groq model was added to one file,
 * the others were often missed. At the time of this fix, `promptInjectionLLM.ts`
 * was MISSING `openai/gpt-oss-20b` (added to the other 3 but not this one).
 * The injection classifier would fall back to `json_object` mode for that
 * model, missing the stronger `json_schema` guarantee.
 *
 * This module provides a SINGLE source of truth for Groq model capabilities.
 * Each consumer imports `supportsGroqJsonSchema()` from here instead of
 * maintaining its own copy.
 *
 * ─── Design decisions ────────────────────────────────────────────────────────
 *
 * 1. **The set is a `const` exported as `GROQ_MODELS_WITH_JSON_SCHEMA`** so
 *    consumers can iterate it if needed (e.g., for admin dashboards that
 *    show which models are configured).
 *
 * 2. **The `supportsGroqJsonSchema()` helper handles the `@date-suffix`
 *    variant** (e.g., `llama-3.3-70b-versatile@2025-01-01`). Groq occasionally
 *    ships dated snapshots; the json_schema capability follows the base model.
 *
 * 3. **The set is NOT configurable via env var** — it's a hardcoded registry
 *    of known Groq model capabilities. If a new model is released, add it here
 *    + all 4 consumers get the update automatically.
 *
 * 4. **The set includes DEPRECATED models** (llama-3.3-70b-versatile,
 *    llama-3.1-8b-instant) for backward compat — users with GROQ_MODEL env
 *    var still pointing at them get json_schema support until the model is
 *    fully decommissioned.
 *
 * ─── Compatibility ───────────────────────────────────────────────────────────
 *
 * This module is purely additive — it doesn't change any behavior. The 4
 * consumers now import from here instead of maintaining their own copies.
 * The `supportsGroqJsonSchema()` function has the SAME signature + behavior
 * as the per-module helpers it replaces.
 */

/**
 * The set of Groq models known to support the `json_schema` response format
 * (stronger than `json_object` — guarantees schema compliance, not just valid JSON).
 *
 * When a model is in this set, the caller uses `response_format:
 * {type: "json_schema", json_schema: {schema, strict: true}}` for guaranteed-
 * shape responses. When NOT in the set, the caller falls back to
 * `response_format: {type: "json_object"}` + runtime validation.
 *
 * v6.2 Part 10: added llama-4-* models (Llama 4 MoE family, supports json_schema).
 * v6.2 Part 19 (Aug 19, 2026): added openai/gpt-oss-120b + openai/gpt-oss-20b
 * (Groq's recommended migration target after Llama 4 deprecation).
 * Kept the deprecated llama-3.3-70b-versatile + llama-3.1-8b-instant entries
 * for backward compat (users with GROQ_MODEL env var still pointing at them).
 */
export const GROQ_MODELS_WITH_JSON_SCHEMA: ReadonlySet<string> = new Set<string>([
  // Llama 4 MoE family (supports json_schema).
  "llama-4-scout-17b-16e-instruct",
  "llama-4-maverick-17b-128e-instruct",
  // OpenAI gpt-oss models (Groq's recommended migration target after Llama 4).
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  // Deprecated Llama 3.3 + 3.1 models (kept for backward compat).
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  // Legacy Llama 3 models (kept for backward compat).
  "llama3-70b-8192",
  "llama3-8b-8192",
]);

/**
 * Checks whether a Groq model supports the `json_schema` response format.
 *
 * Handles the `@date-suffix` variant (e.g., `llama-3.3-70b-versatile@2025-01-01`).
 * Groq occasionally ships dated snapshots; the json_schema capability follows
 * the base model. We split on `@` and check the base name.
 *
 * @param model The Groq model name (e.g., `openai/gpt-oss-120b` or
 *              `llama-3.3-70b-versatile@2025-01-01`).
 * @returns true if the model supports `json_schema`; false if the caller
 *          should fall back to `json_object` + runtime validation.
 *
 * @example
 *   supportsGroqJsonSchema("openai/gpt-oss-120b") // → true
 *   supportsGroqJsonSchema("llama-3.3-70b-versatile@2025-01-01") // → true
 *   supportsGroqJsonSchema("some-unknown-model") // → false
 */
export function supportsGroqJsonSchema(model: string): boolean {
  const base = model.split("@")[0];
  return GROQ_MODELS_WITH_JSON_SCHEMA.has(base);
}
