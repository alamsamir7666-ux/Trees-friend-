export type { GuestCartItem } from "@/contexts/GuestCartContext";
export { useGuestCartContext as useGuestCart } from "@/contexts/GuestCartContext";
import { GUEST_CART_STORAGE_KEY, type GuestCartItem } from "@/contexts/GuestCartContext";

/** Mirror of the server-side CART_TTL_DAYS (routes/cart.ts) and the
 * guest cart's own GUEST_CART_TTL_DAYS (GuestCartContext.tsx). */
const GUEST_CART_TTL_DAYS = 30;

/**
 * Read the guest cart from localStorage, purging any lines older than
 * the 30-day TTL. Returns a typed array (callers were previously
 * getting `any` because the JSON.parse result wasn't narrowed).
 *
 * The TTL purge mirrors the server-side `expires_at` column behavior
 * (routes/cart.ts:buildCart filters `expires_at >= now()`). Without
 * this, a guest cart in localStorage lives forever — abandoned carts
 * pollute the buyer's browser indefinitely, and on sign-in the merge
 * endpoint would receive stale items the buyer no longer wants.
 */
export function getGuestCartItems(): GuestCartItem[] {
  try {
    const raw = localStorage.getItem(GUEST_CART_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as GuestCartItem[];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - GUEST_CART_TTL_DAYS * 24 * 60 * 60 * 1000;
    const fresh = parsed.filter((i) => (i.addedAt ?? 0) >= cutoff);
    // If the purge removed items, write the trimmed list back so the
    // next read doesn't re-parse the stale entries.
    if (fresh.length !== parsed.length) {
      try {
        localStorage.setItem(GUEST_CART_STORAGE_KEY, JSON.stringify(fresh));
      } catch {
        // localStorage unavailable — in-memory state still works.
      }
    }
    return fresh;
  } catch {
    // Corrupted JSON or localStorage unavailable — start fresh.
    return [];
  }
}

export function clearGuestCart() {
  try {
    localStorage.removeItem(GUEST_CART_STORAGE_KEY);
  } catch {
    // localStorage unavailable — nothing to clear.
  }
}
