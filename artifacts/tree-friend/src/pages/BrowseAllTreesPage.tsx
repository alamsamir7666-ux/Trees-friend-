import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import { Link } from "wouter";
import { ChevronLeft, ChevronRight, ArrowRight, Trees, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ProductCard } from "@/components/ui/ProductCard";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import {
  useListCategories,
  listProducts,
  getListCategoriesQueryKey,
  type Category,
  type Product,
} from "@workspace/api-client-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { updateSEO } from "@/lib/seo";

// Same fallback image used on the homepage's CollectionSlider — keeps the
// browse page visually consistent with the homepage when a category has no
// custom image set in the admin panel.
const DEFAULT_CATEGORY_IMAGE =
  "https://images.unsplash.com/photo-1518495973542-4542c06a5843?w=600&q=80&fm=webp";
const DEFAULT_CATEGORY_BG = "hsl(var(--secondary))";

// ─── Infinite scroll batch sizes ──────────────────────────────────────────
// Per the user's request: load 10 cards at a time, then load 10 more when
// the user swipes near the end. These constants control both the subcategory
// client-side pagination (BATCH_SIZE_SUBS) and the product server-side
// pagination (BATCH_SIZE_PRODUCTS).
const BATCH_SIZE_SUBS = 10;
const BATCH_SIZE_PRODUCTS = 10;

// How far the chevron buttons scroll the horizontal card strip. Tuned to
// roughly one card width + gap (220 + 16 = 236, rounded up to 280 to match
// the homepage CollectionSlider behavior).
const SCROLL_STEP = 280;

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * The generated `Category` type omits `parentId`, `image`, `iconImage`, and
 * `description` (the OpenAPI spec is stale), but the API actually returns
 * them at runtime. Every existing consumer casts — we follow the same
 * convention here rather than regenerating the client. This type is the
 * "real" shape we work with internally.
 */
type CategoryWithMeta = Category & {
  parentId?: number | null;
  image?: string | null;
  iconImage?: string | null;
  icon?: string | null;
  description?: string | null;
};

/**
 * Groups the flat categories array into a tree:
 *   parents = top-level categories (parentId == null)
 *   childrenOf(parentId) = subcategories with that parentId
 *
 * Matches the pattern used in HomePage.tsx, ProductsPage.tsx, and Navbar.tsx.
 */
function buildCategoryTree(allCats: CategoryWithMeta[]) {
  const parents = allCats
    .filter((c) => c.parentId == null)
    .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));

  const childrenOf = (parentId: number) =>
    allCats
      .filter((c) => c.parentId === parentId)
      .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));

  return { parents, childrenOf };
}

/**
 * Builds the comma-joined slug string the products API expects when you want
 * to filter by "all subcategories under this parent". If the parent is itself
 * a leaf (no subcategories), returns just the parent's slug.
 */
function buildCategorySlugParam(parent: CategoryWithMeta, subs: CategoryWithMeta[]): string {
  if (subs.length === 0) return parent.slug;
  return subs.map((s) => s.slug).join(",");
}

// ─── Subcategory card (horizontal carousel item) ──────────────────────────

function SubcategoryCard({ cat }: { cat: CategoryWithMeta }) {
  const img = cat.image || DEFAULT_CATEGORY_IMAGE;
  return (
    <Link
      href={`/products?category=${cat.slug}`}
      className="group relative shrink-0 w-[200px] h-[260px] rounded-2xl overflow-hidden cursor-pointer snap-start shadow-md hover:shadow-xl transition-shadow duration-300 block"
      style={{ background: DEFAULT_CATEGORY_BG }}
    >
      <img
        src={img}
        alt={cat.name}
        loading="lazy"
        className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-foreground/70 via-foreground/10 to-transparent" />
      {(cat.icon || cat.iconImage) && (
        <div className="absolute bottom-16 right-4 h-10 w-10 rounded-full flex items-center justify-center text-lg bg-card/90 backdrop-blur-sm shadow-md overflow-hidden">
          {cat.iconImage ? (
            <img src={cat.iconImage} alt="" className="h-full w-full object-cover" />
          ) : (
            cat.icon
          )}
        </div>
      )}
      <div className="absolute bottom-4 left-4 right-4 text-background">
        <p className="text-[10px] uppercase tracking-[0.15em] mb-1 opacity-70">Subcategory</p>
        <h3 className="font-serif text-base font-medium leading-snug mb-1.5 truncate">{cat.name}</h3>
        <span className="text-xs opacity-80 flex items-center gap-1 group-hover:gap-2.5 transition-all duration-300">
          Shop now <ArrowRight className="h-3 w-3" />
        </span>
      </div>
    </Link>
  );
}

// ─── Loading sentinel card (shown at the end of a carousel while fetching) ─

function LoadingSentinelCard() {
  return (
    <div className="shrink-0 w-[200px] h-[260px] rounded-2xl bg-muted/40 flex items-center justify-center snap-start">
      <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
    </div>
  );
}

// ─── Horizontal slider with chevron buttons + infinite scroll ─────────────
// Reuses the pattern from HomePage.CollectionSlider (ref + scrollBy +
// scrollbar-hide + snap-x) and adds an optional infinite-scroll sentinel.
// The sentinel is rendered as the LAST child of the scrollable row; when it
// scrolls into view (i.e. the user has swiped near the end), `onLoadMore`
// fires. The caller is responsible for guarding against duplicate fires
// (e.g. checking hasNextPage + isFetching before issuing the request).

interface HorizontalSliderProps {
  children: React.ReactNode;
  /** Whether to show the loading sentinel at the end. True when more data
      is being fetched OR when there's more data to load (so the sentinel
      is present and observable). */
  showSentinel?: boolean;
  /** Called when the sentinel scrolls into view. */
  onLoadMore?: () => void;
}

function HorizontalSlider({ children, showSentinel, onLoadMore }: HorizontalSliderProps) {
  const sliderRef = useRef<HTMLDivElement>(null);

  // Wire up the infinite scroll sentinel. The root MUST be the slider's
  // scroll container (sliderRef) — otherwise the IntersectionObserver uses
  // the viewport as root and fires immediately for off-screen sentinels.
  const { sentinelRef } = useInfiniteScroll(
    () => onLoadMore?.(),
    {
      enabled: !!showSentinel && !!onLoadMore,
      root: sliderRef,
      rootMargin: "300px",
    },
  );

  return (
    <div className="relative">
      <div className="flex gap-2 justify-end mb-3">
        <button
          onClick={() => sliderRef.current?.scrollBy({ left: -SCROLL_STEP, behavior: "smooth" })}
          aria-label="Scroll left"
          className="h-9 w-9 rounded-full border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          onClick={() => sliderRef.current?.scrollBy({ left: SCROLL_STEP, behavior: "smooth" })}
          aria-label="Scroll right"
          className="h-9 w-9 rounded-full border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
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
        {showSentinel && (
          <div ref={sentinelRef} className="shrink-0">
            <LoadingSentinelCard />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Category section ─────────────────────────────────────────────────────

function CategorySection({
  category,
  subcategories,
}: {
  category: CategoryWithMeta;
  subcategories: CategoryWithMeta[];
}) {
  const hasSubs = subcategories.length > 0;

  // ─── Subcategories: client-side incremental rendering ─────────────────
  // All subcategories are already loaded (from useListCategories in the
  // parent), so there's no API pagination here. But rendering 100 cards
  // at once would be slow (100 image requests + 100 DOM nodes). Instead
  // we render BATCH_SIZE_SUBS at a time and load more when the user
  // swipes near the end.
  const [visibleSubCount, setVisibleSubCount] = useState(BATCH_SIZE_SUBS);
  const visibleSubs = useMemo(
    () => subcategories.slice(0, visibleSubCount),
    [subcategories, visibleSubCount],
  );
  const hasMoreSubs = visibleSubCount < subcategories.length;
  const loadMoreSubs = useCallback(() => {
    setVisibleSubCount((prev) => prev + BATCH_SIZE_SUBS);
  }, []);

  // Reset visible count if the subcategory list changes (e.g. when the
  // parent useListCategories refetches and returns different data).
  useEffect(() => {
    setVisibleSubCount(BATCH_SIZE_SUBS);
  }, [subcategories]);

  // ─── Products: server-side pagination with useInfiniteQuery ──────────
  // Only fetched when the category has NO subcategories. Fetches
  // BATCH_SIZE_PRODUCTS at a time; the next page is loaded automatically
  // when the user swipes near the end of the carousel.
  const slugParam = useMemo(
    () => buildCategorySlugParam(category, subcategories),
    [category, subcategories],
  );

  const {
    data: productsData,
    fetchNextPage: fetchNextProducts,
    hasNextPage: hasNextProductPage,
    isFetchingNextPage: isFetchingNextProducts,
    isLoading: productsLoading,
  } = useInfiniteQuery({
    queryKey: ["products", "browse-infinite", slugParam],
    queryFn: ({ pageParam = 1 }) =>
      listProducts({
        category: slugParam,
        limit: BATCH_SIZE_PRODUCTS,
        page: pageParam,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.totalPages > lastPage.page ? lastPage.page + 1 : undefined,
    enabled: !hasSubs,
    staleTime: 60_000,
  });

  // Flatten all loaded pages into a single product array.
  const products = useMemo(
    () => (productsData?.pages ?? []).flatMap((p) => p.products),
    [productsData],
  );

  const loadMoreProducts = useCallback(() => {
    if (hasNextProductPage && !isFetchingNextProducts) {
      fetchNextProducts();
    }
  }, [fetchNextProducts, hasNextProductPage, isFetchingNextProducts]);

  // ─── "View all" link ───────────────────────────────────────────────────
  const viewAllHref = `/products?category=${slugParam}`;

  return (
    <section className="py-8">
      <div className="flex items-end justify-between mb-5">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.2em] text-accent-text font-semibold mb-1.5">
            {hasSubs ? "Browse Subcategories" : "Featured Products"}
          </p>
          <h2 className="font-serif text-2xl md:text-3xl font-medium leading-tight truncate">
            {category.name}
          </h2>
          {category.description && (
            <p className="text-sm text-muted-foreground mt-1 line-clamp-2 max-w-2xl">
              {category.description}
            </p>
          )}
        </div>
        <Link href={viewAllHref} className="shrink-0 ml-3">
          <Button variant="ghost" className="text-muted-foreground hover:text-foreground text-sm gap-1">
            View all
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </Link>
      </div>

      {hasSubs ? (
        <HorizontalSlider
          showSentinel={hasMoreSubs}
          onLoadMore={loadMoreSubs}
        >
          {visibleSubs.map((sub) => (
            <SubcategoryCard key={sub.id} cat={sub} />
          ))}
        </HorizontalSlider>
      ) : (
        // ─── Products carousel (no subcategories) ───────────────────────
        // Uses server-side paginated fetching: first 10 products load on
        // mount, subsequent pages load automatically when the user swipes
        // near the end. The sentinel card at the end doubles as both the
        // IntersectionObserver target AND a visual loading spinner.
        <>
          {productsLoading ? (
            <HorizontalSlider>
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="shrink-0 w-[220px] h-[340px] rounded-2xl bg-muted/40 animate-pulse snap-start"
                />
              ))}
            </HorizontalSlider>
          ) : products.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center bg-muted/20 rounded-2xl">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
                <Trees className="w-5 h-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium mb-1">No products yet</p>
              <p className="text-xs text-muted-foreground max-w-[280px]">
                Products in {category.name} will appear here once sellers list them.
              </p>
            </div>
          ) : (
            <HorizontalSlider
              showSentinel={hasNextProductPage || isFetchingNextProducts}
              onLoadMore={loadMoreProducts}
            >
              {products.map((product) => (
                <div
                  key={product.id}
                  className="shrink-0 w-[220px] h-[340px] snap-start"
                >
                  <ProductCard product={product} backContext="browse" />
                </div>
              ))}
            </HorizontalSlider>
          )}
        </>
      )}
    </section>
  );
}

// ─── Skeletons ────────────────────────────────────────────────────────────

function CategorySectionSkeleton() {
  return (
    <section className="py-8">
      <div className="flex items-end justify-between mb-5">
        <div className="space-y-2">
          <Skeleton className="h-3 w-32 rounded-full" />
          <Skeleton className="h-8 w-48" />
        </div>
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="shrink-0 w-[200px] h-[260px] rounded-2xl" />
        ))}
      </div>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────

export function BrowseAllTreesPage() {
  // Fetch all categories (flat — both L1 and L2 mixed). Same cache config
  // as HomePage/ProductsPage/Navbar so the data is shared across all four
  // surfaces (no duplicate requests).
  const { data: dbCategories, isLoading: categoriesLoading } = useListCategories({
    query: { staleTime: 60_000, queryKey: getListCategoriesQueryKey() },
  });

  const allCats = (dbCategories ?? []) as CategoryWithMeta[];
  const { parents, childrenOf } = useMemo(() => buildCategoryTree(allCats), [allCats]);

  useEffect(() => {
    updateSEO({
      title: "Browse All Trees — Tree Friend",
      description:
        "Explore all our tree and plant collections. Browse by category and subcategory to find the perfect tree for your home, garden, or office.",
    });
  }, []);

  return (
    <div className="min-h-screen bg-background">
      {/* ─── Page header ─────────────────────────────────────────────────── */}
      <div className="bg-muted/30 border-b py-10">
        <div className="container mx-auto px-4">
          <PageBreadcrumb
            crumbs={[
              { label: "Home", href: "/" },
              { label: "All Trees" },
            ]}
            className="mb-3"
          />
          <h1 className="font-serif text-4xl md:text-5xl font-medium leading-tight">
            Browse All Trees
          </h1>
          <p className="text-muted-foreground mt-2 text-sm max-w-2xl">
            Explore our full catalogue by category. Swipe through subcategories to find exactly what
            you're looking for — from fruit trees to indoor plants and everything in between.
          </p>
        </div>
      </div>

      {/* ─── Category sections ───────────────────────────────────────────── */}
      <div className="container mx-auto px-4 py-6">
        {categoriesLoading ? (
          <>
            <CategorySectionSkeleton />
            <CategorySectionSkeleton />
            <CategorySectionSkeleton />
          </>
        ) : parents.length === 0 ? (
          // ─── Empty state ──────────────────────────────────────────────
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <Trees className="w-7 h-7 text-muted-foreground" />
            </div>
            <h2 className="font-serif text-xl font-medium mb-2">No categories yet</h2>
            <p className="text-sm text-muted-foreground max-w-[320px] mb-6">
              Categories are added by the admin. Once they're set up, you'll see all tree
              collections here.
            </p>
            <Link href="/products">
              <Button className="rounded-full">Browse all products</Button>
            </Link>
          </div>
        ) : (
          parents.map((parent) => {
            const subs = childrenOf(parent.id);
            return (
              <CategorySection
                key={parent.id}
                category={parent}
                subcategories={subs}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
