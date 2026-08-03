import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

export const GUEST_CART_STORAGE_KEY = "treefriend_guest_cart";

export type GuestCartItem = {
  productId: number;
  variantId?: number | null;
  quantity: number;
  name: string;
  price: number;
  discountPrice: number | null;
  image: string;
  /**
   * Per-item delivery charge in taka. Optional for backward compat with
   * older localStorage entries that were created before this field existed
   * — those default to 0 (free), which is the safest fallback since the
   * real charge is always re-computed server-side at checkout.
   *
   * The authenticated cart surfaces this from the variant's
   * `deliveryCharge` column via GET /api/cart; the guest cart mirrors
   * the same field so the bag preview matches what the user will
   * actually be charged.
   */
  deliveryCharge?: number;
};

const STORAGE_KEY = "treefriend_guest_cart";

function readStorage(): GuestCartItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as GuestCartItem[]) : [];
  } catch {
    return [];
  }
}

type GuestCartContextType = {
  items: GuestCartItem[];
  addItem: (item: GuestCartItem) => void;
  removeItem: (productId: number) => void;
  updateQuantity: (productId: number, quantity: number) => void;
  clearCart: () => void;
  totalCount: number;
};

const GuestCartContext = createContext<GuestCartContextType | null>(null);

export function GuestCartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<GuestCartItem[]>(() => readStorage());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {}
  }, [items]);

  const addItem = useCallback((item: GuestCartItem) => {
    setItems((prev) => {
      const existing = prev.find((i) => i.productId === item.productId);
      if (existing) {
        return prev.map((i) =>
          i.productId === item.productId
            ? { ...i, quantity: i.quantity + item.quantity }
            : i
        );
      }
      return [...prev, item];
    });
  }, []);

  const removeItem = useCallback((productId: number) => {
    setItems((prev) => prev.filter((i) => i.productId !== productId));
  }, []);

  const updateQuantity = useCallback((productId: number, quantity: number) => {
    if (quantity <= 0) {
      setItems((prev) => prev.filter((i) => i.productId !== productId));
    } else {
      setItems((prev) =>
        prev.map((i) => (i.productId === productId ? { ...i, quantity } : i))
      );
    }
  }, []);

  const clearCart = useCallback(() => {
    setItems([]);
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }, []);

  const totalCount = items.reduce((s, i) => s + i.quantity, 0);

  return (
    <GuestCartContext.Provider value={{ items, addItem, removeItem, updateQuantity, clearCart, totalCount }}>
      {children}
    </GuestCartContext.Provider>
  );
}

export function useGuestCartContext(): GuestCartContextType {
  const ctx = useContext(GuestCartContext);
  if (!ctx) throw new Error("useGuestCartContext must be used within GuestCartProvider");
  return ctx;
}
