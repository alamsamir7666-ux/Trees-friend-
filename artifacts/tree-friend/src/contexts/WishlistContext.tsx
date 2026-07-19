import { createContext, useContext, useCallback, type ReactNode } from "react";
import { useGetWishlist, useAddToWishlist, useRemoveFromWishlist, getGetWishlistQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import { useGuestWishlist, type GuestWishlistItem } from "@/hooks/useGuestWishlist";

type WishlistContextType = {
  isWishlisted: (productId: number) => boolean;
  toggle: (product: GuestWishlistItem) => void;
};

const WishlistContext = createContext<WishlistContextType>({
  isWishlisted: () => false,
  toggle: () => {},
});

export function WishlistProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const qc = useQueryClient();
  const guestWishlist = useGuestWishlist();

  const { data: wishlist } = useGetWishlist({
    query: { enabled: !!user, retry: false, queryKey: getGetWishlistQueryKey() },
  });

  const addToWishlist = useAddToWishlist();
  const removeFromWishlist = useRemoveFromWishlist();

  const isWishlisted = useCallback(
    (productId: number) =>
      user
        ? wishlist?.some((w) => w.productId === productId) ?? false
        : guestWishlist.isInWishlist(productId),
    [user, wishlist, guestWishlist]
  );

  const toggle = useCallback(
    (product: GuestWishlistItem) => {
      if (!user) {
        guestWishlist.toggle(product);
        return;
      }
      const wishlisted = wishlist?.some((w) => w.productId === product.productId) ?? false;
      if (wishlisted) {
        removeFromWishlist.mutate(
          { productId: product.productId },
          { onSuccess: () => qc.invalidateQueries({ queryKey: getGetWishlistQueryKey() }) }
        );
      } else {
        addToWishlist.mutate(
          { productId: product.productId },
          { onSuccess: () => qc.invalidateQueries({ queryKey: getGetWishlistQueryKey() }) }
        );
      }
    },
    [user, wishlist, addToWishlist, removeFromWishlist, qc, guestWishlist]
  );

  return (
    <WishlistContext.Provider value={{ isWishlisted, toggle }}>
      {children}
    </WishlistContext.Provider>
  );
}

export function useWishlist() {
  return useContext(WishlistContext);
}
