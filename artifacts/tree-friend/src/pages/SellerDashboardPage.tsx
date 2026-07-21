import { useState, useEffect } from "react";
import { Link } from "wouter";
import {
  LayoutDashboard, Package2, ShoppingCart, Wallet, Truck, Store,
  Sprout, Loader2, Menu,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { updateSEO } from "@/lib/seo";
import { useGetMySeller, useListSellerOrders, useGetMe } from "@workspace/api-client-react";
import { SellerOverviewTab } from "@/components/seller/SellerOverviewTab";
import { SellerListingsTab } from "@/components/seller/SellerListingsTab";
import { SellerOrdersTab } from "@/components/seller/SellerOrdersTab";
import { CourierSettingsForm } from "@/components/seller/CourierSettingsForm";
import { PaymentSettingsForm } from "@/components/seller/PaymentSettingsForm";
import { BusinessProfileForm } from "@/components/seller/BusinessProfileForm";

updateSEO({ title: "Seller Dashboard", noIndex: true });

/**
 * Seller dashboard -- plan doc §4's "Upload Listing" + "Manage Inventory"
 * (phase 2), plus Manage Orders + Courier Settings (plan doc §8, Part 4),
 * plus Payment Settings (plan doc §7, seller_payment_configs, Part 6),
 * plus Business Profile / Vacation Mode / Business Verification doc
 * upload (plan doc §4 items 1/2/3/5, Part 7 -- Store Settings folded into
 * Business Profile since no sellers-table field was left uncovered).
 * Manage Discounts (plan §4 item 4) is NOT a separate section here --
 * satisfied by the existing per-listing discountPrice field above.
 *
 * Shell rebuilt for visual/navigational parity with AdminPage.tsx: a
 * persistent left sidebar (not shadcn Tabs) drives an activeSection state,
 * matching admin's activeTab pattern exactly. See handoff doc for the nav
 * grouping rationale and a note on the breadcrumb -> header-title swap.
 */

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "listings", label: "Listings", icon: Package2 },
  { id: "orders", label: "Orders", icon: ShoppingCart },
  { id: "payment", label: "Payment Settings", icon: Wallet },
  { id: "courier", label: "Courier Settings", icon: Truck },
  { id: "profile", label: "Business Profile", icon: Store },
] as const;

type SectionId = (typeof NAV_ITEMS)[number]["id"];

export function SellerDashboardPage() {
  const { data: seller, isLoading: sellerLoading } = useGetMySeller();
  const { data: me } = useGetMe();

  const [activeSection, setActiveSection] = useState<SectionId>("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // `seller` loads asynchronously, so we can't know onVacation at the
  // useState() call above -- sync it in once the seller data arrives.
  // Restores the pre-redesign behavior (defaultValue={onVacation ? "profile"
  // : "listings"}), just adapted to this async-loaded, effect-driven shell.
  // Only forces the jump on vacation entry, never fights the seller's own
  // clicks around the (still-enabled) Business Profile section afterward.
  useEffect(() => {
    if (seller?.status === "vacation") {
      setActiveSection("profile");
    }
  }, [seller?.status]);

  // Pending-order count for the Orders nav badge. Only fetched once the
  // seller is active (same data source SellerOrdersTab itself uses --
  // useListSellerOrders({}) -- no new endpoint).
  const { data: allOrders } = useListSellerOrders(
    {},
    { query: { enabled: seller?.status === "active" } } as any,
  );
  const pendingOrdersCount = (allOrders ?? []).filter((o) => o.orderStatus === "pending").length;

  if (sellerLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // No seller account, or a status where nothing here applies yet
  // (pending review / suspended) -- send them to the become-seller status
  // page rather than showing an empty dashboard. "vacation" is NOT
  // included here -- a vacationing seller still needs to reach Business
  // Profile to turn vacation off, so they fall through to the dashboard
  // below with only that section enabled instead of being locked out
  // entirely. This early return happens before the sidebar shell renders,
  // exactly as before the redesign.
  if (!seller || (seller.status !== "active" && seller.status !== "vacation")) {
    return (
      <div className="container mx-auto px-4 py-16 max-w-lg text-center">
        <Sprout className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
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
  // Vacation mode gating: identical logic to the pre-redesign Tabs
  // disabled-prop gating, now applied to nav items instead. Only Business
  // Profile stays reachable so the seller can turn vacation off.
  const isNavDisabled = (id: SectionId) => onVacation && id !== "profile";

  function handleNavigate(id: string) {
    const target = NAV_ITEMS.find((n) => n.id === id);
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

  const activeNav = NAV_ITEMS.find((n) => n.id === activeSection);
  const ownerInitial = seller.ownerName?.[0] ?? (me as any)?.firstName?.[0] ?? "S";

  const Sidebar = ({ mobile = false }: { mobile?: boolean }) => (
    <aside className="w-64 bg-white border-r flex flex-col h-full">
      <div className="px-6 py-5 border-b">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-pink-400 to-rose-500 flex items-center justify-center">
            <Sprout className="h-4 w-4 text-white" />
          </div>
          <div>
            <p className="font-semibold text-sm text-gray-900">Tree Friend</p>
            <p className="text-xs text-gray-400">Seller Panel</p>
          </div>
        </div>
      </div>

      {onVacation && (
        <div className="mx-3 mt-3 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-xs text-amber-800">
          On vacation mode — Listings, Orders, Payment, and Courier are paused. Turn it off in Business Profile.
        </div>
      )}

      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
          const disabled = isNavDisabled(id);
          return (
            <button
              key={id}
              onClick={() => handleNavigate(id)}
              disabled={disabled}
              aria-current={activeSection === id ? "page" : undefined}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 ${
                disabled
                  ? "text-gray-300 cursor-not-allowed"
                  : activeSection === id
                    ? "bg-pink-50 text-pink-600"
                    : "text-gray-500 hover:bg-gray-50 hover:text-gray-800"
              }`}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" />
              {label}
              {id === "orders" && !disabled && pendingOrdersCount > 0 && (
                <span className="ml-auto bg-pink-100 text-pink-600 text-xs font-semibold px-2 py-0.5 rounded-full">
                  {pendingOrdersCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="px-4 py-4 border-t">
        <div className="flex items-center gap-3 px-2">
          <div className="h-8 w-8 rounded-full bg-gradient-to-br from-pink-300 to-rose-400 flex items-center justify-center shrink-0">
            <span className="text-white text-xs font-bold">{ownerInitial}</span>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-gray-800 truncate">{seller.ownerName || seller.businessName}</p>
            <p className="text-xs text-gray-400">Seller</p>
          </div>
        </div>
      </div>
    </aside>
  );

  return (
    <div className="flex h-screen bg-background overflow-hidden font-sans">
      <div className="hidden md:flex shrink-0">
        <Sidebar />
      </div>

      {sidebarOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm md:hidden" onClick={() => setSidebarOpen(false)} />
          <div className="fixed inset-y-0 left-0 z-50 md:hidden">
            <Sidebar mobile />
          </div>
        </>
      )}

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-16 bg-white border-b flex items-center justify-between px-5 shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden p-2 rounded-lg hover:bg-gray-100 transition-colors"
              aria-label="Open navigation menu"
            >
              <Menu className="h-5 w-5 text-gray-500" />
            </button>
            <div>
              <h1 className="font-semibold text-gray-900 text-sm sm:text-base">{activeNav?.label ?? "Dashboard"}</h1>
              <p className="text-xs text-gray-400 hidden sm:block">{seller.businessName} · {seller.location}</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-pink-300 to-rose-400 flex items-center justify-center">
              <span className="text-white text-xs font-bold">{ownerInitial}</span>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
          <div className="max-w-7xl mx-auto">
            {onVacation && activeSection === "profile" && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 mb-6 text-sm text-amber-800">
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
