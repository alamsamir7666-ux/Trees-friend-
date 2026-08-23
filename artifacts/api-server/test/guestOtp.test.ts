import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { db } from "@workspace/db";
import { guestOtpsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  cleanupAll,
} from "./testDb";
import {
  generateAndSend,
  verifyCode,
  normalizeBdPhoneForStorage,
  getActiveVerifiedSession,
} from "../src/lib/guestOtp";

/**
 * Tests for the guest OTP flow (Part 1 of Daraz-style guest checkout).
 *
 * Two layers:
 *   1. Library-level tests (lib/guestOtp.ts) — directly test generateAndSend,
 *      verifyCode, normalizeBdPhoneForStorage, getActiveVerifiedSession.
 *      These don't go through HTTP, so they bypass rate limiting and can
 *      read the OTP row directly from the DB to verify the code matches.
 *   2. HTTP-level tests — supertest against the real Express app. Verifies
 *      the route handlers, validation, and response shapes. Doesn't verify
 *      the actual code (transport is mocked via dev-mode console logging)
 *      but checks that the endpoint returns the right success/error shape.
 *
 * Test phone numbers: use the 01700XXXXXX range (017 + 00 + 6 digits). 017
 * is the Grameenphone operator prefix (valid per BD_PHONE_REGEX), and the
 * `00` after it makes the number unlikely to belong to a real subscriber.
 * cleanupAll() deletes all 01700-prefixed rows after the suite.
 *
 * NOTE: in dev mode (no Twilio configured), the OTP code is logged to the
 * console — tests read it back from the DB via the library (not the HTTP
 * route, which never returns the plaintext code).
 */

const TEST_PHONE_1 = "01700123456";
const TEST_PHONE_1_PLUS = "+8801700123456"; // E.164 form of the same number
const TEST_PHONE_2 = "01700765432";

describe("guest OTP library (lib/guestOtp.ts)", () => {
  beforeAll(async () => {
    await cleanupAll();
  });

  afterAll(async () => {
    await cleanupAll();
  });

  describe("normalizeBdPhoneForStorage", () => {
    it("normalizes bare local form (01XXXXXXXXX)", () => {
      expect(normalizeBdPhoneForStorage("01700123456")).toBe("01700123456");
    });

    it("normalizes +880 prefix to bare local", () => {
      expect(normalizeBdPhoneForStorage("+8801700123456")).toBe("01700123456");
    });

    it("normalizes 880 prefix (no +) to bare local", () => {
      expect(normalizeBdPhoneForStorage("8801700123456")).toBe("01700123456");
    });

    it("strips spaces and dashes", () => {
      expect(normalizeBdPhoneForStorage("017-0012-3456")).toBe("01700123456");
    });

    it("rejects invalid operator prefix (0111 not in [3-9])", () => {
      // 0111XXXXXXX — second digit 1 is not in [3-9]
      expect(normalizeBdPhoneForStorage("01111234567")).toBeNull();
    });

    it("rejects too-short numbers", () => {
      expect(normalizeBdPhoneForStorage("0170012345")).toBeNull(); // 10 digits
    });

    it("rejects too-long numbers", () => {
      expect(normalizeBdPhoneForStorage("017001234567")).toBeNull(); // 12 digits
    });

    it("rejects empty input", () => {
      expect(normalizeBdPhoneForStorage("")).toBeNull();
      expect(normalizeBdPhoneForStorage(null as unknown as string)).toBeNull();
    });

    it("accepts real BD operator prefixes (013-019)", () => {
      // Real operator prefixes — these would actually send a WhatsApp message
      // in production, but normalizeBdPhoneForStorage only validates the SHAPE,
      // it doesn't send. Safe to test.
      expect(normalizeBdPhoneForStorage("01312345678")).toBe("01312345678");
      expect(normalizeBdPhoneForStorage("01712345678")).toBe("01712345678");
      expect(normalizeBdPhoneForStorage("01912345678")).toBe("01912345678");
    });
  });

  describe("generateAndSend + verifyCode flow", () => {
    beforeEach(async () => {
      // Clean any existing OTP rows for the test phones before each test
      await db.delete(guestOtpsTable).where(eq(guestOtpsTable.phone, TEST_PHONE_1));
      await db.delete(guestOtpsTable).where(eq(guestOtpsTable.phone, TEST_PHONE_2));
    });

    it("generates an OTP, persists the hash (not plaintext), and verifies the correct code", async () => {
      // Generate
      const result = await generateAndSend(TEST_PHONE_1);
      expect(result.phone).toBe(TEST_PHONE_1);
      expect(result.code).toMatch(/^\d{6}$/);
      expect(result.expiresInMs).toBe(5 * 60 * 1000);

      // Verify the persisted row has a hash, NOT the plaintext code
      const [row] = await db
        .select()
        .from(guestOtpsTable)
        .where(eq(guestOtpsTable.phone, TEST_PHONE_1));
      expect(row).toBeDefined();
      expect(row.codeHash).not.toBe(result.code); // hash, not plaintext
      expect(row.codeHash).toHaveLength(64); // SHA-256 hex
      expect(row.attempts).toBe(0);
      expect(row.verifiedAt).toBeNull();
      expect(row.sessionExpiresAt).toBeNull();

      // Verify with the correct code
      const verifyResult = await verifyCode(TEST_PHONE_1, result.code);
      expect(verifyResult.success).toBe(true);
      expect(verifyResult.phone).toBe(TEST_PHONE_1);
      expect(verifyResult.sessionExpiresAt).toBeInstanceOf(Date);

      // The row should now have verifiedAt + sessionExpiresAt set
      const [verifiedRow] = await db
        .select()
        .from(guestOtpsTable)
        .where(eq(guestOtpsTable.phone, TEST_PHONE_1));
      expect(verifiedRow.verifiedAt).toBeInstanceOf(Date);
      expect(verifiedRow.sessionExpiresAt).toBeInstanceOf(Date);
    });

    it("rejects an incorrect code and increments attempts", async () => {
      const { code: correctCode } = await generateAndSend(TEST_PHONE_1);

      // Submit a wrong code (correctCode ± 1, guaranteed different)
      const wrongCode = String((Number(correctCode) + 1) % 1000000).padStart(6, "0");
      const result = await verifyCode(TEST_PHONE_1, wrongCode);

      expect(result.success).toBe(false);
      expect(result.failureReason).toContain("Incorrect code");
      expect(result.failureReason).toContain("4 attempt"); // 5 - 1 = 4 remaining

      // Attempts should be incremented
      const [row] = await db
        .select()
        .from(guestOtpsTable)
        .where(eq(guestOtpsTable.phone, TEST_PHONE_1));
      expect(row.attempts).toBe(1);
    });

    it("invalidates the OTP after 5 failed attempts", async () => {
      await generateAndSend(TEST_PHONE_1);

      // Submit 5 wrong codes
      for (let i = 0; i < 5; i++) {
        await verifyCode(TEST_PHONE_1, "000000");
      }

      // 6th attempt should be blocked by the max-attempts guard
      const result = await verifyCode(TEST_PHONE_1, "000000");
      expect(result.success).toBe(false);
      expect(result.failureReason).toContain("Too many incorrect attempts");
    });

    it("accepts +880-prefixed phone (normalizes to bare local)", async () => {
      // generateAndSend with +880 prefix should normalize and create a row
      // under the bare-local phone number
      const result = await generateAndSend(TEST_PHONE_1_PLUS);
      expect(result.phone).toBe(TEST_PHONE_1); // normalized

      // verifyCode with the bare-local form should work
      const verifyResult = await verifyCode(TEST_PHONE_1, result.code);
      expect(verifyResult.success).toBe(true);

      // verifyCode with the +880 form should also work (normalized internally)
      const verifyResult2 = await verifyCode(TEST_PHONE_1_PLUS, result.code);
      expect(verifyResult2.success).toBe(true); // idempotent — already verified
    });

    it("is idempotent on re-verify within the session window", async () => {
      const { code } = await generateAndSend(TEST_PHONE_1);
      const first = await verifyCode(TEST_PHONE_1, code);
      expect(first.success).toBe(true);

      // Second verify with the same code — should return success (not "already
      // verified" error), with the same sessionExpiresAt
      const second = await verifyCode(TEST_PHONE_1, code);
      expect(second.success).toBe(true);
      expect(second.sessionExpiresAt).toEqual(first.sessionExpiresAt);
    });

    it("generateAndSend replaces the previous unverified OTP (resend)", async () => {
      const first = await generateAndSend(TEST_PHONE_1);
      const second = await generateAndSend(TEST_PHONE_1);

      // The first code should no longer verify — the row was replaced, so
      // the first code's hash no longer matches the stored (second) hash.
      // The row EXISTS (with the second code), so the failure is "Incorrect
      // code", not "No code requested" (which would mean no row exists).
      const verifyFirst = await verifyCode(TEST_PHONE_1, first.code);
      expect(verifyFirst.success).toBe(false);
      expect(verifyFirst.failureReason).toContain("Incorrect code");

      // The second code should verify
      const verifySecond = await verifyCode(TEST_PHONE_1, second.code);
      expect(verifySecond.success).toBe(true);
    });

    it("getActiveVerifiedSession returns the session expiry when verified, null otherwise", async () => {
      // No OTP yet
      expect(await getActiveVerifiedSession(TEST_PHONE_2)).toBeNull();

      // OTP generated but not verified
      await generateAndSend(TEST_PHONE_2);
      expect(await getActiveVerifiedSession(TEST_PHONE_2)).toBeNull();

      // OTP verified — session should exist
      const { code } = await generateAndSend(TEST_PHONE_2);
      await verifyCode(TEST_PHONE_2, code);
      const session = await getActiveVerifiedSession(TEST_PHONE_2);
      expect(session).toBeInstanceOf(Date);
      expect(session).not.toBeNull();
      expect((session as Date).getTime()).toBeGreaterThan(Date.now());
    });

    it("verifyCode rejects a non-6-digit code", async () => {
      await generateAndSend(TEST_PHONE_1);
      const result = await verifyCode(TEST_PHONE_1, "12345"); // 5 digits
      expect(result.success).toBe(false);
      expect(result.failureReason).toContain("6 digits");
    });

    it("verifyCode rejects when no OTP has been requested", async () => {
      const result = await verifyCode(TEST_PHONE_2, "123456");
      expect(result.success).toBe(false);
      expect(result.failureReason).toContain("No code requested");
    });
  });
});

describe("guest OTP HTTP routes", () => {
  beforeAll(async () => {
    await cleanupAll();
  });

  afterAll(async () => {
    await cleanupAll();
  });

  beforeEach(async () => {
    // Clean OTP rows for test phones between HTTP tests (the rate limiter
    // keys on IP, and supertest always comes from 127.0.0.1, so we need to
    // reset state between tests to avoid hitting the per-phone 3/10min cap)
    await db.delete(guestOtpsTable).where(eq(guestOtpsTable.phone, TEST_PHONE_1));
    await db.delete(guestOtpsTable).where(eq(guestOtpsTable.phone, TEST_PHONE_2));
  });

  it("POST /api/auth/guest-otp/send returns success for a valid phone", async () => {
    const res = await request(app)
      .post("/api/auth/guest-otp/send")
      .send({ phone: TEST_PHONE_1 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.expiresInMs).toBe(5 * 60 * 1000);

    // An OTP row should exist for this phone
    const [row] = await db
      .select()
      .from(guestOtpsTable)
      .where(eq(guestOtpsTable.phone, TEST_PHONE_1));
    expect(row).toBeDefined();
    expect(row.codeHash).toHaveLength(64);
    expect(row.attempts).toBe(0);
  });

  it("POST /api/auth/guest-otp/send accepts +880-prefixed phone", async () => {
    const res = await request(app)
      .post("/api/auth/guest-otp/send")
      .send({ phone: TEST_PHONE_1_PLUS });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Row should be stored under the normalized bare-local form
    const [row] = await db
      .select()
      .from(guestOtpsTable)
      .where(eq(guestOtpsTable.phone, TEST_PHONE_1));
    expect(row).toBeDefined();
  });

  it("POST /api/auth/guest-otp/send returns success even for invalid phone (no leak)", async () => {
    const res = await request(app)
      .post("/api/auth/guest-otp/send")
      .send({ phone: "not-a-phone" });

    // Should return 200 success (not 400) to avoid leaking validity
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // No OTP row should exist for the invalid phone
    const [row] = await db
      .select()
      .from(guestOtpsTable)
      .where(eq(guestOtpsTable.phone, "not-a-phone"));
    expect(row).toBeUndefined();
  });

  it("POST /api/auth/guest-otp/send validates body shape (missing phone)", async () => {
    const res = await request(app)
      .post("/api/auth/guest-otp/send")
      .send({});

    expect(res.status).toBe(400);
  });

  it("POST /api/auth/guest-otp/verify succeeds with the correct code", async () => {
    // First, send an OTP via the HTTP route (so a row exists)
    await request(app)
      .post("/api/auth/guest-otp/send")
      .send({ phone: TEST_PHONE_1 });

    // Read the code from the DB (in dev mode, the code is logged to console
    // AND stored as a hash — we can't reverse the hash, so we re-generate
    // via the library to get the plaintext for testing)
    await db.delete(guestOtpsTable).where(eq(guestOtpsTable.phone, TEST_PHONE_1));
    const { code } = await generateAndSend(TEST_PHONE_1);

    // Now verify via HTTP
    const res = await request(app)
      .post("/api/auth/guest-otp/verify")
      .send({ phone: TEST_PHONE_1, code });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.phone).toBe(TEST_PHONE_1);
    expect(res.body.sessionExpiresAt).toBeDefined();
    expect(new Date(res.body.sessionExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("POST /api/auth/guest-otp/verify fails with incorrect code", async () => {
    await generateAndSend(TEST_PHONE_1);

    const res = await request(app)
      .post("/api/auth/guest-otp/verify")
      .send({ phone: TEST_PHONE_1, code: "000000" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Incorrect code");
  });

  it("POST /api/auth/guest-otp/verify validates code format (must be 6 digits)", async () => {
    const res = await request(app)
      .post("/api/auth/guest-otp/verify")
      .send({ phone: TEST_PHONE_1, code: "12345" }); // 5 digits

    expect(res.status).toBe(400);
  });

  it("POST /api/auth/guest-otp/verify fails when no OTP has been requested", async () => {
    const res = await request(app)
      .post("/api/auth/guest-otp/verify")
      .send({ phone: TEST_PHONE_2, code: "123456" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("No code requested");
  });
});
