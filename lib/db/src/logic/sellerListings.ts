import { eq } from "drizzle-orm";
import { db } from "../index";
import { sellerPaymentConfigsTable } from "../schema";

/**
 * Moved here (Part 1 of the post-Phase-9 backlog) from
 * artifacts/api-server/src/routes/sellerListings.ts, where it was a
 * module-local function. It's still exported from sellerListings.ts (that
 * file re-exports it) so every existing call site there is unchanged.
 *
 * It was moved rather than simply marked `export` in place because
 * sellerListings.ts transitively imports express/multer/cloudinary and
 * (via ../middlewares/auth -> ./mobileJwt) throws at module-load time if
 * MOBILE_JWT_SECRET isn't set. That makes the route file unsafe to import
 * from anywhere that doesn't already run inside the full api-server process
 * -- including scripts/src/verify-seller-marketplace.ts, which has no
 * reason to depend on Express, Clerk, Cloudinary, or a JWT secret just to
 * reach a pure DB-read helper. Moving the function to @workspace/db (which
 * the script already depends on for `db` and the schema) removes that
 * coupling entirely: this module only imports drizzle-orm and this
 * package's own db/schema, both of which every consumer already needs.
 *
 * Original doc comment, preserved: seller_payment_configs row can only
 * offer COD -- enforce this at the listing level (reject payment_method =
 * 'advance' or 'both' if no verified config exists). Checks for a row with
 * isVerified = true specifically, not just any row existing. The only
 * place isVerified is ever set true is routes/adminSellers.ts's
 * PUT /admin/seller-payment-configs/:id/verify (a manual admin-review
 * toggle) -- so this returns false for every seller until an admin
 * explicitly verifies their config.
 */
export async function hasVerifiedPaymentConfig(sellerId: number): Promise<boolean> {
  const [config] = await db
    .select({ isVerified: sellerPaymentConfigsTable.isVerified })
    .from(sellerPaymentConfigsTable)
    .where(eq(sellerPaymentConfigsTable.sellerId, sellerId))
    .limit(1);
  return config?.isVerified === true;
}
