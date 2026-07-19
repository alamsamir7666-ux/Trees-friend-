import { Router } from "express";
import { db } from "@workspace/db";
import { sellerPaymentConfigsTable, sellerListingsTable } from "@workspace/db";
import { eq, and, ne } from "drizzle-orm";
import { requireSeller } from "../middlewares/auth";
import { encryptCredential, maskCredential } from "../lib/credentialEncryption";

/**
 * Seller Payment Settings (plan doc §4 "Payment Settings", §7). This is
 * Part 5 scope -- genuinely unbuilt through Part 4 (confirmed by grep, not
 * assumed: no route file existed anywhere in the codebase before this).
 * Mirrors routes/sellerCourierConfigs.ts's shape exactly: create/replace,
 * get-masked, delete. Reuses lib/credentialEncryption.ts (Part 4's
 * AES-256-GCM utility) rather than inventing a second encryption scheme --
 * same CREDENTIAL_ENCRYPTION_KEY env var, same lazy-throw-on-first-use
 * convention.
 *
 * Every response masks credentials via maskCredential -- decrypted
 * plaintext is never returned in an API response body, per
 * seller_payment_configs' schema-comment security note.
 *
 * isVerified is NEVER set true by this route, same convention as
 * sellerCourierConfigs.ts: there is no live-credential check against
 * bKash's actual merchant API here. It starts false and stays false until
 * some future verification step sets it -- which is also the gate
 * routes/sellerListings.ts and routes/orders.ts use to decide whether a
 * seller can offer "advance"/"both" payment methods (plan doc §7). A
 * seller who saves credentials here does NOT immediately unlock advance
 * payment; that's intentional, not a bug to fix in this route.
 */

const router = Router();

type PaymentConfigRow = typeof sellerPaymentConfigsTable.$inferSelect;

function toMasked(c: PaymentConfigRow) {
  return {
    id: c.id,
    sellerId: c.sellerId,
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
 * Seller: get their own payment config (masked). 404 if none configured --
 * that's the normal "COD only" state (plan doc §7), not an error state, so
 * the frontend should treat 404 as "not set up yet," not show an error
 * toast.
 */
router.get("/seller-payment-configs/mine", requireSeller, async (req, res) => {
  try {
    const [config] = await db
      .select()
      .from(sellerPaymentConfigsTable)
      .where(eq(sellerPaymentConfigsTable.sellerId, req.dbSeller!.id))
      .limit(1);
    if (!config) {
      res.status(404).json({ error: "No payment config set up yet" });
      return;
    }
    res.json(toMasked(config));
  } catch (err) {
    console.error("Get seller payment config error:", err);
    res.status(500).json({ error: "Failed to fetch payment config" });
  }
});

/**
 * Seller: create or replace their payment config (one per seller -- upsert
 * by sellerId, matching the table's actual unique(sellerId) constraint,
 * unlike seller_courier_configs which has no DB-level unique constraint.
 * Delete-then-insert here for symmetry with sellerCourierConfigs.ts and to
 * reset isVerified to false on every credential replacement -- a seller
 * changing their bKash credentials should not keep a stale "verified"
 * flag from the old credentials).
 *
 * provider is currently always "bkash" per the schema's default and the
 * plan doc's §7 scope (only bKash is described) -- accepting it as a body
 * field rather than hardcoding it, in case a future provider is added, but
 * validating against the only value the schema/plan actually support
 * today rather than silently accepting anything.
 */
router.post("/seller-payment-configs", requireSeller, async (req, res) => {
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
      res.status(400).json({ error: 'provider must be "bkash" (the only provider this schema/plan supports today)' });
      return;
    }
    if (!merchantAppKey || !merchantAppSecret || !merchantUsername || !merchantPassword) {
      res.status(400).json({
        error: "merchantAppKey, merchantAppSecret, merchantUsername, and merchantPassword are all required",
      });
      return;
    }

    // Delete any existing config for this seller (one bKash merchant
    // account at a time -- see doc comment above).
    await db.delete(sellerPaymentConfigsTable).where(eq(sellerPaymentConfigsTable.sellerId, req.dbSeller!.id));

    const [config] = await db
      .insert(sellerPaymentConfigsTable)
      .values({
        sellerId: req.dbSeller!.id,
        provider: resolvedProvider,
        merchantAppKey: encryptCredential(merchantAppKey),
        merchantAppSecret: encryptCredential(merchantAppSecret),
        merchantUsername: encryptCredential(merchantUsername),
        merchantPassword: encryptCredential(merchantPassword),
        isVerified: false,
      })
      .returning();

    res.status(201).json(toMasked(config));
  } catch (err) {
    console.error("Create seller payment config error:", err);
    res.status(500).json({ error: "Failed to save payment config" });
  }
});

/**
 * Seller: delete their payment config. Per plan doc §7, this immediately
 * drops the seller back to COD-only -- routes/sellerListings.ts and
 * routes/orders.ts both re-check for a verified config on every relevant
 * write/checkout rather than caching seller eligibility anywhere, so
 * deleting here takes effect immediately for new writes/orders with no
 * separate cleanup step needed there.
 *
 * However, existing seller_listings rows are left displaying
 * paymentMethod "advance"/"both" even though the config backing that claim
 * is now gone -- checkout is already money-safe regardless (routes/cart.ts's
 * seller.hasVerifiedPaymentConfig excludes bkash at the cart/checkout layer
 * live), but the listing's own displayed state would otherwise be
 * misleading until the seller happens to edit it. So this route also
 * reconciles: flips any of this seller's listings still claiming
 * "advance"/"both" back to "cod", the same non-destructive, smaller fix
 * used at the admin unverify route (routes/adminSellers.ts) -- see that
 * route's doc comment for the fuller rationale on why this is preferred
 * over anything fancier.
 */
router.delete("/seller-payment-configs/mine", requireSeller, async (req, res) => {
  try {
    const deleted = await db
      .delete(sellerPaymentConfigsTable)
      .where(eq(sellerPaymentConfigsTable.sellerId, req.dbSeller!.id))
      .returning();
    if (deleted.length === 0) {
      res.status(404).json({ error: "No payment config to delete" });
      return;
    }

    await db
      .update(sellerListingsTable)
      .set({ paymentMethod: "cod" })
      .where(and(eq(sellerListingsTable.sellerId, req.dbSeller!.id), ne(sellerListingsTable.paymentMethod, "cod")));

    res.json({ message: "Payment config removed. Your listings will fall back to COD-only." });
  } catch (err) {
    console.error("Delete seller payment config error:", err);
    res.status(500).json({ error: "Failed to delete payment config" });
  }
});

export default router;
