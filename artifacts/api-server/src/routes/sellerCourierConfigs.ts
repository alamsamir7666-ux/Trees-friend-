import { Router } from "express";
import { db } from "@workspace/db";
import { sellerCourierConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireSeller } from "../middlewares/auth";
import { encryptCredential, maskCredential } from "../lib/credentialEncryption";

/**
 * Seller Courier Settings (plan doc §4 "Courier Settings", §8). This is
 * genuinely Part 1 scope per PHASE3_HANDOFF.md point 3 ("Payment/courier
 * config routes don't exist yet ... confirmed absent") -- flagging that
 * this route is being built here, in Part 4, out of necessity: booking a
 * courier (this session's actual scope) has nothing to read credentials
 * from otherwise. Kept intentionally minimal (create/update/get-masked/
 * delete) rather than building out the full Part 1 payment-config route
 * alongside it, since seller_payment_configs isn't needed for courier
 * booking.
 *
 * Every response masks credentials via maskCredential -- decrypted
 * plaintext is never returned in an API response body, per both configs
 * tables' schema-comment security note.
 */

const router = Router();

type CourierConfigRow = typeof sellerCourierConfigsTable.$inferSelect;

function toMasked(c: CourierConfigRow) {
  return {
    id: c.id,
    sellerId: c.sellerId,
    provider: c.provider,
    apiKeyMasked: maskCredential(c.apiKey),
    apiSecretMasked: maskCredential(c.apiSecret),
    storeId: c.storeId,
    isVerified: c.isVerified,
    createdAt: c.createdAt.toISOString(),
  };
}

/**
 * Seller: get their own courier config (masked). 404 if none configured --
 * that's the normal "manual fallback" state (plan doc §8), not an error
 * state, so the frontend should treat 404 as "not set up yet," not show an
 * error toast.
 */
router.get("/seller-courier-configs/mine", requireSeller, async (req, res) => {
  try {
    const [config] = await db
      .select()
      .from(sellerCourierConfigsTable)
      .where(eq(sellerCourierConfigsTable.sellerId, req.dbSeller!.id))
      .limit(1);
    if (!config) {
      res.status(404).json({ error: "No courier config set up yet" });
      return;
    }
    res.json(toMasked(config));
  } catch (err) {
    console.error("Get seller courier config error:", err);
    res.status(500).json({ error: "Failed to fetch courier config" });
  }
});

/**
 * Seller: create or replace their courier config (one per seller -- upsert
 * by sellerId, matching the unique-per-seller pattern seller_payment_configs
 * uses, even though seller_courier_configs.sellerId has no unique
 * constraint in schema today; enforced here at the route layer by
 * delete-then-insert so a seller can't accumulate multiple rows for
 * different providers with no way to pick which one booking should use).
 *
 * For Pathao: per pathao.ts's documented credential-packing convention,
 * apiSecret must arrive here as "clientSecret|username|password" -- the
 * three additional fields Pathao's OAuth needs beyond the 2-field
 * apiKey/apiSecret shape seller_courier_configs provides. This is a real
 * schema mismatch flagged in pathao.ts, not silently patched over; the
 * packing/unpacking convention lives in exactly two places (here and
 * pathao.ts) so it can't drift silently.
 *
 * isVerified is NOT set true here -- there is no live-credential check
 * being performed (would require an actual Pathao/Steadfast API round
 * trip against real credentials to confirm they work, which isn't built).
 * Starts false; verifying is a manual/future step, same open-ended state
 * as seller_payment_configs.isVerified.
 */
router.post("/seller-courier-configs", requireSeller, async (req, res) => {
  try {
    const { provider, apiKey, apiSecret, storeId } = req.body as {
      provider?: string;
      apiKey?: string;
      apiSecret?: string;
      storeId?: string;
    };

    if (provider !== "pathao" && provider !== "steadfast") {
      res.status(400).json({ error: 'provider must be "pathao" or "steadfast"' });
      return;
    }
    if (!apiKey || !apiSecret) {
      res.status(400).json({ error: "apiKey and apiSecret are required" });
      return;
    }
    if (provider === "pathao") {
      const parts = apiSecret.split("|");
      if (parts.length !== 3 || parts.some((p) => !p)) {
        res.status(400).json({
          error: 'For Pathao, apiSecret must be packed as "clientSecret|username|password" (3 non-empty parts)',
        });
        return;
      }
      if (!storeId) {
        res.status(400).json({ error: "storeId is required for Pathao" });
        return;
      }
    }

    // Delete any existing config for this seller (one active courier
    // provider at a time -- see doc comment above).
    await db.delete(sellerCourierConfigsTable).where(eq(sellerCourierConfigsTable.sellerId, req.dbSeller!.id));

    const [config] = await db
      .insert(sellerCourierConfigsTable)
      .values({
        sellerId: req.dbSeller!.id,
        provider,
        apiKey: encryptCredential(apiKey),
        apiSecret: encryptCredential(apiSecret),
        storeId: storeId ?? null,
        isVerified: false,
      })
      .returning();

    res.status(201).json(toMasked(config));
  } catch (err) {
    console.error("Create seller courier config error:", err);
    res.status(500).json({ error: "Failed to save courier config" });
  }
});

router.delete("/seller-courier-configs/mine", requireSeller, async (req, res) => {
  try {
    const deleted = await db
      .delete(sellerCourierConfigsTable)
      .where(eq(sellerCourierConfigsTable.sellerId, req.dbSeller!.id))
      .returning();
    if (deleted.length === 0) {
      res.status(404).json({ error: "No courier config to delete" });
      return;
    }
    res.json({ message: "Courier config removed. Orders will fall back to manual status updates." });
  } catch (err) {
    console.error("Delete seller courier config error:", err);
    res.status(500).json({ error: "Failed to delete courier config" });
  }
});

export default router;
