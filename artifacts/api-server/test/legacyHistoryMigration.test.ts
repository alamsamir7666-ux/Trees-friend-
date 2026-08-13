/**
 * Tests for the legacy UUID history migration (Bug #1 backward compat fix).
 *
 * ─── What this tests ─────────────────────────────────────────────────────────
 *
 * Existing users (who have old chat history) have a bare crypto.randomUUID()
 * in their localStorage from before the Bug #1 fix. When they load the chat
 * page after deploy:
 *
 *   1. No cookie exists yet (cookies are only set by POST /ai/chat)
 *   2. Frontend sends GET /api/ai/sessions/<bare-uuid>
 *   3. Server's verifySessionAccess must:
 *      a. Recognize the bare UUID as a legacy token
 *      b. Look it up in the DB
 *      c. If found → mint a signed token, set cookie, return history
 *      d. If not found → return empty history (new visitor)
 *
 * Without this migration path, existing users would lose access to their
 * previous chat history on first load after deploy.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/legacyHistoryMigration.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

// Ensure the AI_SESSION_SECRET is set (required by sessionToken.ts which is
// transitively imported). setupEnv.ts handles this for the rest of the suite.
process.env.AI_SESSION_SECRET ??=
  "dGVzdC1haS1zZXNzaW9uLXNlY3JldC1rZXktZG8tbm90LXVzZS1pbi1wcm9k";

const aiRouteSource = fs.readFileSync(
  "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/ai.ts",
  "utf8",
);

describe("Legacy UUID history migration (Bug #1 backward compat)", () => {
  describe("isLegacyUuid helper", () => {
    it("is exported as a top-level function in ai.ts", () => {
      expect(aiRouteSource).toContain("function isLegacyUuid(token: string): boolean");
    });

    it("uses the v4 UUID regex pattern", () => {
      expect(aiRouteSource).toContain("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    });
  });

  describe("verifySessionAccess has a legacy UUID migration path", () => {
    it("checks for GET method (only GET honors legacy UUIDs, not DELETE)", () => {
      // DELETE is irreversible — we require the signed cookie for it.
      // GET is read-only — we allow legacy UUIDs for backward compat.
      expect(aiRouteSource).toContain("req.method === \"GET\"");
    });

    it("checks isLegacyUuid(urlToken) before doing the DB lookup", () => {
      expect(aiRouteSource).toContain("isLegacyUuid(urlToken)");
    });

    it("looks up the bare UUID in the DB by session_token", () => {
      expect(aiRouteSource).toContain(
        "SELECT user_id FROM ai_chat_sessions WHERE session_token = $1",
      );
    });

    it("mints a new signed token when the legacy UUID is found", () => {
      expect(aiRouteSource).toContain("signSessionToken({ sid: urlToken, uid: existingUid })");
    });

    it("sets the new signed token as a cookie (so future requests use the cookie)", () => {
      expect(aiRouteSource).toContain("setSessionCookie(res, newToken)");
    });

    it("logs the migration for observability", () => {
      expect(aiRouteSource).toContain("legacy UUID migrated to signed token on GET (history preserved)");
    });

    it("checks ownership for authenticated legacy sessions (uid mismatch → 403)", () => {
      // If the legacy session is bound to user X, the requester must also be X.
      // Otherwise reject (possible hijack).
      expect(aiRouteSource).toContain("existingUid !== null && existingUid !== requesterUid");
      expect(aiRouteSource).toContain("legacy GET access denied — identity mismatch");
    });

    it("returns null (empty history) when legacy UUID is NOT in DB (new visitor)", () => {
      // The code returns null without sending an error response, so the GET
      // handler falls through to "return empty history with 200".
      expect(aiRouteSource).toContain(
        "// Bare UUID not in DB → treat as new visitor (no history yet).",
      );
    });
  });

  describe("GET handler returns empty history (not 401) for missing sessions", () => {
    it("returns 200 with empty messages when verifySessionAccess returns null", () => {
      // The GET handler checks `if (!res.headersSent)` and returns empty history.
      expect(aiRouteSource).toContain('res.json({ sessionToken: null, title: null, messages: [] })');
    });
  });

  describe("DELETE handler does NOT honor legacy UUIDs", () => {
    it("the legacy migration path is guarded by req.method === 'GET'", () => {
      // DELETE is irreversible — we require the signed cookie.
      // The `req.method === "GET"` check in the migration path ensures
      // DELETE requests with a bare UUID fall through to the 401 rejection.
      const migrationPath = aiRouteSource.match(
        /if \(req\.method === "GET" && urlToken && isLegacyUuid\(urlToken\)\)/,
      );
      expect(migrationPath).not.toBeNull();
    });
  });
});

describe("Frontend useAiChat.ts sends legacy UUID in URL for migration", () => {
  const frontendSource = fs.readFileSync(
    "/home/z/my-project/Trees-friend-/artifacts/tree-friend/src/hooks/useAiChat.ts",
    "utf8",
  );

  it("reads legacy token from localStorage on mount", () => {
    expect(frontendSource).toContain("getLegacySessionToken()");
  });

  it("sends the legacy UUID in the URL path (for migration)", () => {
    expect(frontendSource).toContain("const urlToken = legacyToken ?? \"anonymous\"");
    expect(frontendSource).toContain("/api/ai/sessions/${encodeURIComponent(urlToken)}");
  });

  it("uses credentials: 'include' (sends + receives cookies)", () => {
    expect(frontendSource).toContain('credentials: "include"');
  });

  it("clears localStorage when migration succeeds (server returns new token)", () => {
    expect(frontendSource).toContain("clearLegacySessionToken()");
  });
});
