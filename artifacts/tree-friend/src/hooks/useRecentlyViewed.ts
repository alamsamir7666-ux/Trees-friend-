import { useState, useEffect } from "react";

import type { Product } from "@workspace/api-client-react";

// Recently viewed products are stored as the full Product shape returned by
// the API, so ProductCard (which expects a real Product) can render them
// directly without a lossy/fake cast.
export type RecentlyViewedProduct = Product;

const STORAGE_KEY = "treefriend_recently_viewed";
const MAX_ITEMS = 8;

export function saveRecentlyViewed(product: RecentlyViewedProduct): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const items: RecentlyViewedProduct[] = stored ? JSON.parse(stored) : [];
    const filtered = items.filter((p) => p.id !== product.id);
    const updated = [product, ...filtered].slice(0, MAX_ITEMS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {}
}

export function useRecentlyViewed(excludeId?: number): RecentlyViewedProduct[] {
  const [products, setProducts] = useState<RecentlyViewedProduct[]>([]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      const all: RecentlyViewedProduct[] = stored ? JSON.parse(stored) : [];
      setProducts(excludeId != null ? all.filter((p) => p.id !== excludeId) : all);
    } catch {
      setProducts([]);
    }
  }, [excludeId]);

  return products;
}
