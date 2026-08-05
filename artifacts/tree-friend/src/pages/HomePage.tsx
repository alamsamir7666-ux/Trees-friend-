import { useRef, useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { ArrowRight, ShieldCheck, Leaf, Truck, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProductCard } from "@/components/ui/ProductCard";
import { HomepageProductCard } from "@/components/ui/HomepageProductCard";
import { ProductCardSkeleton, ProductGridSkeleton } from "@/components/ui/ProductCardSkeleton";
import { useListProducts, useListCategories, getListCategoriesQueryKey } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/apiClient";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageContext } from "@/contexts/PageContext";
import { updateSEO } from "@/lib/seo";
import { InstagramFeed } from "@/components/ui/InstagramFeed";

// Fallback image/background used only when a category has no custom image
// set in the admin panel (see CategoriesTab). Categories are user-defined
// (e.g. "Fruit Trees", "Indoor Plants"), so there is no fixed slug list to
// key off — this is a single neutral default, not a per-category lookup.
const DEFAULT_CATEGORY_IMAGE =
  "https://images.unsplash.com/photo-1518495973542-4542c06a5843?w=600&q=80&fm=webp";
const DEFAULT_CATEGORY_BG = "hsl(var(--secondary))";

function CollectionSliderSkeleton() {
  return (
    <section className="pt-16 pb-8 bg-muted/20">
      <div className="container mx-auto px-4">
        <div className="flex items-end justify-between mb-8">
          <div className="space-y-2">
            <Skeleton className="h-3 w-36 rounded-full" />
            <Skeleton className="h-8 w-52" />
          </div>
        </div>
        <div className="flex gap-4 overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="shrink-0 w-[220px] h-[300px] rounded-2xl" />
          ))}
        </div>
      </div>
    </section>
  );
}

function HomePageSkeleton() {
  return (
    <div className="min-h-screen">

      <CollectionSliderSkeleton />
      <section className="pt-8 pb-16 bg-background">
        <div className="container mx-auto px-4">
          <div className="flex items-end justify-between mb-10">
            <div className="space-y-2">
              <Skeleton className="h-3 w-28 rounded-full" />
              <Skeleton className="h-10 w-56" />
            </div>
          </div>
          <ProductGridSkeleton count={4} />
        </div>
      </section>
    </div>
  );
}

function CollectionSlider() {
  const sliderRef = useRef<HTMLDivElement>(null);
  const { data: dbCategories, isLoading: categoriesLoading } = useListCategories({
    query: { staleTime: 60_000, queryKey: getListCategoriesQueryKey() },
  });

  // Show "leaf" categories as collection cards -- i.e. anything a shopper can
  // click straight into a product list from. That's every subcategory
  // (parentId set, e.g. "Mango" under "Fruit Trees"), PLUS any top-level
  // category that has no subcategories of its own (e.g. "Indoor Plants" with
  // no children -- products are attached directly to it). Top-level
  // categories that DO have subcategories are excluded, since clicking them
  // would need a drill-down step this slider doesn't support.
  const allCats = dbCategories ?? [];
  const categories = allCats.filter((cat) => {
    const parentId = (cat as { parentId?: number | null }).parentId;
    if (parentId != null) return true; // subcategory -- always a leaf
    const hasChildren = allCats.some(
      (c) => (c as { parentId?: number | null }).parentId === cat.id
    );
    return !hasChildren; // top-level category is only a leaf if childless
  });

  if (categoriesLoading) return <CollectionSliderSkeleton />;
  if (!categories.length) return null;

  return (
    <section className="pt-10 pb-8 md:pt-16 md:pb-10 lg:pt-20 lg:pb-12 xl:pt-24 xl:pb-16 bg-muted/20">
      <div className="container mx-auto px-4 md:px-6 lg:px-8 lg:max-w-6xl xl:max-w-7xl">
        <div className="flex items-end justify-between mb-8 lg:mb-10 xl:mb-12">
          <div>
            <p className="text-[11px] uppercase tracking-[0.2em] text-accent-text font-semibold mb-2">Browse by Collection</p>
            <h2 className="font-serif text-3xl md:text-4xl xl:text-5xl font-medium leading-tight">Our Collections</h2>
          </div>
          <div className="hidden lg:flex items-center gap-3 mr-4">
            <Link href="/products" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5">
              View All <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="flex gap-2 lg:gap-3">
            <button
              onClick={() => sliderRef.current?.scrollBy({ left: -280, behavior: "smooth" })}
              aria-label="Scroll collections left"
              className="h-9 w-9 lg:h-11 lg:w-11 rounded-full border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-foreground hover:shadow-md transition-all"
            >
              <ChevronLeft className="h-4 w-4 lg:h-5 lg:w-5" />
            </button>
            <button
              onClick={() => sliderRef.current?.scrollBy({ left: 280, behavior: "smooth" })}
              aria-label="Scroll collections right"
              className="h-9 w-9 lg:h-11 lg:w-11 rounded-full border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-foreground hover:shadow-md transition-all"
            >
              <ChevronRight className="h-4 w-4 lg:h-5 lg:w-5" />
            </button>
          </div>
        </div>

        <div
          ref={sliderRef}
          className="flex gap-4 lg:gap-5 xl:gap-6 overflow-x-auto pb-2 scrollbar-hide snap-x snap-mandatory"
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
        >
          {categories.map((cat, idx) => {
            const img = (cat as any).image || DEFAULT_CATEGORY_IMAGE;
            const bg = DEFAULT_CATEGORY_BG;
            return (
              <Link key={cat.slug} href={`/products?category=${cat.slug}`}>
                <div
                  className="group relative shrink-0 w-[200px] sm:w-[220px] md:w-[240px] lg:w-[260px] xl:w-[300px] h-[280px] sm:h-[300px] md:h-[320px] lg:h-[340px] xl:h-[380px] rounded-2xl overflow-hidden cursor-pointer snap-start shadow-md hover:shadow-xl transition-shadow duration-300 card-hover-desktop"
                  style={{ background: bg }}
                >
                  <img
                    src={img}
                    alt={cat.name}
                    className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                    fetchPriority={idx === 0 ? "high" : undefined}
                    loading={idx === 0 ? "eager" : "lazy"}
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-foreground/70 via-foreground/10 to-transparent" />
                  {((cat as { icon?: string; iconImage?: string }).icon || (cat as { icon?: string; iconImage?: string }).iconImage) && (
                    <div className="absolute bottom-16 right-4 h-10 w-10 lg:h-12 lg:w-12 rounded-full flex items-center justify-center text-lg bg-card/90 backdrop-blur-sm shadow-md overflow-hidden">
                      {(cat as { iconImage?: string }).iconImage ? (
                        <img src={(cat as { iconImage?: string }).iconImage} alt="" className="h-full w-full object-cover" />
                      ) : (
                        (cat as { icon?: string }).icon
                      )}
                    </div>
                  )}
                  <div className="absolute bottom-4 left-4 right-4 lg:bottom-5 lg:left-5 lg:right-5 text-background">
                    <p className="text-[10px] uppercase tracking-[0.15em] mb-1 opacity-70">Collection</p>
                    <h3 className="font-serif text-lg xl:text-xl font-medium leading-snug mb-1.5">{cat.name}</h3>
                    <span className="text-xs opacity-80 flex items-center gap-1 group-hover:gap-2.5 transition-all duration-300">
                      Shop now <ArrowRight className="h-3 w-3" />
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}

const PAGE_SIZE = 4;

// Maximum products shown per homepage section before the "View all" link
const MAX_FEATURED_PRODUCTS = 4;
const MAX_CATEGORY_PRODUCTS = 8;

type HomeSection = { id: number; key: string; label: string };

export function HomePage() {
  // ── All hooks first — no early returns before this block ─────────────────
  const [activeTab, setActiveTab] = useState<"trending" | "new_arrivals">("trending");
  const [bestTab, setBestTab] = useState("");
  const [heroSearch, setHeroSearch] = useState("");
  const { setPageReady } = usePageContext();
  const [, navigate] = useLocation();

  const { data: trendingData,   isLoading: trendingLoading }   = useListProducts({ homepageTag: "trending",     limit: 22 });
  const { data: newArrivalsData, isLoading: newArrivalsLoading } = useListProducts({ homepageTag: "new_arrivals", limit: 22 });

  // Product cards on the homepage show a category badge (e.g. "Fruit
  // Trees"), but Product only carries categoryId, not a name -- so we fetch
  // the category list once here and look names up by id.
  const { data: cardCategories = [] } = useListCategories({
    query: { staleTime: 60_000, queryKey: getListCategoriesQueryKey() },
  });
  const categoryNameById = new Map<number, string>(
    cardCategories.map((c: { id: number; name: string }) => [c.id, c.name])
  );

  const { data: homepageSections = [] as HomeSection[], isLoading: sectionsLoading } = useQuery({
    queryKey: ["homepage-sections"],
    queryFn: async (): Promise<HomeSection[]> => {
      const { data } = await apiClient.get<HomeSection[]>("/api/homepage-sections");
      return data;
    },
    staleTime: 60_000,
  });

  const { data: activeBestData, isLoading: activeBestLoading } = useQuery({
    queryKey: ["products", "homepage", bestTab],
    queryFn: async (): Promise<{ products: any[] }> => {
      const { data } = await apiClient.get<{ products: any[] }>("/api/products", { params: { homepageTag: bestTab, limit: 15 } });
      return data;
    },
    enabled: !!bestTab,
    staleTime: 30_000,
  });

  const featuredLoading = trendingLoading || newArrivalsLoading;

  useEffect(() => {
    updateSEO();
  }, []);

  useEffect(() => {
    setPageReady(!featuredLoading);
  }, [featuredLoading, setPageReady]);

  // Auto-select first tab when sections load
  useEffect(() => {
    if (!sectionsLoading && homepageSections.length > 0 && bestTab === "") {
      setBestTab(homepageSections[0].key);
    }
  }, [sectionsLoading, homepageSections, bestTab]);

  // ── Derived values (after all hooks) ─────────────────────────────────────
  if (featuredLoading) return <HomePageSkeleton />;

  const trendingProducts   = trendingData?.products   ?? [];
  const newArrivalsProducts = newArrivalsData?.products ?? [];
  const activeProducts     = activeTab === "trending" ? trendingProducts : newArrivalsProducts;

  const BEST_TABS   = homepageSections;
  const bestProducts = activeBestData?.products ?? [];
  const bestLoading  = activeBestLoading;

  return (
    <div className="min-h-screen">
      {/* Hero */}
      <section className="relative overflow-hidden pt-4 pb-4 md:pt-8 md:pb-8 lg:pt-12 lg:pb-12 bg-background">
        <div className="absolute inset-0 flex items-start justify-end pr-2 md:pr-12 lg:pr-24 xl:pr-32 pointer-events-none">
          <img
            src="https://res.cloudinary.com/dcfbtdp6r/image/upload/v1783747272/IMG_20260711_111454-removebg-preview_11zon_wsnwgd.png"
            alt="Potted tree sapling"
            className="h-full max-h-[340px] md:max-h-[420px] lg:max-h-[520px] xl:max-h-[580px] w-auto object-contain opacity-90"
            fetchPriority="high"
            loading="eager"
            decoding="sync"
          />
        </div>
        <div className="absolute inset-0 bg-gradient-to-r from-background via-background/85 to-background/10" />
        <div className="container mx-auto px-4 md:px-6 lg:px-8 relative z-10 max-w-6xl">
          <div className="max-w-lg md:max-w-xl lg:max-w-2xl xl:max-w-3xl w-full py-2 lg:py-12 xl:py-20">
            <h1 className="font-serif text-5xl md:text-6xl lg:text-7xl xl:text-8xl font-medium leading-[0.95] mb-0 text-primary xl:tracking-[0.03em]">
              Grow with
              <br />
              <em className="text-accent-text not-italic">nature.</em>
            </h1>
            <div className="mt-5 lg:mt-7 flex items-center gap-3">
              <img src="https://res.cloudinary.com/dcfbtdp6r/image/upload/v1783747272/IMG_20260710_161008-removebg-preview_11zon_ieoekc.png" alt="" className="h-6 w-6 lg:h-7 lg:w-7 object-contain" />
              <span className="h-px w-12 lg:w-20 bg-accent-text/40" />
              <span className="hidden lg:inline text-[10px] uppercase tracking-[0.2em] text-accent-text/70 font-medium">Est. 2024</span>
              <span className="hidden lg:inline h-px w-8 bg-accent-text/20" />
            </div>
            <p className="mt-3 text-base md:text-lg lg:text-lg xl:text-xl text-muted-foreground max-w-md lg:max-w-lg">
              Discover trees that enhance life and a greener tomorrow.
            </p>
            <div className="mt-6">
              <Link
                href="/browse"
                className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-7 md:px-8 lg:px-10 xl:px-12 py-3 md:py-3.5 lg:py-4 rounded-full text-sm lg:text-base font-medium tracking-wide lg:tracking-wider hover:bg-accent hover:text-accent-foreground hover:shadow-lg hover:shadow-accent/20 transition-all duration-200"
              >
                Browse All Trees
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Collection Cards Slider */}
      <CollectionSlider />

      {/* Trending / New Arrivals Section */}
      <section className="pt-10 pb-12 md:pt-14 md:pb-16 lg:pt-16 lg:pb-20 xl:pt-24 xl:pb-28 bg-background">
        <div className="container mx-auto px-4 md:px-6 lg:px-8 lg:max-w-6xl xl:max-w-7xl">
          {/* Section header: label + title + subtitle + tabs in one composed block */}
          <div className="mb-10 lg:mb-12 xl:mb-14">
            <div className="flex items-end justify-between mb-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.2em] text-accent-text font-semibold mb-2">{activeTab === "trending" ? "Trending Now" : "New Arrivals"}</p>
                <h2 className="font-serif text-3xl md:text-4xl xl:text-5xl font-medium leading-tight">{activeTab === "trending" ? "Discover Your Green Paradise" : "Fresh Off the Nursery"}</h2>
              </div>
              <Link href="/products">
                <Button variant="ghost" className="text-muted-foreground hover:text-foreground text-sm lg:text-base gap-1 shrink-0">
                  View all <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
            <p className="text-muted-foreground text-sm lg:text-base max-w-md lg:max-w-lg mb-6">
              {activeTab === "trending" ? "Explore the most loved trees and plants for a healthier, greener tomorrow." : "Be the first to discover our newest arrivals — fresh from the nursery to your doorstep."}
            </p>

            {/* Tabs — pill group with border ring */}
            <div className="inline-flex items-center rounded-full border border-border bg-muted/40 p-1 lg:p-1.5 gap-1 lg:gap-1.5">
              <button
                onClick={() => setActiveTab("trending")}
                className={`px-5 py-2 lg:px-7 lg:py-2.5 rounded-full text-sm lg:text-base font-medium transition-all duration-200 ${activeTab === "trending" ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-muted/60"}`}
              >Trending</button>
              <button
                onClick={() => setActiveTab("new_arrivals")}
                className={`px-5 py-2 lg:px-7 lg:py-2.5 rounded-full text-sm lg:text-base font-medium transition-all duration-200 ${activeTab === "new_arrivals" ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-muted/60"}`}
              >New Arrivals</button>
            </div>
          </div>

          {activeProducts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <div className="h-20 w-20 rounded-full bg-muted/60 flex items-center justify-center">
                <Leaf className="h-9 w-9 text-muted-foreground/60" />
              </div>
              <div className="text-center max-w-xs">
                <p className="text-foreground font-semibold text-base mb-1">{activeTab === "trending" ? "No trending products yet" : "No new arrivals yet"}</p>
                <p className="text-muted-foreground text-sm leading-relaxed">{activeTab === "trending" ? "We're picking the best for you. Check back soon or browse our full collection." : "We're adding fresh stock soon. In the meantime, explore what's trending!"}</p>
              </div>
              <Link href="/products">
                <Button variant="outline" className="mt-1 rounded-full text-sm gap-1.5">
                  Browse all products <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-5 lg:gap-6 xl:gap-7">
              {activeProducts.slice(0, MAX_FEATURED_PRODUCTS).map((product) => (
                <HomepageProductCard
                  key={product.id}
                  product={product as any}
                  categoryName={categoryNameById.get((product as any).categoryId)}
                  backContext="featured"
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Best Plants & Trees by Category */}
      <section className="py-10 md:py-14 lg:py-16 xl:py-20 bg-muted/10 border-t">
        <div className="container mx-auto px-4 md:px-6 lg:px-8 lg:max-w-6xl xl:max-w-7xl">
          <div className="mb-10 lg:mb-12 xl:mb-14">
            <div className="flex items-end justify-between mb-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.2em] text-accent-text font-semibold mb-2">Based On Category</p>
                <h2 className="font-serif text-3xl md:text-4xl xl:text-5xl font-medium leading-tight">Best Plants &amp; Trees</h2>
              </div>
              <Link href="/products">
                <Button variant="ghost" className="text-muted-foreground hover:text-foreground text-sm lg:text-base gap-1 shrink-0">
                  View all <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>

            {/* Category tabs — scrollable on mobile, pill group style */}
            {sectionsLoading ? (
              <div className="flex gap-2 mt-2 mb-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-9 w-28 rounded-full bg-muted animate-pulse" />
                ))}
              </div>
            ) : BEST_TABS.length === 0 ? null : (
              <div className="flex items-center rounded-full border border-border bg-muted/40 p-1 lg:p-1.5 gap-1 lg:gap-1.5 mt-2 overflow-x-auto max-w-full lg:flex-wrap" style={{ scrollbarWidth: "none" }}>
                {BEST_TABS.map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setBestTab(tab.key)}
                    className={`px-5 py-2 lg:px-6 lg:py-2.5 rounded-full text-sm lg:text-base font-medium transition-all duration-200 whitespace-nowrap ${bestTab === tab.key ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-muted/60"}`}
                  >{tab.label}</button>
                ))}
              </div>
            )}
          </div>

          {sectionsLoading || bestLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 lg:gap-5 xl:gap-6">
              {Array.from({ length: 8 }).map((_, i) => <ProductCardSkeleton key={i} />)}
            </div>
          ) : BEST_TABS.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div className="h-20 w-20 rounded-full bg-muted/60 flex items-center justify-center">
                <Leaf className="h-9 w-9 text-muted-foreground/60" />
              </div>
              <p className="text-foreground font-medium text-base">No sections created yet.</p>
              <p className="text-muted-foreground text-sm">Go to Admin → Homepage Sections to add tabs.</p>
            </div>
          ) : bestProducts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <div className="h-20 w-20 rounded-full bg-muted/60 flex items-center justify-center">
                <Leaf className="h-9 w-9 text-muted-foreground/60" />
              </div>
              <div className="text-center max-w-xs">
                <p className="text-foreground font-semibold text-base mb-1">No products in this category yet</p>
                <p className="text-muted-foreground text-sm leading-relaxed">We're restocking this section. Try browsing a different category or check our full collection.</p>
              </div>
              <Link href="/products">
                <Button variant="outline" className="mt-1 rounded-full text-sm gap-1.5">
                  Browse all products <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 lg:gap-5 xl:gap-6">
              {bestProducts.slice(0, MAX_CATEGORY_PRODUCTS).map(product => (
                <ProductCard
                  key={product.id}
                  product={product as any}
                  backContext="category"
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Why Choose Us */}
      <section className="py-12 md:py-16 lg:py-20 xl:py-24 bg-background border-t relative overflow-hidden">
        {/* Subtle decorative background on desktop */}
        <div className="hidden lg:block absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-accent/3 rounded-full blur-3xl" />
          <div className="absolute bottom-0 right-1/4 w-80 h-80 bg-primary/3 rounded-full blur-3xl" />
        </div>
        <div className="container mx-auto px-4 md:px-6 lg:px-8 lg:max-w-6xl xl:max-w-7xl relative z-10">
          <div className="text-center mb-10 md:mb-14 lg:mb-16">
            <p className="text-[11px] uppercase tracking-[0.2em] text-accent-text font-semibold mb-3">Why Choose Us</p>
            <h2 className="font-serif text-3xl md:text-4xl xl:text-5xl font-medium">Our Promise to You</h2>
            <span className="hidden lg:inline-block mt-4 h-px w-16 bg-accent-text/30" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6 lg:gap-8 xl:gap-10 max-w-5xl lg:max-w-5xl xl:max-w-6xl mx-auto">
            {[
              {
                icon: Leaf,
                title: "Premium Quality Plants",
                desc: "Every plant is carefully selected from trusted nurseries and checked for health, quality, and authenticity before reaching your hands.",
              },
              {
                icon: ShieldCheck,
                title: "Fair & Transparent Pricing",
                desc: "No hidden charges, no gimmicks. We offer fair prices so you get the best value for your money — always.",
              },
              {
                icon: Truck,
                title: "Safe & Fast Delivery",
                desc: "We pack with care and deliver to your doorstep safely and on time. Your plant's safety is our promise.",
              },
            ].map(({ icon: Icon, title, desc }) => (
              <div key={title} className="flex flex-col items-center text-center gap-4 px-4 py-6 lg:px-8 lg:py-10 xl:px-10 xl:py-12 rounded-2xl bg-card border border-border/60 hover:shadow-md lg:hover:shadow-xl lg:hover:-translate-y-1 transition-all duration-300">
                <div className="h-14 w-14 lg:h-18 lg:w-18 xl:h-20 xl:w-20 rounded-2xl bg-accent/10 flex items-center justify-center shrink-0">
                  <Icon className="h-6 w-6 lg:h-7 lg:w-7 xl:h-8 xl:w-8 text-accent" />
                </div>
                <h3 className="font-serif text-xl lg:text-2xl font-medium">{title}</h3>
                <p className="text-muted-foreground text-sm lg:text-base leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Instagram Feed */}
      <InstagramFeed />
    </div>
  );
}
