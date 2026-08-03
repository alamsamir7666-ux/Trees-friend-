import { useRef, useEffect, useMemo } from "react";
import { Link } from "wouter";
import { ChevronLeft, ChevronRight, ArrowRight, Trees } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ProductCard } from "@/components/ui/ProductCard";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import {
  useListCategories,
  useListProducts,
  getListCategoriesQueryKey,
  getListProductsQueryKey,
  type Category,
  type Product,
} from "@workspace/api-client-react";
import { updateSEO } from "@/lib/seo";

// Same fallback image used on the homepage's CollectionSlider — keeps the
// browse page visually consistent with the homepage when a category has no
// custom image set in the admin panel.
const DEFAULT_CATEGORY_IMAGE =
  "https://images.unsplash.com/photo-1518495973542-4542c06a5843?w=600&q=80&fm=webp";
const DEFAULT_CATEGORY_BG = "hsl(var(--secondary))";

// Max products to fetch per top-level category (when it has no subcategories
// and we show products directly). 10 is plenty for a "browse" preview — the
// user can click through to /products?category=... for the full list.
const PRODUCTS_PER_CATEGORY = 10;

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
 *
 * Matches the linking pattern in ProductsPage.tsx:367-369 and Navbar.tsx:97.
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

// ─── Horizontal slider with chevron buttons ───────────────────────────────
// Reuses the exact pattern from HomePage.CollectionSlider: a ref + scrollBy
// + scrollbar-hide + snap-x. The shadcn Embla Carousel component exists but
// isn't used anywhere in production code, so we stick with the established
// hand-rolled pattern for consistency.

function HorizontalSlider({ children }: { children: React.ReactNode }) {
  const sliderRef = useRef<HTMLDivElement>(null);
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

  // ─── Fetch products for this category ──────────────────────────────────
  // Only fetched when the category has NO subcategories — in that case we
  // show product cards directly under the category name (per the user's
  // spec: "for the category that does not have subcategories, there will
  // be products in the form of cards below the category name").
  //
  // When the category DOES have subcategories, we skip the product fetch
  // entirely (the subcategory cards are the content).
  //
  // The slug param is the comma-joined slugs of all subcategories — this
  // is the same multi-slug pattern ProductsPage.tsx uses for its "All"
  // pill, and the API supports it natively (inArray lookup on slug).
  const slugParam = useMemo(
    () => buildCategorySlugParam(category, subcategories),
    [category, subcategories],
  );

  const { data: productsData, isLoading: productsLoading } = useListProducts(
    // Only query when no subcategories. Passing undefined as params when
    // disabled would still fire the query, so we use the `enabled` option
    // via the query config object.
    { category: hasSubs ? undefined : slugParam, limit: PRODUCTS_PER_CATEGORY },
    {
      query: {
        enabled: !hasSubs,
        staleTime: 60_000,
        queryKey: getListProductsQueryKey({
          category: hasSubs ? undefined : slugParam,
          limit: PRODUCTS_PER_CATEGORY,
        }),
      },
    },
  );

  const products = (productsData?.products ?? []) as Product[];

  // ─── "View all" link ───────────────────────────────────────────────────
  // Points to the existing /products page with the category filter applied.
  // For a parent with subs, the slug param is the comma-joined subcategory
  // slugs (shows all products across all subs). For a leaf parent, it's
  // just the parent's own slug.
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
        <HorizontalSlider>
          {subcategories.map((sub) => (
            <SubcategoryCard key={sub.id} cat={sub} />
          ))}
        </HorizontalSlider>
      ) : (
        // ─── Products grid (no subcategories) ────────────────────────────
        // Uses a horizontal slider too, to match the user's spec ("products
        // in the form of cards below the category name") and keep the page
        // visually consistent — every section scrolls horizontally. The
        // ProductCard component is the same one used on the homepage and
        // products page.
        <>
          {productsLoading ? (
            <HorizontalSlider>
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="shrink-0 w-[220px] h-[300px] rounded-2xl bg-muted/40 animate-pulse"
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
            <HorizontalSlider>
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
