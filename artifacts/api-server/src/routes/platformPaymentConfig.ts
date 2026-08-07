import { Router } from "express";
import { db } from "@workspace/db";
import { platformPaymentConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import { encryptCredential, maskCredential } from "../lib/credentialEncryption";
import { grantToken, clearCachedToken, BkashApiError } from "../lib/bkash";
import { logAudit } from "../lib/audit";
import { logger } from "../lib/logger";

/**
 * Admin-only: the PLATFORM's single bKash merchant config (Part 1 of 4 --
 * see PART1_HANDOFF.md). Mirrors routes/sellerPaymentConfigs.ts's shape
 * (masked GET, create/replace POST, reuse credentialEncryption.ts) but
 * gated by requireAdmin instead of requireSeller, and reads/writes the
 * single platform_payment_config row instead of a per-seller row.
 *
 * No DELETE route -- judgment call, per the prompt's explicit "your call,
 * document reasoning if you skip it." Reasoning: deleting the platform's
 * ONLY bKash merchant account would mean the platform has no way to
 * accept ANY buyer payment at all (unlike a seller deleting their own
 * config, which just drops that one seller back to COD -- see
 * sellerPaymentConfigs.ts's DELETE route's own reconciliation logic). That
 * is a much higher-blast-radius action than this part's scope (schema +
 * config CRUD) should silently enable. An admin who genuinely needs to
 * rotate/replace credentials can already do so via POST (delete-then-
 * insert under the hood, same as the seller route) without ever leaving
 * the platform with zero rows. If a real "deactivate payments entirely"
 * admin action is wanted later, that reads as a deliberate, differently-
 * shaped feature (probably a flag/toggle with its own confirmation UX and
 * its own effect on checkout), not a bare DELETE endpoint -- left for a
 * future part to decide, not decided here.
 *
 * isVerified is never set true by the GET/POST routes below -- no live
 * bKash API call happens in either of them. See platformPaymentConfig.ts's
 * schema doc comment for what this flag is expected to gate (Part 2's
 * Checkout and Part 3's B2C payout both refuse to call bKash at all while
 * it's false).
 *
 * PART 4 ADDENDUM (see PART4_HANDOFF.md): this file now also has the ONE
 * route that ever sets isVerified true -- `POST
 * /admin/platform-payment-config/verify`, below. This was the single
 * highest-priority item across the whole 4-part project: before this
 * route existed, isVerified could never become true by any path in this
 * codebase, which meant Part 2's checkout gate and Part 3's payout gate
 * (both going through lib/bkash.ts's loadPlatformCredentials()) refused to
 * do anything at all, in any real deployment, forever. See that route's
 * own doc comment for how it verifies (a real grantToken() call against
 * the platform's currently-stored credentials) and why that's safe to
 * call as often as an admin wants.
 */

const router = Router();

type PlatformPaymentConfigRow = typeof platformPaymentConfigTable.$inferSelect;

function toMasked(c: PlatformPaymentConfigRow) {
  return {
    id: c.id,
    provider: c.provider,
    merchantAppKeyMasked: maskCredential(c.merchantAppKey),
    merchantAppSecretMasked: maskCredential(c.merchantAppSecret),
    merchantUsernameMasked: maskCredential(c.merchantUsername),
    merchantPasswordMasked: maskCredential(c.merchantPassword),
    isVerified: c.isVerified,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/**
 * Admin: get the platform's bKash merchant config (masked). 404 if not
 * configured yet -- there is genuinely no fallback state to describe here
 * (unlike the seller route's "404 means COD-only," a missing platform
 * config means the platform cannot accept ANY bKash payment at all yet;
 * Part 2 is expected to treat this the same way sellerListings.ts/orders.ts
 * treat a missing/unverified seller config today).
 */
router.get("/platform-payment-config", requireAdmin, async (_req, res) => {
  try {
    const [config] = await db.select().from(platformPaymentConfigTable).limit(1);
    if (!config) {
      res.status(404).json({ error: "Platform bKash merchant account not configured yet" });
      return;
    }
    res.json(toMasked(config));
  } catch (err) {
    logger.error({ err }, "Failed to fetch platform payment config");
    res.status(500).json({ error: "Failed to fetch platform payment config" });
  }
});

/**
 * Admin: create or replace the platform's bKash merchant config.
 *
 * Uses a transaction with SELECT-then-INSERT-or-UPDATE instead of the
 * old DELETE-then-INSERT pattern. The old pattern had a race window:
 * under two concurrent POSTs, both DELETEs could fire before either
 * INSERT, then the second INSERT would throw on the singleton UNIQUE
 * constraint, returning 500 and leaving the platform with ZERO bKash
 * config (the prior row was already deleted). That broke all bKash
 * checkout until an admin manually re-added credentials.
 *
 * The new pattern: inside a transaction, SELECT the existing row. If
 * it exists, UPDATE it in place (preserving the row's id and createdAt).
 * If not, INSERT a new row. isVerified always resets to false on any
 * credential replacement — a credential rotation should not silently
 * keep a stale "verified" flag pointing at the OLD credentials.
 *
 * The transaction's SERIALIZABLE isolation (Postgres default for
 * drizzle-orm transactions) ensures two concurrent POSTs can't both
 * see "no row exists" and both INSERT — the second will block until
 * the first commits, then see the new row and UPDATE it instead.
 */
router.post("/platform-payment-config", requireAdmin, async (req, res) => {
  try {
    const { provider, merchantAppKey, merchantAppSecret, merchantUsername, merchantPassword } = req.body as {
      provider?: string;
      merchantAppKey?: string;
      merchantAppSecret?: string;
      merchantUsername?: string;
      merchantPassword?: string;
    };

    const resolvedProvider = provider ?? "bkash";
    if (resolvedProvider !== "bkash") {
      res.status(400).json({ error: 'provider must be "bkash" (the only provider this schema supports today)' });
      return;
    }
    if (!merchantAppKey || !merchantAppSecret || !merchantUsername || !merchantPassword) {
      res.status(400).json({
        error: "merchantAppKey, merchantAppSecret, merchantUsername, and merchantPassword are all required",
      });
      return;
    }

    const encryptedValues = {
      provider: resolvedProvider,
      merchantAppKey: encryptCredential(merchantAppKey),
      merchantAppSecret: encryptCredential(merchantAppSecret),
      merchantUsername: encryptCredential(merchantUsername),
      merchantPassword: encryptCredential(merchantPassword),
      isVerified: false,
      updatedAt: new Date(),
    };

    const config = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: platformPaymentConfigTable.id })
        .from(platformPaymentConfigTable)
        .limit(1);

      if (existing) {
        const [updated] = await tx
          .update(platformPaymentConfigTable)
          .set(encryptedValues)
          .where(eq(platformPaymentConfigTable.id, existing.id))
          .returning();
        return updated;
      }

      const [inserted] = await tx
        .insert(platformPaymentConfigTable)
        .values(encryptedValues)
        .returning();
      return inserted;
    });

    // BUGFIX follow-up (see PART4_FIX_HANDOFF.md and clearCachedToken()'s
    // own doc comment): a token granted under the OLD credentials must not
    // survive a rotation. Cheap and unconditional -- there's no cost to
    // clearing a cache that may already be empty.
    clearCachedToken();

    res.status(201).json(toMasked(config));
  } catch (err) {
    logger.error({ err }, "Failed to save platform payment config");
    res.status(500).json({ error: "Failed to save platform payment config" });
  }
});

/**
 * Admin: "test connection" / "verify" action -- Part 4 of 4 (see
 * PART4_HANDOFF.md and PART4_FIX_HANDOFF.md). THE highest-priority item in
 * this whole part: this is the only route anywhere in this codebase that
 * ever sets platformPaymentConfigTable.isVerified to true, and until it
 * existed, the entire bKash checkout (Part 2) + payout (Part 3) system was
 * unreachable in any real deployment -- both go through lib/bkash.ts's
 * withTokenRetry(), which calls assertPlatformVerified() and throws a
 * BkashApiError with step: "config" if isVerified isn't true.
 *
 * BUGFIX NOTE (see PART4_FIX_HANDOFF.md for the full story): the original
 * version of this route was circular and could never actually succeed --
 * grantToken() used to route through the SAME isVerified check this route
 * exists to satisfy, so it always threw on a fresh/unverified config, which
 * is the only config this route is ever useful against. Fixed by moving
 * the isVerified check out of loadPlatformCredentials() (used by
 * grantToken()/refreshToken(), pure auth handshakes) and into a new
 * assertPlatformVerified(), called only from withTokenRetry() (the real
 * chokepoint for money-moving calls: createPayment/executePayment/
 * queryPayment/disburseToSeller). grantToken() itself no longer checks
 * isVerified at all -- correct, since establishing verification is
 * precisely its job when called from this route.
 *
 * What this does: calls grantToken() (Part 2/3's existing, already-exported
 * function -- reused directly, not reimplemented) against whatever
 * credentials are currently stored in platform_payment_config. grantToken()
 * itself calls loadPlatformCredentials() first, which means this route
 * naturally 404s the same way GET does if no config row exists yet (no
 * separate "not configured" check needed here -- the underlying function
 * already does it). If grantToken() succeeds (bKash actually returns a real
 * id_token), this route flips isVerified to true. If it throws, isVerified
 * is left exactly as it was (false, on a first attempt; unchanged from
 * whatever it was on a later attempt) and the error is surfaced to the
 * admin.
 *
 * Judgment call: grantToken() itself already caches the resulting token
 * (see lib/bkash.ts's module-level cache) as a side effect of a successful
 * call -- that's fine and not fought against here; it doesn't matter
 * whether the very first "real" checkout/payout call ends up reusing a
 * token this verification call already fetched, or fetches its own. Not
 * worth adding a separate no-cache code path just to keep this route
 * "pure" when the caching is already safe and idempotent by design (see
 * getValidToken()'s own doc comment on why this module treats a single
 * cached token as correct for the one-merchant-account model).
 *
 * SANDBOX-SAFE, per the prompt's explicit framing: Grant Token is bKash's
 * pure auth handshake -- it moves no money and creates no payment intent
 * (unlike createPayment/executePayment/disburseToSeller). Safe for an admin
 * to call as often as they like, e.g. right after rotating credentials via
 * POST above (which always resets isVerified to false -- see that route's
 * doc comment), to immediately re-verify the new credentials without
 * waiting for a real buyer checkout to exercise them.
 *
 * Error surfacing: if grantToken() throws a BkashApiError, its message
 * (and step, e.g. "config" for missing/unconfigured, "grant" for bKash
 * itself rejecting the credentials) is returned directly in the response
 * body -- an admin debugging "why won't this verify" needs the real
 * reason (wrong app_key, wrong username/password, bKash sandbox unreachable,
 * etc.), not a generic "verification failed." A non-BkashApiError (e.g. a
 * network-level fetch failure inside grantToken(), or a DB error) is
 * caught by the outer try/catch and reported generically, same as every
 * other route in this file.
 */
router.post("/admin/platform-payment-config/verify", requireAdmin, async (req: any, res) => {
  try {
    await grantToken();

    // Scoped by singleton's literal value rather than an unconditional
    // update-with-no-where -- functionally identical today (the DB-level
    // UNIQUE constraint on `singleton` guarantees at most one row exists
    // at all, see the schema's own doc comment), but explicit about WHICH
    // row this intends to touch rather than relying on that guarantee
    // silently. grantToken() above already 404s (via BkashApiError
    // step: "config") if no row exists, so `config` here is never
    // undefined by the time we reach this update.
    const [config] = await db
      .update(platformPaymentConfigTable)
      .set({ isVerified: true, updatedAt: new Date() })
      .where(eq(platformPaymentConfigTable.singleton, "singleton"))
      .returning();

    await logAudit({
      adminId: req.userId,
      adminEmail: req.dbUser?.email,
      action: "platform_payment_config.verified",
      targetType: "platform_payment_config",
      targetId: config ? String(config.id) : undefined,
    });

    res.json(toMasked(config));
  } catch (err) {
    if (err instanceof BkashApiError) {
      // Leave isVerified untouched (see doc comment above) -- surface
      // bKash's own step/message so the admin can actually debug this
      // (wrong credentials vs. not configured vs. bKash unreachable),
      // rather than a generic failure message.
      res.status(400).json({ error: err.message, step: err.step });
      return;
    }
    logger.error({ err }, "Failed to verify platform payment config");
    res.status(500).json({ error: "Failed to verify platform payment config" });
  }
});

export default router;
