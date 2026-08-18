/**
 * Streaming & sharing features tests (v5.1).
 *
 * Verifies:
 *   - SSE event types for streaming tool-call args, usage, followups
 *   - Parallel tool execution (Promise.all) in gemini.ts + groq.ts
 *   - Export routes (JSON + Markdown)
 *   - Share routes (create + view)
 *   - Frontend useAiChat.ts handles new SSE events
 *   - SharedConversationPage exists
 *   - DB schema for ai_chat_shared_links
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/streamingSharing.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

// ─── #2: Parallel tool execution ─────────────────────────────────────────────

describe("#2: Parallel tool execution", () => {
  it("gemini.ts executes tool calls via Promise.all (concurrent)", () => {
    const source = readSource("artifacts/api-server/src/lib/gemini.ts");
    expect(source).toContain("const functionResponseParts = await Promise.all(");
    expect(source).toContain("functionCalls.map(async (fc: any)");
  });

  it("groq.ts executes tool calls via Promise.all (concurrent)", () => {
    const source = readSource("artifacts/api-server/src/lib/groq.ts");
    expect(source).toContain("const toolMessages: GroqMessage[] = await Promise.all(");
    // Comment documenting the v3.9 fix
    expect(source).toContain("execute tools in PARALLEL via Promise.all");
  });
});

// ─── #5: Live token/cost display ─────────────────────────────────────────────

describe("#5: Live token/cost streaming", () => {
  it("ai.ts streams usage via SSE `usage` event", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain('type: "usage"');
    expect(source).toContain("promptTokens");
    expect(source).toContain("completionTokens");
    expect(source).toContain("totalTokens");
  });

  it("useAiChat.ts handles `usage` SSE event", () => {
    const source = readSource("artifacts/tree-friend/src/hooks/useAiChat.ts");
    expect(source).toContain('payload.type === "usage"');
    expect(source).toContain("usage?:");
    expect(source).toContain("promptTokens");
  });

  it("ChatMessage type has usage field", () => {
    const source = readSource("artifacts/tree-friend/src/hooks/useAiChat.ts");
    expect(source).toContain("usage?: {");
    expect(source).toContain("model?: string");
    expect(source).toContain("provider?: string");
  });
});

// ─── #1: Streaming tool-call args ────────────────────────────────────────────

describe("#1: Streaming tool-call args", () => {
  it("ToolStreamEvent includes tool_call_delta type", () => {
    const source = readSource("artifacts/api-server/src/lib/aiToolLoop.ts");
    expect(source).toContain('type: "tool_call_delta"');
    expect(source).toContain("toolCallId: string");
    expect(source).toContain("argsDelta: string");
  });

  it("groq.ts fires onToolCallDelta as args accumulate", () => {
    const source = readSource("artifacts/api-server/src/lib/groq.ts");
    expect(source).toContain("onToolCallDelta");
    expect(source).toContain("argsDelta: tc.function.arguments");
  });

  it("groq.ts bridges onToolCallDelta to onToolEvent", () => {
    const source = readSource("artifacts/api-server/src/lib/groq.ts");
    expect(source).toContain('type: "tool_call_delta"');
  });

  it("ai.ts forwards tool_call_delta via SSE", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain('event.type === "tool_call_delta"');
    expect(source).toContain('type: "tool_call_delta"');
    expect(source).toContain("argsDelta: event.argsDelta");
  });

  it("useAiChat.ts handles tool_call_delta + accumulates argsPreview", () => {
    const source = readSource("artifacts/tree-friend/src/hooks/useAiChat.ts");
    expect(source).toContain('payload.type === "tool_call_delta"');
    expect(source).toContain("argsPreview");
  });

  it("ActiveToolCall type has argsPreview field", () => {
    const source = readSource("artifacts/tree-friend/src/hooks/useAiChat.ts");
    expect(source).toContain("argsPreview?: string");
  });
});

// ─── #3: Streaming followups regeneration ────────────────────────────────────

describe("#3: Streaming followups", () => {
  it("ai.ts sends followups_loading SSE event before structured output call", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain('type: "followups_loading"');
  });

  it("ai.ts sends followups_delta SSE event with structured followups", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain('type: "followups_delta"');
    expect(source).toContain("followups: structuredFollowups");
  });

  it("useAiChat.ts handles followups_loading + followups_delta", () => {
    const source = readSource("artifacts/tree-friend/src/hooks/useAiChat.ts");
    expect(source).toContain('payload.type === "followups_loading"');
    expect(source).toContain('payload.type === "followups_delta"');
    expect(source).toContain("followupsLoading");
    expect(source).toContain("followups:");
  });

  it("ChatMessage type has followupsLoading + followups fields", () => {
    const source = readSource("artifacts/tree-friend/src/hooks/useAiChat.ts");
    expect(source).toContain("followupsLoading?: boolean");
    expect(source).toContain("followups?: string[]");
  });
});

// ─── #7: Conversation export ────────────────────────────────────────────────

describe("#7: Conversation export", () => {
  it("ai.ts has GET /ai/sessions/:token/export route", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain('"/ai/sessions/:token/export"');
  });

  it("export route supports JSON format", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain('format === "markdown"');
    expect(source).toContain("application/json");
  });

  it("export route supports Markdown format with proper headers", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain("text/markdown");
    expect(source).toContain("Content-Disposition");
    expect(source).toContain("treebot-");
  });

  it("useAiChat.ts exports exportConversation function", () => {
    const source = readSource("artifacts/tree-friend/src/hooks/useAiChat.ts");
    expect(source).toContain("exportConversation");
    expect(source).toContain('format?: "json" | "markdown"');
  });
});

// ─── #6: Conversation sharing ───────────────────────────────────────────────

describe("#6: Conversation sharing", () => {
  it("ai.ts has POST /ai/sessions/:token/share route", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain('"/ai/sessions/:token/share"');
  });

  it("ai.ts has GET /ai/shared/:shareToken route (public)", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain('"/ai/shared/:shareToken"');
  });

  it("share route generates 32-char hex token (128 bits)", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain('randomBytes(16).toString("hex")');
  });

  it("share route supports optional expiration", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain("expiresHours");
    expect(source).toContain("Math.min(expiresHours, 720)");
  });

  it("shared view increments view_count", () => {
    const source = readSource("artifacts/api-server/src/routes/ai.ts");
    expect(source).toContain("view_count = view_count + 1");
  });

  it("useAiChat.ts exports shareConversation function", () => {
    const source = readSource("artifacts/tree-friend/src/hooks/useAiChat.ts");
    expect(source).toContain("shareConversation");
  });

  it("SharedConversationPage.tsx exists + fetches shared conversation", () => {
    const source = readSource("artifacts/tree-friend/src/pages/SharedConversationPage.tsx");
    expect(source).toContain("export function SharedConversationPage");
    expect(source).toContain("/api/ai/shared/");
    expect(source).toContain("useParams");
  });

  it("App.tsx has /shared/:shareToken route", () => {
    const source = readSource("artifacts/tree-friend/src/App.tsx");
    expect(source).toContain('path="/shared/:shareToken"');
    expect(source).toContain("SharedConversationPage");
  });
});

// ─── DB schema for sharing ──────────────────────────────────────────────────

describe("DB schema: ai_chat_shared_links", () => {
  it("ensureAiTables.ts creates the ai_chat_shared_links table", () => {
    const source = readSource("artifacts/api-server/src/lib/ensureAiTables.ts");
    expect(source).toContain("CREATE TABLE IF NOT EXISTS ai_chat_shared_links");
    expect(source).toContain("share_token TEXT NOT NULL UNIQUE");
    expect(source).toContain("expires_at TIMESTAMP");
    expect(source).toContain("view_count INTEGER NOT NULL DEFAULT 0");
  });

  it("Drizzle schema declares aiChatSharedLinksTable", () => {
    const source = readSource("lib/db/src/schema/aiChat.ts");
    expect(source).toContain("aiChatSharedLinksTable = pgTable(");
    expect(source).toContain('"ai_chat_shared_links"');
    expect(source).toContain("shareToken:");
    expect(source).toContain("expiresAt:");
    expect(source).toContain("viewCount:");
  });
});

// ─── #4: Tone profile streaming (skipped — not a real gap) ──────────────────

describe("#4: Tone profile streaming (background job — no streaming needed)", () => {
  it("kbToneProfiles.ts remains non-streaming (background job, not user-facing)", () => {
    const source = readSource("artifacts/api-server/src/lib/kbToneProfiles.ts");
    // Tone profiles are generated by a background job (jobs/kbToneProfileJob.ts),
    // not by a user-facing route. Streaming would add complexity for no UX benefit
    // — the admin just sees the result when it's done. This is NOT a real gap.
    expect(source).toContain("generateContent");
  });
});
