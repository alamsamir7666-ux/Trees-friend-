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

const COOLDOWN_MS = Number(process.env.AI_QUOTA_COOLDOWN_MS ?? 60_000);

// ─── Per-model cooldown (same pattern as gemini.ts) ─────────────────────────
const _modelCooldowns = new Map<string, number>();

function isOnCooldown(modelName: string): boolean {
  const until = _modelCooldowns.get(modelName);
  if (!until) return false;
  if (Date.now() >= until) {
    _modelCooldowns.delete(modelName);
    return false;
  }
  return true;
}

function setCooldown(modelName: string): void {
  _modelCooldowns.set(modelName, Date.now() + COOLDOWN_MS);
}

// ─── Cached working model ────────────────────────────────────────────────────
let _workingModel: string | null = null;

// ─── Public helpers ──────────────────────────────────────────────────────────

export function isGroqConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

export function getGroqWorkingModel(): string | null {
  return _workingModel;
}

export function getGroqDebugInfo(): {
  configured: boolean;
  workingModel: string | null;
  modelChain: string[];
  cooldowns: { model: string; retryInMs: number; retryAt: string }[];
  groqModelEnv: string | null;
} {
  const now = Date.now();
  const cooldowns: { model: string; retryInMs: number; retryAt: string }[] = [];
  for (const [model, until] of _modelCooldowns) {
    const retryInMs = Math.max(0, until - now);
    if (retryInMs > 0) {
      cooldowns.push({ model, retryInMs, retryAt: new Date(until).toISOString() });
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
export function forceGroqRediscover(): void {
  _workingModel = null;
  _modelCooldowns.clear();
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

function convertDeclarationsToTools(
  declarations: FunctionDeclaration[],
): GroqTool[] {
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
    const err = new Error(
      `Groq API error ${response.status}: ${errText.slice(0, 500)}`,
    ) as any;
    err.status = response.status;
    err.errorDetails = errText;
    throw err;
  }

  return (await response.json()) as GroqChatResponse;
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
  systemPrompt: string,
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
  onMetadata?: (meta: { model: string; usage?: unknown }) => void,
): AsyncGenerator<string, void, unknown> {
  if (!isGroqConfigured()) {
    throw new Error("GROQ_API_KEY is not set. Get one at https://console.groq.com");
  }

  // Build the message array in OpenAI format.
  // Convert Gemini's "model" role → OpenAI's "assistant" role.
  const messages: GroqMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map((h) => ({
      role: (h.role === "model" ? "assistant" : "user") as "assistant" | "user",
      content: h.text,
    })),
    { role: "user", content: userMessage },
  ];

  const groqTools = tools?.declarations ? convertDeclarationsToTools(tools.declarations) : undefined;

  // Build the model try-list: cached working model first, then chain,
  // filtering out models on cooldown.
  const explicit = process.env.GROQ_MODEL;
  const tryModels: string[] = [];
  if (explicit && explicit.trim().length > 0) {
    tryModels.push(explicit.trim());
  } else {
    if (_workingModel) tryModels.push(_workingModel);
    for (const m of GROQ_MODEL_CHAIN) {
      if (!tryModels.includes(m) && !isOnCooldown(m)) tryModels.push(m);
    }
    if (tryModels.length === 0) tryModels.push(...GROQ_MODEL_CHAIN);
  }

  let lastErr: unknown = null;

  for (const modelName of tryModels) {
    try {
      // ─── Multi-round function-calling loop ─────────────────────────────
      // Same pattern as gemini.ts: non-streaming call first to check for
      // tool_calls, then stream the final text response.
      const MAX_TOOL_ROUNDS = 4;

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        // Non-streaming call (to detect tool_calls)
        const response = await callGroq(modelName, messages, round === 0 ? groqTools : undefined);

        // Emit metadata (model + usage) to the caller.
        if (onMetadata) {
          onMetadata({
            model: response.model ?? modelName,
            usage: response.usage,
          });
        }

        const choice = response.choices?.[0];
        const toolCalls = choice?.message?.tool_calls;

        if (toolCalls && toolCalls.length > 0 && tools) {
          // Execute each tool call + append results to messages
          logger.info(
            { round, calls: toolCalls.map((tc) => tc.function.name) },
            "Groq: executing function calls",
          );

          // Append the assistant message with tool_calls to the conversation
          messages.push({
            role: "assistant",
            content: choice.message.content,
            tool_calls: toolCalls,
          });

          // Execute each tool + append the result as a "tool" role message
          for (const tc of toolCalls) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments || "{}");
            } catch {
              // malformed arguments — proceed with empty
            }
            const result = await tools.execute(tc.function.name, args, userId ?? null);
            messages.push({
              role: "tool",
              content: JSON.stringify(result),
              tool_call_id: tc.id,
            });
          }

          // Loop continues — Groq processes the tool results
          continue;
        }

        // ─── No tool calls — this is the final text response ────────────
        const text = choice?.message?.content;
        if (text) {
          // We have the full text (non-streaming call). Stream it in
          // chunks to simulate streaming for the frontend.
          // This is simpler than re-calling with stream:true, and for
          // Groq's fast LPU hardware the latency is negligible.
          //
          // Split into word-level chunks for a natural typing effect.
          const words = text.split(/(\s+)/);
          for (const word of words) {
            yield word;
            // Tiny delay to make streaming visible (Groq is very fast,
            // otherwise the whole response appears in <100ms).
            // Skip delay if the word is just whitespace.
            if (word.trim()) {
              await new Promise((r) => setTimeout(r, 8));
            }
          }
        }

        // Success — cache this model.
        if (_workingModel !== modelName) {
          logger.info(
            { model: modelName, previousModel: _workingModel },
            "Groq: model selected and cached for subsequent requests",
          );
          _workingModel = modelName;
        }
        return;
      }

      // Hit MAX_TOOL_ROUNDS
      throw new Error("Groq: hit max tool rounds — model kept calling functions without producing a final answer");
    } catch (err) {
      lastErr = err;

      if (isQuotaExhaustedError(err)) {
        setCooldown(modelName);
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

  const transcript = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");

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
  const response = await callGroq(model, [
    { role: "user", content: summaryPrompt },
  ]);

  const text = response.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Groq returned empty summary.");
  }
  return text.trim();
}
