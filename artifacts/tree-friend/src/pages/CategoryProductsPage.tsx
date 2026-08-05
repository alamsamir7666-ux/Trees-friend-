import { useEffect, useMemo, useRef } from "react";
import { Link, useParams } from "wouter";
import { Trees, Loader2, ArrowRight, Package, Sprout } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { HomepageProductCard } from "@/components/ui/HomepageProductCard";
import {
  useListCategories,
  getListCategoriesQueryKey,
  listProducts,
  type Category,
  type Product,
} from "@workspace/api-client-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { updateSEO } from "@/lib/seo";

// Page size for the product list's infinite scroll (leaf category view --
// e.g. "Mango Tree" showing its varieties as product cards). 12 fits a
// 2-column grid (6 rows) without overwhelming the initial load.
const PRODUCT_PAGE_SIZE = 12;

const DEFAULT_CATEGORY_IMAGE =
  "https://images.unsplash.com/photo-1518495973542-4542c06a5843?w=600&q=80&fm=webp";

type CategoryWithMeta = Category & {
  parentId?: number | null;
  image?: string | null;
  iconImage?: string | null;
  icon?: string | null;
  description?: string | null;
};


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

  // ── Product list for this leaf category (e.g. Mango Tree's varieties) ───
  // This is the primary view for a leaf category: browse the species/
  // varieties as product cards (name, rating, growth/care, description),
  // each linking through to its product detail page. Seller listings for a
  // specific variety live one click further in, on that detail page.
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
      listProducts({ category: slug, limit: PRODUCT_PAGE_SIZE, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.totalPages > lastPage.page ? lastPage.page + 1 : undefined,
    enabled: !!slug && !categoriesLoading && !isParentCategory,
    staleTime: 60_000,
  });

  const products = useMemo(
    () => productsData?.pages.flatMap((p) => p.products) ?? [],
    [productsData],
  );
  const totalProducts = productsData?.pages[0]?.total ?? 0;

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isFetchingNextPage) fetchNextPage();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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
        <div className="bg-muted/30 border-b py-6 md:py-8 lg:py-10">
          <div className="container mx-auto px-4 md:px-6 lg:px-8 max-w-6xl">
            <Skeleton className="h-3 w-48 rounded-full mb-3" />
            <Skeleton className="h-10 w-64 mb-2" />
            <Skeleton className="h-4 w-96" />
          </div>
        </div>
        <div className="container mx-auto px-4 md:px-6 lg:px-8 py-6 md:py-8 lg:py-10 max-w-6xl">
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
    <div className="min-h-screen bg-background">
      {/* Page header */}
      <div className="bg-muted/30 border-b py-6 md:py-8 lg:py-10">
        <div className="container mx-auto px-4 md:px-6 lg:px-8 max-w-6xl">
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
      <div className="container mx-auto px-4 md:px-6 lg:px-8 py-6 md:py-8 lg:py-10 max-w-6xl">
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
        ) : productsLoading ? (
          // ── Loading skeletons ────────────────────────────────────────────
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[160px] rounded-[20px]" />
            ))}
          </div>
        ) : productsError ? (
          // ── Error state ──────────────────────────────────────────────────
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
              <Package className="w-7 h-7 text-destructive" />
            </div>
            <h2 className="font-serif text-xl font-medium mb-2">Couldn't load products</h2>
            <p className="text-sm text-muted-foreground max-w-[360px] mb-6">
              Something went wrong while fetching products for {currentCat.name}. Please try again.
            </p>
            <Button variant="outline" onClick={() => window.location.reload()} className="rounded-full">
              Try again
            </Button>
          </div>
        ) : products.length === 0 ? (
          // ── Empty state ──────────────────────────────────────────────────
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <Trees className="w-7 h-7 text-muted-foreground" />
            </div>
            <h2 className="font-serif text-xl font-medium mb-2">No products yet</h2>
            <p className="text-sm text-muted-foreground max-w-[360px] mb-6">
              Products in {currentCat.name} will appear here once sellers list them. Check back soon!
            </p>
            <Link href="/browse"><Button className="rounded-full">Browse other categories</Button></Link>
          </div>
        ) : (
          // ── Product grid (species / varieties in this leaf category) ────
          <>
            <div className="mb-6 flex items-center gap-2">
              <Sprout className="w-4 h-4 text-accent shrink-0" />
              <p className="text-sm text-muted-foreground">
                {totalProducts} product{totalProducts !== 1 ? "s" : ""} available
              </p>
            </div>

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

            {/* Infinite scroll sentinel */}
            {hasNextPage && (
              <div ref={sentinelRef} className="flex items-center justify-center py-10" aria-hidden="true">
                {isFetchingNextPage && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading more products...
                  </div>
                )}
              </div>
            )}

            {/* End of results */}
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
