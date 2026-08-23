import { type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { db } from "@workspace/db";
import { usersTable, sellersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyMobileJwt } from "./mobileJwt";
import { extractGuestJwtFromHeader } from "../lib/guestJwt";
import { claimGuestOrders } from "../lib/accountClaim";
import { normalizeBdPhoneForStorage } from "../lib/guestOtp";
import { logger } from "../lib/logger";

/**
 * Admin email addresses — loaded from the ADMIN_EMAILS environment variable
 * (comma-separated, e.g. "admin@example.com,ops@example.com").
 *
 * Industry-standard rationale:
 *  - Never hardcode secrets or role-granting identifiers in source code.
 *  - ENV vars are easy to change per deployment (staging vs production)
 *    without a code change, and are the standard way 12-factor apps
 *    manage configuration.
 *  - Comma-separated lists are the most common convention for multi-value
 *    ENV vars (used by CORS origins, allowed hosts, etc.).
 *
 * Fallback: in development an empty array is used so that no one
 * accidentally gets admin rights; in production a missing variable logs
 * a prominent warning.
 */
const ADMIN_EMAILS: string[] = (() => {
  const raw = process.env.ADMIN_EMAILS ?? "";
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      logger.warn(
        "ADMIN_EMAILS env var is empty — no user will be auto-promoted to admin. " +
          "Set ADMIN_EMAILS to a comma-separated list of admin email addresses.",
      );
    }
    return []; // Safe default: nobody gets admin by accident
  }
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
})();

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      dbUser?: typeof usersTable.$inferSelect;
      dbSeller?: typeof sellersTable.$inferSelect;
    }
  }
}

/**
 * Resolves the authenticated Clerk user ID (and, where available, claimed
 * email/name) from either:
 *  1. Our own mobile JWT, sent as `Authorization: Bearer <token>` by the
 *     Flutter app after a successful /api/mobile-auth/sign-in — checked
 *     first since it's a fast, local signature check with no network call.
 *  2. Clerk's own session JWT, used by the website via @clerk/express —
 *     unchanged from the original implementation.
 *
 * Returns null if neither produces a valid identity, meaning the request
 * is unauthenticated.
 */
function resolveIdentity(req: Request): {
  clerkId: string;
  claimedEmail: string | null;
  claimedFirst: string | null;
  claimedLast: string | null;
  claimedPhone: string | null;
} | null {
  // 1. Try our mobile JWT first.
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length);
    const mobilePayload = verifyMobileJwt(token);
    if (mobilePayload) {
      return {
        clerkId: mobilePayload.clerkId,
        claimedEmail: mobilePayload.email,
        claimedFirst: null,
        claimedLast: null,
        claimedPhone: null,
      };
    }
    // Not a valid mobile JWT — fall through and let Clerk's own verifier
    // try it below, since @clerk/express also reads the Authorization
    // header for real Clerk session tokens (used by future native flows
    // or other Clerk-aware clients).
  }

  // 2. Fall back to Clerk's own session verification (website / any real
  // Clerk-issued session JWT). Wrapped in try-catch because getAuth(req)
  // can throw when Clerk's middleware hasn't fully initialized (e.g. in
  // the test environment with fake Clerk credentials, or when a non-Clerk
  // Bearer token is sent that Clerk's parser rejects). A throw here means
  // "no Clerk identity found" — treat it the same as null, not a 500.
  let auth: ReturnType<typeof getAuth> | null = null;
  let clerkId: string | null = null;
  try {
    auth = getAuth(req);
    clerkId = auth?.userId ?? null;
  } catch {
    clerkId = null;
  }
  if (!clerkId) return null;

  const claims = (auth as any)?.sessionClaims ?? {};
  return {
    clerkId,
    claimedEmail: claims.email ?? claims.email_address ?? claims.primary_email_address ?? null,
    claimedFirst: claims.first_name ?? claims.firstName ?? null,
    claimedLast: claims.last_name ?? claims.lastName ?? null,
    // Part 4: extract phone from Clerk session claims for account-claim.
    // Clerk stores the verified phone number in `phone_number` when the
    // user has phone verification enabled. The value is in E.164 format
    // (+8801XXXXXXXXX) — normalizeBdPhoneForStorage converts it to the
    // bare-local form (01XXXXXXXXX) used by guest_otps.phone.
    claimedPhone: claims.phone_number ?? claims.phoneNumber ?? null,
  };
}

/**
 * Core authentication logic — shared by requireAuth, requireAdmin,
 * requireSellerAccount, and requireSeller.
 *
 * Extracted so the higher-level middlewares don't need the obscure
 * `await new Promise<void>((resolve) => requireAuth(req, res, () => resolve())); if (res.headersSent) return;`
 * pattern to call requireAuth from within another middleware.
 *
 * On success: sets `req.userId` and `req.dbUser`, returns `true`.
 * On failure: sends the appropriate error response (401 or 403), returns `false`.
 * The caller should check the return value and `return` early if `false`.
 */
async function authenticate(req: Request, res: Response): Promise<boolean> {
  const identity = resolveIdentity(req);
  if (!identity) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  const { clerkId, claimedEmail, claimedFirst, claimedLast, claimedPhone } = identity;
  req.userId = clerkId;

  let user = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkId, clerkId))
    .limit(1)
    .then((r) => r[0]);

  // Role from Clerk publicMetadata takes precedence (set via Clerk dashboard or API).
  // Only available when authenticated via Clerk's own session (web); mobile
  // JWT requests fall back to the DB record's existing role, which is fine
  // since the DB row is the source of truth once created.
  const auth = getAuth(req);
  const clerkRole: string | null =
    (auth as any)?.sessionClaims?.metadata?.role ??
    (auth as any)?.sessionClaims?.public_metadata?.role ??
    null;

  const effectiveRole =
    clerkRole ?? (claimedEmail && ADMIN_EMAILS.includes(claimedEmail.toLowerCase()) ? "admin" : null);

  if (!user) {
    const email = claimedEmail ?? `${clerkId}@clerk.user`;
    const isAdminEmail = ADMIN_EMAILS.includes(email.toLowerCase());
    const [inserted] = await db
      .insert(usersTable)
      .values({
        clerkId,
        email,
        firstName: claimedFirst,
        lastName: claimedLast,
        // Part 4: save the phone number on the user row so future lookups
        // (e.g. seller dashboard, order history) can find it without
        // re-parsing Clerk claims.
        phone: claimedPhone ?? null,
        role: effectiveRole ?? (isAdminEmail ? "admin" : "user"),
      })
      .returning();
    user = inserted;

    // Part 4: account claim — migrate guest orders + cart to this new
    // account if the buyer previously checked out as a phone-verified
    // guest with the same phone number. Idempotent: if no guest orders
    // exist under "guest_<phone>", the UPDATE matches 0 rows and is a
    // no-op. Fire-and-forget (non-blocking) — account creation succeeds
    // even if the migration fails (the guest's data stays intact and
    // can be retried on the next sign-in).
    if (claimedPhone) {
      const normalizedPhone = normalizeBdPhoneForStorage(claimedPhone);
      if (normalizedPhone) {
        claimGuestOrders(clerkId, normalizedPhone).catch((err) => {
          logger.error(
            { err, clerkId, phone: normalizedPhone },
            "[auth] Account claim failed (non-fatal — guest data stays intact)",
          );
        });
      }
    }
  } else {
    const isAdminEmail = claimedEmail ? ADMIN_EMAILS.includes(claimedEmail.toLowerCase()) : ADMIN_EMAILS.includes(user.email.toLowerCase());
    const resolvedRole = effectiveRole ?? (isAdminEmail ? "admin" : null);
    // Part 4: also update phone if it changed (e.g. the user just added
    // a phone number to their Clerk profile — we want it on the user row
    // AND we want to trigger account claim for the new phone).
    const phoneChanged = claimedPhone && user.phone !== claimedPhone;
    const needsUpdate =
      (claimedFirst && user.firstName !== claimedFirst) ||
      (claimedLast && user.lastName !== claimedLast) ||
      (claimedEmail && user.email !== claimedEmail) ||
      (resolvedRole && user.role !== resolvedRole) ||
      phoneChanged;

    if (needsUpdate) {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (claimedFirst) updates.firstName = claimedFirst;
      if (claimedLast) updates.lastName = claimedLast;
      if (claimedEmail) updates.email = claimedEmail;
      if (resolvedRole) updates.role = resolvedRole;
      if (phoneChanged) updates.phone = claimedPhone;

      const [updated] = await db
        .update(usersTable)
        .set(updates)
        .where(eq(usersTable.clerkId, clerkId))
        .returning();
      user = updated;
    }

    // Part 4: account claim for EXISTING users too — the user may have
    // just added a phone number to their Clerk profile (or signed in for
    // the first time after a guest checkout). Idempotent: if the guest
    // orders have already been migrated, the UPDATE matches 0 rows.
    if (phoneChanged && claimedPhone) {
      const normalizedPhone = normalizeBdPhoneForStorage(claimedPhone);
      if (normalizedPhone) {
        claimGuestOrders(clerkId, normalizedPhone).catch((err) => {
          logger.error(
            { err, clerkId, phone: normalizedPhone },
            "[auth] Account claim failed (non-fatal — guest data stays intact)",
          );
        });
      }
    }
  }

  if (user.isBlocked) {
    res.status(403).json({ error: "Account is blocked" });
    return false;
  }

  req.dbUser = user;
  return true;
}

export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!(await authenticate(req, res))) return;
  next();
};

export const requireAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!(await authenticate(req, res))) return;
  if (req.dbUser?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
};

/**
 * Gates self-service seller-account routes (own profile edit, vacation
 * toggle) to any user with a sellers row, REGARDLESS of status --
 * deliberately more permissive than requireSeller above.
 *
 * requireSeller's active-only restriction is correct for listings/orders/
 * payment/courier writes (a suspended or vacationing seller shouldn't keep
 * transacting), but it also means a seller who has just switched to
 * "vacation" would be locked out of the one action that lets them switch
 * back -- the toggle needs to stay reachable from every non-deleted state.
 * pending_verification sellers also need this (to edit their profile while
 * awaiting approval), where requireSeller would 403 them entirely.
 *
 * Route handlers using this must NOT assume seller.status === "active" and
 * must not perform listing/order/payment/courier writes -- those stay on
 * requireSeller. This is intentionally narrow: profile fields and the
 * active<->vacation toggle only.
 */
export const requireSellerAccount = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!(await authenticate(req, res))) return;

  const [seller] = await db
    .select()
    .from(sellersTable)
    .where(eq(sellersTable.userId, req.dbUser!.id))
    .limit(1);

  if (!seller) {
    res.status(403).json({ error: "You don't have a seller account" });
    return;
  }

  req.dbSeller = seller;
  next();
};

/**
 * Gates seller-dashboard routes (seller_listings CRUD, upload-listing, etc.)
 * to users with an `active` sellers row. Deliberately does NOT allow
 * pending_verification, suspended, or vacation sellers to write listings --
 * pending applicants haven't been approved yet, suspended/vacation sellers
 * are already hidden buyer-side and shouldn't be able to keep creating new
 * listings while in that state (vacation is meant to pause the storefront,
 * not just hide it while the seller keeps working behind the scenes).
 *
 * Attaches the sellers row to req.dbSeller so route handlers don't have to
 * re-query it. Requires requireAuth's req.dbUser to already be set, so this
 * always runs requireAuth first, same pattern as requireAdmin.
 */
export const requireSeller = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!(await authenticate(req, res))) return;

  const [seller] = await db
    .select()
    .from(sellersTable)
    .where(eq(sellersTable.userId, req.dbUser!.id))
    .limit(1);

  if (!seller) {
    res.status(403).json({ error: "You don't have a seller account" });
    return;
  }
  if (seller.status !== "active") {
    res.status(403).json({ error: `Seller account status is "${seller.status}", not active` });
    return;
  }

  req.dbSeller = seller;
  next();
};

/**
 * Combined auth middleware — accepts EITHER a guest JWT (phone-verified
 * guest) OR a normal Clerk/mobile-JWT session (logged-in user).
 *
 * Part 2 of the Daraz-style guest checkout. Cart routes use this instead
 * of `requireAuth` so that phone-verified guests can use the same cart
 * API as logged-in users. The guest's cart items are stored under
 * `userId = "guest_<phone>"` in cart_items — same table, same queries,
 * no route duplication.
 *
 * Flow:
 *   1. Try guest JWT first (fast — local HMAC verify, no DB lookup).
 *      If valid → set req.userId = "guest_<phone>", skip usersTable
 *      lookup (guests don't have a user account — that's the point of
 *      guest checkout). Call next().
 *   2. If no guest JWT (or invalid) → fall through to the existing
 *      `authenticate()` which handles Clerk session JWTs and mobile-auth
 *      JWTs. This is the normal logged-in path, unchanged.
 *
 * What guests CAN do with this middleware:
 *   - GET /cart, POST /cart/items, PUT /cart/items/:id, DELETE /cart/items/:id
 *   - POST /cart/merge (merge localStorage → server cart)
 *   - POST /orders/guest (Part 3 — will be extended to support marketplace items)
 *
 * What guests CANNOT do:
 *   - Anything that requires req.dbUser (which stays undefined for guests):
 *     requireAdmin, requireSeller, requireSellerAccount, wishlist, loyalty, etc.
 *   - Routes that still use `requireAuth` (not yet migrated to
 *     requireGuestOrAuth) — these will 401 for guests, which is correct
 *     (guests shouldn't access account-only features).
 */
export const requireGuestOrAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // 1. Try guest JWT — fast, local, no DB lookup.
  const guestPayload = extractGuestJwtFromHeader(req.headers.authorization);
  if (guestPayload) {
    // Valid guest token. Set req.userId to "guest_<phone>" so cart
    // routes scope cart_items by this key. req.dbUser stays undefined
    // — guests don't have a usersTable row (Part 4 handles account
    // claim when they later sign up).
    req.userId = `guest_${guestPayload.phone}`;
    next();
    return;
  }

  // 2. No guest token — fall through to normal auth (Clerk or mobile JWT).
  if (!(await authenticate(req, res))) return;
  next();
};