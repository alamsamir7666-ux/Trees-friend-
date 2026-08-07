import { useState, useEffect, useCallback, memo } from "react";
import { X, BarChart2, Plus, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { type Product } from "@workspace/api-client-react";

// A comparable product is just the real Product shape. Price comes from
// listingMinPrice/listingMaxPrice (the marketplace-derived range), NOT
// startingPrice -- startingPrice is the admin-set price and is permanently
// null for every product created after Phase 2 (PHASE2_HANDOFF.md §5). The
// comment this replaced was itself stale/wrong about which field to use;
// fixed as part of Phase 4's startingPrice/variants sweep.
type ComparableProduct = Product;

// Global comparison state (max 3 products) - persisted to localStorage
const STORAGE_KEY = "compare-ids";

function readFromStorage(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as number[]) : [];
  } catch {
    return [];
  }
}

function writeToStorage(ids: number[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {}
}

let _compareIds: number[] = readFromStorage();
let _listeners: Array<() => void> = [];

function notifyListeners() {
  _listeners.forEach((fn) => fn());
}

export function useComparison() {
  const [, forceRender] = useState(0);

  const listen = useCallback(() => {
    const fn = () => forceRender((n) => n + 1);
    _listeners.push(fn);
    return () => {
      _listeners = _listeners.filter((l) => l !== fn);
    };
  }, []);

  // Subscribe on mount, unsubscribe on unmount
  // (useEffect - not useState - is the right API for side-effects with cleanup)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => listen(), []);

  function addToCompare(id: number) {
    if (_compareIds.includes(id)) return;
    if (_compareIds.length >= 3) {
      _compareIds = [..._compareIds.slice(1), id];
    } else {
      _compareIds = [..._compareIds, id];
    }
    writeToStorage(_compareIds);
    notifyListeners();
  }

  function removeFromCompare(id: number) {
    _compareIds = _compareIds.filter((i) => i !== id);
    writeToStorage(_compareIds);
    notifyListeners();
  }

  function clearCompare() {
    _compareIds = [];
    writeToStorage(_compareIds);
    notifyListeners();
  }

  return {
    compareIds: _compareIds,
    addToCompare,
    removeFromCompare,
    clearCompare,
    isInCompare: (id: number) => _compareIds.includes(id),
  };
}

interface ComparisonDrawerProps {
  open: boolean;
  onClose: () => void;
  products: ComparableProduct[];
}

export const ComparisonDrawer = memo(function ComparisonDrawer({
  open,
  onClose,
  products,
}: ComparisonDrawerProps) {
  const { removeFromCompare } = useComparison();

  // Phase 4: the "Add to Bag" row below used to read product.variants
  // (admin-only, permanently empty since Phase 2 -- see
  // PHASE2_HANDOFF.md §5) and either silently no-op or offer only the
  // first admin variant, both broken. Removed rather than rewired: like
  // ProductCard.tsx (Phase 3b Part 5), this drawer is a discovery/
  // comparison surface with no seller-listing context for any of its
  // products -- buying now always requires picking a seller's listing
  // (and often a variant of that listing), which isn't information this
  // component has for N products at once. Both actions remain one click
  // away via each product's link to its detail page's seller cards.

  if (products.length < 2) return null;

  const rows = [
    {
      label: "Price",
      render: (p: ComparableProduct) => {
        // startingPrice is the admin-set price, permanently null post-
        // Phase-2. listingMinPrice/listingMaxPrice is the real marketplace
        // price, mirroring ProductCard.tsx's range/single/unavailable rule.
        const hasListings = p.listingCount > 0 && p.listingMinPrice != null;
        if (!hasListings) return "Not currently available";
        return p.listingMinPrice !== p.listingMaxPrice
          ? `Tk${p.listingMinPrice!.toLocaleString()} – Tk${p.listingMaxPrice!.toLocaleString()}`
          : `Tk${p.listingMinPrice!.toLocaleString()}`;
      },
    },
    {
      label: "Rating",
      render: (p: ComparableProduct) => (
        <span className="flex items-center gap-1">
          <Star className="h-3.5 w-3.5 fill-accent text-accent" />
          {p.averageRating} ({p.reviewCount})
        </span>
      ),
    },
    {
      label: "Care",
      render: (p: ComparableProduct) => p.watering ? `Watering: ${p.watering}` : "-",
    },
    {
      label: "Key Benefits",
      render: (p: ComparableProduct) =>
        p.keyBenefits?.length
          ? p.keyBenefits.map((b, i) => (
              <Badge key={i} variant="secondary" className="text-xs mr-1 mb-1">{b}</Badge>
            ))
          : "-",
    },
    {
      label: "Best For",
      render: (p: ComparableProduct) =>
        p.bestFor?.length
          ? p.bestFor.join(", ")
          : "-",
    },
  ];

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent side="bottom" className="h-[85vh] overflow-y-auto">
        <SheetHeader className="mb-4">
          <SheetTitle className="flex items-center gap-2">
            <BarChart2 className="h-5 w-5 text-accent" />
            Product Comparison
          </SheetTitle>
        </SheetHeader>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left font-medium text-muted-foreground py-2 pr-4 w-28">Feature</th>
                {products.map((p) => (
                  <th key={p.id} className="text-left font-medium py-2 pr-4 min-w-[160px]">
                    <div className="flex flex-col gap-1.5">
                      <div className="relative w-16 h-16 rounded-xl overflow-hidden bg-muted">
                        <img
                          src={p.images[0]}
                          alt={p.name}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                        <button
                          onClick={() => removeFromCompare(p.id)}
                          className="absolute top-0.5 right-0.5 h-5 w-5 bg-background/80 rounded-full flex items-center justify-center"
                          aria-label={`Remove ${p.name} from comparison`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      <span className="text-xs font-semibold line-clamp-2">{p.name}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-t">
                  <td className="py-3 pr-4 text-muted-foreground text-xs font-medium whitespace-nowrap">
                    {row.label}
                  </td>
                  {products.map((p) => (
                    <td key={p.id} className="py-3 pr-4 align-top text-sm">
                      {row.render(p)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SheetContent>
    </Sheet>
  );
});

// Floating comparison bar shown when 2+ products selected
export function ComparisonBar({ onOpen }: { onOpen: () => void }) {
  const { compareIds, clearCompare } = useComparison();
  if (compareIds.length < 2) return null;

  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 bg-card border shadow-xl rounded-2xl px-5 py-3 flex items-center gap-4 text-sm animate-in slide-in-from-bottom-4">
      <BarChart2 className="h-4 w-4 text-accent" />
      <span className="font-medium">{compareIds.length} products selected</span>
      <Button size="sm" className="rounded-full text-xs" onClick={onOpen}>
        Compare Now
      </Button>
      <button onClick={clearCompare} aria-label="Clear comparison" className="text-muted-foreground hover:text-foreground transition-colors">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
