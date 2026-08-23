import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";

/**
 * Guest OTP (One-Time Password) for phone-verified guest checkout.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Daraz-style guest checkout: a buyer who isn't signed in can complete a
 * marketplace purchase by verifying their phone number via OTP. This is
 * the "light identity" layer — no account, no password, no Clerk — but the
 * platform has a verified phone number it can use for:
 *   1. Order confirmation (WhatsApp/SMS at order time)
 *   2. Courier handoff (the courier calls this number on delivery)
 *   3. Order tracking (GET /orders/guest/:phone is gated by OTP)
 *   4. Account claim (when the buyer later signs up with the same phone,
 *      their guest orders auto-attach to the new account — Part 4)
 *
 * SECURITY MODEL
 * ──────────────
 *   - `codeHash` stores a SHA-256 hash of the 6-digit code, never the
 *     plaintext. A DB leak doesn't expose usable codes (and codes expire
 *     in 5 minutes anyway).
 *   - `attempts` counts verification tries; after 5 failed attempts the
 *     OTP is invalidated (defense against brute force — 6 digits = 1M
 *     combos, 5 attempts is generous for a real buyer but blocks
 *     scripted guessing).
 *   - `expiresAt` is 5 minutes from creation. Industry-standard OTP TTL
 *     (WhatsApp/Twilio Verify defaults to 5 min; Daraz uses 5 min).
 *   - One active OTP per phone: a new send invalidates the previous one
 *     (upsert pattern — see `lib/guestOtp.ts:generateAndSend`).
 *   - `verifiedAt` is set on successful verification; the row is kept
 *     (not deleted) so Part 2/3 can look up "is this phone verified
 *     right now?" via `getActiveVerifiedOtp(phone)`.
 *
 * LIFECYCLE
 * ─────────
 *   1. Buyer enters phone → POST /auth/guest-otp/send
 *      → generates 6-digit code, hashes it, stores row, sends via WhatsApp
 *   2. Buyer receives code → POST /auth/guest-otp/verify
 *      → looks up by phone, hashes submitted code, compares to stored hash
 *      → on match: sets verifiedAt, returns a guest session token (Part 2)
 *      → on mismatch: increments attempts; at 5 → invalidate
 *   3. After checkout, the verified phone is linked to the order row
 *      (Part 3 — ordersTable will get a `guestPhone` column)
 *   4. Account claim (Part 4) matches guest orders by phone
 *
 * RATE LIMITING
 * ─────────────
 * Rate limiting is enforced at the route level (see `routes/guestAuth.ts`),
 * not here. Two tiers:
 *   - Send: 3 per 10 minutes per phone (stops spam-sending to one number)
 *   - Verify: 5 per 10 minutes per phone (stops brute-force guessing)
 * The `attempts` column is the OTP-level brute-force guard (5 tries per
 * code), independent of the route-level rate limiter.
 *
 * CLEANUP
 * ───────
 * Expired/unverified OTPs are cleaned up lazily by `generateAndSend`
 * (deletes the previous unverified row for this phone before inserting
 * a new one). Verified OTPs are kept for 24 hours (for Part 2/3 lookups),
 * then a cron job can purge them. For now, no cron — the table stays
 * small because each phone has at most one active row at a time.
 */
export const guestOtpsTable = pgTable(
  "guest_otps",
  {
    id: serial("id").primaryKey(),
    // Normalized to bare 11-digit local form (01XXXXXXXXX) at insert time
    // by `normalizeBdPhoneForStorage()` in lib/guestOtp.ts. Indexed
    // because every send/verify/lookup filters WHERE phone = ?.
    phone: text("phone").notNull(),
    // SHA-256 hash of the 6-digit code. Never the plaintext.
    codeHash: text("code_hash").notNull(),
    // Failed verification attempts. At 5 → row is invalidated (verifiedAt
    // stays NULL, but subsequent verifies reject with "max attempts
    // exceeded — request a new code"). Industry-standard brute-force guard.
    attempts: integer("attempts").notNull().default(0),
    // Set when the buyer successfully verifies. NULL = pending verification
    // or invalidated by max-attempts. Once set, the phone is "verified"
    // for guest checkout until `expiresAt` (the verified-session window,
    // extended on verification to 30 minutes — see `lib/guestOtp.ts`).
    verifiedAt: timestamp("verified_at"),
    // 5 minutes from creation (the OTP code TTL). Once verified, the
    // VERIFIED SESSION extends to 30 minutes — see `sessionExpiresAt`.
    expiresAt: timestamp("expires_at").notNull(),
    // Separate from `expiresAt`: the code expires in 5 min, but once
    // verified the buyer has 30 min to complete checkout. NULL until
    // verification succeeds.
    sessionExpiresAt: timestamp("session_expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Lookup by phone — every send/verify/lookup filters on this.
    // Partial index on unverified rows only would be ideal, but Drizzle
    // doesn't support partial indexes cleanly (same pattern as
    // productsTable's homepage_tag_active_idx — raw SQL in the migration).
    // For now, a plain index is fine; the table is small.
    index("guest_otps_phone_idx").on(table.phone),
    // Future cleanup cron: DELETE WHERE session_expires_at < now().
    // Index on sessionExpiresAt so the cron can find expired rows fast.
    index("guest_otps_session_expires_at_idx").on(table.sessionExpiresAt),
  ],
);

export type GuestOtp = typeof guestOtpsTable.$inferSelect;
