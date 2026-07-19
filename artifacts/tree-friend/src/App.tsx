import { useEffect, useRef, useState } from "react";
import { ClerkProvider, Show, useClerk, useAuth, useSession } from '@clerk/react';
import { setAuthTokenGetter } from '@workspace/api-client-react';
import { setTokenGetter as setLocalApiTokenGetter } from '@/lib/getToken';
import { shadcn } from '@clerk/themes';
import { Switch, Route, useLocation, Router as WouterRouter, Redirect, Link } from 'wouter';
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { GuestCartProvider } from "@/contexts/GuestCartContext";
import { useGuestWishlist } from "@/hooks/useGuestWishlist";
import { useAddToWishlist } from "@workspace/api-client-react";
import { GuestWishlistProvider } from "@/contexts/GuestWishlistContext";
import { WishlistProvider } from "@/contexts/WishlistContext";
import { PageProvider, usePageContext } from "@/contexts/PageContext";

import { Navbar } from "./components/layout/Navbar";
import { Footer } from "./components/layout/Footer";
import { lazy, Suspense } from "react";
const AddressesPage = lazy(() => import("@/pages/AddressesPage").then(m => ({ default: m.AddressesPage })));
const BecomeSellerPage = lazy(() => import("@/pages/BecomeSellerPage").then(m => ({ default: m.BecomeSellerPage })));
const SellerDashboardPage = lazy(() => import("@/pages/SellerDashboardPage").then(m => ({ default: m.SellerDashboardPage })));
const SignInPage = lazy(() => import("@/pages/SignInPage").then(m => ({ default: m.SignInPage })));
const SignUpPage = lazy(() => import("@/pages/SignUpPage").then(m => ({ default: m.SignUpPage })));
const BlogPage = lazy(() => import("@/pages/BlogPage").then(m => ({ default: m.BlogPage })));
const BlogArticlePage = lazy(() => import("@/pages/BlogArticlePage").then(m => ({ default: m.BlogArticlePage })));
import { I18nProvider } from "@/lib/i18n";
import { ThemeProvider } from "next-themes";
import { CurrencyProvider } from "@/lib/currency";
import { FlashSaleBanner } from "@/components/ui/FlashSaleBanner";
import { FloatingCartIcon } from "./components/ui/FloatingCartIcon";
import { PageTransition } from "@/components/ui/PageTransition";
import { ProfileSync } from "./components/auth/ProfileSync";
import { HomePage } from "./pages/HomePage";
import { ProductsPage } from "./pages/ProductsPage";
import { ProductDetailPage } from "./pages/ProductDetailPage";
import { CartPage } from "./pages/CartPage";
import { CheckoutPage } from "./pages/CheckoutPage";
import { PreOrderCheckoutPage } from "./pages/PreOrderCheckoutPage";
import { OrdersPage } from "./pages/OrdersPage";
import { OrderDetailPage } from "./pages/OrderDetailPage";
import { PreOrderDetailPage } from "./pages/PreOrderDetailPage";
import { WishlistPage } from "./pages/WishlistPage";
import { ProfilePage } from "./pages/ProfilePage";
import { TrackOrderPage } from "./pages/TrackOrderPage";
const AdminPage = lazy(() => import("./pages/AdminPage").then(m => ({ default: m.AdminPage })));
const SubscriptionsPage = lazy(() => import("@/pages/SubscriptionsPage").then(m => ({ default: m.SubscriptionsPage })));
const GiftCardsPage = lazy(() => import("@/pages/GiftCardsPage").then(m => ({ default: m.GiftCardsPage })));
const EmailPreferencesPage = lazy(() => import("@/pages/EmailPreferencesPage").then(m => ({ default: m.EmailPreferencesPage })));
const LoyaltyPage = lazy(() => import("@/pages/LoyaltyPage"));
const ReferralPage = lazy(() => import("@/pages/ReferralPage"));
const ComparePage = lazy(() => import("@/pages/ComparePage"));
import { useGetMe } from "@workspace/api-client-react";
import { useUser } from "@clerk/react";

function TokenSync() {
  const { getToken, isSignedIn } = useAuth();
  // Set synchronously so queries have token on first render
  setAuthTokenGetter(isSignedIn ? () => getToken() : null);
  // Also wire up the local apiClient's token getter (used by ProductModal,
  // CategoryModal, and admin tabs that call apiClient.* directly instead of
  // the generated @workspace/api-client-react hooks). Previously this was
  // never connected, so every apiClient request went out with no
  // Authorization header and silently got a 401 from the API.
  setLocalApiTokenGetter(isSignedIn ? () => getToken() : () => Promise.resolve(null));
  return null;
}

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

// Guard: fail fast with a clear message if the key is missing, instead of a
// cryptic Clerk internal error that's hard to diagnose.
if (!clerkPubKey && import.meta.env.PROD) {
  document.body.innerHTML =
    '<div style="padding:2rem;font-family:system-ui;text-align:center"><h2>Configuration Error</h2><p>VITE_CLERK_PUBLISHABLE_KEY is not set. Please check your environment variables.</p></div>';
  throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required but not set.");
}
// At this point we've either thrown (prod with no key) or have a real key.
// In dev without a key, Clerk itself will throw a clear runtime error on
// mount, so it's safe to narrow the type here rather than threading
// `| undefined` through every consumer below.
const resolvedClerkPubKey = clerkPubKey ?? "";

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL as string | undefined;
const basePath = (import.meta.env.BASE_URL as string).replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: 'https://res.cloudinary.com/dcfbtdp6r/image/upload/v1783743859/IMG_20260710_151144-removebg-preview_11zon_ck95ax.png',
  },
  variables: {
    colorPrimary: "hsl(20 10% 18%)",
    colorForeground: "hsl(20 10% 18%)",
    colorMutedForeground: "hsl(20 6% 45%)",
    colorDanger: "hsl(0 72% 51%)",
    colorBackground: "hsl(34 23% 98%)",
    colorInput: "hsl(34 23% 98%)",
    colorInputForeground: "hsl(20 10% 18%)",
    colorNeutral: "hsl(30 15% 86%)",
    fontFamily: "'DM Sans', Inter, sans-serif",
    borderRadius: "0.5rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-card rounded-xl w-[440px] max-w-full overflow-hidden border border-border shadow-lg",
    card: "!shadow-none !border-0 !bg-transparent",
    footer: "!shadow-none !border-0 !bg-transparent",
    headerTitle: "font-serif text-2xl font-medium",
    headerSubtitle: "text-muted-foreground",
    socialButtonsBlockButtonText: "font-medium",
    formFieldLabel: "text-foreground font-medium text-sm",
    footerActionLink: "text-accent hover:text-accent/80 font-medium",
    footerActionText: "text-muted-foreground",
    dividerText: "text-muted-foreground",
    identityPreviewEditButton: "text-primary",
    formFieldSuccessText: "text-green-600",
    alertText: "text-destructive",
    logoBox: "flex justify-center mb-2",
    logoImage: "h-12 w-12 rounded-full object-cover object-center",
    socialButtonsBlockButton: "border border-border hover:bg-muted/50 rounded-full h-11 font-medium transition-all",
    formButtonPrimary: "bg-primary text-primary-foreground hover:bg-primary/90 font-medium rounded-full h-11 tracking-wide",
    footerAction: "bg-muted/30 pb-6 pt-4",
    dividerLine: "bg-border",
    alert: "bg-destructive/10 border-destructive/20 text-destructive",
    otpCodeFieldInput: "border-input bg-background",
    formFieldRow: "mb-4",
    main: "p-8",
  },
};

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        queryClient.invalidateQueries();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

// Must be set at module level - before any component renders - so the browser
// never auto-scrolls on popstate before we can intercept it.
if (typeof window !== "undefined") {
  window.history.scrollRestoration = "manual";
}

const SCROLL_KEY = (path: string) => `__scroll__${path}`;

// Module-level flag - survives React render batching unlike a ref
let _isPop = false;
let _lastScrollY = 0;

function saveScrollPosition(path: string) {
  try {
    sessionStorage.setItem(SCROLL_KEY(path), String(Math.round(window.scrollY)));
  } catch (_) {}
}

function readScrollPosition(path: string): number {
  try {
    const v = sessionStorage.getItem(SCROLL_KEY(path));
    return v ? parseInt(v, 10) : 0;
  } catch (_) { return 0; }
}

// Fixed ScrollManager - handles async/data-fetching pages correctly.
// Root cause of the original bug: double-rAF fired before data-fetching pages
// finished rendering their full content, so scrollTo(y) landed on a skeleton
// page that was still short. The page then grew below the viewport.
//
// Fix: poll body.scrollHeight every 80ms until the page is tall enough to
// accommodate the saved Y position, then scroll. Self-cancels on new navigation.
function ScrollManager() {
  // Use full URL (pathname + search) as the scroll key so back/forward
  // across filter/search state (?q=, ?category=) is correctly restored.
  const [location] = useLocation();
  const fullHref = typeof window !== "undefined"
    ? window.location.pathname + window.location.search
    : location;
  const prevPathRef = useRef(fullHref);
  const isPopStateRef = useRef(false);
  const pendingScrollRef = useRef<number | null>(null);

  // Track last known scrollY in a ref so cleanup can save correct value
  const lastScrollYRef = useRef(0);
  useEffect(() => {
    const save = () => {
      lastScrollYRef.current = window.scrollY;
      saveScrollPosition(fullHref);
    };
    window.addEventListener("scroll", save, { passive: true });
    window.addEventListener("pagehide", save);
    return () => {
      // Save using the last known scrollY, not window.scrollY (which may be 0 already)
      try {
        sessionStorage.setItem(SCROLL_KEY(fullHref), String(Math.round(lastScrollYRef.current)));
      } catch (_) {}
      window.removeEventListener("scroll", save);
      window.removeEventListener("pagehide", save);
    };
  }, [fullHref]);

  // Detect back/forward navigation - capture leaving path before wouter updates
  useEffect(() => {
    const onPopState = () => {
      // Do NOT save here - scrollY is already 0 by the time popstate fires.
      // The scroll listener already saved the correct position continuously.
      isPopStateRef.current = true;
      console.log("[scroll] saved value for /:", sessionStorage.getItem("__scroll__/"));
      console.log("[scroll] popstate fired, prev:", prevPathRef.current);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Flush scroll position on every navigation (belt-and-suspenders)
  useEffect(() => {
    const onBeforeUnload = () => saveScrollPosition(fullHref);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [fullHref]);

  // Handle scroll on route change
  useEffect(() => {
    prevPathRef.current = fullHref;

    const targetY = readScrollPosition(fullHref);
    console.log("[scroll] effect ran, fullHref:", fullHref, "savedY:", targetY);
    if (targetY > 0) {
      pendingScrollRef.current = targetY;

      if (targetY === 0) {
        window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
        pendingScrollRef.current = null;
        return;
      }

      // Poll until page is tall enough, then scroll.
      // MAX_ATTEMPTS ? INTERVAL_MS = max wait time before giving up.
      // Increased to handle slow API responses on all pages.
      let attempts = 0;
      const MAX_ATTEMPTS = 50;
      const INTERVAL_MS = 100;

      function tryScroll() {
        if (pendingScrollRef.current === null) return; // cancelled
        const pageHeight = document.body.scrollHeight;
        const viewportHeight = window.innerHeight;

        if (pageHeight - viewportHeight >= targetY || attempts >= MAX_ATTEMPTS) {
          console.log("[scroll] restoring to:", targetY, "pageHeight:", pageHeight, "attempts:", attempts);
          window.scrollTo({ top: targetY, behavior: "instant" as ScrollBehavior });
          pendingScrollRef.current = null;
        } else {
          attempts++;
          setTimeout(tryScroll, INTERVAL_MS);
        }
      }

      requestAnimationFrame(() => requestAnimationFrame(tryScroll));
    } else {
      pendingScrollRef.current = null;
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    }
  }, [fullHref]);

  return null;
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  return (
    <>
      <Show when="signed-in"><Component /></Show>
      <Show when="signed-out"><Redirect to="/sign-in" /></Show>
    </>
  );
}

function AdminRoute() {
  console.log("[AdminRoute] component function called - fresh mount or re-render");
  const { user: clerkUser } = useUser();
  const { data: dbUser, isLoading } = useGetMe({ query: { retry: false, queryKey: ["me"], staleTime: Infinity, refetchOnMount: false, refetchOnReconnect: false } });
  const [verifiedAdmin, setVerifiedAdmin] = useState(false);

  useEffect(() => {
    if (!isLoading && (dbUser?.role === "admin" || clerkUser?.publicMetadata?.role === "admin")) {
      setVerifiedAdmin(true);
    }
  }, [isLoading, dbUser, clerkUser]);

  if (verifiedAdmin) {
    return <Suspense fallback={<div className="min-h-[60vh]" />}><AdminPage /></Suspense>;
  }
  if (isLoading) return null;
  if (dbUser?.role !== "admin" && clerkUser?.publicMetadata?.role !== "admin") return <Redirect to="/" />;
  return <Suspense fallback={<div className="min-h-[60vh]" />}><AdminPage /></Suspense>;
}

// Compute flash sale end time once at module level - not inside the component
// to avoid creating a new Date() reference on every render which confuses the timer.
function getTodayMidnight(): Date {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}
const FLASH_SALE_END = getTodayMidnight();

function AppLayout({ children }: { children: React.ReactNode }) {
  const { pageReady } = usePageContext();
  const flashSaleEnd = FLASH_SALE_END;

  return (
    <>
      <div className="min-h-[100dvh] flex flex-col">
        <FlashSaleBanner label="Flash Sale - Up to 30% Off" endsAt={flashSaleEnd} href="/products" />
        <Navbar />
        <main className="flex-1">
          {children}
        </main>
        {pageReady && <Footer />}
      </div>
      <FloatingCartIcon />
    </>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={resolvedClerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: "Welcome back", subtitle: "Sign in to your Tree Friend account" } },
        signUp: { start: { title: "Join Tree Friend", subtitle: "Create your account to start your ritual" } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <TokenSync />
        <GuestCartProvider>
        <GuestWishlistProvider>
          <WishlistProvider>
          <PageProvider>
            <ClerkQueryClientCacheInvalidator />
            <ProfileSync />
            <WishlistMergeSync />
            <ScrollManager />
            <AppLayout>
              <Suspense fallback={<div className="min-h-[60vh]" />}>
              <PageTransition>
              <Switch>
                <Route path="/" component={HomePage} />
                <Route path="/products" component={ProductsPage} />
                <Route path="/products/:id" component={ProductDetailPage} />
                <Route path="/cart" component={CartPage} />
                <Route path="/checkout" component={CheckoutPage} />
        <Route path="/pre-order-checkout" component={PreOrderCheckoutPage} />
                <Route path="/orders" component={OrdersPage} />
                <Route path="/orders/:id" component={OrderDetailPage} />
                <Route path="/pre-orders/:id" component={PreOrderDetailPage} />
                <Route path="/wishlist" component={WishlistPage} />
                <Route path="/profile">
                  {() => <ProtectedRoute component={ProfilePage} />}
                </Route>
                <Route path="/subscriptions">
                  {() => <ProtectedRoute component={SubscriptionsPage} />}
                </Route>
                <Route path="/gift-cards" component={GiftCardsPage} />
                <Route path="/email-preferences">
                  {() => <ProtectedRoute component={EmailPreferencesPage} />}
                </Route>
                <Route path="/loyalty">
                  {() => <ProtectedRoute component={LoyaltyPage} />}
                </Route>
                <Route path="/referral">
                  {() => <ProtectedRoute component={ReferralPage} />}
                </Route>
                <Route path="/compare" component={ComparePage} />
                <Route path="/track" component={TrackOrderPage} />
                <Route path="/track/:trackingId" component={TrackOrderPage} />
                <Route path="/addresses" component={AddressesPage} />
                <Route path="/become-seller">
                  {() => <ProtectedRoute component={BecomeSellerPage} />}
                </Route>
                <Route path="/seller/dashboard">
                  {() => <ProtectedRoute component={SellerDashboardPage} />}
                </Route>
                <Route path="/blog" component={BlogPage} />
                <Route path="/blog/:slug" component={BlogArticlePage} />
                <Route path="/admin">
                  {() => (
                    <>
                      <Show when="signed-in"><AdminRoute /></Show>
                      <Show when="signed-out"><Redirect to="/sign-in" /></Show>
                    </>
                  )}
                </Route>
                <Route path="/sign-in/*?" component={SignInPage} />
                <Route path="/sign-up/*?" component={SignUpPage} />
                <Route path="/:rest*">
                  <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
                    <h1 className="font-serif text-6xl font-medium mb-4 text-muted-foreground/30">404</h1>
                    <h2 className="font-serif text-2xl font-medium mb-2">Page not found</h2>
                    <p className="text-muted-foreground mb-8">The page you're looking for doesn't exist.</p>
                    <Link href="/" className="text-sm text-accent underline underline-offset-4">Return home</Link>
                  </div>
                </Route>
              </Switch>
              </PageTransition>
              </Suspense>
            </AppLayout>
            <Toaster />
          </PageProvider>
          </WishlistProvider>
        </GuestWishlistProvider>
        </GuestCartProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
    <I18nProvider>
      <CurrencyProvider>
        <WouterRouter base={basePath}>
          <ClerkProviderWithRoutes />
        </WouterRouter>
      </CurrencyProvider>
    </I18nProvider>
    </ThemeProvider>
  );
}

export default App;

function WishlistMergeSync() {
  const { user, isLoaded } = useUser();
  const guestWishlist = useGuestWishlist();
  const addToWishlist = useAddToWishlist();
  const merged = useRef(false);

  useEffect(() => {
    if (!isLoaded || !user || merged.current) return;
    if (guestWishlist.items.length === 0) return;
    merged.current = true;
    Promise.all(
      guestWishlist.items.map((item) =>
        addToWishlist.mutateAsync({ productId: item.productId }).catch(() => {})
      )
    ).then(() => {
      guestWishlist.clearWishlist();
    });
  }, [isLoaded, user]);

  return null;
}
