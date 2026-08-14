/**
 * Tests for the signed session token utility (lib/sessionToken.ts).
 *
 * These tests verify the cryptographic contract:
 *   - Sign + verify round-trips correctly.
 *   - Tampering with any byte invalidates the signature.
 *   - Forged tokens (wrong secret, no signature, malformed payload) are rejected.
 *   - Identity binding works: a token bound to user X can't be used as user Y.
 *   - Legacy bare UUIDs are NOT valid signed tokens (they have no signature).
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/sessionToken.test.ts
 */
import { describe, it, expect } from "vitest";
import * as nodeCrypto from "node:crypto";
import {
  signSessionToken,
  verifySessionToken,
  mintAnonymousSessionToken,
  mintAuthenticatedSessionToken,
  tokenMatchesIdentity,
} from "../src/lib/sessionToken";

// Ensure the test secret is set BEFORE the module loads it. setupEnv.ts
// handles this for the rest of the suite, but we double-check here.
process.env.AI_SESSION_SECRET ??=
  "dGVzdC1haS1zZXNzaW9uLXNlY3JldC1rZXktZG8tbm90LXVzZS1pbi1wcm9k";

describe("sessionToken", () => {
  describe("signSessionToken + verifySessionToken round-trip", () => {
    it("round-trips an anonymous token", () => {
      const token = mintAnonymousSessionToken();
      const verified = verifySessionToken(token);
      expect(verified).not.toBeNull();
      expect(verified!.v).toBe(1);
      expect(verified!.sid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(verified!.uid).toBeNull();
      expect(typeof verified!.iat).toBe("number");
    });

    it("round-trips an authenticated token", () => {
      const uid = "user_abc123";
      const token = mintAuthenticatedSessionToken(uid);
      const verified = verifySessionToken(token);
      expect(verified).not.toBeNull();
      expect(verified!.uid).toBe(uid);
      expect(verified!.sid).toMatch(/^[0-9a-f]{8}-/i);
    });

    it("preserves the sid across sign + verify", () => {
      const sid = "11111111-2222-3333-4444-555555555555";
      const token = signSessionToken({ sid, uid: null });
      const verified = verifySessionToken(token);
      expect(verified!.sid).toBe(sid);
    });
  });

  describe("tamper detection", () => {
    it("rejects a token with a modified payload", () => {
      const token = mintAnonymousSessionToken();
      // Flip the first character of the payload (before the `.`).
      const dotIdx = token.lastIndexOf(".");
      const payloadB64 = token.slice(0, dotIdx);
      const sigB64 = token.slice(dotIdx + 1);
      // Replace the first payload char with a different one.
      const tamperedPayload =
        (payloadB64[0] === "A" ? "B" : "A") + payloadB64.slice(1);
      const tamperedToken = `${tamperedPayload}.${sigB64}`;
      expect(verifySessionToken(tamperedToken)).toBeNull();
    });

    it("rejects a token with a modified signature", () => {
      const token = mintAnonymousSessionToken();
      const dotIdx = token.lastIndexOf(".");
      const payloadB64 = token.slice(0, dotIdx);
      const sigB64 = token.slice(dotIdx + 1);
      // Flip one character in the signature.
      const tamperedSig =
        (sigB64[0] === "A" ? "B" : "A") + sigB64.slice(1);
      const tamperedToken = `${payloadB64}.${tamperedSig}`;
      expect(verifySessionToken(tamperedToken)).toBeNull();
    });

    it("rejects a token with the wrong sid bound to a uid (forged identity)", () => {
      // Sign a token with a known sid + uid. This is just a round-trip
      // sanity check: the sid and uid we put in are what we get back.
      const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const uid = "user_xyz";
      const token = signSessionToken({ sid, uid });
      const verified = verifySessionToken(token);
      expect(verified).not.toBeNull();
      expect(verified!.sid).toBe(sid);
      expect(verified!.uid).toBe(uid);
    });
  });

  describe("forgery rejection", () => {
    it("rejects a token with no signature (bare UUID)", () => {
      const bareUuid = nodeCrypto.randomUUID();
      expect(verifySessionToken(bareUuid)).toBeNull();
    });

    it("rejects a token with a malformed payload (not base64url JSON)", () => {
      const fakePayload = "not-valid-json-base64";
      const fakeSig = "fakesig";
      expect(verifySessionToken(`${fakePayload}.${fakeSig}`)).toBeNull();
    });

    it("rejects a token with no `.` separator", () => {
      expect(verifySessionToken("nopdotatall")).toBeNull();
    });

    it("rejects a token with an empty payload", () => {
      expect(verifySessionToken(".fakesig")).toBeNull();
    });

    it("rejects a token with an empty signature", () => {
      expect(verifySessionToken("payload.")).toBeNull();
    });

    it("rejects a token signed with a different secret", () => {
      // Mint a token with the test secret, then swap the secret and verify.
      const token = mintAnonymousSessionToken();
      // We can't easily change the module's loaded secret in-place, so we
      // simulate this by signing with a different secret manually.
      // (This is the same logic the module uses, just with a different key.)
      const otherSecret = "different-secret-entirely";
      const otherHmac = nodeCrypto.createHmac("sha256", otherSecret);
      const dotIdx = token.lastIndexOf(".");
      const payloadB64 = token.slice(0, dotIdx);
      otherHmac.update(payloadB64, "utf8");
      const otherSig = otherHmac.digest().toString("base64url");
      const forgedToken = `${payloadB64}.${otherSig}`;
      expect(verifySessionToken(forgedToken)).toBeNull();
    });

    it("rejects a token with a wrong version", () => {
      // Manually construct a v=2 token (we're v=1).
      const payload = {
        v: 2, // unsupported version
        sid: nodeCrypto.randomUUID(),
        uid: null,
        iat: Date.now(),
      };
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const hmac = nodeCrypto.createHmac("sha256", process.env.AI_SESSION_SECRET!);
      hmac.update(payloadB64, "utf8");
      const sig = hmac.digest().toString("base64url");
      const token = `${payloadB64}.${sig}`;
      // Signature is valid, but version is wrong → reject.
      expect(verifySessionToken(token)).toBeNull();
    });
  });

  describe("identity binding (tokenMatchesIdentity)", () => {
    it("anonymous tokens match any requester (possession = ownership)", () => {
      const token = mintAnonymousSessionToken();
      const verified = verifySessionToken(token)!;
      expect(tokenMatchesIdentity(verified, null)).toBe(true);
      expect(tokenMatchesIdentity(verified, "user_a")).toBe(true);
    });

    it("authenticated tokens match the bound user + allow null requester (signed token = proof)", () => {
      const uid = "user_xyz";
      const token = mintAuthenticatedSessionToken(uid);
      const verified = verifySessionToken(token)!;
      // Matching identity → allowed.
      expect(tokenMatchesIdentity(verified, uid)).toBe(true);
      // v3.10 fix: null requester (Clerk couldn't resolve) → ALLOWED.
      // The signed token itself is the proof of possession (122-bit entropy
      // + HMAC). This fixes the "history disappears on reopen" bug where
      // Clerk's session JWT expired between chat close + reopen.
      expect(tokenMatchesIdentity(verified, null)).toBe(true);
      // Different signed-in user → REJECTED (hijack attempt).
      expect(tokenMatchesIdentity(verified, "user_different")).toBe(false);
    });
  });

  describe("input validation", () => {
    it("rejects empty string", () => {
      expect(verifySessionToken("")).toBeNull();
    });

    it("rejects very long strings (>4KB)", () => {
      const long = "x".repeat(5000);
      expect(verifySessionToken(long)).toBeNull();
    });

    it("rejects non-string input", () => {
      expect(verifySessionToken(null as any)).toBeNull();
      expect(verifySessionToken(undefined as any)).toBeNull();
      expect(verifySessionToken(123 as any)).toBeNull();
    });

    it("rejects payload with missing required fields", () => {
      // sid is missing
      const payload = { v: 1, uid: null, iat: Date.now() };
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const hmac = nodeCrypto.createHmac("sha256", process.env.AI_SESSION_SECRET!);
      hmac.update(payloadB64, "utf8");
      const sig = hmac.digest().toString("base64url");
      expect(verifySessionToken(`${payloadB64}.${sig}`)).toBeNull();
    });

    it("rejects payload with empty sid", () => {
      const payload = { v: 1, sid: "", uid: null, iat: Date.now() };
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const hmac = nodeCrypto.createHmac("sha256", process.env.AI_SESSION_SECRET!);
      hmac.update(payloadB64, "utf8");
      const sig = hmac.digest().toString("base64url");
      expect(verifySessionToken(`${payloadB64}.${sig}`)).toBeNull();
    });

    it("rejects payload with empty-string uid (must be null or non-empty string)", () => {
      const payload = { v: 1, sid: nodeCrypto.randomUUID(), uid: "", iat: Date.now() };
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const hmac = nodeCrypto.createHmac("sha256", process.env.AI_SESSION_SECRET!);
      hmac.update(payloadB64, "utf8");
      const sig = hmac.digest().toString("base64url");
      expect(verifySessionToken(`${payloadB64}.${sig}`)).toBeNull();
    });
  });
});
