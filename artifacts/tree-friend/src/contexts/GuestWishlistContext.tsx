import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

const STORAGE_KEY = "treefriend_guest_wishlist";

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

function readStorage(): GuestWishlistItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as GuestWishlistItem[]) : [];
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
};

const GuestWishlistContext = createContext<GuestWishlistContextType | null>(null);

export function GuestWishlistProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<GuestWishlistItem[]>(() => readStorage());

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch {}
  }, [items]);

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

  return (
    <GuestWishlistContext.Provider value={{ items, addItem, removeItem, isInWishlist, toggle, clearWishlist }}>
      {children}
    </GuestWishlistContext.Provider>
  );
}

export function useGuestWishlistContext(): GuestWishlistContextType {
  const ctx = useContext(GuestWishlistContext);
  if (!ctx) throw new Error("useGuestWishlistContext must be used within GuestWishlistProvider");
  return ctx;
}
