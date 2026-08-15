import { useEffect, useRef } from "react";
import { useUser } from "@clerk/react";
import { useUpdateMe, getGetCartQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGuestCartItems, clearGuestCart } from "@/hooks/useGuestCart";
import { apiClient } from "@/lib/apiClient";

/**
 * Pushes the Clerk-side user profile (firstName / lastName / email) to
 * the backend `PUT /api/users/me` endpoint, and migrates any guest cart
 * to the signed-in user's server-side cart.
 *
 * Debouncing
 * ──────────
 * The previous implementation called `updateMe.mutate(...)` directly
 * inside a `useEffect` whose deps included `user?.firstName`,
 * `user?.lastName`, `user?.primaryEmailAddress?.emailAddress`. Clerk
 * fires `useUser()` updates on every token refresh, image re-fetch,
 * and metadata change — which can happen several times per minute
 * during a normal session. Each one triggered a `PUT /api/users/me`,
 * hammering the backend and producing duplicate audit rows.
 *
 * Now we snapshot the profile fields into refs, schedule a 1500ms
 * debounce timer, and only fire the PUT if the snapshot has actually
 * changed after the timer elapses. The one-shot guest-cart migration
 * is unaffected (still keyed on `user?.id`) and runs once on sign-in.
 *
 * Cart merge
 * ──────────
 * On first sign-in, the guest cart (localStorage) is merged into the
 * user's server-side cart via a single `POST /api/cart/merge` call.
 * The previous implementation called `POST /api/cart/items` N times
 * sequentially (N network round-trips) and didn't pass variantId or
 * sellerListingVariantId — so every guest item with a variant was
 * rejected by the XOR check in routes/cart.ts. The new merge endpoint
 * accepts all items in one request, validates stock per item, and
 * returns a `skipped[]` array of items that couldn't be merged (out of
 * stock, listing no longer approved, etc.) so the frontend can surface
 * a warning to the buyer.
 */
const PROFILE_SYNC_DEBOUNCE_MS = 1500;

export function ProfileSync() {
  const { user, isLoaded } = useUser();
  const updateMe = useUpdateMe();
  const qc = useQueryClient();
  const cartSynced = useRef(false);

  // Snapshot of the last profile we successfully pushed to the backend.
  // We compare against this (not against the live Clerk value) so that
  // a transient re-render with the same underlying values doesn't fire
  // a duplicate PUT.
  const lastSyncedProfileRef = useRef<{
    firstName: string;
    lastName: string;
    email: string;
  } | null>(null);

  // Track the latest profile fields so the debounce timer reads fresh
  // values when it fires, without re-arming on every Clerk re-render.
  const latestProfileRef = useRef<{
    firstName: string;
    lastName: string;
    email: string;
  } | null>(null);

  useEffect(() => {
    if (!isLoaded || !user) {
      cartSynced.current = false;
      lastSyncedProfileRef.current = null;
      latestProfileRef.current = null;
      return;
    }

    const firstName = user.firstName ?? "";
    const lastName = user.lastName ?? "";
    const email = user.primaryEmailAddress?.emailAddress ?? "";
    latestProfileRef.current = { firstName, lastName, email };

    // Don't fire a PUT until we have *something* to push. The backend
    // rejects empty payloads (firstName and lastName can't both be
    // empty per the API spec).
    if (!firstName && !lastName && !email) return;

    const timer = window.setTimeout(() => {
      const latest = latestProfileRef.current;
      if (!latest) return;
      const prev = lastSyncedProfileRef.current;
      // Skip if nothing actually changed since the last successful sync.
      if (
        prev &&
        prev.firstName === latest.firstName &&
        prev.lastName === latest.lastName &&
        prev.email === latest.email
      ) {
        return;
      }
      updateMe.mutate({
        data: {
          firstName: latest.firstName || undefined,
          lastName: latest.lastName || undefined,
          email: latest.email || undefined,
        },
      });
      lastSyncedProfileRef.current = { ...latest };
    }, PROFILE_SYNC_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [
    isLoaded,
    user?.id,
    user?.firstName,
    user?.lastName,
    user?.primaryEmailAddress?.emailAddress,
  ]);

  // One-shot guest-cart migration on first sign-in. Independent of the
  // debounced profile-sync above. Uses the batch /cart/merge endpoint
  // (single network call) instead of N sequential POST /cart/items
  // calls, and passes variantId/sellerListingVariantId so variant-keyed
  // items aren't rejected by the XOR check.
  useEffect(() => {
    if (!isLoaded || !user) {
      cartSynced.current = false;
      return;
    }
    if (cartSynced.current) return;
    cartSynced.current = true;

    const guestItems = getGuestCartItems();
    if (guestItems.length === 0) return;

    // Snapshot BEFORE clearing — clearGuestCart() mutates localStorage
    // synchronously, so reading from getGuestCartItems() after would
    // return []. We capture the items here and pass them to /cart/merge.
    const snapshot = guestItems.map((i) => ({
      productId: i.productId,
      variantId: i.variantId ?? null,
      sellerListingVariantId: i.sellerListingVariantId ?? null,
      quantity: i.quantity,
    }));

    (async () => {
      try {
        const { data: result } = await apiClient.post<{
          merged: number;
          skipped: { productId: number; reason: string }[];
        }>("/cart/merge", { items: snapshot });

        // Clear the guest cart only after a successful merge response.
        // If the request fails (network error, 500, etc.), leave the
        // guest cart intact so a retry on next sign-in can pick it up.
        clearGuestCart();

        // Invalidate the cart query so the authenticated cart UI
        // refetches with the merged items.
        qc.invalidateQueries({ queryKey: getGetCartQueryKey() });

        // Surface skipped items to the buyer — these are items that
        // couldn't be merged (out of stock, listing no longer approved,
        // etc.). The buyer should know their guest cart wasn't fully
        // transferred. (Toast handled by the caller / global error
        // boundary; here we just log for now. A follow-up could surface
        // a non-blocking toast per skipped item.)
        if (result.skipped.length > 0) {
          console.warn(
            `[ProfileSync] ${result.skipped.length} guest cart item(s) could not be merged:`,
            result.skipped,
          );
        }
      } catch (err) {
        // Don't clear the guest cart on failure — leave it for a retry.
        console.error("[ProfileSync] guest cart merge failed:", err);
      }
    })();
  }, [isLoaded, user?.id]);

  return null;
}
