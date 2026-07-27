import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

const STORAGE_KEY = "treefriend_guest_wishlist";
// Separate key (not merged into STORAGE_KEY's array) so existing guests'
// stored product wishlists are read back unchanged by readStorage() below,
// and so the two kinds can be cleared/managed independently.
const SELLER_LISTING_STORAGE_KEY = "treefriend_guest_wishlist_seller_listings";

export type GuestWishlistItem = {
  productId: number;
  name: string;
  slug: string;
  price: number;
  discountPrice: number | null;
  image: string;
  // Added so the Wishlist page can show a category badge + scientific name
  // without needing a per-item product fetch for guests (logged-in users
  // get these for free via WishlistItem.product, which is the full Product
  // type already).
  scientificName?: string | null;
  categoryId?: number | null;
};

// Guest-side equivalent of SellerListingWishlistItem (api.schemas.ts) --
// holds everything the Wishlist page's seller-listing card needs to render
// and to add-to-cart, since guests have no server-side row to re-fetch this
// from the way logged-in users do via GET /wishlist's sellerListings[].
export type GuestSellerListingWishlistItem = {
  sellerListingVariantId: number;
  productId: number;
  productName: string;
  image: string;
  sellerName: string;
  price: number;
  discountPrice: number | null;
  variantLabel: string;
};

function readStorage(): GuestWishlistItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as GuestWishlistItem[]) : [];
  } catch {
    return [];
  }
}

function readSellerListingStorage(): GuestSellerListingWishlistItem[] {
  try {
    const raw = localStorage.getItem(SELLER_LISTING_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as GuestSellerListingWishlistItem[]) : [];
  } catch {
    return [];
  }
}

type GuestWishlistContextType = {
  items: GuestWishlistItem[];
  addItem: (item: GuestWishlistItem) => void;
  removeItem: (productId: number) => void;
  isInWishlist: (productId: number) => boolean;
  toggle: (item: GuestWishlistItem) => void;
  clearWishlist: () => void;
  // Seller-listing-variant equivalents of the above, kept as a fully
  // separate list/API rather than overloading the product-shaped methods,
  // since a seller-listing row keys on sellerListingVariantId (several can
  // share the same productId) while the product list is unique per
  // productId -- see WishlistContext.tsx for how these are surfaced.
  sellerListingItems: GuestSellerListingWishlistItem[];
  addSellerListingItem: (item: GuestSellerListingWishlistItem) => void;
  removeSellerListingItem: (sellerListingVariantId: number) => void;
  isSellerListingInWishlist: (sellerListingVariantId: number) => boolean;
  toggleSellerListing: (item: GuestSellerListingWishlistItem) => void;
  clearSellerListingWishlist: () => void;
};

const GuestWishlistContext = createContext<GuestWishlistContextType | null>(null);

export function GuestWishlistProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<GuestWishlistItem[]>(() => readStorage());
  const [sellerListingItems, setSellerListingItems] = useState<GuestSellerListingWishlistItem[]>(() => readSellerListingStorage());

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch {}
  }, [items]);

  useEffect(() => {
    try { localStorage.setItem(SELLER_LISTING_STORAGE_KEY, JSON.stringify(sellerListingItems)); } catch {}
  }, [sellerListingItems]);

  const addItem = useCallback((item: GuestWishlistItem) => {
    setItems((prev) => prev.find((i) => i.productId === item.productId) ? prev : [...prev, item]);
  }, []);

  const removeItem = useCallback((productId: number) => {
    setItems((prev) => prev.filter((i) => i.productId !== productId));
  }, []);

  const isInWishlist = useCallback((productId: number) => items.some((i) => i.productId === productId), [items]);

  const toggle = useCallback((item: GuestWishlistItem) => {
    setItems((prev) =>
      prev.some((i) => i.productId === item.productId)
        ? prev.filter((i) => i.productId !== item.productId)
        : [...prev, item]
    );
  }, []);

  const clearWishlist = useCallback(() => {
    setItems([]);
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }, []);

  const addSellerListingItem = useCallback((item: GuestSellerListingWishlistItem) => {
    setSellerListingItems((prev) =>
      prev.find((i) => i.sellerListingVariantId === item.sellerListingVariantId) ? prev : [...prev, item]
    );
  }, []);

  const removeSellerListingItem = useCallback((sellerListingVariantId: number) => {
    setSellerListingItems((prev) => prev.filter((i) => i.sellerListingVariantId !== sellerListingVariantId));
  }, []);

  const isSellerListingInWishlist = useCallback(
    (sellerListingVariantId: number) => sellerListingItems.some((i) => i.sellerListingVariantId === sellerListingVariantId),
    [sellerListingItems]
  );

  const toggleSellerListing = useCallback((item: GuestSellerListingWishlistItem) => {
    setSellerListingItems((prev) =>
      prev.some((i) => i.sellerListingVariantId === item.sellerListingVariantId)
        ? prev.filter((i) => i.sellerListingVariantId !== item.sellerListingVariantId)
        : [...prev, item]
    );
  }, []);

  const clearSellerListingWishlist = useCallback(() => {
    setSellerListingItems([]);
    try { localStorage.removeItem(SELLER_LISTING_STORAGE_KEY); } catch {}
  }, []);

  return (
    <GuestWishlistContext.Provider value={{
      items, addItem, removeItem, isInWishlist, toggle, clearWishlist,
      sellerListingItems, addSellerListingItem, removeSellerListingItem,
      isSellerListingInWishlist, toggleSellerListing, clearSellerListingWishlist,
    }}>
      {children}
    </GuestWishlistContext.Provider>
  );
}

export function useGuestWishlistContext(): GuestWishlistContextType {
  const ctx = useContext(GuestWishlistContext);
  if (!ctx) throw new Error("useGuestWishlistContext must be used within GuestWishlistProvider");
  return ctx;
}
