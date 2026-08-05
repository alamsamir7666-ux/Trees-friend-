import { useEffect, useMemo, useCallback, useState, useRef } from "react";
import { Link, useParams, useLocation } from "wouter";
import { Trees, Loader2, ArrowRight, Package, Sprout, ShoppingBag, Star, Truck, MapPin, Eye, BadgeCheck, ImageOff, ChevronLeft, ChevronRight, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import {
  useListCategories,
  getListCategoriesQueryKey,
  useAddToCart,
  getGetCartQueryKey,
  type Category,
  type SellerListing,
  type SellerListingCardSellerInfo,
  type SellerListingVariant,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/apiClient";
import { useUser } from "@clerk/react";
import { useToast } from "@/hooks/use-toast";
import { SellerListingVariantPickerDialog } from "@/components/ui/SellerListingVariantPickerDialog";
import { updateSEO } from "@/lib/seo";

// ── Constants ──────────────────────────────────────────────────────────────
const INITIAL_CARDS = 6;   // initial cards per product group
const BATCH_CARDS = 8;     // cards to load on swipe near edge
const SCROLL_STEP = 340;   // px per chevron click

const DEFAULT_CATEGORY_IMAGE =
  "https://images.unsplash.com/photo-1518495973542-4542c06a5843?w=600&q=80&fm=webp";

type CategoryWithMeta = Category & {
  parentId?: number | null;
  image?: string | null;
  iconImage?: string | null;
  icon?: string | null;
  description?: string | null;
};

// ── Seller listing card types (same shape as shop-all) ────────────────────
interface SellerListingCard {
  listing: SellerListing;
  seller: SellerListingCardSellerInfo;
  rating: number;
  reviewCount: number;
  product: { id: number; name: string; slug: string };
}

interface ProductGroup {
  product: { id: number; name: string; slug: string };
  totalCount: number;
  cards: SellerListingCard[];
}

interface ByCategoryResponse {
  groups: ProductGroup[];
}

interface ByCategoryLoadMoreResponse {
  productId: number;
  cards: SellerListingCard[];
  hasMore: boolean;
}

// ── Fetchers ──────────────────────────────────────────────────────────────
async function fetchByCategory(categoryId: number): Promise<ByCategoryResponse> {
  const { data } = await apiClient.get<ByCategoryResponse>("/seller-listings/by-category", {
    params: { categoryId: String(categoryId), limit: String(INITIAL_CARDS) },
  });
  return data;
}

async function fetchByCategoryMore(productId: number, categoryId: number, offset: number): Promise<ByCategoryLoadMoreResponse> {
  const { data } = await apiClient.get<ByCategoryLoadMoreResponse>("/seller-listings/by-category", {
    params: { categoryId: String(categoryId), productId: String(productId), offset: String(offset), batchSize: String(BATCH_CARDS) },
  });
  return data;
}

// ══════════════════════════════════════════════════════════════════════════
//  Seller Listing Card (same design as Shop All)
// ══════════════════════════════════════════════════════════════════════════

interface CardProps {
  card: SellerListingCard;
  onAddToBag: (productId: number, listingId: number, nurseryName: string, qualifying: SellerListingVariant[]) => void;
  adding: boolean;
  isLoggedIn: boolean;
}

function SellerListingCard({ card, onAddToBag, adding, isLoggedIn }: CardProps) {
  const qualifying = card.listing.variants.filter((v) => v.availableQuantity > 0);
  const pricedVariant = [...(qualifying.length > 0 ? qualifying : card.listing.variants)].sort(
    (a, b) => (a.discountPrice ?? a.price) - (b.discountPrice ?? b.price),
  )[0];
  const outOfStock = qualifying.length === 0;
  const totalStock = card.listing.variants.reduce((sum: number, v) => sum + v.stock, 0);
  const img = card.listing.images?.[0] || null;
  const discountPct = pricedVariant?.discountPrice != null
    ? Math.round((1 - pricedVariant.discountPrice / pricedVariant.price) * 100)
    : null;

  return (
    <div className="shrink-0 w-[300px] sm:w-[340px] border rounded-2xl p-4 bg-card flex flex-col gap-3 snap-start shadow-sm hover:shadow-md transition-shadow">
      {/* Top: Seller identity */}
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

      {/* Product name */}
      <p className="font-serif text-base font-semibold text-foreground leading-snug line-clamp-2">
        {card.product.name}
      </p>

      {/* Pricing */}
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

      {/* Action buttons */}
      <div className="flex gap-2 mt-auto">
        <Link href={`/products/${card.product.id}/listings/${card.listing.id}`} className="flex-1">
          <Button variant="outline" size="sm" className="w-full rounded-lg border-primary text-primary hover:bg-primary/5 hover:text-primary gap-1.5">
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
//  Swipeable row (IntersectionObserver sentinel + skeleton cards)
// ══════════════════════════════════════════════════════════════════════════

function CardSkeleton() {
  return (
    <div className="shrink-0 w-[300px] sm:w-[340px] border rounded-2xl p-4 bg-card snap-start animate-in fade-in duration-300">
      <div className="flex gap-3">
        <Skeleton className="h-20 w-20 sm:h-24 sm:w-24 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      <Skeleton className="h-5 w-32 mt-3" />
      <div className="flex items-baseline gap-2 mt-3">
        <Skeleton className="h-7 w-16" />
        <Skeleton className="h-4 w-12" />
      </div>
      <div className="flex gap-2 mt-3">
        <Skeleton className="h-9 flex-1 rounded-lg" />
        <Skeleton className="h-9 flex-1 rounded-lg" />
      </div>
    </div>
  );
}

interface SwipeableRowProps {
  onLoadMore?: () => void;
  loadingMore?: boolean;
  hasMore?: boolean;
  children: React.ReactNode;
}

function SwipeableRow({ children, onLoadMore, loadingMore, hasMore }: SwipeableRowProps) {
  const sliderRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const slider = sliderRef.current;
    if (!sentinel || !slider || !onLoadMore || !hasMore) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !loadingMore) {
          onLoadMore();
        }
      },
      { root: slider, threshold: 0, rootMargin: "0px 700px 0px 0px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore, loadingMore]);

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
        {loadingMore && (<><CardSkeleton /><CardSkeleton /></>)}
        {hasMore && !loadingMore && (
          <div ref={sentinelRef} className="shrink-0 w-1" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

// ── Wide subcategory card (for parent categories) ─────────────────────────

function SubcategoryCardWide({ cat }: { cat: CategoryWithMeta }) {
  const img = cat.image || DEFAULT_CATEGORY_IMAGE;
  return (
    <Link
      href={`/category/${cat.slug}`}
      className="group block bg-card border border-border rounded-[20px] p-4 sm:p-5 shadow-[0_4px_20px_rgba(0,0,0,0.08)] hover:shadow-lg transition-shadow cursor-pointer overflow-hidden"
    >
      <div className="flex gap-4 items-center">
        <div className="shrink-0 h-24 w-24 sm:h-28 sm:w-28 rounded-xl overflow-hidden bg-muted/30">
          <img src={img} alt={cat.name} loading="lazy" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground mb-1">Subcategory</p>
          <h3 className="font-serif text-lg sm:text-xl font-medium leading-snug truncate mb-1">{cat.name}</h3>
          {cat.description && <p className="text-[13px] text-muted-foreground line-clamp-2 mb-2">{cat.description}</p>}
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent">
            Shop now <ArrowRight className="h-3 w-3 group-hover:translate-x-1 transition-transform" />
          </span>
        </div>
        {(cat.icon || cat.iconImage) && (
          <div className="shrink-0 h-10 w-10 rounded-full flex items-center justify-center text-lg bg-success/10 border border-success/20 overflow-hidden">
            {cat.iconImage ? <img src={cat.iconImage} alt="" className="h-full w-full object-cover" /> : cat.icon}
          </div>
        )}
      </div>
    </Link>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Main Page
// ══════════════════════════════════════════════════════════════════════════

export function CategoryProductsPage() {
  const { slug } = useParams<{ slug: string }>();

  // ── Categories ──────────────────────────────────────────────────────────
  const { data: dbCategories, isLoading: categoriesLoading } = useListCategories({
    query: { staleTime: 60_000, queryKey: getListCategoriesQueryKey() },
  });
  const allCats = (dbCategories ?? []) as CategoryWithMeta[];

  const currentCat = useMemo(() => allCats.find((c) => c.slug === slug), [allCats, slug]);
  const parentCat = useMemo(
    () => (currentCat?.parentId != null ? allCats.find((c) => c.id === currentCat.parentId) : null),
    [allCats, currentCat],
  );

  const subcategories = useMemo(
    () =>
      currentCat
        ? allCats
            .filter((c) => c.parentId === currentCat.id)
            .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name))
        : [],
    [allCats, currentCat],
  );
  const isParentCategory = subcategories.length > 0;

  // ── Seller listings by category (leaf subcategory only) ────────────────
  const {
    data: byCategoryRaw,
    isLoading: listingsLoading,
  } = useQuery<ByCategoryResponse>({
    queryKey: ["seller-listings-by-category", currentCat?.id],
    queryFn: () => fetchByCategory(currentCat!.id),
    staleTime: 60_000,
    enabled: !!currentCat && !isParentCategory,
  });

  // Progressive loading state
  const [productGroups, setProductGroups] = useState<ProductGroup[]>([]);
  const [loadingMoreProducts, setLoadingMoreProducts] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (byCategoryRaw?.groups) {
      setProductGroups(byCategoryRaw.groups);
    }
  }, [byCategoryRaw]);

  const handleLoadMore = useCallback(async (productId: number) => {
    if (!currentCat) return;
    const group = productGroups.find((g) => g.product.id === productId);
    if (!group) return;
    const currentCount = group.cards.length;
    if (currentCount >= group.totalCount || loadingMoreProducts.has(productId)) return;

    setLoadingMoreProducts((prev) => new Set(prev).add(productId));
    try {
      const result = await fetchByCategoryMore(productId, currentCat.id, currentCount);
      setProductGroups((prev) =>
        prev.map((g) =>
          g.product.id === productId
            ? { ...g, cards: [...g.cards, ...result.cards] }
            : g,
        ),
      );
    } catch (err) {
      console.error("Failed to load more seller listings:", err);
    } finally {
      setLoadingMoreProducts((prev) => { const next = new Set(prev); next.delete(productId); return next; });
    }
  }, [currentCat, productGroups, loadingMoreProducts]);

  // ── Cart / auth ─────────────────────────────────────────────────────────
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

  // Picker
  const pickerCard = productGroups
    .flatMap((g) => g.cards)
    .find((c) => c.listing.id === pickerListingId);
  const pickerQualifying = pickerCard ? pickerCard.listing.variants.filter((v) => v.availableQuantity > 0) : [];

  // ── SEO ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (currentCat) {
      updateSEO({
        title: `${currentCat.name} — Tree Friend`,
        description: currentCat.description ?? `Browse all ${currentCat.name} trees and plants available on Tree Friend.`,
      });
    }
  }, [currentCat]);

  // ── Loading state ───────────────────────────────────────────────────────
  if (categoriesLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="bg-muted/30 border-b py-10">
          <div className="container mx-auto px-4">
            <Skeleton className="h-3 w-48 rounded-full mb-3" />
            <Skeleton className="h-10 w-64 mb-2" />
            <Skeleton className="h-4 w-96" />
          </div>
        </div>
        <div className="container mx-auto px-4 py-8">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[160px] rounded-[20px]" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── 404 ─────────────────────────────────────────────────────────────────
  if (!currentCat) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
          <Trees className="w-7 h-7 text-muted-foreground" />
        </div>
        <h1 className="font-serif text-2xl font-medium mb-2">Category not found</h1>
        <p className="text-sm text-muted-foreground max-w-[360px] mb-6">
          We couldn't find a category with the slug &quot;{slug}&quot;.
        </p>
        <Link href="/browse"><Button className="rounded-full">Browse all trees</Button></Link>
      </div>
    );
  }

  // ── Breadcrumbs ─────────────────────────────────────────────────────────
  const crumbs = [
    { label: "Products", href: "/products" },
    ...(parentCat ? [{ label: parentCat.name, href: `/category/${parentCat.slug}` }] : []),
    { label: currentCat.name },
  ];

  return (
    <>
    <div className="min-h-screen bg-background">
      {/* Page header */}
      <div className="bg-muted/30 border-b py-10">
        <div className="container mx-auto px-4">
          <PageBreadcrumb crumbs={crumbs} className="mb-3" />
          <div className="flex items-start gap-4">
            {(currentCat.icon || currentCat.iconImage) && (
              <div className="h-14 w-14 rounded-2xl bg-card border border-border flex items-center justify-center text-2xl shrink-0 overflow-hidden">
                {currentCat.iconImage ? <img src={currentCat.iconImage} alt="" className="h-full w-full object-cover" /> : currentCat.icon}
              </div>
            )}
            <div className="min-w-0 flex-1">
              {parentCat && (
                <p className="text-[11px] uppercase tracking-[0.2em] text-accent-text font-semibold mb-1.5">
                  {parentCat.name}
                </p>
              )}
              <h1 className="font-serif text-4xl md:text-5xl font-medium leading-tight">
                {currentCat.name}
              </h1>
              {currentCat.description && (
                <p className="text-muted-foreground mt-2 text-sm max-w-2xl">{currentCat.description}</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="container mx-auto px-4 py-8">
        {isParentCategory ? (
          // ── Parent category: subcategory cards ─────────────────────────
          <>
            <div className="mb-6 flex items-center gap-2">
              <Sprout className="w-4 h-4 text-accent shrink-0" />
              <p className="text-sm text-muted-foreground">
                {subcategories.length} subcategor{subcategories.length === 1 ? "y" : "ies"} in {currentCat.name}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-5 max-w-2xl">
              {subcategories.map((sub) => (
                <SubcategoryCardWide key={sub.id} cat={sub} />
              ))}
            </div>
          </>
        ) : listingsLoading ? (
          // ── Loading skeletons ──────────────────────────────────────────
          <div className="space-y-8">
            {Array.from({ length: 3 }).map((_, i) => (
              <section key={i} className="py-6">
                <div className="flex items-end justify-between mb-5">
                  <div className="space-y-2">
                    <Skeleton className="h-7 w-44" />
                  </div>
                </div>
                <div className="flex gap-4 overflow-hidden">
                  {Array.from({ length: 3 }).map((_, j) => (
                    <CardSkeleton key={j} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : productGroups.length === 0 ? (
          // ── Empty state ────────────────────────────────────────────────
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <Trees className="w-7 h-7 text-muted-foreground" />
            </div>
            <h2 className="font-serif text-xl font-medium mb-2">No seller listings yet</h2>
            <p className="text-sm text-muted-foreground max-w-[360px] mb-6">
              Seller listings in {currentCat.name} will appear here once sellers list them.
            </p>
            <Link href="/browse"><Button className="rounded-full">Browse other categories</Button></Link>
          </div>
        ) : (
          // ── Seller listings grouped by product (swipeable rows) ────────
          <>
            <div className="mb-6 flex items-center gap-2">
              <Package className="w-4 h-4 text-accent shrink-0" />
              <p className="text-sm text-muted-foreground">
                {productGroups.length} product{productGroups.length !== 1 ? "s" : ""} with seller listings
              </p>
            </div>

            {productGroups.map((group) => (
              <section key={group.product.id} className="py-6">
                {/* Product name heading */}
                <div className="flex items-end justify-between mb-5">
                  <h2 className="font-serif text-2xl md:text-3xl font-medium leading-tight">
                    {group.product.name}
                  </h2>
                  <Link href={`/products/${group.product.id}`} className="shrink-0 ml-3">
                    <Button variant="ghost" className="text-muted-foreground hover:text-foreground text-sm gap-1">
                      View product
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  </Link>
                </div>

                {/* Swipeable seller listing cards with progressive loading */}
                <SwipeableRow
                  onLoadMore={() => handleLoadMore(group.product.id)}
                  loadingMore={loadingMoreProducts.has(group.product.id)}
                  hasMore={group.cards.length < group.totalCount}
                >
                  {group.cards.map((card) => (
                    <SellerListingCard
                      key={card.listing.id}
                      card={card}
                      onAddToBag={handleAddToBag}
                      adding={addingId === card.listing.id && addToCart.isPending}
                      isLoggedIn={!!user}
                    />
                  ))}
                </SwipeableRow>
              </section>
            ))}

            {/* End of results */}
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="h-px w-16 bg-border mb-4" />
              <p className="text-xs text-muted-foreground">
                Showing seller listings for all products in {currentCat.name}
              </p>
            </div>
          </>
        )}
      </div>
    </div>

    {/* Variant picker dialog */}
    {pickerCard && (
      <SellerListingVariantPickerDialog
        open={pickerListingId !== null}
        onOpenChange={(open) => { if (!open) setPickerListingId(null); }}
        variants={pickerQualifying}
        sellerName={pickerCard.seller.nurseryName}
        onConfirm={(variant) => addVariantToBag(pickerCard.product.id, variant, pickerCard.listing.id, pickerCard.seller.nurseryName)}
      />
    )}
    </>
  );
}
