import { useRef, useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { ArrowRight, ShieldCheck, Leaf, Truck, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProductCard } from "@/components/ui/ProductCard";
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
    <section className="pt-16 pb-8 bg-muted/20">
      <div className="container mx-auto px-4">
        <div className="flex items-end justify-between mb-8">
          <div>
            <p className="text-xs uppercase tracking-[0.15em] text-accent-text mb-2 font-medium">Browse by Collection</p>
            <h2 className="font-serif text-3xl font-medium">Our Collections</h2>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => sliderRef.current?.scrollBy({ left: -280, behavior: "smooth" })}
              aria-label="Scroll collections left"
              className="h-9 w-9 rounded-full border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => sliderRef.current?.scrollBy({ left: 280, behavior: "smooth" })}
              aria-label="Scroll collections right"
              className="h-9 w-9 rounded-full border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div
          ref={sliderRef}
          className="flex gap-4 overflow-x-auto pb-2 scrollbar-hide snap-x snap-mandatory"
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
        >
          {categories.map((cat, idx) => {
            const img = (cat as any).image || DEFAULT_CATEGORY_IMAGE;
            const bg = DEFAULT_CATEGORY_BG;
            return (
              <Link key={cat.slug} href={`/products?category=${cat.slug}`}>
                <div
                  className="group relative shrink-0 w-[220px] h-[300px] rounded-2xl overflow-hidden cursor-pointer snap-start"
                  style={{ background: bg }}
                >
                  <img
                    src={img}
                    alt={cat.name}
                    className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                    fetchPriority={idx === 0 ? "high" : undefined}
                    loading={idx === 0 ? "eager" : "lazy"}
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-foreground/60 via-transparent to-transparent" />
                  {((cat as { icon?: string; iconImage?: string }).icon || (cat as { icon?: string; iconImage?: string }).iconImage) && (
                    <div className="absolute bottom-9 right-5 h-12 w-12 rounded-full flex items-center justify-center text-2xl bg-secondary shadow-md overflow-hidden">
                      {(cat as { iconImage?: string }).iconImage ? (
                        <img src={(cat as { iconImage?: string }).iconImage} alt="" className="h-full w-full object-cover" />
                      ) : (
                        (cat as { icon?: string }).icon
                      )}
                    </div>
                  )}
                  <div className="absolute bottom-5 left-5 text-white">
                    <p className="text-xs uppercase tracking-[0.12em] mb-1 opacity-80">Collection</p>
                    <h3 className="font-serif text-xl font-medium mb-2">{cat.name}</h3>
                    <span className="text-xs opacity-90 flex items-center gap-1.5 group-hover:gap-3 transition-all">
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

type HomeSection = { id: number; key: string; label: string };

export function HomePage() {
  // ── All hooks first — no early returns before this block ─────────────────
  const [activeTab, setActiveTab] = useState<"trending" | "new_arrivals">("trending");
  const [bestTab, setBestTab] = useState("");
  const [heroSearch, setHeroSearch] = useState("");
  const { setPageReady } = usePageContext();
  const [, navigate] = useLocation();

  const { data: trendingData,   isLoading: trendingLoading }   = useListProducts({ homepageTag: "trending",     limit: 22 } as any);
  const { data: newArrivalsData, isLoading: newArrivalsLoading } = useListProducts({ homepageTag: "new_arrivals", limit: 22 } as any);

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
      <section className="relative overflow-hidden pt-4 pb-4 bg-background">
        <div className="absolute inset-0 flex items-start justify-end pr-2 lg:pr-16 pointer-events-none">
          <img
            src="https://res.cloudinary.com/dcfbtdp6r/image/upload/v1783747272/IMG_20260711_111454-removebg-preview_11zon_wsnwgd.png"
            alt="Potted tree sapling"
            className="h-full max-h-[380px] lg:max-h-[480px] w-auto object-contain opacity-90"
            fetchPriority="high"
            loading="eager"
            decoding="sync"
          />
        </div>
        <div className="absolute inset-0 bg-gradient-to-r from-background via-background/85 to-background/10" />
        <div className="container mx-auto px-4 relative z-10">
          <div className="max-w-xl w-full py-2 lg:py-10">
            <h1 className="font-serif text-6xl md:text-7xl lg:text-8xl font-medium leading-[0.95] mb-0 text-primary">
              Grow with
              <br />
              <em className="text-accent-text not-italic">nature.</em>
            </h1>
            <div className="mt-5 flex items-center gap-3">
              <img src="https://res.cloudinary.com/dcfbtdp6r/image/upload/v1783747272/IMG_20260710_161008-removebg-preview_11zon_ieoekc.png" alt="" className="h-6 w-6 object-contain" />
              <span className="h-px w-12 bg-accent-text/40" />
            </div>
            <p className="mt-3 text-lg text-muted-foreground max-w-md">
              Discover trees that enhance life and a greener tomorrow.
            </p>
            <div className="mt-6">
              <a
                href="/products"
                className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-8 py-3.5 rounded-full text-sm font-medium tracking-wide hover:bg-accent hover:text-accent-foreground transition-colors duration-200"
              >
                Browse All Trees
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Collection Cards Slider */}
      <CollectionSlider />

      {/* Trending / New Arrivals Section */}
      <section className="pt-10 pb-16 bg-background">
        <div className="container mx-auto px-4">
          {/* Top label + View all */}
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs uppercase tracking-[0.18em] text-accent-text font-semibold">Trending Now</p>
            <Link href="/products">
              <Button variant="ghost" className="text-muted-foreground hover:text-foreground text-sm">
                View all <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
          </div>

          {/* Title + subtitle */}
          <h2 className="font-serif text-3xl md:text-4xl font-medium mb-2">Discover Your Green Paradise</h2>
          <p className="text-muted-foreground text-sm mb-7 max-w-lg">
            Explore the most loved trees and plants for a healthier, greener tomorrow.
          </p>

          {/* Tabs */}
          <div className="flex gap-2 mb-8">
            <button
              onClick={() => setActiveTab("trending")}
              className={`px-5 py-2 rounded-full text-sm font-medium transition-colors ${activeTab === "trending" ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground"}`}
            >Trending</button>
            <button
              onClick={() => setActiveTab("new_arrivals")}
              className={`px-5 py-2 rounded-full text-sm font-medium transition-colors ${activeTab === "new_arrivals" ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground"}`}
            >New Arrivals</button>
          </div>

          {activeProducts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <span className="text-5xl">🌱</span>
              <p className="text-foreground font-medium text-base">No products here yet.</p>
              <p className="text-muted-foreground text-sm">Check back soon for exciting new arrivals.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
              {activeProducts.map((product) => (
                <ProductCard key={product.id} product={product as any} backContext="featured" />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Best Plants & Trees by Category */}
      <section className="py-16 bg-muted/10 border-t">
        <div className="container mx-auto px-4">
          <div className="flex items-end justify-between mb-2">
            <div>
              <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground font-medium mb-1">Based On Category</p>
              <h2 className="font-serif text-3xl font-medium">Best Plants &amp; Trees</h2>
            </div>
            <Link href="/products">
              <Button variant="ghost" className="text-muted-foreground hover:text-foreground">
                View all <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
          </div>

          {/* Category tabs — scrollable on mobile */}
          {sectionsLoading ? (
            <div className="flex gap-2 mt-6 mb-8">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-9 w-28 rounded-full bg-muted animate-pulse" />
              ))}
            </div>
          ) : BEST_TABS.length === 0 ? null : (
            <div className="flex gap-2 mt-6 mb-8 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
              {BEST_TABS.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setBestTab(tab.key)}
                  className={`px-5 py-2 rounded-full text-sm font-semibold tracking-wide transition-colors whitespace-nowrap ${bestTab === tab.key ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground"}`}
                >{tab.label}</button>
              ))}
            </div>
          )}

          {sectionsLoading || bestLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
              {Array.from({ length: 8 }).map((_, i) => <ProductCardSkeleton key={i} />)}
            </div>
          ) : BEST_TABS.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <span className="text-5xl">🌿</span>
              <p className="text-foreground font-medium text-base">No sections created yet.</p>
              <p className="text-muted-foreground text-sm">Go to Admin → Homepage Sections to add tabs.</p>
            </div>
          ) : bestProducts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <span className="text-5xl">🌿</span>
              <p className="text-foreground font-medium text-base">No products here yet.</p>
              <p className="text-muted-foreground text-sm">Check back soon for exciting new arrivals.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
              {bestProducts.map(product => (
                <ProductCard key={product.id} product={product as any} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Why Choose Us */}
      <section className="py-20 bg-background border-t">
        <div className="container mx-auto px-4">
          <div className="text-center mb-14">
            <p className="text-xs uppercase tracking-[0.18em] text-accent-text mb-3 font-semibold">Why Choose Us</p>
            <h2 className="font-serif text-3xl md:text-4xl font-medium">Our Promise to You</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-5xl mx-auto">
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
              <div key={title} className="flex flex-col items-center text-center gap-4 px-4">
                <div className="h-16 w-16 rounded-2xl bg-accent/10 flex items-center justify-center shrink-0">
                  <Icon className="h-7 w-7 text-accent" />
                </div>
                <h3 className="font-serif text-xl font-medium">{title}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">{desc}</p>
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
