import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useDebounce } from "@/hooks/useDebounce";
import { useListProducts, useListCategories, getListCategoriesQueryKey, type Product, useAddToCart, getGetCartQueryKey, type SellerListing, type SellerListingCardSellerInfo, type SellerListingVariant } from "@workspace/api-client-react";
import { ProductCard } from "@/components/ui/ProductCard";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Search, SlidersHorizontal, X, ShoppingBag, Loader2, Package, Star, Truck, MapPin, Eye, BadgeCheck, ImageOff, ChevronLeft, ChevronRight, ArrowRight, Trees, LogIn } from "lucide-react";
import { Link, useLocation, useSearch } from "wouter";
import { updateSEO } from "@/lib/seo";
import { ComparisonBar, ComparisonDrawer, useComparison } from "@/components/ui/ProductComparison";
// ComparisonBar and ComparisonDrawer available for future use
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/apiClient";
import { useUser } from "@clerk/react";
import { useToast } from "@/hooks/use-toast";
import { SellerListingVariantPickerDialog } from "@/components/ui/SellerListingVariantPickerDialog";

// ── Constants ──────────────────────────────────────────────────────────────
const INITIAL_LOAD = 10;
const LOAD_MORE_BATCH = 4;
const FETCH_LIMIT = 50;

const SORT_OPTIONS = [
  { value: "default",       label: "Default" },
  { value: "price-asc",     label: "Price: Low to High" },
  { value: "price-desc",    label: "Price: High to Low" },
  { value: "rating-desc",   label: "Top Rated" },
  { value: "newest",        label: "Newest First" },
];

const PER_PAGE_OPTIONS = ["12", "24", "36", "48"];

// ── Shop-All API types ─────────────────────────────────────────────────────
/** One seller listing card as returned by the shop-all endpoint */
interface ShopAllCard {
  listing: SellerListing;
  seller: SellerListingCardSellerInfo;
  rating: number;
  reviewCount: number;
  product: { id: number; name: string; slug: string };
}

/** One group (subcategory or category) with its seller listing cards */
interface ShopAllGroup {
  id: number;
  name: string;
  slug: string;
  parentId: number | null;
  parentName: string | null;
  cards: ShopAllCard[];
}

/** Response shape from GET /api/seller-listings/shop-all */
interface ShopAllResponse {
  groups: ShopAllGroup[];
}

// ── Fetcher for the shop-all endpoint ──────────────────────────────────────
async function fetchShopAll(category?: string): Promise<ShopAllResponse> {
  const params: Record<string, string> = { limit: "20" };
  if (category) params.category = category;
  const { data } = await apiClient.get<ShopAllResponse>("/seller-listings/shop-all", { params });
  return data;
}

// ── Sort helper (for the legacy product grid view) ─────────────────────────
function sortProducts(products: Product[], sort: string): Product[] {
  const arr = [...products];
  switch (sort) {
    case "price-asc":   return arr.sort((a, b) => (a.startingPrice ?? 0) - (b.startingPrice ?? 0));
    case "price-desc":  return arr.sort((a, b) => (b.startingPrice ?? 0) - (a.startingPrice ?? 0));
    case "rating-desc": return arr.sort((a, b) => (b.averageRating ?? 0) - (a.averageRating ?? 0));
    case "newest":      return arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    default:            return arr;
  }
}

// ── Lazy product card (legacy grid view) ───────────────────────────────────
function LazyProductCard({ product, backContext }: { product: any; backContext?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVisible(true); }, { rootMargin: "400px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div ref={ref}>
      {visible ? <ProductCard product={product} backContext={backContext} /> : <Skeleton className="aspect-[3/4] rounded-2xl" />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Swipeable Seller Listing Card (reference design)
// ══════════════════════════════════════════════════════════════════════════

interface SwipeableCardProps {
  card: ShopAllCard;
  onAddToBag: (productId: number, listingId: number, nurseryName: string, qualifying: SellerListingVariant[]) => void;
  adding: boolean;
  isLoggedIn: boolean;
}

function SwipeableSellerListingCard({ card, onAddToBag, adding, isLoggedIn }: SwipeableCardProps) {
  const qualifying = card.listing.variants.filter((v) => v.availableQuantity > 0);
  const pricedVariant = [...(qualifying.length > 0 ? qualifying : card.listing.variants)].sort(
    (a, b) => (a.discountPrice ?? a.price) - (b.discountPrice ?? b.price),
  )[0];
  const outOfStock = qualifying.length === 0;
  const totalStock = card.listing.variants.reduce((sum, v) => sum + v.stock, 0);
  const img = card.listing.images?.[0] || null;
  const discountPct = pricedVariant?.discountPrice != null
    ? Math.round((1 - pricedVariant.discountPrice / pricedVariant.price) * 100)
    : null;

  return (
    <div className="shrink-0 w-[300px] sm:w-[340px] border rounded-2xl p-4 bg-card flex flex-col gap-3 snap-start shadow-sm hover:shadow-md transition-shadow">
      {/* ── Top: Seller identity ─────────────────────────────────── */}
      <div className="flex gap-3">
        <div className="h-20 w-20 sm:h-24 sm:w-24 rounded-xl overflow-hidden bg-muted/30 shrink-0 flex items-center justify-center">
          {img ? (
            <img src={img} alt={card.seller.nurseryName} className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <div className="flex flex-col items-center gap-1 text-muted-foreground/60">
              <ImageOff className="h-5 w-5" />
              <span className="text-[10px]">No image</span>
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm truncate flex items-center gap-1.5">
            {card.seller.nurseryName}
            {card.seller.isVerified && (
              <BadgeCheck className="h-4 w-4 text-emerald-500 shrink-0" aria-label="Verified seller" />
            )}
          </p>

          {card.reviewCount > 0 && (
            <div className="flex items-center gap-1 text-xs mt-1">
              <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
              <span className="font-semibold">{card.rating.toFixed(1)}</span>
              <span className="text-muted-foreground">({card.reviewCount})</span>
            </div>
          )}

          <div className="flex flex-col gap-0.5 text-xs text-muted-foreground mt-1.5">
            {card.listing.deliveryTimeDays != null && (
              <span className="flex items-center gap-1"><Truck className="h-3 w-3 shrink-0" /> {card.listing.deliveryTimeDays}-day delivery</span>
            )}
            <span className="flex items-center gap-1"><MapPin className="h-3 w-3 shrink-0" /> {card.seller.location}</span>
          </div>
        </div>
      </div>

      {/* ── Product name ──────────────────────────────────────── */}
      <p className="font-serif text-base font-semibold text-foreground leading-snug line-clamp-2">
        {card.product.name}
      </p>

      {/* ── Middle: Pricing ──────────────────────────────────────── */}
      <div>
        <div className="flex items-baseline gap-2 flex-wrap">
          {pricedVariant && (
            <>
              <span className="font-serif text-xl font-bold text-primary">Tk{pricedVariant.discountPrice ?? pricedVariant.price}</span>
              {pricedVariant.discountPrice != null && (
                <>
                  <span className="text-sm text-muted-foreground line-through">Tk{pricedVariant.price}</span>
                  {discountPct != null && discountPct > 0 && (
                    <span className="text-xs font-semibold text-destructive bg-destructive/10 rounded-md px-1.5 py-0.5">{discountPct}% OFF</span>
                  )}
                </>
              )}
            </>
          )}
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1.5">
          <Package className="h-3.5 w-3.5" />
          {totalStock > 0 ? <><span className="text-emerald-600 font-medium">In Stock</span> ({totalStock})</> : "Out of stock"}
        </p>
      </div>

      {card.listing.offerText && (
        <p className="text-xs text-accent font-medium -mt-1">{card.listing.offerText}</p>
      )}

      {/* ── Bottom: Action buttons ───────────────────────────────── */}
      <div className="flex gap-2 mt-auto">
        <Link href={`/products/${card.product.id}/listings/${card.listing.id}`} className="flex-1">
          <Button
            variant="outline"
            size="sm"
            className="w-full rounded-lg border-primary text-primary hover:bg-primary/5 hover:text-primary gap-1.5"
          >
            <Eye className="h-3.5 w-3.5" /> View Details
          </Button>
        </Link>
        <Button
          variant="outline"
          size="sm"
          className="flex-1 rounded-lg border-primary text-primary hover:bg-primary/5 hover:text-primary gap-1.5"
          disabled={outOfStock || adding}
          onClick={() => onAddToBag(card.product.id, card.listing.id, card.seller.nurseryName, qualifying)}
        >
          {!isLoggedIn ? (
            <><LogIn className="h-3.5 w-3.5" /> Sign in</>
          ) : outOfStock ? (
            "Out of stock"
          ) : (
            <><ShoppingBag className="h-3.5 w-3.5" /> {adding ? "Adding..." : "Add to Bag"}</>
          )}
        </Button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Swipeable row with chevron buttons
// ══════════════════════════════════════════════════════════════════════════

const SCROLL_STEP = 340;

function SwipeableRow({ children }: { children: React.ReactNode }) {
  const sliderRef = useRef<HTMLDivElement>(null);

  return (
    <div className="relative">
      <div className="flex gap-2 justify-end mb-3">
        <button
          onClick={() => sliderRef.current?.scrollBy({ left: -SCROLL_STEP, behavior: "smooth" })}
          aria-label="Scroll left"
          className="h-8 w-8 rounded-full border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          onClick={() => sliderRef.current?.scrollBy({ left: SCROLL_STEP, behavior: "smooth" })}
          aria-label="Scroll right"
          className="h-8 w-8 rounded-full border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <div
        ref={sliderRef}
        className="flex gap-4 overflow-x-auto pb-2 scrollbar-hide snap-x snap-mandatory"
        style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
      >
        {children}
      </div>
    </div>
  );
}

// ── Skeleton for the shop-all view ─────────────────────────────────────────

function ShopAllGroupSkeleton() {
  return (
    <section className="py-6">
      <div className="flex items-end justify-between mb-5">
        <div className="space-y-2">
          <Skeleton className="h-3 w-28 rounded-full" />
          <Skeleton className="h-7 w-44" />
        </div>
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="shrink-0 w-[300px] h-[260px] rounded-2xl" />
        ))}
      </div>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Main Page
// ══════════════════════════════════════════════════════════════════════════

export function ProductsPage() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 350);
  const [sort, setSort] = useState("default");
  const [minRating, setMinRating] = useState(0);
  const [perPage, setPerPage] = useState(24);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [activeParentIdx, setActiveParentIdx] = useState(0);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [totalFromAPI, setTotalFromAPI] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const resetPage = useCallback(() => setCurrentPage(1), []);

  const [, navigate] = useLocation();
  const searchStr = useSearch();
  const activeCategory = new URLSearchParams(searchStr).get("category") ?? "";

  // ── Categories (shared cache with nav/browse/home) ──────────────────────
  const { data: dbCategories } = useListCategories({
    query: { staleTime: 60_000, queryKey: getListCategoriesQueryKey() },
  });

  // ── Shop-All data: seller listings grouped by subcategory/category ───────
  //    Only fetched when no category filter is active (the "Shop All" view)
  const {
    data: shopAllData,
    isLoading: shopAllLoading,
  } = useQuery<ShopAllResponse>({
    queryKey: ["shop-all-seller-listings", activeCategory],
    queryFn: () => fetchShopAll(activeCategory || undefined),
    staleTime: 60_000,
    enabled: !debouncedSearch, // only use shop-all when no search is active
  });

  // ── Cart / auth for Add to Bag ──────────────────────────────────────────
  const { user } = useUser();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const addToCart = useAddToCart();
  const [addingId, setAddingId] = useState<number | null>(null);
  const [pickerListingId, setPickerListingId] = useState<number | null>(null);

  function addVariantToBag(productId: number, variant: SellerListingVariant, listingId: number, nurseryName: string) {
    setAddingId(listingId);
    addToCart.mutate(
      { data: { productId, sellerListingVariantId: variant.id, quantity: 1 } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetCartQueryKey() });
          toast({ title: "Added to bag", description: `From ${nurseryName}` });
        },
        onError: (err: any) => {
          toast({ title: "Couldn't add to bag", description: err?.message ?? "Please try again.", variant: "destructive" });
        },
        onSettled: () => setAddingId(null),
      },
    );
  }

  function handleAddToBag(productId: number, listingId: number, nurseryName: string, qualifyingVariants: SellerListingVariant[]) {
    if (!user) {
      toast({ title: "Sign in required", description: "Please sign in to buy from marketplace sellers.", variant: "destructive" });
      setLocation("/sign-in");
      return;
    }
    if (qualifyingVariants.length === 1) {
      addVariantToBag(productId, qualifyingVariants[0], listingId, nurseryName);
      return;
    }
    setPickerListingId(listingId);
  }

  // ── Determine view mode ─────────────────────────────────────────────────
  // "shop-all" = seller listings grouped by category (swipeable)
  // "products" = traditional product grid (when searching or category-filtered with search)
  const isShopAllView = !debouncedSearch && !activeCategory;

  // ── Legacy product grid (used when search is active or category + search) ─
  useEffect(() => {
    const p = new URLSearchParams(searchStr);
    const cat = p.get("category") ?? "";
    if (cat !== activeCategory) {
      p.delete("page");
      if (cat) p.set("category", cat);
      const qs = p.toString();
      navigate(`/products${qs ? "?" + qs : ""}`, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateURL = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(searchStr);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") p.delete(k); else p.set(k, v);
    }
    const qs = p.toString();
    navigate(`/products${qs ? "?" + qs : ""}`, { replace: true });
  };

  const didMountCategory = useRef(false);
  useEffect(() => {
    if (!didMountCategory.current) { didMountCategory.current = true; return; }
    resetPage(); setAllProducts([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategory]);

  const didMountFilters = useRef(false);
  useEffect(() => {
    if (!didMountFilters.current) { didMountFilters.current = true; return; }
    resetPage(); setAllProducts([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, minRating, perPage]);

  useEffect(() => {
    const catTitle = activeCategory
      ? activeCategory.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : "";
    updateSEO({
      title: activeCategory ? `${catTitle} - Trees & Plants` : "Shop All Trees & Plants",
      description: "Browse healthy, nursery-grown trees and plants for your home and garden.",
    });
  }, [activeCategory]);

  const { data, isLoading, isFetching } = useListProducts({
    category: activeCategory || undefined,
    search: debouncedSearch || undefined,
    minRating: minRating > 0 ? minRating : undefined,
    page: currentPage,
    limit: perPage,
  });

  useEffect(() => {
    if (!data?.products) return;
    setAllProducts(data.products);
    setTotalFromAPI(data.total ?? 0);
  }, [data]);

  const sortedProducts = useMemo(() => sortProducts(allProducts, sort), [allProducts, sort]);
  const totalPages = Math.ceil(totalFromAPI / perPage);

  const handlePageChange = (page: number) => {
    const p = new URLSearchParams(searchStr);
    if (page === 1) p.delete("page"); else p.set("page", String(page));
    const qs = p.toString();
    navigate(`/products${qs ? "?" + qs : ""}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const activeCategoryObj = dbCategories?.find(c => c.slug === activeCategory);
  const isMultiCategory = activeCategory.includes(",");
  const matchedParentForAll = isMultiCategory
    ? (dbCategories ?? []).find((cat: any) => !cat.parentId &&
        (dbCategories ?? []).filter((c: any) => c.parentId === cat.id).map((c: any) => c.slug).join(",") === activeCategory)
    : undefined;
  const displayTitle = activeCategoryObj?.name
    ?? matchedParentForAll?.name
    ?? (activeCategory && !isMultiCategory ? activeCategory.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : "Shop All");

  const breadcrumbs = [
    { label: "Products", href: "/products", icon: <ShoppingBag className="h-3 w-3" /> },
    ...(activeCategory ? [{ label: activeCategoryObj?.name ?? displayTitle, icon: <Package className="h-3 w-3" /> }] : []),
  ];

  const activeFiltersCount = (minRating > 0 ? 1 : 0) + (activeCategory ? 1 : 0) + (search.trim() ? 1 : 0);

  // ── Comparison (legacy product grid) ────────────────────────────────────
  const { compareIds, addToCompare, removeFromCompare, isInCompare, clearCompare } = useComparison();

  // ── Picker for variant selection (seller listings) ──────────────────────
  const pickerCard = shopAllData?.groups
    .flatMap(g => g.cards)
    .find(c => c.listing.id === pickerListingId);
  const pickerQualifying = pickerCard ? pickerCard.listing.variants.filter(v => v.availableQuantity > 0) : [];

  // ══════════════════════════════════════════════════════════════════════
  //  RENDER
  // ══════════════════════════════════════════════════════════════════════

  return (
    <>
    <div className="min-h-screen bg-background">

      {/* ── Page header ──────────────────────────────────────────────── */}
      <div className="bg-muted/30 border-b py-3">
        <div className="container mx-auto px-4">
          <PageBreadcrumb crumbs={breadcrumbs} />
        </div>
      </div>

      <div className="container mx-auto px-4 py-6">

        {/* ── Search bar (always visible) ──────────────────────────── */}
        <div className="bg-secondary/60 border border-border rounded-2xl px-4 py-3 mb-6">
          <div className="relative w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search for product"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 h-10 rounded-xl border-border bg-card text-sm shadow-none w-full"
              aria-label="Search products"
            />
          </div>
        </div>

        {/* ════════════════════════════════════════════════════════════
            SHOP ALL VIEW: Seller listings grouped by subcategory/category
            ════════════════════════════════════════════════════════════ */}
        {isShopAllView ? (
          <>
            {/* Page heading */}
            <div className="mb-8">
              <h1 className="font-serif text-3xl md:text-4xl font-medium leading-tight">Shop All</h1>
              <p className="text-muted-foreground mt-2 text-sm max-w-2xl">
                Browse seller listings from verified nurseries. Swipe through each category to find the best trees and plants at the best prices.
              </p>
            </div>

            {shopAllLoading ? (
              <>
                <ShopAllGroupSkeleton />
                <ShopAllGroupSkeleton />
                <ShopAllGroupSkeleton />
              </>
            ) : !shopAllData?.groups || shopAllData.groups.length === 0 ? (
              /* ── Empty state ─────────────────────────────────────────── */
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
                  <Trees className="w-7 h-7 text-muted-foreground" />
                </div>
                <h2 className="font-serif text-xl font-medium mb-2">No seller listings yet</h2>
                <p className="text-sm text-muted-foreground max-w-[320px] mb-6">
                  Once sellers list their trees and plants, you'll see them here organized by category.
                </p>
                <Link href="/browse">
                  <Button className="rounded-full">Browse all categories</Button>
                </Link>
              </div>
            ) : (
              /* ── Groups with swipeable rows ──────────────────────────── */
              shopAllData.groups.map((group) => (
                <section key={group.id} className="py-6">
                  {/* Section header */}
                  <div className="flex items-end justify-between mb-5">
                    <div className="min-w-0">
                      {group.parentName && (
                        <p className="text-[11px] uppercase tracking-[0.2em] text-accent-text font-semibold mb-1.5">
                          {group.parentName}
                        </p>
                      )}
                      <h2 className="font-serif text-2xl md:text-3xl font-medium leading-tight truncate">
                        {group.name}
                      </h2>
                    </div>
                    <Link href={`/category/${group.slug}`} className="shrink-0 ml-3">
                      <Button variant="ghost" className="text-muted-foreground hover:text-foreground text-sm gap-1">
                        View all
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    </Link>
                  </div>

                  {/* Swipeable row of seller listing cards */}
                  <SwipeableRow>
                    {group.cards.map((card) => (
                      <SwipeableSellerListingCard
                        key={card.listing.id}
                        card={card}
                        onAddToBag={handleAddToBag}
                        adding={addingId === card.listing.id && addToCart.isPending}
                        isLoggedIn={!!user}
                      />
                    ))}
                  </SwipeableRow>
                </section>
              ))
            )}
          </>
        ) : (
          /* ════════════════════════════════════════════════════════════
              PRODUCT GRID VIEW (when searching or category-filtered)
              ════════════════════════════════════════════════════════════ */
          <>
            {/* Filter bar */}
            <div className="bg-secondary/60 border border-border rounded-2xl px-4 py-3 mb-6">
              {/* Row 1: Sort, Per page, Filter toggle */}
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <Select value={sort} onValueChange={setSort}>
                    <SelectTrigger className="h-10 rounded-xl border-border bg-card text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SORT_OPTIONS.map(o => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="min-w-[80px]">
                  <Select value={String(perPage)} onValueChange={v => { setPerPage(Number(v)); }}>
                    <SelectTrigger className="h-10 rounded-xl border-border bg-card text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PER_PAGE_OPTIONS.map(n => (
                        <SelectItem key={n} value={n}>{n}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <button
                  onClick={() => setShowFilterPanel(v => !v)}
                  className={`flex items-center gap-2 h-10 px-4 rounded-xl border text-sm font-medium transition-colors ${
                    showFilterPanel || activeFiltersCount > 0
                      ? "border-accent bg-accent text-accent-foreground"
                      : "border-border bg-card text-foreground hover:border-accent/60"
                  }`}
                  aria-label="Toggle filters"
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  {activeFiltersCount > 0 && (
                    <span className="bg-card text-accent text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                      {activeFiltersCount}
                    </span>
                  )}
                </button>

                {totalFromAPI > 0 && (
                  <p className="text-xs text-muted-foreground ml-auto hidden sm:block">
                    {totalFromAPI} products
                  </p>
                )}
              </div>

              {/* Expandable filter panel */}
              {showFilterPanel && (
                <div className="mt-4 pt-4 border-t border-border grid grid-cols-1 sm:grid-cols-3 gap-6">
                  {/* Category carousel */}
                  <div className="sm:col-span-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Category</p>
                    {(() => {
                      const allCats = dbCategories ?? [];
                      const parents = allCats.filter((cat: any) => !cat.parentId);
                      const currentParent = parents[activeParentIdx];
                      const subs = currentParent ? allCats.filter((cat: any) => cat.parentId === currentParent.id) : [];
                      return (
                        <div>
                          <div className="flex justify-center gap-1.5 mb-3">
                            {parents.map((_: any, i: number) => (
                              <button key={i} onClick={() => setActiveParentIdx(i)}
                                className={`h-1.5 rounded-full transition-all ${i === activeParentIdx ? "w-6 bg-accent" : "w-1.5 bg-border"}`} />
                            ))}
                          </div>
                          <div className="border border-border rounded-2xl p-4 bg-card"
                            onTouchStart={(e) => {
                              const touch = e.touches[0];
                              (e.currentTarget as any)._touchStartX = touch.clientX;
                            }}
                            onTouchEnd={(e) => {
                              const startX = (e.currentTarget as any)._touchStartX ?? 0;
                              const endX = e.changedTouches[0].clientX;
                              const diff = startX - endX;
                              if (Math.abs(diff) > 40) {
                                if (diff > 0) setActiveParentIdx(i => Math.min(i + 1, parents.length - 1));
                                else setActiveParentIdx(i => Math.max(i - 1, 0));
                              }
                            }}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-2">
                                <span className="text-2xl">{currentParent?.icon ?? "✨"}</span>
                                <span className="font-semibold text-[15px]">{currentParent?.name}</span>
                              </div>
                              <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{subs.length} types</span>
                            </div>

                            {subs.length > 0 ? (
                              <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide" style={{ scrollbarWidth: "none" }}>
                                {subs.map((sub: any) => {
                                  const isActive = activeCategory === sub.slug;
                                  const allSubSlugs = subs.map((s: any) => s.slug).join(",");
                                  const isParentActive = activeCategory === allSubSlugs;
                                  return (
                                    <button key={sub.id}
                                      onClick={() => {
                                        const target = isActive ? null : sub.slug;
                                        updateURL({ category: target, page: null });
                                        setActiveParentIdx(activeParentIdx);
                                      }}
                                      className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                                        isActive
                                          ? "bg-accent text-accent-foreground border-accent"
                                          : isParentActive
                                            ? "bg-accent/20 text-accent border-accent/40"
                                            : "bg-muted/50 text-foreground border-border hover:border-accent/50"
                                      }`}
                                    >
                                      {sub.icon && <span className="mr-1">{sub.icon}</span>}
                                      {sub.name}
                                    </button>
                                  );
                                })}
                                <button
                                  onClick={() => updateURL({ category: subs.map((s: any) => s.slug).join(","), page: null })}
                                  className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                                    activeCategory === subs.map((s: any) => s.slug).join(",")
                                      ? "bg-accent text-accent-foreground border-accent"
                                      : "bg-muted/50 text-foreground border-border hover:border-accent/50"
                                  }`}
                                >
                                  All {currentParent?.name}
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => updateURL({ category: currentParent?.slug ?? null, page: null })}
                                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                                  activeCategory === currentParent?.slug
                                    ? "bg-accent text-accent-foreground border-accent"
                                    : "bg-muted/50 text-foreground border-border hover:border-accent/50"
                                }`}
                              >
                                Browse {currentParent?.name}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Rating filter */}
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Min Rating</p>
                    <div className="flex gap-2">
                      {[0, 3, 4, 4.5].map(r => (
                        <button key={r}
                          onClick={() => { setMinRating(r); if (r > 0) resetPage(); }}
                          className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                            minRating === r ? "bg-accent text-accent-foreground border-accent" : "bg-muted/50 text-foreground border-border hover:border-accent/50"
                          }`}
                        >
                          {r === 0 ? "Any" : `${r}+`}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Clear filters */}
                  <div className="flex items-end">
                    <Button variant="ghost" size="sm"
                      onClick={() => { setMinRating(0); updateURL({ category: null, page: null }); }}
                      className="text-muted-foreground"
                    >
                      <X className="h-3.5 w-3.5 mr-1" /> Clear filters
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Product grid */}
            {isLoading ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="aspect-[3/4] rounded-2xl" />)}
              </div>
            ) : sortedProducts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
                  <ShoppingBag className="w-7 h-7 text-muted-foreground" />
                </div>
                <h2 className="font-serif text-xl font-medium mb-2">No products found</h2>
                <p className="text-sm text-muted-foreground max-w-[320px] mb-6">
                  Try adjusting your search or filters.
                </p>
                <Button variant="outline" onClick={() => { setSearch(""); setMinRating(0); updateURL({ category: null, page: null }); }} className="rounded-full">
                  Clear all filters
                </Button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                  {sortedProducts.map((p) => (
                    <LazyProductCard key={p.id} product={p} backContext="products" />
                  ))}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-center gap-2 mt-8">
                    <Button variant="outline" size="sm" disabled={currentPage === 1}
                      onClick={() => handlePageChange(currentPage - 1)} className="rounded-full gap-1">
                      <ChevronLeft className="h-4 w-4" /> Prev
                    </Button>
                    <span className="text-sm text-muted-foreground px-3">
                      Page {currentPage} of {totalPages}
                    </span>
                    <Button variant="outline" size="sm" disabled={currentPage === totalPages}
                      onClick={() => handlePageChange(currentPage + 1)} className="rounded-full gap-1">
                      Next <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

    </div>

    {/* Variant picker dialog for seller listings */}
    {pickerCard && (
      <SellerListingVariantPickerDialog
        open={pickerListingId != null}
        onOpenChange={(o) => { if (!o) setPickerListingId(null); }}
        sellerName={pickerCard.seller.nurseryName}
        variants={pickerQualifying}
        onConfirm={(variant) => addVariantToBag(pickerCard.product.id, variant, pickerCard.listing.id, pickerCard.seller.nurseryName)}
      />
    )}
    </>
  );
}
