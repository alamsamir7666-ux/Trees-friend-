import { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { db } from "@workspace/db";
import { usersTable, sellersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyMobileJwt } from "./mobileJwt";

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
      };
    }
    // Not a valid mobile JWT — fall through and let Clerk's own verifier
    // try it below, since @clerk/express also reads the Authorization
    // header for real Clerk session tokens (used by future native flows
    // or other Clerk-aware clients).
  }

  // 2. Fall back to Clerk's own session verification (website / any real
  // Clerk-issued session JWT).
  const auth = getAuth(req);
  const clerkId = auth?.userId;
  if (!clerkId) return null;

  const claims = (auth as any)?.sessionClaims ?? {};
  return {
    clerkId,
    claimedEmail: claims.email ?? claims.email_address ?? claims.primary_email_address ?? null,
    claimedFirst: claims.first_name ?? claims.firstName ?? null,
    claimedLast: claims.last_name ?? claims.lastName ?? null,
  };
}

export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const identity = resolveIdentity(req);
  if (!identity) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { clerkId, claimedEmail, claimedFirst, claimedLast } = identity;
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

  const ADMIN_EMAILS = ["alammahatab717@gmail.com"];
  const effectiveRole =
    clerkRole ?? (claimedEmail && ADMIN_EMAILS.includes(claimedEmail) ? "admin" : null);

  if (!user) {
    const email = claimedEmail ?? `${clerkId}@clerk.user`;
    const isAdminEmail = ADMIN_EMAILS.includes(email);
    const [inserted] = await db
      .insert(usersTable)
      .values({
        clerkId,
        email,
        firstName: claimedFirst,
        lastName: claimedLast,
        role: effectiveRole ?? (isAdminEmail ? "admin" : "user"),
      })
      .returning();
    user = inserted;
  } else {
    const isAdminEmail = claimedEmail ? ADMIN_EMAILS.includes(claimedEmail) : ADMIN_EMAILS.includes(user.email);
    const resolvedRole = effectiveRole ?? (isAdminEmail ? "admin" : null);
    const needsUpdate =
      (claimedFirst && user.firstName !== claimedFirst) ||
      (claimedLast && user.lastName !== claimedLast) ||
      (claimedEmail && user.email !== claimedEmail) ||
      (resolvedRole && user.role !== resolvedRole);

    if (needsUpdate) {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (claimedFirst) updates.firstName = claimedFirst;
      if (claimedLast) updates.lastName = claimedLast;
      if (claimedEmail) updates.email = claimedEmail;
      if (resolvedRole) updates.role = resolvedRole;

      const [updated] = await db
        .update(usersTable)
        .set(updates)
        .where(eq(usersTable.clerkId, clerkId))
        .returning();
      user = updated;
    }
  }

  if (user.isBlocked) {
    res.status(403).json({ error: "Account is blocked" });
    return;
  }

  req.dbUser = user;
  next();
};

export const requireAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  await new Promise<void>((resolve) => requireAuth(req, res, () => resolve()));
  if (res.headersSent) return;
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
  await new Promise<void>((resolve) => requireAuth(req, res, () => resolve()));
  if (res.headersSent) return;

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
  await new Promise<void>((resolve) => requireAuth(req, res, () => resolve()));
  if (res.headersSent) return;

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