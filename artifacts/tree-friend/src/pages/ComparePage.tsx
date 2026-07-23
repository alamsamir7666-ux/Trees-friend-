import { useEffect } from "react";
import { X, Star, Scale } from "lucide-react";
import { updateSEO } from "@/lib/seo";
import { useListProducts, type Product } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useLocalStorage } from "@/hooks/useLocalStorage";

// Rows to compare. Price/stock are variant-based now, so they're rendered
// with dedicated logic below rather than through a generic key lookup.
const COMPARE_ROWS = [
  { key: "price", label: "Price" },
  { key: "averageRating", label: "Rating" },
  { key: "stock", label: "Availability" },
  { key: "watering", label: "Watering" },
  { key: "sunlight", label: "Sunlight" },
  { key: "bestFor", label: "Best For" },
  { key: "keyBenefits", label: "Key Benefits" },
] as const;

function renderCell(key: (typeof COMPARE_ROWS)[number]["key"], product: Product) {
  switch (key) {
    case "price": {
      // startingPrice is the admin-set price and is permanently null for
      // every product created after Phase 2 (see PHASE2_HANDOFF.md §5) --
      // the real marketplace price lives in listingMinPrice/listingMaxPrice.
      // Mirrors ProductCard.tsx's range-or-single-figure-or-"no listings"
      // pattern for consistency.
      const hasListings = product.listingCount > 0 && product.listingMinPrice != null;
      const priceRange = hasListings && product.listingMinPrice !== product.listingMaxPrice;
      return (
        <span className="font-semibold">
          {hasListings
            ? priceRange
              ? `Tk${product.listingMinPrice!.toLocaleString()} – Tk${product.listingMaxPrice!.toLocaleString()}`
              : `Tk${product.listingMinPrice!.toLocaleString()}`
            : <span className="text-muted-foreground font-normal">Not currently available</span>}
        </span>
      );
    }
    case "averageRating":
      return (
        <div className="flex items-center gap-1">
          <Star className="h-3.5 w-3.5 fill-accent text-accent" />
          <span className="text-sm">{product.averageRating.toFixed(1)}</span>
          <span className="text-xs text-muted-foreground">({product.reviewCount})</span>
        </div>
      );
    case "stock": {
      // Same fix as "price": inStock is admin-variant-derived and
      // permanently false post-Phase-2. listingCount > 0 (with a real min
      // price) is the real marketplace-availability signal.
      const hasListings = product.listingCount > 0 && product.listingMinPrice != null;
      return hasListings ? (
        <span className="text-green-600 text-sm font-medium">In Stock</span>
      ) : (
        <span className="text-destructive text-sm font-medium">Out of Stock</span>
      );
    }
    case "watering":
      return <span className="text-sm text-muted-foreground">{product.watering || "-"}</span>;
    case "sunlight":
      return <span className="text-sm text-muted-foreground capitalize">{product.sunlight?.replace(/_/g, " ") || "-"}</span>;
    case "bestFor":
    case "keyBenefits": {
      const values = key === "bestFor" ? product.bestFor : product.keyBenefits;
      return (
        <ul className="text-xs text-muted-foreground space-y-0.5">
          {(values ?? []).slice(0, 4).map((v) => (
            <li key={v} className="flex items-start gap-1">
              <span className="text-accent mt-0.5">✓</span> {v}
            </li>
          ))}
        </ul>
      );
    }
  }
}

export default function ComparePage() {
  const [compareIds, setCompareIds] = useLocalStorage<number[]>("compare-ids", []);

  // Fetched broadly and filtered client-side, matching the same pattern
  // used elsewhere on the site for lookups by id against a slug-oriented API.
  const { data } = useListProducts({ limit: 50 }, { query: { queryKey: ["products-for-compare"], staleTime: 1000 * 60 * 5 } });
  const allProducts = data?.products ?? [];

  const compareProducts = allProducts.filter((p) => compareIds.includes(p.id));

  function removeProduct(id: number) {
    setCompareIds((prev) => prev.filter((x) => x !== id));
  }

  useEffect(() => {
    updateSEO({ title: "Compare Products" });
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-4 py-10">
      <div className="flex items-center gap-3 mb-8">
        <Scale className="h-6 w-6 text-accent" />
        <h1 className="font-serif text-3xl">Compare Products</h1>
      </div>

      {compareProducts.length === 0 ? (
        <div className="text-center py-16">
          <Scale className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
          <p className="text-muted-foreground mb-2">No products selected for comparison.</p>
          <p className="text-sm text-muted-foreground mb-6">
            Use the compare button on product cards to add items here.
          </p>
          <Link href="/products">
            <Button className="rounded-full">Browse Products</Button>
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="text-left p-4 w-36 text-sm text-muted-foreground font-medium">
                  Attribute
                </th>
                {compareProducts.map((p) => (
                  <th key={p.id} className="p-4 min-w-[200px] align-top">
                    <div className="relative">
                      <button
                        onClick={() => removeProduct(p.id)}
                        className="absolute -top-1 -right-1 p-1 rounded-full bg-muted hover:bg-destructive hover:text-white transition-colors"
                        aria-label={`Remove ${p.name}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                      <img
                        src={p.images[0]}
                        alt={p.name}
                        className="w-full aspect-square object-cover rounded-xl mb-2"
                        loading="lazy"
                      />
                      <Link href={`/products/${p.id}`}>
                        <p className="font-medium text-sm hover:text-accent transition-colors leading-snug">
                          {p.name}
                        </p>
                      </Link>
                    </div>
                  </th>
                ))}
                {compareProducts.length < 3 && (
                  <th className="p-4 min-w-[200px]">
                    <Link href="/products">
                      <div className="aspect-square rounded-xl border-2 border-dashed border-border flex items-center justify-center text-muted-foreground hover:border-accent hover:text-accent transition-colors cursor-pointer">
                        <div className="text-center">
                          <span className="text-3xl">+</span>
                          <p className="text-xs mt-1">Add product</p>
                        </div>
                      </div>
                    </Link>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map(({ key, label }) => (
                <tr key={key} className="border-t border-border">
                  <td className="p-4 text-sm font-medium text-muted-foreground whitespace-nowrap">
                    {label}
                  </td>
                  {compareProducts.map((p) => (
                    <td key={p.id} className="p-4 align-top">
                      {renderCell(key, p)}
                    </td>
                  ))}
                  {compareProducts.length < 3 && <td />}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
