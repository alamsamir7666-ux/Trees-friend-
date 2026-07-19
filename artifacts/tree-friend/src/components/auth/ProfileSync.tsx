import { useEffect, useRef } from "react";
import { useUser } from "@clerk/react";
import { useUpdateMe, useAddToCart, getGetCartQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGuestCartItems } from "@/hooks/useGuestCart";
import { useGuestCartContext } from "@/contexts/GuestCartContext";

export function ProfileSync() {
  const { user, isLoaded } = useUser();
  const updateMe = useUpdateMe();
  const addToCart = useAddToCart();
  const qc = useQueryClient();
  const guestCart = useGuestCartContext();
  const cartSynced = useRef(false);

  useEffect(() => {
    if (!isLoaded || !user) {
      cartSynced.current = false;
      return;
    }

    const firstName = user.firstName ?? "";
    const lastName = user.lastName ?? "";
    const email = user.primaryEmailAddress?.emailAddress ?? "";

    if (firstName || lastName || email) {
      updateMe.mutate({
        data: {
          firstName: firstName || undefined,
          lastName: lastName || undefined,
          email: email || undefined,
        } as any,
      });
    }

    if (!cartSynced.current) {
      cartSynced.current = true;
      const guestItems = getGuestCartItems();
      if (guestItems.length > 0) {
        const syncNext = (index: number) => {
          if (index >= guestItems.length) {
            // Clear both context state and localStorage
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
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, user?.id, user?.firstName, user?.lastName, user?.primaryEmailAddress?.emailAddress]);

  return null;
}
