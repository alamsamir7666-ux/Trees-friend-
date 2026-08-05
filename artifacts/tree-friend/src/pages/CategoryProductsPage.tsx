import { useEffect, useMemo, useCallback } from "react";
import { Link, useParams } from "wouter";
import { Trees, Loader2, ArrowRight, Package, Sprout } from "lucide-react";
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

// Same fallback image used on the browse page and homepage — keeps the
// category cards visually consistent when a category has no custom image.
const DEFAULT_CATEGORY_IMAGE =
  "https://images.unsplash.com/photo-1518495973542-4542c06a5843?w=600&q=80&fm=webp";

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

// ─── Wide subcategory card (vertical 1-column layout) ─────────────────────
// When the user lands on a PARENT category (e.g. "Fruit Trees" which has
// Mango + Banana as subcategories), we show subcategory cards instead of
// products. This card is a horizontal layout (image left, info right) —
// wider than the browse page's portrait carousel cards, suitable for a
// 1-column vertical stack. Visual style matches the HomepageProductCard
// aesthetic so the page feels cohesive if the user navigates from a
// subcategory (products view) to a parent (subcategories view).

function SubcategoryCardWide({ cat }: { cat: CategoryWithMeta }) {
  const img = cat.image || DEFAULT_CATEGORY_IMAGE;
  return (
    <Link
      href={`/category/${cat.slug}`}
      className="group block bg-card border border-border rounded-[20px] p-4 sm:p-5 shadow-[0_4px_20px_rgba(0,0,0,0.08)] hover:shadow-lg transition-shadow cursor-pointer overflow-hidden"
    >
      <div className="flex gap-4 items-center">
        {/* Image — 96px square, rounded, shrink-0 */}
        <div className="shrink-0 h-24 w-24 sm:h-28 sm:w-28 rounded-xl overflow-hidden bg-muted/30">
          <img
            src={img}
            alt={cat.name}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
          />
        </div>

        {/* Info — flex-1, min-w-0 for truncation */}
        <div className="flex-1 min-w-0">
          <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground mb-1">
            Subcategory
          </p>
          <h3 className="font-serif text-lg sm:text-xl font-medium leading-snug truncate mb-1">
            {cat.name}
          </h3>
          {cat.description && (
            <p className="text-[13px] text-muted-foreground line-clamp-2 mb-2">
              {cat.description}
            </p>
          )}
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent">
            Shop now
            <ArrowRight className="h-3 w-3 group-hover:translate-x-1 transition-transform" />
          </span>
        </div>

        {/* Icon badge (emoji or uploaded iconImage) — top-right of the info area */}
        {(cat.icon || cat.iconImage) && (
          <div className="shrink-0 h-10 w-10 rounded-full flex items-center justify-center text-lg bg-success/10 border border-success/20 overflow-hidden">
            {cat.iconImage ? (
              <img src={cat.iconImage} alt="" className="h-full w-full object-cover" />
            ) : (
              cat.icon
            )}
          </div>
        )}
      </div>
    </Link>
  );
}

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

  // ─── Subcategory detection ──────────────────────────────────────────────
  // If the current category is a PARENT (i.e. it has subcategories — e.g.
  // "Fruit Trees" with Mango + Banana as children), we show subcategory
  // cards instead of trying to fetch products. Products are attached to
  // subcategories, not parents, so querying products with the parent's
  // slug would always return 0 results (the bug the user reported).
  //
  // This mirrors the buildCategoryTree logic in BrowseAllTreesPage: a
  // category is a "parent" if any other category has parentId === its id.
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
    // Don't fire the query until we've confirmed the slug exists AND the
    // current category is a leaf (no subcategories). Parent categories
    // have no products directly attached — querying them would always
    // return 0 results (the bug the user reported on the Fruit Trees
    // page). We also defer until categories have loaded so `isParentCategory`
    // is computed correctly before the enabled check.
    enabled: !!slug && !categoriesLoading && !isParentCategory,
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
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[160px] rounded-[20px]" />
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
              {/* Count — subcategory count for parents, product count for leaves */}
              {isParentCategory ? (
                <p className="text-xs text-muted-foreground mt-2">
                  {subcategories.length} subcategor{subcategories.length === 1 ? "y" : "ies"}
                </p>
              ) : (
                !productsLoading && (
                  <p className="text-xs text-muted-foreground mt-2">
                    {totalProducts} product{totalProducts !== 1 ? "s" : ""} available
                  </p>
                )
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Body: subcategories (parent category) OR products (leaf) ─────── */}
      <div className="container mx-auto px-4 py-8">
        {isParentCategory ? (
          // ─── Parent category: show subcategory cards vertically ──────────
          // Per the user's request: "show subcategories card vertically 1
          // column 2 cards". This renders the subcategories of the current
          // parent category as wide horizontal cards in a single-column
          // grid. Each card links to /category/:slug (which will then show
          // products since the subcategory is a leaf).
          //
          // The max-w-2xl keeps the column readable on desktop — without
          // it, a single card would stretch too wide on large screens.
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
        ) : productsLoading ? (
          /* Initial loading state — skeleton cards matching the 2-col grid */
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[160px] rounded-[20px]" />
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
          // ─── Product grid (horizontal HomepageProductCard design) ──────────
          // Uses the HomepageProductCard component (horizontal card: image
          // on left, name + scientific name + category badge + rating +
          // description + growth/care metrics on right). Same card design
          // as the homepage's "Trending / New Arrivals" section.
          //
          // Grid: 1 col on mobile, 2 from sm — matches the homepage's
          // HomepageProductCard grid density.
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              {products.map((product: Product) => (
                <HomepageProductCard
                  key={product.id}
                  product={product}
                  categoryName={currentCat?.name}
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
