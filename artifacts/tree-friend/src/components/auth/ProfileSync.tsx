import { useEffect, useRef } from "react";
import { useUser } from "@clerk/react";
import { useUpdateMe, useAddToCart, getGetCartQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGuestCartItems } from "@/hooks/useGuestCart";
import { useGuestCartContext } from "@/contexts/GuestCartContext";

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
 */
const PROFILE_SYNC_DEBOUNCE_MS = 1500;

export function ProfileSync() {
  const { user, isLoaded } = useUser();
  const updateMe = useUpdateMe();
  const addToCart = useAddToCart();
  const qc = useQueryClient();
  const guestCart = useGuestCartContext();
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
        } as any,
      });
      lastSyncedProfileRef.current = { ...latest };
    }, PROFILE_SYNC_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, user?.id, user?.firstName, user?.lastName, user?.primaryEmailAddress?.emailAddress]);

  // One-shot guest-cart migration on first sign-in. Independent of the
  // debounced profile-sync above.
  useEffect(() => {
    if (!isLoaded || !user) {
      cartSynced.current = false;
      return;
    }
    if (cartSynced.current) return;
    cartSynced.current = true;
    const guestItems = getGuestCartItems();
    if (guestItems.length === 0) return;

    const syncNext = (index: number) => {
      if (index >= guestItems.length) {
        guestCart.clearCart();
        qc.invalidateQueries({ queryKey: getGetCartQueryKey() });
        return;
      }
      const item = guestItems[index];
      addToCart.mutate(
        { data: { productId: item.productId, quantity: item.quantity } },
        { onSettled: () => syncNext(index + 1) }
      );
    };
    syncNext(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, user?.id]);

  return null;
}
