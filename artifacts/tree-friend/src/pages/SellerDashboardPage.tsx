import { useState, useEffect } from "react";
import { Link } from "wouter";
import {
  LayoutDashboard, Package, ShoppingBag, Wallet, Truck, Building2,
  Sprout, Loader2, Menu, Undo2, CalendarClock, X, ExternalLink,
  Settings, ChevronRight, LogOut, BadgeCheck, Tag,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useSEO } from "@/lib/seo";
import { useGetMySeller, useListSellerOrders, useGetMe } from "@workspace/api-client-react";
import { SellerOverviewTab } from "@/components/seller/SellerOverviewTab";
import { SellerListingsTab } from "@/components/seller/SellerListingsTab";
import { SellerOrdersTab } from "@/components/seller/SellerOrdersTab";
import { SellerReturnsTab } from "@/components/seller/SellerReturnsTab";
import { SellerMonthlyHistoryTab } from "@/components/seller/SellerMonthlyHistoryTab";
import { CourierSettingsForm } from "@/components/seller/CourierSettingsForm";
import { PaymentSettingsForm } from "@/components/seller/PaymentSettingsForm";
import { BusinessProfileForm } from "@/components/seller/BusinessProfileForm";
import { SellerCouponsTab } from "@/components/seller/SellerCouponsTab";
import { useAuth } from "@clerk/react";

type SectionId =
  | "dashboard" | "listings" | "orders" | "returns"
  | "monthlyHistory" | "coupons" | "payment" | "courier" | "profile";

const NAV_GROUPS: {
  label: string;
  items: { id: SectionId; label: string; icon: React.ElementType }[];
}[] = [
  {
    label: "Overview",
    items: [
      { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
      { id: "listings", label: "Listings", icon: Package },
      { id: "orders", label: "Orders", icon: ShoppingBag },
      { id: "returns", label: "Returns", icon: Undo2 },
      { id: "monthlyHistory", label: "Monthly History", icon: CalendarClock },
      { id: "coupons", label: "Coupons", icon: Tag },
    ],
  },
  {
    label: "Settings",
    items: [
      { id: "payment", label: "Payment", icon: Wallet },
      { id: "courier", label: "Courier", icon: Truck },
      { id: "profile", label: "Business Profile", icon: Building2 },
    ],
  },
];

const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

export function SellerDashboardPage() {
  useSEO({ title: "Seller Dashboard", noIndex: true });
  const { data: seller, isLoading: sellerLoading } = useGetMySeller();
  const { data: me } = useGetMe();
  const { signOut } = useAuth();

  const [activeSection, setActiveSection] = useState<SectionId>("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    if (seller?.status === "vacation") {
      setActiveSection("profile");
    }
  }, [seller?.status]);

  const { data: allOrders } = useListSellerOrders(
    {},
    { query: { enabled: seller?.status === "active" } } as any,
  );
  const pendingOrdersCount = (allOrders ?? []).filter((o) => o.orderStatus === "pending").length;

  if (sellerLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-primary to-[hsl(150_30%_22%)] flex items-center justify-center">
              <Sprout className="h-6 w-6 text-primary-foreground" />
            </div>
            <Loader2 className="absolute -bottom-1 -right-1 h-5 w-5 animate-spin text-muted-foreground bg-card rounded-full" />
          </div>
          <p className="text-xs text-muted-foreground">Loading your seller dashboard…</p>
        </div>
      </div>
    );
  }

  if (!seller || (seller.status !== "active" && seller.status !== "vacation")) {
    return (
      <div className="container mx-auto px-4 py-16 max-w-lg text-center">
        <div className="h-16 w-16 mx-auto mb-4 rounded-2xl bg-muted flex items-center justify-center">
          <Sprout className="h-8 w-8 text-muted-foreground" />
        </div>
        <h1 className="font-serif text-xl font-medium mb-2">Seller dashboard unavailable</h1>
        <p className="text-sm text-muted-foreground mb-4">
          {!seller
            ? "You don't have a seller account yet."
            : `Your seller account status is "${seller.status}" — the dashboard is only available for active sellers.`}
        </p>
        <Link href="/become-seller">
          <Button className="rounded-full">
            {!seller ? "Become a Seller" : "View Application Status"}
          </Button>
        </Link>
      </div>
    );
  }

  const activeSeller = seller;
  const onVacation = activeSeller.status === "vacation";
  const isNavDisabled = (id: SectionId) => onVacation && id !== "profile";

  function handleNavigate(id: string) {
    const target = ALL_NAV_ITEMS.find((n: { id: SectionId; label: string; icon: React.ElementType }) => n.id === id as SectionId);
    if (!target || isNavDisabled(target.id)) return;
    setActiveSection(target.id);
    setSidebarOpen(false);
  }

  function renderActiveSection() {
    switch (activeSection) {
      case "dashboard":
        return <SellerOverviewTab seller={activeSeller} onNavigate={handleNavigate} />;
      case "listings":
        return <SellerListingsTab />;
      case "orders":
        return <SellerOrdersTab />;
      case "returns":
        return <SellerReturnsTab />;
      case "monthlyHistory":
        return <SellerMonthlyHistoryTab />;
      case "coupons":
        return <SellerCouponsTab />;
      case "payment":
        return <PaymentSettingsForm />;
      case "courier":
        return <CourierSettingsForm />;
      case "profile":
        return <BusinessProfileForm />;
      default:
        return <SellerOverviewTab seller={activeSeller} onNavigate={handleNavigate} />;
    }
  }

  const activeNav = ALL_NAV_ITEMS.find((n: { id: SectionId; label: string; icon: React.ElementType }) => n.id === activeSection);
  const ownerInitial = seller.ownerName?.[0] ?? (me as any)?.firstName?.[0] ?? "S";
  const storeInitial = (seller.businessName ?? seller.nurseryName ?? "S")[0];

  function Sidebar({ mobile = false }: { mobile?: boolean }) {
    return (
      <aside
        className={[
          "w-72 bg-sidebar text-sidebar-foreground flex flex-col h-full border-r border-sidebar-border",
          mobile ? "shadow-2xl" : "",
        ].join(" ")}
      >
        {/* Brand header */}
        <div className="px-5 py-5 border-b border-sidebar-border">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-primary to-[hsl(150_30%_22%)] flex items-center justify-center shrink-0 shadow-sm">
              <Sprout className="h-5 w-5 text-primary-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-sm text-sidebar-foreground truncate">Tree Friend</p>
              <p className="text-[11px] text-sidebar-foreground/60">Seller Center</p>
            </div>
            {mobile && (
              <button
                onClick={() => setSidebarOpen(false)}
                className="p-1.5 rounded-lg text-sidebar-foreground/60 hover:bg-sidebar-accent/40"
                aria-label="Close menu"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Vacation notice */}
        {onVacation && (
          <div className="mx-4 mt-3 bg-warning border border-warning-border rounded-xl px-3 py-2.5 text-[11px] text-warning-foreground leading-relaxed">
            <p className="font-semibold mb-0.5">Vacation mode active</p>
            <p className="text-warning-foreground">Listings, Orders, Payment, and Courier are paused. Turn it off in Business Profile.</p>
          </div>
        )}

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mb-5">
              <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.items.map(({ id, label, icon: Icon }) => {
                  const disabled = isNavDisabled(id);
                  const isActive = activeSection === id;
                  return (
                    <button
                      key={id}
                      onClick={() => handleNavigate(id)}
                      disabled={disabled}
                      aria-current={isActive ? "page" : undefined}
                      className={[
                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 group",
                        disabled
                          ? "text-sidebar-foreground/30 cursor-not-allowed"
                          : isActive
                            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                            : "text-sidebar-foreground/70 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground",
                      ].join(" ")}
                    >
                      <Icon
                        className={[
                          "h-[18px] w-[18px] shrink-0 transition-colors",
                          isActive ? "text-sidebar-primary-foreground" : "",
                        ].join(" ")}
                      />
                      <span className="flex-1 text-left truncate">{label}</span>
                      {id === "orders" && !disabled && pendingOrdersCount > 0 && (
                        <span
                          className={[
                            "text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center tabular-nums",
                            isActive
                              ? "bg-sidebar-primary-foreground/20 text-sidebar-primary-foreground"
                              : "bg-sidebar-accent text-sidebar-accent-foreground",
                          ].join(" ")}
                        >
                          {pendingOrdersCount}
                        </span>
                      )}
                      {isActive && !disabled && (
                        <ChevronRight className="h-3.5 w-3.5 text-sidebar-primary-foreground/70" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Store card */}
        <div className="px-3 pb-3">
          <div className="rounded-xl bg-sidebar-accent/30 border border-sidebar-border p-3">
            <div className="flex items-center gap-2.5">
              <Avatar className="h-9 w-9 border border-sidebar-border shrink-0">
                {activeSeller.logoUrl ? (
                  <img src={activeSeller.logoUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <AvatarFallback className="bg-gradient-to-br from-primary to-[hsl(150_30%_22%)] text-primary-foreground text-xs font-bold">
                    {storeInitial}
                  </AvatarFallback>
                )}
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-sidebar-foreground truncate">
                  {activeSeller.businessName}
                </p>
                <p className="text-[11px] text-sidebar-foreground/60 truncate flex items-center gap-1">
                  {activeSeller.isVerified && <BadgeCheck className="h-3 w-3 text-success-foreground" />}
                  {activeSeller.location || "No location"}
                </p>
              </div>
            </div>
            <div className="mt-2.5 flex items-center gap-1.5">
              <Link href={`/seller/${activeSeller.id}`} className="flex-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full h-7 text-[11px] text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  View store
                </Button>
              </Link>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px] text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
                onClick={() => signOut?.()}
                title="Sign out"
              >
                <LogOut className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </div>

        {/* User row */}
        <div className="px-4 py-3 border-t border-sidebar-border">
          <div className="flex items-center gap-2.5">
            <Avatar className="h-8 w-8 shrink-0">
              <AvatarFallback className="bg-secondary text-secondary-foreground text-[11px] font-bold">
                {ownerInitial}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-sidebar-foreground truncate">
                {activeSeller.ownerName || (me as any)?.firstName || "Seller"}
              </p>
              <p className="text-[11px] text-sidebar-foreground/60 truncate">
                {(me as any)?.email || "Signed in"}
              </p>
            </div>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <div className="flex h-screen bg-background overflow-hidden font-sans">
      {/* Desktop sidebar */}
      <div className="hidden md:flex shrink-0">
        <Sidebar />
      </div>

      {/* Mobile sidebar */}
      {sidebarOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50 md:hidden">
            <Sidebar mobile />
          </div>
        </>
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="h-16 bg-card border-b border-border flex items-center justify-between px-4 sm:px-6 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden p-2 rounded-lg hover:bg-muted transition-colors shrink-0"
              aria-label="Open navigation menu"
            >
              <Menu className="h-5 w-5 text-muted-foreground" />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="font-semibold text-foreground text-sm sm:text-base truncate">
                  {activeNav?.label ?? "Dashboard"}
                </h1>
                {onVacation && (
                  <span className="hidden sm:inline-flex text-[10px] font-medium text-warning-foreground bg-warning ring-1 ring-warning-border rounded-full px-2 py-0.5">
                    Vacation
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground hidden sm:block truncate">
                {seller.businessName}
                {seller.location ? ` · ${seller.location}` : ""}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Link href="/">
              <Button
                size="sm"
                variant="ghost"
                className="hidden sm:inline-flex h-9 text-muted-foreground hover:text-foreground"
                title="Back to store"
              >
                <ExternalLink className="h-4 w-4 mr-1.5" />
                Store
              </Button>
            </Link>
            <Avatar className="h-9 w-9 border border-border">
              <AvatarFallback className="bg-gradient-to-br from-primary to-[hsl(150_30%_22%)] text-primary-foreground text-xs font-bold">
                {ownerInitial}
              </AvatarFallback>
            </Avatar>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto bg-background">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
            {onVacation && activeSection === "profile" && (
              <div className="bg-warning border border-warning-border rounded-2xl px-4 py-3 mb-6 text-sm text-warning-foreground">
                You're on vacation mode — your listings are hidden from buyers and Listings/Orders/Payment/Courier are
                paused until you turn it off below.
              </div>
            )}
            {renderActiveSection()}
          </div>
        </main>
      </div>
    </div>
  );
}
