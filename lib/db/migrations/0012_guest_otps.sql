-- ─── Migration 0012: guest_otps table ─────────────────────────────────────────
--
-- Daraz-style phone-verified guest checkout (Part 1 of 4).
-- See lib/db/src/schema/guestOtps.ts for the full design rationale.
--
-- Stores one-time-password challenges for guest buyers who aren't signed in
-- but need a "light identity" (verified phone number) to complete a
-- marketplace purchase. No account, no password — just a phone + 6-digit
-- code verified via WhatsApp/SMS.
--
-- ─── Safety ──────────────────────────────────────────────────────────────────
--   * Idempotent (IF NOT EXISTS on index creation, plain CREATE TABLE
--     is safe because drizzle-kit migrate runs in a transaction).
--   * No data migration — this is a brand-new table.
--   * No FKs to other tables — the phone number is a free-text field
--     (normalized to 01XXXXXXXXX at the app layer). This is deliberate:
--     a guest may not have a usersTable row yet (that's the whole point
--     of guest checkout), so FK-ing to users.clerkId would defeat the
--     purpose. Account claim (Part 4) will match by phone, not by FK.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "guest_otps" (
  "id" serial PRIMARY KEY,
  "phone" text NOT NULL,
  "code_hash" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "verified_at" timestamp,
  "expires_at" timestamp NOT NULL,
  "session_expires_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- Lookup by phone — every send/verify/lookup filters WHERE phone = ?.
CREATE INDEX IF NOT EXISTS "guest_otps_phone_idx" ON "guest_otps" ("phone");

-- Future cleanup cron: DELETE WHERE session_expires_at < now().
CREATE INDEX IF NOT EXISTS "guest_otps_session_expires_at_idx" ON "guest_otps" ("session_expires_at");
