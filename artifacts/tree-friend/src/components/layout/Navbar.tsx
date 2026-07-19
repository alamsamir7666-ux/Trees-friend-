import { useState, useEffect } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { Show, useUser, useClerk } from "@clerk/react";
import {
  ShoppingBag, User as UserIcon, Heart, Menu, LogOut,
  Settings, Package, X, Home, Sparkles, Sun, Moon, Star, Share2, Search, ChevronRight, ChevronDown, ShoppingBasket, TreeDeciduous,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGetCart, getGetCartQueryKey, useListCategories, getListCategoriesQueryKey, useGetMe, useListProducts } from "@workspace/api-client-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { useGuestCart } from "@/hooks/useGuestCart";
import { SearchAutocomplete } from "@/components/ui/SearchAutocomplete";
import { useTheme } from "next-themes";

// Categories are user-defined (e.g. "Fruit Trees", "Indoor Plants") with no
// fixed slug list, so there's no meaningful per-category icon lookup — a
// single tree icon is used as the default for all categories.
function getCategoryIcon(_slug: string): React.ElementType {
  return TreeDeciduous;
}

function TruckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 17h4V5H2v12h3" />
      <path d="M20 17h2v-3.34a4 4 0 0 0-1.17-2.83L19 9h-5v8h1" />
      <circle cx="7.5" cy="17.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
    </svg>
  );
}

function DashboardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </svg>
  );
}

function DrillCategoryProducts({ slug, onNavigate }: { slug: string; onNavigate: () => void }) {
  const { data, isLoading } = useListProducts({ category: slug, limit: 50 });
  const products = data?.products ?? [];

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 px-2 py-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-12 rounded-lg animate-pulse" style={{ backgroundColor: "var(--tf-icon-bg)" }} />
        ))}
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <p className="px-2 py-4 text-sm text-center" style={{ color: "var(--tf-text-muted)" }}>
        No products in this category yet.
      </p>
    );
  }

  return (
    <ul className="tf-category-list flex flex-col list-none">
      {products.map((p: any) => (
        <li key={p.id}>
          <Link href={`/products/${p.id}`} onClick={onNavigate} className="tf-nav-item w-full text-left">
            <span className="flex items-center gap-3 min-w-0">
              <span className="tf-icon-box overflow-hidden shrink-0">
                {p.images?.[0] ? (
                  <img src={p.images[0]} alt="" className="h-7 w-7 object-cover rounded" />
                ) : (
                  <span className="text-base">🌱</span>
                )}
              </span>
              <span className="truncate">{p.name}</span>
            </span>
          </Link>
        </li>
      ))}
      <li>
        <Link
          href={`/products?category=${slug}`}
          onClick={onNavigate}
          className="tf-nav-item w-full text-left flex items-center gap-2 text-[13px]"
          style={{ color: "var(--tf-text-muted)" }}
        >
          View all in this category <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </li>
    </ul>
  );
}

export function Navbar() {
  const [location, navigate] = useLocation();
  const searchStr = useSearch();
  const { user } = useUser();
  const { signOut } = useClerk();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountExpanded, setAccountExpanded] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const guestCart = useGuestCart();

  const { data: cart } = useGetCart({
    query: { enabled: !!user, retry: false, queryKey: getGetCartQueryKey() },
  });

  const { data: dbUser } = useGetMe({
    query: { enabled: !!user, retry: false, queryKey: ["me"] },
  });

  const { data: dbCategories } = useListCategories({
    query: { staleTime: 60_000, queryKey: getListCategoriesQueryKey() },
  });

  const serverCartCount = cart?.items?.reduce((sum, item) => sum + item.quantity, 0) ?? 0;
  const cartItemCount = user ? serverCartCount : guestCart.totalCount;

  // Admin if DB role is admin (covers both Clerk metadata and DB-only admin)
  const isAdmin = dbUser?.role === "admin" || user?.publicMetadata?.role === "admin";

  const categories = dbCategories ?? [];
  const parentCategories = categories.filter((cat: any) => !cat.parentId);
  const [drillCategory, setDrillCategory] = useState<any>(null);

  const activeCategory = new URLSearchParams(searchStr).get("category") ?? "";

  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [mobileOpen]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location, searchStr]);

  function handleMobileCategory(slug: string) {
    navigate(`/products?category=${slug}`);
    setMobileOpen(false);
    setDrillCategory(null);
  }

  return (
    <>
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="flex items-center gap-2">
              <img src="https://res.cloudinary.com/dcfbtdp6r/image/upload/v1783743859/IMG_20260710_151144-removebg-preview_11zon_ck95ax.png" alt="Tree Friend" className="h-10 w-10 object-contain" /><span className="font-serif text-xl font-medium tracking-wide">Tree Friend</span>
            </Link>

            <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
              <Link
                href="/products"
                className={`transition-colors hover:text-primary ${location === "/products" && !activeCategory ? "text-primary" : "text-muted-foreground"}`}
              >
                All Products
              </Link>
              {categories.slice(0, 3).map((cat) => (
                <Link
                  key={cat.slug}
                  href={`/products?category=${cat.slug}`}
                  className={`transition-colors hover:text-primary ${activeCategory === cat.slug ? "text-primary" : "text-muted-foreground"}`}
                >
                  {cat.name}
                </Link>
              ))}
              <Link href="/track" className="transition-colors hover:text-primary text-muted-foreground">
                Track Order
              </Link>
            </nav>
          </div>

          <div className="flex items-center gap-2 md:gap-4">
            <div className="hidden sm:block w-56 lg:w-72">
              <SearchAutocomplete />
            </div>

            <Show when="signed-out">
              <Link
                href="/sign-in"
                className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors hidden sm:block"
              >
                Sign In
              </Link>
            </Show>

            <Show when="signed-in">
              <Link href="/wishlist">
                <Button variant="ghost" size="icon" className="hidden sm:flex">
                  <Heart className="h-5 w-5" />
                  <span className="sr-only">Wishlist</span>
                </Button>
              </Link>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="rounded-full hidden sm:flex">
                    {user?.imageUrl ? (
                      <img src={user.imageUrl} alt="Profile" className="h-7 w-7 rounded-full object-cover" />
                    ) : (
                      <UserIcon className="h-5 w-5" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <div className="flex flex-col space-y-1 leading-none px-2 py-2">
                    <p className="font-medium text-sm">{user?.firstName} {user?.lastName}</p>
                    <p className="text-xs text-muted-foreground truncate">{user?.emailAddresses[0]?.emailAddress}</p>
                  </div>
                  <DropdownMenuSeparator />
                  {isAdmin && (
                    <>
                      <DropdownMenuItem asChild>
                        <Link href="/admin" className="cursor-pointer flex items-center">
                          <Settings className="mr-2 h-4 w-4" />
                          Admin Dashboard
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem asChild>
                    <Link href="/profile" className="cursor-pointer flex items-center">
                      <UserIcon className="mr-2 h-4 w-4" />
                      Profile
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/orders" className="cursor-pointer flex items-center">
                      <Package className="mr-2 h-4 w-4" />
                      Orders
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/loyalty" className="cursor-pointer flex items-center">
                      <Star className="mr-2 h-4 w-4" />
                      Loyalty Points
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/referral" className="cursor-pointer flex items-center">
                      <Share2 className="mr-2 h-4 w-4" />
                      Refer a Friend
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="cursor-pointer text-destructive focus:text-destructive"
                    onClick={() => signOut()}
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    Log out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </Show>

            {/* Dark mode toggle */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label="Toggle dark mode"
              className="hidden sm:flex"
            >
              <Sun className="h-5 w-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute h-5 w-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            </Button>

            {/* Mobile search icon */}
            <Button
              variant="ghost"
              size="icon"
              className="sm:hidden"
              onClick={() => setSearchOpen(v => !v)}
              aria-label="Search"
            >
              {searchOpen ? <X className="h-5 w-5" /> : <Search className="h-5 w-5" />}
            </Button>

            <Link href="/cart">
              <Button variant="ghost" size="icon" className="relative">
                <ShoppingBag className="h-5 w-5" />
                {cartItemCount > 0 && (
                  <Badge className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 rounded-full bg-accent text-accent-foreground text-xs">
                    {cartItemCount > 99 ? "99+" : cartItemCount}
                  </Badge>
                )}
                <span className="sr-only">Cart</span>
              </Button>
            </Link>

            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => { setMobileOpen((v) => !v); setAccountExpanded(false); }}
              aria-label="Toggle menu"
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          </div>
        </div>
      </header>

      {/* Mobile search bar - slides down below navbar */}
      <div className={`sm:hidden border-b bg-background/95 backdrop-blur transition-all duration-300 ${searchOpen ? "py-2 px-4" : "max-h-0 overflow-hidden"}`}>
        <SearchAutocomplete onClose={() => setSearchOpen(false)} />
      </div>

      {/* Scoped styles for the redesigned mobile sidebar */}
      <style>{`
        .tf-sb {
          --tf-bg-top: hsl(var(--sidebar));
          --tf-bg-bottom: hsl(var(--muted));
          --tf-text-main: hsl(var(--sidebar-foreground));
          --tf-text-muted: hsl(var(--muted-foreground));
          --tf-text-header: hsl(var(--accent-text));
          --tf-icon-bg: hsl(var(--secondary));
          --tf-active-bg: hsl(var(--muted));
          --tf-btn-bg: hsl(var(--secondary));
          --tf-border: hsl(var(--sidebar-border));
          --tf-font-sans: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
          --tf-font-serif: 'Lora', Georgia, serif;
          font-family: var(--tf-font-sans);
          color: var(--tf-text-main);
          background-color: var(--tf-bg-top);
        }
        .tf-sb .tf-brand-name { font-family: var(--tf-font-serif); }
        .tf-sb .tf-circle-btn {
          width: 30px; height: 30px; border-radius: 50%;
          background-color: var(--tf-btn-bg); border: none;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; color: var(--tf-text-main);
          transition: background-color 0.2s;
        }
        .tf-sb .tf-circle-btn:hover { background-color: var(--tf-border); }
        .tf-sb .tf-nav-item {
          position: relative;
          display: flex; align-items: center; justify-content: space-between;
          padding: 9px 10px; border-radius: 10px;
          text-decoration: none; color: var(--tf-text-main);
          font-size: 14px; font-weight: 400; cursor: pointer;
          transition: background-color 0.15s ease;
        }
        .tf-sb .tf-nav-item:hover { background-color: color-mix(in srgb, var(--tf-active-bg) 50%, transparent); }
        .tf-sb .tf-nav-item.active { background-color: var(--tf-active-bg); font-weight: 500; }
        .tf-sb .tf-icon-box {
          width: 28px; height: 28px; border-radius: 7px;
          background-color: var(--tf-icon-bg);
          display: flex; align-items: center; justify-content: center;
          color: hsl(var(--primary)); flex-shrink: 0;
        }
        .tf-sb .tf-nav-item.active .tf-icon-box { background-color: hsl(var(--sidebar-accent) / 0.15); }
        .tf-sb .tf-hover-leaf {
          position: absolute; right: 12px; top: 50%; opacity: 0;
          transform: translateY(-50%) scale(0.7) rotate(-10deg);
          transition: opacity 0.25s cubic-bezier(0.4,0,0.2,1), transform 0.25s cubic-bezier(0.4,0,0.2,1);
          pointer-events: none; color: var(--tf-text-muted);
        }
        .tf-sb .tf-nav-item:hover .tf-hover-leaf,
        .tf-sb .tf-nav-item.active .tf-hover-leaf { opacity: 0.7; transform: translateY(-50%) scale(1) rotate(0deg); }
        .tf-sb .tf-section-divider { display: flex; align-items: center; gap: 8px; margin: 14px 0 6px 0; padding: 0 4px; }
        .tf-sb .tf-section-title { font-size: 10px; font-weight: 600; color: var(--tf-text-header); letter-spacing: 1.1px; text-transform: uppercase; }
        .tf-sb .tf-line { flex-grow: 1; height: 1px; background-color: var(--tf-border); }
        .tf-sb .tf-category-list .tf-nav-item { border-bottom: 1px solid hsl(var(--sidebar-border) / 0.6); border-radius: 0; padding: 10px 6px; }
        .tf-sb .tf-category-list .tf-nav-item:last-child { border-bottom: none; }
        .tf-sb .tf-chevron { color: hsl(var(--muted-foreground)); }
        .tf-sb-bottom {
          background-color: var(--tf-bg-bottom);
          border-top: 1px solid var(--tf-border);
          padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
        }
        .tf-sb-bottom .tf-user-avatar {
          width: 36px; height: 36px; border-radius: 50%;
          background-color: hsl(var(--secondary)); display: flex; align-items: center; justify-content: center;
          color: hsl(var(--secondary-foreground)); flex-shrink: 0;
        }
        .tf-sb-bottom .tf-expand-btn {
          background: none; border: none; color: hsl(var(--muted-foreground)); cursor: pointer;
          padding: 6px; display: flex; align-items: center; justify-content: center;
          border-radius: 50%; transition: background-color 0.2s, color 0.2s, transform 0.3s cubic-bezier(0.4,0,0.2,1);
        }
        .tf-sb-bottom .tf-expand-btn:hover { background-color: hsl(var(--foreground) / 0.05); color: hsl(var(--tf-text-main)); }
        .tf-sb-bottom .tf-expand-btn.expanded { transform: rotate(180deg); }
      `}</style>

      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-foreground/40 backdrop-blur-sm transition-opacity duration-300 md:hidden ${
          mobileOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={() => setMobileOpen(false)}
      />

      {/* Mobile Drawer */}
      <div
        className={`tf-sb fixed top-0 left-0 z-50 h-full w-[85%] max-w-[330px] shadow-2xl transform transition-transform duration-300 ease-out md:hidden flex flex-col ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex-1 overflow-y-auto py-3 px-4 scrollbar-hide">
          {/* Brand header */}
          <div className="flex items-center justify-between mb-4">
            <Link href="/" className="flex items-center gap-2.5" onClick={() => setMobileOpen(false)}>
              <img src="https://res.cloudinary.com/dcfbtdp6r/image/upload/v1783743859/IMG_20260710_151144-removebg-preview_11zon_ck95ax.png" alt="Tree Friend" className="h-9 w-9 object-contain" />
              <span className="tf-brand-name text-[19px] font-semibold tracking-tight" style={{ color: "hsl(var(--primary))" }}>Tree Friend</span>
            </Link>
            <div className="flex items-center gap-1.5">
              <button className="tf-circle-btn" aria-label="Toggle dark mode" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
                <Sun className="h-3.5 w-3.5 dark:hidden" />
                <Moon className="h-3.5 w-3.5 hidden dark:block" />
              </button>
              <button className="tf-circle-btn" aria-label="Close menu" onClick={() => setMobileOpen(false)}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Primary links */}
          <ul className="flex flex-col gap-0.5 list-none">
            <li>
              <Link href="/" onClick={() => setMobileOpen(false)} className={`tf-nav-item ${location === "/" ? "active" : ""}`}>
                <span className="flex items-center gap-3">
                  <span className="tf-icon-box"><Home className="h-3.5 w-3.5" /></span>
                  Home
                </span>
                <TreeDeciduous className="tf-hover-leaf h-5 w-5" />
              </Link>
            </li>
            <li>
              <Link href="/products" onClick={() => setMobileOpen(false)} className={`tf-nav-item ${location === "/products" && !activeCategory ? "active" : ""}`}>
                <span className="flex items-center gap-3">
                  <span className="tf-icon-box"><ShoppingBasket className="h-3.5 w-3.5" /></span>
                  Shop All
                </span>
                <TreeDeciduous className="tf-hover-leaf h-5 w-5" />
              </Link>
            </li>
            <li>
              <Link href="/blog" onClick={() => setMobileOpen(false)} className={`tf-nav-item ${location === "/blog" ? "active" : ""}`}>
                <span className="flex items-center gap-3">
                  <span className="tf-icon-box"><Sparkles className="h-3.5 w-3.5" /></span>
                  Plant Care Blog
                </span>
                <TreeDeciduous className="tf-hover-leaf h-5 w-5" />
              </Link>
            </li>
          </ul>

          {/* Categories */}
          <div className="tf-section-divider">
            <span className="tf-section-title">Categories</span>
            <div className="tf-line" />
          </div>

          {drillCategory ? (
            <>
              <button
                onClick={() => setDrillCategory(null)}
                className="tf-nav-item w-full text-left mb-1"
              >
                <span className="flex items-center gap-2 text-[13px]" style={{ color: "var(--tf-text-muted)" }}>
                  <ChevronRight className="h-3.5 w-3.5 rotate-180" /> Back
                </span>
              </button>
              <div className="px-2 py-2 mb-1 rounded-lg" style={{ backgroundColor: "var(--tf-icon-bg)" }}>
                <p className="text-[15px] font-semibold" style={{ fontFamily: "var(--tf-font-serif)" }}>{drillCategory.name}</p>
              </div>
              {(() => {
                const subs = categories.filter((cat: any) => cat.parentId === drillCategory.id);
                if (subs.length > 0) {
                  return (
                    <ul className="tf-category-list flex flex-col list-none">
                      {subs.map((sub: any) => (
                        <li key={sub.slug}>
                          <button onClick={() => handleMobileCategory(sub.slug)} className="tf-nav-item w-full text-left">
                            <span className="flex items-center gap-3">
                              {sub.iconImage ? (
                                <span className="tf-icon-box overflow-hidden"><img src={sub.iconImage} alt="" className="h-5 w-5 object-contain" /></span>
                              ) : sub.icon ? (
                                <span className="tf-icon-box text-base">{sub.icon}</span>
                              ) : (
                                <span className="tf-icon-box"><TreeDeciduous className="h-3.5 w-3.5" /></span>
                              )}
                              {sub.name}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  );
                }
                // Leaf category (no subcategories) -- list its products directly,
                // e.g. "Medicinal Plants" with no subcategories, just products.
                return <DrillCategoryProducts slug={drillCategory.slug} onNavigate={() => { setMobileOpen(false); setDrillCategory(null); }} />;
              })()}
            </>
          ) : (
            <ul className="tf-category-list flex flex-col list-none">
              {parentCategories.map((cat: any) => {
                const Icon = getCategoryIcon(cat.slug);
                return (
                  <li key={cat.slug}>
                    <button
                      onClick={() => setDrillCategory(cat)}
                      className="tf-nav-item w-full text-left"
                    >
                      <span className="flex items-center gap-3">
                          <span className="tf-icon-box overflow-hidden">
                          {cat.iconImage ? (
                            <img src={cat.iconImage} alt="" className="h-5 w-5 object-contain" />
                          ) : cat.icon ? (
                            <span className="text-base">{cat.icon}</span>
                          ) : (
                            <Icon className="h-3.5 w-3.5" />
                          )}
                        </span>
                        {cat.name}
                      </span>
                      <ChevronRight className="tf-chevron h-3.5 w-3.5 shrink-0" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {/* More */}
          <div className="tf-section-divider">
            <span className="tf-section-title">More</span>
            <div className="tf-line" />
          </div>
          <ul className="flex flex-col gap-0.5 list-none">
            <li>
              <Link href="/track" onClick={() => setMobileOpen(false)} className={`tf-nav-item ${location === "/track" ? "active" : ""}`}>
                <span className="flex items-center gap-3">
                  <span className="tf-icon-box"><TruckIcon className="h-3.5 w-3.5" /></span>
                  Track Order
                </span>
                <TreeDeciduous className="tf-hover-leaf h-5 w-5" />
              </Link>
            </li>
            {!user && (
              <>
                <li>
                  <Link href="/orders" onClick={() => setMobileOpen(false)} className={`tf-nav-item ${location === "/orders" ? "active" : ""}`}>
                    <span className="flex items-center gap-3">
                      <span className="tf-icon-box"><Package className="h-3.5 w-3.5" /></span>
                      My Orders
                    </span>
                    <TreeDeciduous className="tf-hover-leaf h-5 w-5" />
                  </Link>
                </li>
                <li>
                  <Link href="/wishlist" onClick={() => setMobileOpen(false)} className={`tf-nav-item ${location === "/wishlist" ? "active" : ""}`}>
                    <span className="flex items-center gap-3">
                      <span className="tf-icon-box"><Heart className="h-3.5 w-3.5" /></span>
                      Wishlist
                    </span>
                    <TreeDeciduous className="tf-hover-leaf h-5 w-5" />
                  </Link>
                </li>
              </>
            )}
          </ul>
        </div>

        {/* Bottom account area */}
        <div className="tf-sb-bottom shrink-0 px-4 py-3">
          <Show when="signed-out">
            <Link href="/sign-in" onClick={() => setMobileOpen(false)}>
              <Button className="w-full rounded-full" size="sm">Sign In</Button>
            </Link>
          </Show>
          <Show when="signed-in">
            <button
              className="w-full flex items-center justify-between gap-3 py-1.5"
              onClick={() => setAccountExpanded(v => !v)}
              aria-expanded={accountExpanded}
            >
              <span className="flex items-center gap-2.5 min-w-0">
                {user?.imageUrl ? (
                  <img src={user.imageUrl} alt="Profile" className="tf-user-avatar object-cover" />
                ) : (
                  <span className="tf-user-avatar"><UserIcon className="h-4 w-4" /></span>
                )}
                <span className="min-w-0 text-left">
                  <span className="block text-[13.5px] font-semibold truncate" style={{ color: "var(--tf-text-main)" }}>{user?.firstName} {user?.lastName}</span>
                  <span className="block text-[10.5px] truncate" style={{ color: "var(--tf-text-muted)" }}>{user?.emailAddresses[0]?.emailAddress}</span>
                </span>
              </span>
              <span className={`tf-expand-btn ${accountExpanded ? "expanded" : ""}`}>
                <ChevronDown className="h-4 w-4" />
              </span>
            </button>

            {accountExpanded && (
              <ul className="flex flex-col gap-0.5 list-none mt-2 pt-2" style={{ borderTop: "1px solid rgba(0,0,0,0.06)" }}>
                <li>
                  <Link href="/profile" onClick={() => setMobileOpen(false)} className="tf-nav-item">
                    <span className="flex items-center gap-3"><span className="tf-icon-box"><UserIcon className="h-3.5 w-3.5" /></span>Profile</span>
                  </Link>
                </li>
                <li>
                  <Link href="/orders" onClick={() => setMobileOpen(false)} className="tf-nav-item">
                    <span className="flex items-center gap-3"><span className="tf-icon-box"><Package className="h-3.5 w-3.5" /></span>My Orders</span>
                  </Link>
                </li>
                <li>
                  <Link href="/loyalty" onClick={() => setMobileOpen(false)} className="tf-nav-item">
                    <span className="flex items-center gap-3"><span className="tf-icon-box"><Star className="h-3.5 w-3.5" /></span>Loyalty Points</span>
                  </Link>
                </li>
                <li>
                  <Link href="/referral" onClick={() => setMobileOpen(false)} className="tf-nav-item">
                    <span className="flex items-center gap-3"><span className="tf-icon-box"><Share2 className="h-3.5 w-3.5" /></span>Refer a Friend</span>
                  </Link>
                </li>
                <li>
                  <Link href="/wishlist" onClick={() => setMobileOpen(false)} className="tf-nav-item">
                    <span className="flex items-center gap-3"><span className="tf-icon-box"><Heart className="h-3.5 w-3.5" /></span>Wishlist</span>
                  </Link>
                </li>
                {isAdmin && (
                  <li>
                    <Link href="/admin" onClick={() => setMobileOpen(false)} className="tf-nav-item">
                      <span className="flex items-center gap-3"><span className="tf-icon-box"><DashboardIcon className="h-3.5 w-3.5" /></span>Admin Dashboard</span>
                    </Link>
                  </li>
                )}
              </ul>
            )}

            <div className="mt-1.5 pt-1.5" style={{ borderTop: "1px solid rgba(0,0,0,0.06)" }}>
              <button
                onClick={() => { signOut(); setMobileOpen(false); }}
                className="tf-nav-item w-full text-left text-destructive"
              >
                <span className="flex items-center gap-3">
                  <span className="tf-icon-box" style={{ backgroundColor: "transparent" }}><LogOut className="h-3.5 w-3.5" /></span>
                  Log out
                </span>
              </button>
            </div>
          </Show>
        </div>
      </div>
    </>
  );
}
