import { createContext, useContext, useCallback, type ReactNode } from "react";
import {
  useGetWishlist, useAddToWishlist, useRemoveFromWishlist, getGetWishlistQueryKey,
  useAddSellerListingVariantToWishlist, useRemoveSellerListingVariantFromWishlist,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import { useGuestWishlist, type GuestWishlistItem, type GuestSellerListingWishlistItem } from "@/hooks/useGuestWishlist";

type WishlistContextType = {
  isWishlisted: (productId: number) => boolean;
  toggle: (product: GuestWishlistItem) => void;
  // Seller-listing-variant wishlisting -- a separate axis from the plain
  // product toggle above. isSellerListingWishlisted/toggleSellerListing
  // key off sellerListingVariantId, not productId, since a person can
  // wishlist several different sellers' variants of the same product as
  // distinct entries (see WishlistPage.tsx's two-section split).
  isSellerListingWishlisted: (sellerListingVariantId: number) => boolean;
  toggleSellerListing: (item: GuestSellerListingWishlistItem) => void;
};

const WishlistContext = createContext<WishlistContextType>({
  isWishlisted: () => false,
  toggle: () => {},
  isSellerListingWishlisted: () => false,
  toggleSellerListing: () => {},
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
  const addSellerListingVariant = useAddSellerListingVariantToWishlist();
  const removeSellerListingVariant = useRemoveSellerListingVariantFromWishlist();

  const isWishlisted = useCallback(
    (productId: number) =>
      user
        ? wishlist?.products.some((w) => w.productId === productId) ?? false
        : guestWishlist.isInWishlist(productId),
    [user, wishlist, guestWishlist]
  );

  const toggle = useCallback(
    (product: GuestWishlistItem) => {
      if (!user) {
        guestWishlist.toggle(product);
        return;
      }
      const wishlisted = wishlist?.products.some((w) => w.productId === product.productId) ?? false;
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

  const isSellerListingWishlisted = useCallback(
    (sellerListingVariantId: number) =>
      user
        ? wishlist?.sellerListings.some((w) => w.sellerListingVariantId === sellerListingVariantId) ?? false
        : guestWishlist.isSellerListingInWishlist(sellerListingVariantId),
    [user, wishlist, guestWishlist]
  );

  const toggleSellerListing = useCallback(
    (item: GuestSellerListingWishlistItem) => {
      if (!user) {
        guestWishlist.toggleSellerListing(item);
        return;
      }
      const wishlisted = wishlist?.sellerListings.some((w) => w.sellerListingVariantId === item.sellerListingVariantId) ?? false;
      if (wishlisted) {
        removeSellerListingVariant.mutate(
          { variantId: item.sellerListingVariantId },
          { onSuccess: () => qc.invalidateQueries({ queryKey: getGetWishlistQueryKey() }) }
        );
      } else {
        addSellerListingVariant.mutate(
          { variantId: item.sellerListingVariantId },
          { onSuccess: () => qc.invalidateQueries({ queryKey: getGetWishlistQueryKey() }) }
        );
      }
    },
    [user, wishlist, addSellerListingVariant, removeSellerListingVariant, qc, guestWishlist]
  );

  return (
    <WishlistContext.Provider value={{ isWishlisted, toggle, isSellerListingWishlisted, toggleSellerListing }}>
      {children}
    </WishlistContext.Provider>
  );
}

export function useWishlist() {
  return useContext(WishlistContext);
}
