import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

export const GUEST_CART_STORAGE_KEY = "treefriend_guest_cart";

/**
 * Guest cart line. Mirrors the shape of an authenticated cart line's
 * essential fields so the bag/checkout UI can render both kinds from the
 * same data shape.
 *
 * Identity is the (productId, variantId) tuple — NOT productId alone.
 * The DB unique constraint on cart_items is
 *   UNIQUE(userId, productId, variantId)
 * (schema/cart.ts:91-95), and the guest cart must mirror that: two
 * variants of the same product (e.g. "Seeds" Tk100 and "Saplings" Tk250)
 * must stay as two separate lines. Keying by productId alone collapsed
 * them into one line with the first-added price — a real bug that
 * produced wrong totals and lost the second variant.
 *
 * variantId may be null/undefined for legacy rows or for products that
 * genuinely have no variants (admin-direct lines where the variantId
 * wasn't captured at add time). The merge key handles nulls explicitly
 * so two no-variant lines on the same product still merge into one.
 */
export type GuestCartItem = {
  productId: number;
  variantId?: number | null;
  /**
   * Optional marketplace variant id. Mutually exclusive with variantId —
   * a cart line is EITHER an admin-direct variant line (variantId set)
   * OR a marketplace seller-listing-variant line (sellerListingVariantId
   * set), never both. Mirrors the XOR enforced at the DB/API level
   * (schema/cart.ts doc comment, routes/cart.ts:247).
   */
  sellerListingVariantId?: number | null;
  quantity: number;
  name: string;
  price: number;
  discountPrice: number | null;
  image: string;
  /**
   * Seller's nurseryName for marketplace lines (sellerListingVariantId is
   * set). For admin-direct variant lines (variantId set, no seller) this
   * is undefined — and the CartPage groups those under a "Tree Friend"
   * header (the platform itself, since admin-direct lines have no seller).
   *
   * The CartPage shows "Sold by <sellerName>" above each group of items
   * from the same seller — matching the authenticated cart's behavior
   * (CartPage.tsx groupBySeller + SellerGroupHeader). Without this field,
   * a guest's bag showed "Tree Friend" for EVERY item, which was wrong:
   * the platform never sells anything, every cart line is a seller's
   * listing, so every line MUST show the seller's nursery name.
   *
   * Stored at add-time (snapshot). If the seller later renames their
   * nursery, the guest's localStorage cart keeps the old name until
   * they re-add the item. The server-side cart (post-OTP-verify) always
   * returns the live nurseryName via GET /cart, so this drift is
   * temporary and self-heals on merge.
   */
  sellerName?: string;
  /**
   * Per-item delivery charge in taka. Optional for backward compat with
   * older localStorage entries that were created before this field existed
   * — those default to 0 (free), which is the safest fallback since the
   * real charge is always re-computed server-side at checkout.
   *
   * The authenticated cart surfaces this from the variant's
   * `deliveryCharge` column via GET /api/cart; the guest cart mirrors
   * the same field on each item so the bag preview matches what the user
   * will actually be charged.
   */
  deliveryCharge?: number;
  /**
   * Stock snapshot at add-time. Optional for backward compat with older
   * localStorage entries. When present, the CartPage uses it to:
   *   1. Show "Only N left" warning when stock <= 5
   *   2. Disable the `+` button when quantity >= stock
   * This is a SNAPSHOT — it can drift from server-side stock between
   * add-time and checkout. The server re-validates at checkout time
   * (orders.ts), so a stale snapshot can at worst cause a confusing UX,
   * never oversell. Still, it's strictly better than the previous
   * behavior (guest could hit `+` to 999 with no feedback).
   */
  stock?: number;
  /**
   * Epoch millis when this line was added/last updated. Used by the
   * 30-day TTL purge (matches the server-side CART_TTL_DAYS in
   * routes/cart.ts). Without this, a guest cart in localStorage lives
   * forever — abandoned carts pollute the buyer's browser indefinitely.
   */
  addedAt?: number;
};

const STORAGE_KEY = GUEST_CART_STORAGE_KEY;

/** Mirror of the server-side CART_TTL_DAYS constant (routes/cart.ts). */
const GUEST_CART_TTL_DAYS = 30;
/** Mirror of the server-side MAX_CART_LINES constant. */
const MAX_GUEST_CART_LINES = 50;

function readStorage(): GuestCartItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as GuestCartItem[];
    if (!Array.isArray(parsed)) return [];
    // Purge lines older than the TTL — abandoned guest carts shouldn't
    // persist forever in the buyer's browser. Matches the server-side
    // expires_at column behavior.
    const cutoff = Date.now() - GUEST_CART_TTL_DAYS * 24 * 60 * 60 * 1000;
    return parsed.filter((i) => (i.addedAt ?? 0) >= cutoff);
  } catch {
    return [];
  }
}

function writeStorage(items: GuestCartItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // localStorage may be unavailable (private mode, quota exceeded) —
    // the in-memory state still works, just won't persist across reloads.
  }
}

/**
 * Stable identity key for a guest cart line. Mirrors the DB unique
 * constraint UNIQUE(userId, productId, variantId) and the marketplace
 * equivalent UNIQUE(userId, sellerListingVariantId). Two lines merge if
 * AND ONLY IF they share the same key.
 *
 * Null variantId / sellerListingVariantId are normalized to "null" so
 * two no-variant lines on the same product correctly merge (instead of
 * being treated as distinct because `undefined !== undefined` in JS).
 */
function lineKey(
  productId: number,
  variantId?: number | null,
  sellerListingVariantId?: number | null,
): string {
  // A marketplace line keys on sellerListingVariantId; an admin-direct
  // line keys on variantId. They can never collide (one is null when
  // the other is set), so we can safely use a single string key.
  if (sellerListingVariantId != null) {
    return `slv:${productId}:${sellerListingVariantId}`;
  }
  return `v:${productId}:${variantId ?? "null"}`;
}

type GuestCartContextType = {
  items: GuestCartItem[];
  addItem: (item: GuestCartItem) => void;
  /**
   * Remove a line. Accepts (productId, variantId, sellerListingVariantId)
   * so the caller can unambiguously target a specific variant line.
   * The old signature (productId only) collapsed all variants of the
   * same product into one removal, which was a bug.
   */
  removeItem: (
    productId: number,
    variantId?: number | null,
    sellerListingVariantId?: number | null,
  ) => void;
  /**
   * Update quantity on a specific variant line. Same identity rules as
   * removeItem. qty <= 0 removes the line (mirrors the old behavior but
   * scoped to the right line).
   */
  updateQuantity: (
    productId: number,
    quantity: number,
    variantId?: number | null,
    sellerListingVariantId?: number | null,
  ) => void;
  clearCart: () => void;
  totalCount: number;
};

const GuestCartContext = createContext<GuestCartContextType | null>(null);

export function GuestCartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<GuestCartItem[]>(() => readStorage());

  useEffect(() => {
    writeStorage(items);
  }, [items]);

  const addItem = useCallback((item: GuestCartItem) => {
    setItems((prev) => {
      // Cap total lines at MAX_GUEST_CART_LINES — mirrors the server-side
      // MAX_CART_LINES check in routes/cart.ts. If the buyer is already
      // at the cap and this is a NEW line (not a merge into an existing
      // one), reject the add. Merges are always allowed because they
      // don't add a new row.
      const key = lineKey(item.productId, item.variantId, item.sellerListingVariantId);
      const exists = prev.some(
        (i) => lineKey(i.productId, i.variantId, i.sellerListingVariantId) === key,
      );
      if (!exists && prev.length >= MAX_GUEST_CART_LINES) {
        return prev;
      }

      const now = Date.now();
      if (exists) {
        // Merge quantity into the existing line. KEEP the existing line's
        // price/image/stock — these are the snapshot the buyer saw when
        // they first added the item, and changing them on a silent merge
        // would be surprising (the buyer didn't pick the new price). The
        // server re-validates price/stock at checkout, so a stale snapshot
        // can at worst cause a "price changed" warning there.
        return prev.map((i) =>
          lineKey(i.productId, i.variantId, i.sellerListingVariantId) === key
            ? { ...i, quantity: i.quantity + item.quantity, addedAt: now }
            : i,
        );
      }
      return [...prev, { ...item, addedAt: now }];
    });
  }, []);

  const removeItem = useCallback(
    (productId: number, variantId?: number | null, sellerListingVariantId?: number | null) => {
      const key = lineKey(productId, variantId, sellerListingVariantId);
      setItems((prev) =>
        prev.filter((i) => lineKey(i.productId, i.variantId, i.sellerListingVariantId) !== key),
      );
    },
    [],
  );

  const updateQuantity = useCallback(
    (
      productId: number,
      quantity: number,
      variantId?: number | null,
      sellerListingVariantId?: number | null,
    ) => {
      const key = lineKey(productId, variantId, sellerListingVariantId);
      setItems((prev) => {
        if (quantity <= 0) {
          return prev.filter(
            (i) => lineKey(i.productId, i.variantId, i.sellerListingVariantId) !== key,
          );
        }
        return prev.map((i) =>
          lineKey(i.productId, i.variantId, i.sellerListingVariantId) === key
            ? { ...i, quantity, addedAt: Date.now() }
            : i,
        );
      });
    },
    [],
  );

  const clearCart = useCallback(() => {
    setItems([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // localStorage unavailable — in-memory state is already cleared.
    }
  }, []);

  const totalCount = items.reduce((s, i) => s + i.quantity, 0);

  return (
    <GuestCartContext.Provider
      value={{ items, addItem, removeItem, updateQuantity, clearCart, totalCount }}
    >
      {children}
    </GuestCartContext.Provider>
  );
}

export function useGuestCartContext(): GuestCartContextType {
  const ctx = useContext(GuestCartContext);
  if (!ctx) throw new Error("useGuestCartContext must be used within GuestCartProvider");
  return ctx;
}
