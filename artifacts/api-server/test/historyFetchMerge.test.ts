/**
 * Tests for Bug #8 fix: history fetch no longer overwrites in-flight messages.
 *
 * ─── What was the bug ───────────────────────────────────────────────────────
 *
 * The old `useEffect` on mount fetched history and called:
 *   setMessages(data.messages.map(...))
 *
 * This REPLACED the entire state. If the user had already typed + sent a
 * message before the GET resolved (slow network, ~500ms+), their
 * optimistic user message + streaming assistant placeholder were wiped.
 * The user saw their message vanish mid-stream.
 *
 * ─── The fix ─────────────────────────────────────────────────────────────────
 *
 * The new code MERGES:
 *   1. History messages from the server are prepended.
 *   2. Any ephemeral `pending-*` messages (optimistic user msg + assistant
 *      placeholder) are preserved.
 *
 * This way, the user's in-flight conversation isn't wiped by a
 * late-arriving history fetch.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/historyFetchMerge.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

describe("Bug #8 fix: history fetch merges (not replaces) in-flight messages", () => {
  const source = fs.readFileSync(
    `${REPO_ROOT}/artifacts/tree-friend/src/hooks/useAiChat.ts`,
    "utf8",
  );

  it("uses setMessages with a function (prev => ...) for the merge", () => {
    // The old code was: setMessages(data.messages.map(...))
    // The new code is: setMessages((prev) => { ... return [...historyMessages, ...ephemeral] })
    expect(source).toContain("setMessages((prev) =>");
  });

  it("filters ephemeral pending-* messages from prev state", () => {
    expect(source).toContain("prev.filter(");
    expect(source).toContain('m.id.startsWith("pending-")');
  });

  it("preserves ephemeral messages by appending them after history", () => {
    expect(source).toContain("[...historyMessages, ...ephemeral]");
  });

  it("no longer uses the replace pattern (setMessages(data.messages.map(...)))", () => {
    // The old pattern: setMessages(data.messages.map(...))
    // This should NO LONGER appear in executable code (it's OK in comments).
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/setMessages\(\s*data\.messages\.map\(/);
  });
});

describe("Bug #8 fix: ChatMessage.id type widened to number | string", () => {
  const source = fs.readFileSync(
    `${REPO_ROOT}/artifacts/tree-friend/src/hooks/useAiChat.ts`,
    "utf8",
  );

  it("ChatMessage.id is number | string (Bug #19 fix — no more `as any`)", () => {
    // The old type was `id?: number` which forced the `as any` cast for
    // the optimistic placeholder. The new type is `number | string`.
    expect(source).toMatch(/id\?:\s*number\s*\|\s*string/);
  });

  it("optimistic placeholder no longer uses `as any` cast (Bug #19 fix)", () => {
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    // The old code had: id: assistantId as any,
    expect(codeOnly).not.toMatch(/id:\s*assistantId\s+as\s+any/);
  });
});

describe("Bug #16 fix: concurrent send race via loadingRef", () => {
  const source = fs.readFileSync(
    `${REPO_ROOT}/artifacts/tree-friend/src/hooks/useAiChat.ts`,
    "utf8",
  );

  it("declares a loadingRef (useRef<boolean>)", () => {
    expect(source).toContain("const loadingRef = useRef(false)");
  });

  it("send() checks loadingRef.current (not the `loading` state variable)", () => {
    expect(source).toContain("if (!trimmed || loadingRef.current) return");
  });

  it("send() sets loadingRef.current = true synchronously before any await", () => {
    expect(source).toContain("loadingRef.current = true;");
  });

  it("send() resets loadingRef.current = false in the finally block", () => {
    expect(source).toContain("loadingRef.current = false");
  });

  it("clear() resets loadingRef.current = false", () => {
    // The clear function should also reset the ref.
    expect(source).toContain("loadingRef.current = false");
  });

  it("send() no longer has [loading] in the useCallback deps", () => {
    // The old code: }, [loading]);
    // The new code: }, []);
    // (We use loadingRef now, which is stable, so no dep needed.)
    expect(source).toMatch(/\}, \[\]\); \/\/ Bug #16 fix/);
  });
});

describe("Bug #18 fix: crypto.randomUUID no longer used in AI chat (cookie-based)", () => {
  const source = fs.readFileSync(
    `${REPO_ROOT}/artifacts/tree-friend/src/hooks/useAiChat.ts`,
    "utf8",
  );

  it("no longer calls crypto.randomUUID() in executable code", () => {
    // The old code called crypto.randomUUID() in getSessionToken() and
    // clear(). The new code uses cookie-based auth (server issues the
    // token). crypto.randomUUID should only appear in comments.
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    expect(codeOnly).not.toMatch(/crypto\.randomUUID\(\)/);
  });

  it("uses credentials: 'include' for cookie-based auth", () => {
    expect(source).toContain('credentials: "include"');
  });

  it("has a getLegacySessionToken helper (migration path)", () => {
    expect(source).toContain("function getLegacySessionToken()");
  });

  it("has a clearLegacySessionToken helper (migration cleanup)", () => {
    expect(source).toContain("function clearLegacySessionToken()");
  });
});
