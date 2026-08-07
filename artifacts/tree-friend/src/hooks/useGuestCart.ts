export type { GuestCartItem } from "@/contexts/GuestCartContext";
export { useGuestCartContext as useGuestCart } from "@/contexts/GuestCartContext";
import { GUEST_CART_STORAGE_KEY } from "@/contexts/GuestCartContext";

export function getGuestCartItems() {
  try {
    const raw = localStorage.getItem(GUEST_CART_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function clearGuestCart() {
  try { localStorage.removeItem(GUEST_CART_STORAGE_KEY); } catch {}
}
