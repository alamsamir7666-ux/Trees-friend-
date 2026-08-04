import { useEffect, useMemo, useCallback, useRef } from "react";
import { Link, useParams } from "wouter";
import { Trees, Loader2, ArrowRight, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { HomepageProductCard } from "@/components/ui/HomepageProductCard";
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

// Page size for the infinite scroll. 12 fits nicely in a 2-column grid
// (6 rows) without overwhelming the initial load — the user can scroll to
// load more on demand.
const PAGE_SIZE = 12;

/**
 * The generated `Category` type omits `parentId`, `image`, `iconImage`,
 * `description` (the OpenAPI spec is stale), but the API returns them at
 * runtime. We cast to this shape — same convention as BrowseAllTreesPage,
 * HomePage, ProductsPage, and Navbar.
 */
type CategoryWithMeta = Category & {
  parentId?: number | null;
  image?: string | null;
  iconImage?: string | null;
  icon?: string | null;
  description?: string | null;
};

export function CategoryProductsPage() {
  const { slug } = useParams<{ slug: string }>();

  // ─── Fetch all categories so we can look up the current one by slug ─────
  // Same shared cache key as BrowseAllTreesPage / HomePage / Navbar, so
  // this doesn't trigger a duplicate request if the user navigated from
  // any of those pages.
  const { data: dbCategories, isLoading: categoriesLoading } = useListCategories({
    query: { staleTime: 60_000, queryKey: getListCategoriesQueryKey() },
  });
  const allCats = (dbCategories ?? []) as CategoryWithMeta[];

  // Look up the current category + its parent (for breadcrumbs).
  const currentCat = useMemo(
    () => allCats.find((c) => c.slug === slug),
    [allCats, slug],
  );
  const parentCat = useMemo(
    () => (currentCat?.parentId != null ? allCats.find((c) => c.id === currentCat.parentId) : null),
    [allCats, currentCat],
  );

  // Build a categoryId → name map for the green category badge on each card
  // (HomepageProductCard takes a `categoryName` prop — the Product type only
  // carries `categoryId`, so we need to join names here, same as HomePage).
  const categoryNameById = useMemo(
    () => new Map<number, string>(allCats.map((c: { id: number; name: string }) => [c.id, c.name])),
    [allCats],
  );

  // ─── Infinite-query the products for this subcategory ──────────────────
  // Server-side pagination via useInfiniteQuery + listProducts. The API
  // supports `page` + `limit` params and returns `totalPages`, which we use
  // to compute the next page param. Each page fetches PAGE_SIZE products;
  // the next page loads automatically when the user scrolls near the bottom
  // (IntersectionObserver sentinel at the end of the grid).
  const {
    data: productsData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading: productsLoading,
    error: productsError,
  } = useInfiniteQuery({
    queryKey: ["products", "category-page", slug],
    queryFn: ({ pageParam = 1 }) =>
      listProducts({
        category: slug,
        limit: PAGE_SIZE,
        page: pageParam,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.totalPages > lastPage.page ? lastPage.page + 1 : undefined,
    // Don't fire the query until we've confirmed the slug exists. This
    // avoids a wasted request for a 404 category and also defers until the
    // categories list has loaded (so the queryKey is stable).
    enabled: !!slug && !categoriesLoading,
    staleTime: 60_000,
  });

  // Flatten all loaded pages into a single product array.
  const products = useMemo(
    () => (productsData?.pages ?? []).flatMap((p) => p.products),
    [productsData],
  );

  const totalProducts = productsData?.pages?.[0]?.total ?? 0;

  // ─── Vertical infinite scroll sentinel ──────────────────────────────────
  // For a vertical page, the IntersectionObserver root is the viewport
  // (default), so we don't pass a `root` option — unlike the horizontal
  // carousels on the browse page. The sentinel sits at the very bottom of
  // the grid; when it enters the viewport, load the next page.
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const { sentinelRef } = useInfiniteScroll(loadMore, {
    enabled: hasNextPage,
    rootMargin: "600px", // trigger ~2 screens before the bottom
  });

  // ─── SEO ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (currentCat) {
      updateSEO({
        title: `${currentCat.name} — Tree Friend`,
        description:
          currentCat.description ??
          `Browse all ${currentCat.name} trees and plants available on Tree Friend.`,
      });
    }
  }, [currentCat]);

  // ─── Loading state (categories still loading) ───────────────────────────
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
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-44 rounded-[20px]" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ─── 404: category not found ────────────────────────────────────────────
  if (!currentCat) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
          <Trees className="w-7 h-7 text-muted-foreground" />
        </div>
        <h1 className="font-serif text-2xl font-medium mb-2">Category not found</h1>
        <p className="text-sm text-muted-foreground max-w-[360px] mb-6">
          We couldn't find a category with the slug "{slug}". It may have been renamed or removed.
        </p>
        <Link href="/browse">
          <Button className="rounded-full">Browse all trees</Button>
        </Link>
      </div>
    );
  }

  // ─── Breadcrumbs ────────────────────────────────────────────────────────
  // Home / Browse / [Parent category] / [Current subcategory]
  // If the current category has no parent (it's a top-level leaf), we skip
  // the parent crumb.
  const crumbs = [
    { label: "Browse", href: "/browse" },
    ...(parentCat ? [{ label: parentCat.name, href: `/category/${parentCat.slug}` }] : []),
    { label: currentCat.name },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* ─── Page header ─────────────────────────────────────────────────── */}
      <div className="bg-muted/30 border-b py-10">
        <div className="container mx-auto px-4">
          <PageBreadcrumb crumbs={crumbs} className="mb-3" />
          <div className="flex items-start gap-4">
            {/* Category icon (emoji or uploaded iconImage) */}
            {(currentCat.icon || currentCat.iconImage) && (
              <div className="h-14 w-14 rounded-2xl bg-card border border-border flex items-center justify-center text-2xl shrink-0 overflow-hidden">
                {currentCat.iconImage ? (
                  <img
                    src={currentCat.iconImage}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  currentCat.icon
                )}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h1 className="font-serif text-4xl md:text-5xl font-medium leading-tight">
                {currentCat.name}
              </h1>
              {currentCat.description && (
                <p className="text-muted-foreground mt-2 text-sm max-w-2xl">
                  {currentCat.description}
                </p>
              )}
              {/* Product count — shown once the first page loads */}
              {!productsLoading && (
                <p className="text-xs text-muted-foreground mt-2">
                  {totalProducts} product{totalProducts !== 1 ? "s" : ""} available
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Products grid ───────────────────────────────────────────────── */}
      <div className="container mx-auto px-4 py-8">
        {/* Initial loading state — show skeleton cards in the same 2-col grid */}
        {productsLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-44 rounded-[20px]" />
            ))}
          </div>
        ) : productsError ? (
          // ─── Error state ───────────────────────────────────────────────
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
              <Package className="w-7 h-7 text-destructive" />
            </div>
            <h2 className="font-serif text-xl font-medium mb-2">Couldn't load products</h2>
            <p className="text-sm text-muted-foreground max-w-[360px] mb-6">
              Something went wrong while fetching products for {currentCat.name}. Please try again.
            </p>
            <Button
              variant="outline"
              onClick={() => window.location.reload()}
              className="rounded-full"
            >
              Try again
            </Button>
          </div>
        ) : products.length === 0 ? (
          // ─── Empty state ───────────────────────────────────────────────
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <Trees className="w-7 h-7 text-muted-foreground" />
            </div>
            <h2 className="font-serif text-xl font-medium mb-2">No products yet</h2>
            <p className="text-sm text-muted-foreground max-w-[360px] mb-6">
              Products in {currentCat.name} will appear here once sellers list them. Check back soon!
            </p>
            <Link href="/browse">
              <Button className="rounded-full">Browse other categories</Button>
            </Link>
          </div>
        ) : (
          // ─── Product grid (HomepageProductCard design) ──────────────────
          // Same container classes as the homepage's "Trending / New
          // Arrivals" section: grid-cols-1 on mobile, 2 columns from sm up.
          // The HomepageProductCard component handles image transforms,
          // wishlist, rating, category badge, description, and the
          // growth/care footer — we just pass product + categoryName +
          // backContext.
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              {products.map((product: Product) => (
                <HomepageProductCard
                  key={product.id}
                  product={product}
                  categoryName={categoryNameById.get(product.categoryId)}
                  backContext="category"
                />
              ))}
            </div>

            {/* ─── Infinite scroll sentinel ──────────────────────────────
                A tiny sentinel div at the bottom of the grid. When it
                enters the viewport (user scrolled near the bottom), the
                IntersectionObserver fires loadMore() which calls
                fetchNextPage(). While fetching, show a spinner row. When
                there's no more data, the sentinel is unmounted entirely
                so the observer disconnects. */}
            {hasNextPage && (
              <div
                ref={sentinelRef}
                className="flex items-center justify-center py-10"
                aria-hidden="true"
              >
                {isFetchingNextPage && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading more products...
                  </div>
                )}
              </div>
            )}

            {/* ─── "End of results" footer ────────────────────────────────
                Shown when all pages have been loaded — gives the user a
                clear signal that there's nothing more to scroll for. */}
            {!hasNextPage && products.length > 0 && (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <div className="h-px w-16 bg-border mb-4" />
                <p className="text-xs text-muted-foreground">
                  You've seen all {products.length} product{products.length !== 1 ? "s" : ""} in {currentCat.name}
                </p>
                <Link href="/browse" className="mt-4">
                  <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground">
                    Browse other categories <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
