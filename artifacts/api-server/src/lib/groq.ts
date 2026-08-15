/**
 * Groq provider for the TreeBot assistant.
 *
 * Why Groq as a fallback to Gemini:
 *   - Massive free tier: 30 RPM, 14,400 RPD, 500K tokens/day (vs Gemini's
 *     20 RPD for gemini-3.6-flash on new GCP projects)
 *   - Extremely fast: LPU hardware generates at 500-800 tokens/sec
 *   - Llama 3.3 70B has good multilingual support (Bangla + Banglish)
 *   - Supports function calling (OpenAI-compatible tools format)
 *
 * API: Groq uses an OpenAI-compatible API at https://api.groq.com/openai/v1
 *   - POST /chat/completions
 *   - Supports: stream: true, tools (function calling), temperature, max_tokens
 *   - Auth: Bearer gsk_... (get one at https://console.groq.com)
 *
 * Interface: this module exports `streamGroqChat()` and `summarizeConversationGroq()`
 *   with the SAME signature as gemini.ts's streamGeminiChat() and
 *   summarizeConversation(). This lets the provider router (aiRouter.ts)
 *   swap between them transparently.
 *
 * Model chain:
 *   - llama-3.3-70b-versatile — best quality, supports function calling, 30 RPM
 *   - llama-3.1-8b-instant — faster + cheaper, supports function calling
 *   Groq models are stable (no frequent deprecations like Gemini), so we
 *   don't need model discovery. Just try them in order with 429 cooldown.
 *
 * Config:
 *   GROQ_API_KEY — required, get one free at https://console.groq.com
 *   GROQ_MODEL — optional, overrides the chain with a specific model
 *   AI_QUOTA_COOLDOWN_MS — shared with Gemini, default 60s
 */
import { logger } from "./logger";
import type { FunctionDeclaration } from "@google/genai";
import { checkCircuit, recordSuccess, recordFailure } from "./circuitBreaker";
import { truncateHistory } from "./tokenCounter";
import { isOnCooldown, setCooldown, clearAllCooldowns } from "./modelCooldown";
import {
  ToolRoundBudget,
  signatureOf,
  buildMaxRoundsErrorMessage,
  buildForceFinalPromptSuffix,
  type OnToolEvent,
  type ToolCallSignature,
} from "./aiToolLoop";

// ─── Model fallback chain ───────────────────────────────────────────────────
// Groq models are stable (unlike Gemini's frequent deprecations), so we
// don't need ListModels discovery. Just try in order.
const GROQ_MODEL_CHAIN = [
  "llama-3.3-70b-versatile", // best quality, function calling, 30 RPM
  "llama-3.1-8b-instant", // faster + cheaper, function calling
];

// ─── Config ──────────────────────────────────────────────────────────────────

function getTemperature(): number {
  const raw = Number(process.env.AI_TEMPERATURE);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 2) return raw;
  return 0.4;
}

function getMaxOutputTokens(): number {
  const raw = Number(process.env.AI_MAX_TOKENS);
  if (Number.isFinite(raw) && raw >= 256 && raw <= 8192) return raw;
  return 2048;
}

/**
 * v3.9: Max number of auto-continue calls when the model hits max_tokens.
 *
 * When finish_reason === "length" (Groq's OpenAI-compatible name for
 * MAX_TOKENS), the response was truncated. We make up to N additional
 * calls, appending the partial text + a "continue" instruction, until
 * the model finishes naturally (stop) or we hit the limit.
 *
 * Default: 2 (so up to 3 × AI_MAX_TOKENS = 6144 tokens with default 2048).
 * Set to 0 to disable auto-continue.
 *
 * Kept in sync with gemini.ts's getMaxAutoContinues() (same env var).
 */
function getMaxAutoContinues(): number {
  const raw = Number(process.env.AI_MAX_AUTO_CONTINUES);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 5) return raw;
  return 2;
}

const COOLDOWN_MS = Number(process.env.AI_QUOTA_COOLDOWN_MS ?? 60_000);

// v3.3: Per-model cooldown is now Redis-backed (see lib/modelCooldown.ts).
// The isOnCooldown() and setCooldown() functions are imported from there.
// This enables distributed coordination across server instances.

// ─── Cached working model ────────────────────────────────────────────────────
let _workingModel: string | null = null;

// ─── Public helpers ──────────────────────────────────────────────────────────

export function isGroqConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

export function getGroqWorkingModel(): string | null {
  return _workingModel;
}

export async function getGroqDebugInfo(): Promise<{
  configured: boolean;
  workingModel: string | null;
  modelChain: string[];
  cooldowns: { model: string; retryInMs: number; retryAt: string }[];
  groqModelEnv: string | null;
}> {
  // v3.3: cooldowns are now Redis-backed, so we need to fetch them async.
  // We use getCooldownRemaining for each model in the chain.
  const { getCooldownRemaining } = await import("./modelCooldown");
  const cooldowns: { model: string; retryInMs: number; retryAt: string }[] = [];
  for (const model of GROQ_MODEL_CHAIN) {
    const remaining = await getCooldownRemaining("groq", model);
    if (remaining > 0) {
      cooldowns.push({
        model,
        retryInMs: remaining,
        retryAt: new Date(Date.now() + remaining).toISOString(),
      });
    }
  }
  return {
    configured: isGroqConfigured(),
    workingModel: _workingModel,
    modelChain: GROQ_MODEL_CHAIN,
    cooldowns,
    groqModelEnv: process.env.GROQ_MODEL ?? null,
  };
}

/**
 * Clears the working model cache + cooldowns. Used by the admin
 * /api/ai/admin/providers?refresh=1 endpoint after swapping API keys.
 */
export async function forceGroqRediscover(): Promise<void> {
  _workingModel = null;
  await clearAllCooldowns();
}

// ─── Groq API types ──────────────────────────────────────────────────────────
// Minimal types for the OpenAI-compatible chat completions API.
// We only define what we need — keeps the code small + easy to audit.

interface GroqMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string; // for role: "tool" messages
}

interface GroqTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

interface GroqChatRequest {
  model: string;
  messages: GroqMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: GroqTool[];
  tool_choice?: "auto" | "none";
  // Bug #9 fix: request usage stats in the stream. Groq (OpenAI-compatible)
  // sends a final chunk with `usage` after the [DONE] marker when this is set.
  // Without it, the streaming response has NO usage data → token counts are
  // undefined → cost computes to $0.
  stream_options?: { include_usage?: boolean };
}

interface GroqChatResponse {
  choices: {
    message: {
      content: string | null;
      tool_calls?: GroqMessage["tool_calls"];
    };
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  model: string;
}

// ─── Conversion: Gemini FunctionDeclaration → Groq/OpenAI tool format ───────

/**
 * Converts Gemini's FunctionDeclaration (uses Type.OBJECT enum) to
 * OpenAI's tool format (uses "object" string). Recursive to handle
 * nested properties.
 */
function convertSchemaToOpenAI(schema: any): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return {};

  // Map Gemini's Type enum values to OpenAI string values.
  // Type.OBJECT = "object", Type.STRING = "string", Type.NUMBER = "number",
  // Type.BOOLEAN = "boolean", Type.ARRAY = "array"
  const typeMap: Record<string, string> = {
    object: "object",
    string: "string",
    number: "number",
    integer: "integer",
    boolean: "boolean",
    array: "array",
  };

  const result: Record<string, unknown> = {};
  if (schema.type != null) {
    // Gemini SDK Type enum — try toString() to get "OBJECT" → lowercase
    const typeName =
      typeof schema.type === "string"
        ? schema.type.toLowerCase()
        : String(schema.type).toLowerCase().replace("type_", "");
    result.type = typeMap[typeName] ?? typeName;
  }
  if (schema.description) result.description = schema.description;
  if (Array.isArray(schema.enum)) result.enum = schema.enum;
  if (Array.isArray(schema.required)) result.required = schema.required;

  if (schema.properties && typeof schema.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      props[key] = convertSchemaToOpenAI(val);
    }
    result.properties = props;
  }

  if (schema.items) {
    result.items = convertSchemaToOpenAI(schema.items);
  }

  return result;
}

function convertDeclarationsToTools(declarations: FunctionDeclaration[]): GroqTool[] {
  return declarations.map((d) => ({
    type: "function" as const,
    function: {
      name: d.name ?? "",
      description: d.description ?? "",
      parameters: convertSchemaToOpenAI(d.parameters),
    },
  }));
}

// ─── Core: call Groq API (non-streaming, for function-calling rounds) ──────

async function callGroq(
  model: string,
  messages: GroqMessage[],
  tools?: GroqTool[],
): Promise<GroqChatResponse> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set. Get one at https://console.groq.com");
  }

  const body: GroqChatRequest = {
    model,
    messages,
    temperature: getTemperature(),
    max_tokens: getMaxOutputTokens(),
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    const err = new Error(`Groq API error ${response.status}: ${errText.slice(0, 500)}`) as any;
    err.status = response.status;
    err.errorDetails = errText;
    throw err;
  }

  return (await response.json()) as GroqChatResponse;
}

// ─── Core: stream Groq response (real SSE, not word-by-word hack) ───────────

/**
 * Streams a chat completion from Groq using real Server-Sent Events.
 *
 * Yields text deltas as they arrive from the API. Also accumulates
 * tool_calls from the stream (if any) so the caller can execute them
 * and do another round.
 *
 * This replaces the v3.0 "word-by-word with 8ms delay" hack with
 * proper streaming — the industry standard approach.
 *
 * @returns An async generator that yields text chunks. After the generator
 *   completes, check `getAccumulatedToolCalls()` to see if the model
 *   requested any function calls.
 */
interface StreamResult {
  toolCalls: GroqMessage["tool_calls"] | null;
  finishReason: string | null;
  // Bug #9 fix: capture usage stats from the final stream chunk.
  // Groq sends this when stream_options.include_usage = true.
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

async function* streamGroqCompletion(
  model: string,
  messages: GroqMessage[],
  tools?: GroqTool[],
  /**
   * v5.1: Optional callback fired as tool-call args accumulate in the
   * stream. Groq (OpenAI-compatible) streams tool_calls as deltas:
   *   chunk 1: { tool_calls: [{ index: 0, id: "call_abc", function: { name: "search_catalog", arguments: "" } }] }
   *   chunk 2: { tool_calls: [{ index: 0, function: { arguments: '{"qu' } }] }
   *   chunk 3: { tool_calls: [{ index: 0, function: { arguments: 'ery":"mang' } }] }
   *   chunk 4: { tool_calls: [{ index: 0, function: { arguments: 'o"}' } }] }
   *
   * The frontend accumulates these deltas to render "Searching for: mang..."
   * → "mango..." as the model generates the args. This is the industry-
   * standard pattern (Vercel AI SDK `tool-input-delta`, OpenAI streaming
   * tool_calls).
   *
   * NOTE: Gemini's SDK does NOT stream tool-call args (it delivers complete
   * functionCall parts), so this callback is only invoked by Groq. The route
   * handles the absence of deltas gracefully.
   */
  onToolCallDelta?: (event: { toolCallId: string; name?: string; argsDelta: string }) => void,
): AsyncGenerator<string, StreamResult, unknown> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set.");
  }

  const body: GroqChatRequest = {
    model,
    messages,
    temperature: getTemperature(),
    max_tokens: getMaxOutputTokens(),
    stream: true,
    // Bug #9 fix: request usage stats in the stream. Groq sends a final
    // chunk with `usage` (prompt_tokens, completion_tokens, total_tokens)
    // after the [DONE] marker. Without this, we have NO token count data
    // → cost tracking returns $0.
    stream_options: { include_usage: true },
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    const err = new Error(`Groq API error ${response.status}: ${errText.slice(0, 500)}`) as any;
    err.status = response.status;
    err.errorDetails = errText;
    throw err;
  }

  if (!response.body) {
    throw new Error("Groq API returned no response body for streaming.");
  }

  // Accumulate tool_calls from stream deltas.
  // Tool calls come in pieces: first chunk has {id, type, function: {name, arguments: ""}},
  // subsequent chunks append to function.arguments by index.
  const toolCallAccumulator = new Map<
    number,
    {
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }
  >();
  let finishReason: string | null = null;
  // Bug #9 fix: accumulate usage stats from the final stream chunk.
  // Groq sends a chunk with `usage` (and empty choices) after all content
  // chunks, before [DONE]. We capture it here and return it in StreamResult.
  let usage: StreamResult["usage"] | undefined;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by \n\n
    let sepIdx: number;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);

      const dataLines = rawEvent
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (dataLines.length === 0) continue;
      const payloadStr = dataLines.join("");

      if (payloadStr === "[DONE]") {
        // Stream complete — return accumulated tool calls + usage stats
        const toolCalls =
          toolCallAccumulator.size > 0
            ? Array.from(toolCallAccumulator.entries())
                .sort(([a], [b]) => a - b)
                .map(([_, tc]) => tc)
            : null;
        return { toolCalls, finishReason, usage };
      }

      try {
        const payload = JSON.parse(payloadStr);
        const choice = payload.choices?.[0];
        const delta = choice?.delta;

        // Yield text content as it arrives (real streaming)
        if (delta?.content && typeof delta.content === "string") {
          yield delta.content;
        }

        // Accumulate tool_calls (for function-calling rounds)
        if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const existing = toolCallAccumulator.get(idx);
            if (existing) {
              // Append to existing tool call
              if (tc.function?.name) existing.function.name = tc.function.name;
              if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
              // v5.1: fire delta callback for the args accumulation
              if (onToolCallDelta && tc.function?.arguments) {
                onToolCallDelta({
                  toolCallId: existing.id,
                  argsDelta: tc.function.arguments,
                });
              }
            } else {
              // New tool call
              const newId = tc.id ?? `call_${idx}`;
              toolCallAccumulator.set(idx, {
                id: newId,
                type: "function",
                function: {
                  name: tc.function?.name ?? "",
                  arguments: tc.function?.arguments ?? "",
                },
              });
              // v5.1: fire delta callback with the tool name (first delta)
              if (onToolCallDelta) {
                onToolCallDelta({
                  toolCallId: newId,
                  name: tc.function?.name,
                  argsDelta: tc.function?.arguments ?? "",
                });
              }
            }
          }
        }

        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }

        // Bug #9 fix: capture usage stats from the final chunk. Groq sends
        // this when stream_options.include_usage = true. The chunk has
        // `usage` at the top level (not inside choices) + empty choices.
        if (payload.usage && typeof payload.usage === "object") {
          usage = payload.usage;
        }
      } catch {
        // skip malformed chunks
      }
    }
  }

  // If we get here without seeing [DONE], return what we have
  const toolCalls =
    toolCallAccumulator.size > 0
      ? Array.from(toolCallAccumulator.entries())
          .sort(([a], [b]) => a - b)
          .map(([_, tc]) => tc)
      : null;
  return { toolCalls, finishReason, usage };
}

// ─── Error classification ───────────────────────────────────────────────────

function isQuotaExhaustedError(err: unknown): boolean {
  const e = err as any;
  const status = e?.status;
  if (status === 429) return true;
  const msg = typeof e?.message === "string" ? e.message.toLowerCase() : "";
  if (/rate limit|quota|too many requests/i.test(msg)) return true;
  return false;
}

// ─── Main: streamGroqChat (same signature as gemini.ts) ────────────────────

/**
 * Streams a chat completion from Groq with automatic model fallback +
 * multi-round function calling.
 *
 * Same signature as streamGeminiChat() so the router can swap them
 * transparently.
 *
 * @yields string — incremental text deltas (same as Gemini)
 */
export async function* streamGroqChat(
  // BUG-I5 fix: accept either a string (original behavior) or a getter
  // function `() => string` (so the prompt can change between tool rounds).
  // The getter is called before each round to get the current prompt.
  systemPrompt: string | (() => string),
  history: { role: "user" | "model"; text: string }[],
  userMessage: string,
  tools?: {
    declarations: FunctionDeclaration[];
    execute: (
      name: string,
      args: Record<string, unknown>,
      userId: string | null,
    ) => Promise<unknown>;
  },
  userId?: string | null,
  onMetadata?: (meta: { model: string; usage?: unknown; toolCalls?: string[] }) => void,
  /**
   * v3.7: Fired when a tool is about to be executed (`tool_call`) and when
   * it finishes (`tool_result`). The route handler writes these as SSE
   * events so the frontend can show "Looking up your order..." chips
   * during multi-tool rounds. See lib/aiToolLoop.ts → ToolStreamEvent.
   */
  onToolEvent?: OnToolEvent,
  /**
   * BUG-I5 fix: callback invoked after each tool round. If it returns a
   * string, that string replaces the system prompt for subsequent rounds.
   * Forwarded from `streamChat` in aiRouter.ts.
   */
  onToolRoundComplete?: (round: number, toolCalls: ToolCallSignature[]) => string | void,
): AsyncGenerator<string, void, unknown> {
  if (!isGroqConfigured()) {
    throw new Error("GROQ_API_KEY is not set. Get one at https://console.groq.com");
  }

  // BUG-I5 fix: resolve the system prompt source to a string for the
  // current round. Called before each round. The getter pattern means
  // the route's `onToolRoundComplete` callback can mutate
  // `currentSystemPrompt` in the route's closure, and the getter will
  // return the updated value on the next call.
  const resolveSystemPrompt = (): string =>
    typeof systemPrompt === "function" ? systemPrompt() : systemPrompt;

  // Build the message array in OpenAI format.
  // Convert Gemini's "model" role → OpenAI's "assistant" role.
  //
  // BUG-I5 fix: use the resolved system prompt (calls the getter if a
  // getter was passed). The system message at index 0 is rebuilt before
  // each round (see the refresh below in the tool loop).
  const messages: GroqMessage[] = [
    { role: "system", content: resolveSystemPrompt() },
    ...history.map((h) => ({
      role: (h.role === "model" ? "assistant" : "user") as "assistant" | "user",
      content: h.text,
    })),
    { role: "user", content: userMessage },
  ];

  const groqTools = tools?.declarations
    ? convertDeclarationsToTools(tools.declarations)
    : undefined;

  // Build the model try-list: cached working model first, then chain,
  // filtering out models on cooldown.
  const explicit = process.env.GROQ_MODEL;
  const tryModels: string[] = [];
  if (explicit && explicit.trim().length > 0) {
    tryModels.push(explicit.trim());
  } else {
    if (_workingModel) tryModels.push(_workingModel);
    // v3.9: check cooldowns in PARALLEL via Promise.all (matching
    // gemini.ts's getModelChain pattern). Previously this was a sequential
    // `for (const m of GROQ_MODEL_CHAIN) { await isOnCooldown(...) }` loop
    // — with 2 models the cost was ~2ms, but the pattern was wrong and
    // would scale linearly with chain length.
    const cooldownChecks = await Promise.all(
      GROQ_MODEL_CHAIN.map((m) => isOnCooldown("groq", m).then((onCd) => ({ m, onCd }))),
    );
    for (const { m, onCd } of cooldownChecks) {
      if (!tryModels.includes(m) && !onCd) tryModels.push(m);
    }
    if (tryModels.length === 0) tryModels.push(...GROQ_MODEL_CHAIN);
  }

  let lastErr: unknown = null;

  for (const modelName of tryModels) {
    // v3.2: Check circuit breaker before making any API call.
    // If the circuit is open, skip this model entirely (don't waste a
    // round-trip that will likely fail).
    const circuitCheck = await checkCircuit("groq", modelName);
    if (!circuitCheck.allowed) {
      logger.info(
        { model: modelName, state: circuitCheck.state, retryInMs: circuitCheck.retryInMs },
        "Groq: circuit breaker OPEN, skipping model",
      );
      continue;
    }

    try {
      // ─── Multi-round function-calling loop with REAL streaming ───────
      // v3.2: uses streamGroqCompletion() for real SSE streaming instead
      // of the word-by-word hack. Tool calls are accumulated from stream
      // deltas and executed between rounds.
      //
      // v3.6 (industry-standard tool-loop fix):
      //   - MAX_TOOL_ROUNDS is now configurable via AI_MAX_TOOL_ROUNDS
      //     (default 10, was 4). Shared with Gemini via ToolRoundBudget.
      //   - Stuck detection: if the model calls the same tool with the
      //     same args in two consecutive rounds, abort the loop and
      //     fall through to the force-final path.
      //   - Graceful degradation: when the budget is exhausted, make ONE
      //     more call with tools DISABLED so the user gets a best-effort
      //     text answer instead of a hard error.
      //   - Tools are now passed on EVERY round (was: round 0 only).
      //     This enables sequential tool calling — e.g. the model can
      //     call get_user_orders first, then call get_product_care for
      //     a specific product from the order, based on the order result.
      //     Industry standard (OpenAI, Anthropic, Vercel AI SDK) all
      //     support this pattern.
      const budget = new ToolRoundBudget();

      // Bug #4 fix: track all tool calls across all rounds so we can emit
      // them in the final metadata callback. The route uses this to decide
      // cache policy (skip cache for user-scoped tools, short-TTL for catalog
      // tools).
      const toolCallsCalled: string[] = [];
      // Bug #9 fix: capture usage from the LAST round that produced a
      // StreamResult. If the force-final call runs, its usage overrides
      // earlier ones (it's the most accurate final-token count).
      let lastUsage: StreamResult["usage"] | undefined;

      while (budget.hasBudget) {
        const round = budget.currentRound;

        if (budget.shouldWarnAboutHighRounds) {
          logger.warn(
            { round, maxRounds: budget.maxRoundsValue, model: modelName },
            "Groq: tool loop exceeded soft warning threshold — investigate if this happens often",
          );
          budget.markWarned();
        }

        // v3.2: truncate history to fit the model's context window.
        // This prevents 400 errors when the conversation is very long.
        // Only relevant on round 0 — later rounds use the `messages`
        // array (which already includes tool results) directly.
        let messagesForRound: GroqMessage[];
        if (round === 0) {
          // BUG-I5 fix: resolve the system prompt via the getter (in case
          // it changed between rounds — though for round 0 it hasn't yet).
          const resolvedSystemPrompt = resolveSystemPrompt();
          const { history: truncatedHistory, truncated } = truncateHistory(
            resolvedSystemPrompt,
            history,
            userMessage,
            modelName,
            !!groqTools,
          );
          if (truncated) {
            logger.debug(
              { model: modelName, droppedMessages: truncated },
              "Groq: truncated history to fit context window",
            );
          }
          messagesForRound = [
            { role: "system", content: resolvedSystemPrompt },
            ...truncatedHistory.map((h) => ({
              role: (h.role === "model" ? "assistant" : "user") as "assistant" | "user",
              content: h.text,
            })),
            { role: "user", content: userMessage },
          ];
          // Persist the round-0 messages into `messages` so subsequent
          // rounds can append tool calls/results to it.
          messages.length = 0;
          messages.push(...messagesForRound);
        } else {
          messagesForRound = messages;
        }

        // v3.6: pass tools on EVERY round (was: round 0 only). This
        // enables sequential tool calling where tool B's args depend on
        // tool A's result. The max-rounds budget + stuck detection
        // prevent runaway loops.
        //
        // The force-final path (when budget is exhausted) overrides
        // this to `undefined` below.
        const toolsForRound = groqTools;

        // Streaming call — yields text as it arrives, accumulates tool_calls.
        // v5.1: pass onToolCallDelta so the frontend can stream tool args.
        // We bridge onToolEvent (the route's callback) to onToolCallDelta
        // (the streaming-internal callback) by converting the delta event
        // to a ToolStreamEvent + firing it via onToolEvent.
        const stream = streamGroqCompletion(
          modelName,
          messagesForRound,
          toolsForRound,
          onToolEvent
            ? (delta) => {
                onToolEvent({
                  type: "tool_call_delta",
                  toolCallId: delta.toolCallId,
                  name: delta.name,
                  argsDelta: delta.argsDelta,
                });
              }
            : undefined,
        );

        let result: StreamResult | undefined;
        while (true) {
          const { value, done } = await stream.next();
          if (done) {
            result = value as StreamResult;
            break;
          }
          if (typeof value === "string") {
            yield value;
          }
        }

        if (result?.usage) {
          lastUsage = result.usage;
        }

        // NOTE: we no longer emit metadata here per-round. We emit it ONCE
        // after the loop completes, with the accumulated toolCalls list.
        // (Bug #4 fix — the route needs the final toolCalls info to decide
        // cache policy.)

        const toolCalls = result?.toolCalls;

        if (toolCalls && toolCalls.length > 0 && tools) {
          // Bug #4 fix: record the tool names for the final metadata emission.
          for (const tc of toolCalls) {
            if (typeof tc?.function?.name === "string") {
              toolCallsCalled.push(tc.function.name);
            }
          }
          // Execute each tool call + append results to messages
          logger.info(
            { round, calls: toolCalls.map((tc) => tc.function.name) },
            "Groq: executing function calls",
          );

          // Append the assistant message with tool_calls to the conversation
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: toolCalls,
          });

          // v3.6: Stuck detection — if this round's tool calls are identical
          // (same name + same args) to the PREVIOUS round's, the model is
          // stuck in a loop. Break out and fall through to the force-final
          // path.
          const currentSignatures = toolCalls.map((tc) => {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments || "{}");
            } catch {
              // malformed arguments — proceed with empty
            }
            return signatureOf(tc.function.name, args);
          });
          const stuckTool = budget.detectStuck(currentSignatures);
          if (stuckTool) {
            logger.error(
              { round, stuckTool, model: modelName, maxRounds: budget.maxRoundsValue },
              "Groq: stuck loop detected — model called the same tool with the same args in consecutive rounds",
            );
            // v3.7 fix: mark stuck BEFORE break so shouldForceFinal returns
            // true and the graceful-degradation path runs (was: falling
            // through to the safety-net throw, giving users a hard error).
            budget.markStuck();
            // Break out of the loop and fall through to graceful degradation.
            break;
          }
          budget.recordRound(currentSignatures);

          // v3.7: Execute tools + append results as "tool" role messages.
          // Fire onToolEvent before+after each so the UI can show progress.
          //
          // v3.9: execute tools in PARALLEL via Promise.all (matching
          // gemini.ts's pattern). Previously this was a sequential
          // `for (const tc of toolCalls)` loop, which meant:
          //   - If the model emitted 3 tool calls, they ran one-after-another
          //     (3 × avg-tool-latency = ~3 × 50-200ms = 150-600ms).
          //   - The same logical request behaved DIFFERENTLY depending on
          //     which provider handled it (Gemini parallel, Groq sequential).
          //
          // Parallel execution cuts multi-tool latency to ~max(individual)
          // instead of sum(individual). The tool-result messages are pushed
          // in the ORIGINAL order (Promise.all preserves array order), so
          // Groq sees the same message sequence regardless of execution order.
          //
          // Safety: the 5 tools (search_catalog, get_product_care,
          // get_user_orders, get_order_details, search_knowledge_base) are
          // all read-only SELECTs against independent tables — no write
          // contention, no shared-row race. If write tools are added later,
          // they should be sequenced explicitly (not via this Promise.all).
          const toolMessages: GroqMessage[] = await Promise.all(
            toolCalls.map(async (tc) => {
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(tc.function.arguments || "{}");
              } catch {
                // malformed arguments — proceed with empty
              }
              const toolName = tc.function.name;
              if (onToolEvent) {
                onToolEvent({ type: "tool_call", name: toolName, args });
              }
              const t0 = Date.now();
              try {
                const toolResult = await tools.execute(toolName, args, userId ?? null);
                if (onToolEvent) {
                  onToolEvent({
                    type: "tool_result",
                    name: toolName,
                    ok: true,
                    durationMs: Date.now() - t0,
                  });
                }
                return {
                  role: "tool" as const,
                  content: JSON.stringify(toolResult),
                  tool_call_id: tc.id,
                };
              } catch (err) {
                // String(err) always returns a string, so `?? "tool execution failed"`
                // would be dead code. Use a fallback only for empty strings.
                const rawMsg = (err as any)?.message ?? String(err);
                const errMsg = rawMsg || "tool execution failed";
                if (onToolEvent) {
                  onToolEvent({
                    type: "tool_result",
                    name: toolName,
                    ok: false,
                    error: errMsg,
                    durationMs: Date.now() - t0,
                  });
                }
                // Return the error as the tool result so the model can react.
                return {
                  role: "tool" as const,
                  content: JSON.stringify({ error: errMsg }),
                  tool_call_id: tc.id,
                };
              }
            }),
          );
          // Push all tool-result messages in original order (Promise.all
          // preserves array order regardless of resolution order).
          messages.push(...toolMessages);

          // BUG-I5 fix: notify the route handler that a tool round completed.
          // If the callback returns a string, the route has updated
          // `currentSystemPrompt` in its closure — we refresh the system
          // message below so the next round sees the updated prompt.
          // Used to clear the {{knowledge}} block after the first
          // search_knowledge_base call so the LLM doesn't see stale
          // auto-inject context mixed with fresh tool results.
          if (onToolRoundComplete) {
            // round is 0-indexed in Groq's loop; pass 1-indexed to the
            // callback for human-readability + consistency with Gemini.
            onToolRoundComplete(round + 1, currentSignatures);
          }

          // BUG-I5 fix: refresh the system message at index 0 before the
          // next round. If the route passed a getter, this calls the
          // getter — which may have been updated by `onToolRoundComplete`
          // above (the callback updates `currentSystemPrompt` in the
          // route's closure, and the getter returns the new value).
          messages[0] = { role: "system", content: resolveSystemPrompt() };

          // Loop continues — Groq processes the tool results
          budget.advance();
          continue;
        }

        // ─── No tool calls — response is complete (already streamed) ────
        // v3.5: If the stream produced no text, log a warning. The route
        // handler will show a friendly fallback to the user.
        if (round > 0) {
          // After tool rounds, we expect text. If empty, something went wrong.
          logger.warn(
            { model: modelName, round, hadToolCallsInPrevRound: true },
            "Groq: completed tool rounds but produced no final text",
          );
        }
        // Success — record with circuit breaker + cache this model.
        await recordSuccess("groq", modelName);
        if (_workingModel !== modelName) {
          logger.info(
            { model: modelName, previousModel: _workingModel },
            "Groq: model selected and cached for subsequent requests",
          );
          _workingModel = modelName;
        }

        // v3.9: auto-continue if truncated (finish_reason === "length").
        // Groq uses OpenAI-compatible "length" instead of Gemini's "MAX_TOKENS".
        //
        // When the response hits max_tokens, we make up to
        // AI_MAX_AUTO_CONTINUES additional calls, appending the partial
        // assistant text + a "continue" user message, until the model
        // finishes naturally (stop) or we hit the limit.
        //
        // This fixes the v3.8 bug where long plant-care guides got
        // truncated at 2048 tokens, often cutting off the [followups]
        // block — which then triggered the structuredOutput fallback
        // LLM call (double cost). Now the response continues + the
        // [followups] block lands in the natural stop.
        //
        // We only auto-continue when there were NO tool calls (pure text
        // response). Tool-call rounds loop normally.
        if (result?.finishReason === "length") {
          const maxAutoContinues = getMaxAutoContinues();
          let continueCount = 0;
          // Track the finish reason across continue calls.
          let currentFinishReason: string | null = result.finishReason;

          while (
            currentFinishReason === "length" &&
            continueCount < maxAutoContinues &&
            !budget.hadStuckLoop
          ) {
            continueCount++;
            logger.info(
              {
                continueCount,
                maxAutoContinues,
                model: modelName,
                maxOutputTokens: getMaxOutputTokens(),
              },
              "Groq: auto-continuing truncated response (finish_reason=length)",
            );

            // Append the partial assistant message + a "continue" user
            // message. The model sees its own partial output + knows to
            // pick up mid-sentence. This is the standard "continue
            // generation" pattern (OpenAI, Anthropic, LangChain all do
            // this for max_tokens truncation).
            //
            // We use content: null for the assistant message (matching
            // the tool-call assistant message pattern) + a fresh user
            // message with the continue instruction.
            messages.push({
              role: "assistant",
              content: null,
            });
            messages.push({
              role: "user",
              content:
                "Continue your previous response exactly from where it was cut off. Do not repeat what you already said — just complete the remaining content.",
            });

            // Run one more streaming call (no tools — we're continuing
            // a text response). The text deltas are yielded to the SSE
            // stream as they arrive.
            const continueStream = streamGroqCompletion(modelName, messages, undefined);
            let continueResult: StreamResult | undefined;
            while (true) {
              const { value, done } = await continueStream.next();
              if (done) {
                continueResult = value as StreamResult;
                break;
              }
              if (typeof value === "string") {
                yield value;
              }
            }

            if (continueResult?.usage) {
              lastUsage = continueResult.usage;
            }
            currentFinishReason = continueResult?.finishReason ?? null;
          }

          if (currentFinishReason === "length") {
            logger.warn(
              {
                finishReason: currentFinishReason,
                model: modelName,
                maxOutputTokens: getMaxOutputTokens(),
                continueCount,
              },
              "Groq: response still truncated after auto-continue limit. Consider raising AI_MAX_TOKENS or AI_MAX_AUTO_CONTINUES.",
            );
          }
        }

        // Bug #4 fix: emit the FINAL metadata with the accumulated toolCalls
        // list. This lets the route decide cache policy (skip cache for
        // user-scoped tools like get_user_orders, short-TTL for catalog tools
        // like search_catalog, normal long-TTL for no-tool responses).
        //
        // Bug #9 fix: also pass the captured `usage` from the last round's
        // StreamResult. With stream_options.include_usage = true, Groq sends
        // a final chunk with prompt_tokens / completion_tokens / total_tokens.
        // The route uses this for cost tracking (calculateCost).
        if (onMetadata) {
          onMetadata({
            model: modelName,
            // Bug #9 fix: pass the captured usage (was `undefined` before).
            // Map Groq's OpenAI-style field names to the generic shape the
            // route expects (promptTokenCount / candidatesTokenCount /
            // totalTokenCount — Gemini names, since the route's extraction
            // code was originally written for Gemini).
            usage: lastUsage
              ? {
                  promptTokenCount: lastUsage.prompt_tokens,
                  candidatesTokenCount: lastUsage.completion_tokens,
                  totalTokenCount: lastUsage.total_tokens,
                }
              : undefined,
            toolCalls: toolCallsCalled,
          });
        }
        return;
      }

      // ─── Graceful degradation: budget exhausted (or stuck loop) ───────
      //
      // Instead of throwing an error (the old behavior), make ONE more call
      // with tools DISABLED + a "stop calling tools" system-prompt suffix.
      // This forces Groq to produce a best-effort text answer using whatever
      // information it already gathered from the tool calls. The user gets
      // SOMETHING useful instead of a hard error.
      //
      // Industry references:
      //   - Vercel AI SDK: emits a `tool-call-error` then continues the stream
      //   - OpenAI Assistants: stops the run with `expired` status but keeps
      //     partial output
      //   - Anthropic: stops with `max_tokens` stop reason, keeps partial output
      if (budget.shouldForceFinal) {
        budget.markForceFinalEmitted();
        logger.warn(
          { rounds: budget.maxRoundsValue, model: modelName, hadStuckLoop: budget.hadStuckLoop },
          "Groq: tool budget exhausted — making one force-final call with tools disabled (graceful degradation)",
        );

        // Append the force-final suffix to the system prompt.
        const forceFinalMessages: GroqMessage[] = [
          {
            role: "system",
            content:
              (messages[0]?.role === "system" ? (messages[0].content as string) : systemPrompt) +
              buildForceFinalPromptSuffix(),
          },
          ...messages.slice(messages[0]?.role === "system" ? 1 : 0),
        ];

        const forceStream = streamGroqCompletion(
          modelName,
          forceFinalMessages,
          undefined, // no tools — force text answer
        );

        let forceResult: StreamResult | undefined;
        while (true) {
          const { value, done } = await forceStream.next();
          if (done) {
            forceResult = value as StreamResult;
            break;
          }
          if (typeof value === "string") {
            yield value;
          }
        }

        if (forceResult?.usage) {
          lastUsage = forceResult.usage;
        }

        // Record success/failure with circuit breaker. The force-final call
        // succeeded if we got any text — even if it's a best-effort answer.
        await recordSuccess("groq", modelName);
        if (_workingModel !== modelName) {
          _workingModel = modelName;
        }

        if (onMetadata) {
          onMetadata({
            model: modelName,
            usage: lastUsage
              ? {
                  promptTokenCount: lastUsage.prompt_tokens,
                  candidatesTokenCount: lastUsage.completion_tokens,
                  totalTokenCount: lastUsage.total_tokens,
                }
              : undefined,
            toolCalls: toolCallsCalled,
          });
        }
        return;
      }

      // Safety net — should be unreachable. The force-final block above
      // should always run when the budget is exhausted.
      await recordFailure("groq", modelName, "other");
      throw new Error(buildMaxRoundsErrorMessage(budget.maxRoundsValue));
    } catch (err) {
      lastErr = err;

      // Record failure with circuit breaker (for all error types)
      const errorType = isQuotaExhaustedError(err) ? "429" : "other";
      await recordFailure("groq", modelName, errorType);

      if (isQuotaExhaustedError(err)) {
        await setCooldown("groq", modelName);
        const wasCached = _workingModel === modelName;
        if (wasCached) {
          _workingModel = null;
        }
        logger.warn(
          { model: modelName, wasCached, cooldownMs: COOLDOWN_MS },
          `Groq: model quota exhausted (429), ${wasCached ? "clearing cache + " : ""}on cooldown, trying next model`,
        );
        continue;
      }

      // Non-quota error — don't try other models, rethrow.
      throw err;
    }
  }

  // All models exhausted (all returned 429 quota errors)
  throw new Error(
    "All Groq models are rate-limited or unavailable. " +
      `Last error: ${(lastErr as any)?.message ?? "unknown"}. ` +
      "Check your Groq quota at https://console.groq.com/usage.",
  );
}

// ─── Summarization (same signature as gemini.ts) ────────────────────────────

/**
 * Generates a short summary of an older conversation using Groq.
 * Same signature as gemini.ts's summarizeConversation().
 */
export async function summarizeConversationGroq(
  messages: { role: "user" | "assistant"; content: string }[],
): Promise<string> {
  if (!isGroqConfigured()) {
    throw new Error("GROQ_API_KEY is not set; cannot summarize conversation.");
  }

  const transcript = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");

  const summaryPrompt = `Summarize the following plant-assistant conversation in 3-5 sentences.
Capture:
- What plants/topics the user asked about
- Key advice or recommendations given
- Any products mentioned or recommended
- The user's garden setup (if mentioned: indoor/balcony/garden, climate, soil type)

Be concise — this summary will be injected into a future system prompt to
give the assistant long-term memory. Don't include greetings or small talk.

CONVERSATION:
${transcript}

SUMMARY:`;

  const model = _workingModel ?? GROQ_MODEL_CHAIN[0];
  const response = await callGroq(model, [{ role: "user", content: summaryPrompt }]);

  const text = response.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Groq returned empty summary.");
  }
  return text.trim();
}
