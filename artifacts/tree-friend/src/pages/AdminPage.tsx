import { useState, useMemo, useRef, Fragment, useEffect, useCallback, memo } from "react";
import { useDebounce } from "@/hooks/useDebounce";
import { useAdminOrders } from "@/hooks/useAdminOrders";
import { useAdminArchived } from "@/hooks/useAdminArchived";
import { useAdminDashboard } from "@/hooks/useAdminDashboard";
import { useAdminMonthly } from "@/hooks/useAdminMonthly";
import {
  useListProducts, useCreateProduct, useUpdateProduct, useDeleteProduct,
  getGetFeaturedProductsQueryKey, getGetHomepageProductsQueryKey,
  useListAllOrders, useUpdateOrderStatus,
  useListAllUsers, useToggleUserBlock,
  useListCategories, useCreateCategory, useUpdateCategory, useDeleteCategory,
  useListAllReviews, useDeleteReview,
  getListProductsQueryKey, getListAllOrdersQueryKey, getListCategoriesQueryKey, getListAllUsersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useMe } from "@/hooks/useMe";
import type { Product, AdminReview } from "@workspace/api-client-react";
import type {
  AdminPreOrder,
  AdminOrder,
  ArchivedOrder,
  MonthlyRecord,
  AdminUser,
  AdminContextValue,
} from "@/contexts/AdminContext";
import { useApiJson } from "@/lib/useApiFetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  LayoutDashboard, Package2, ShoppingCart, Users, Tag, Settings,
  Plus, Pencil, Trash2, Search, TrendingUp, DollarSign, Star,
  ChevronRight, X, Menu, BarChart3, CheckCircle2, Clock, Truck,
  AlertCircle, XCircle, Layers, MessageSquare, MapPin, Ban, UserCheck, ChevronDown, Archive,
  Calendar, RotateCcw, Activity, Upload, HelpCircle,
  BookOpen, FileText, Save, LayoutGrid, Store, Boxes, Wallet, Sparkles,
} from "lucide-react";
import { useAuth } from "@clerk/react";
import { apiClient } from "@/lib/apiClient";
import { AdminContext } from "@/contexts/AdminContext";
import { ProductModal } from "@/components/admin/modals/ProductModal";
import { CategoryModal } from "@/components/admin/modals/CategoryModal";
import { ConfirmDialog } from "@/components/admin/modals/ConfirmDialog";
import { CancelOrderModal } from "@/components/admin/CancelOrderModal";
import { SettingsTab } from "@/components/admin/tabs/SettingsTab";
import { ReturnsTab } from "@/components/admin/tabs/ReturnsTab";
import { BlogTab } from "@/components/admin/tabs/BlogTab";
import { AuditLogsTab } from "@/components/admin/tabs/AuditLogsTab";
import { QATab } from "@/components/admin/tabs/QATab";
import { BulkImportTab } from "@/components/admin/tabs/BulkImportTab";
import { ProductsTab } from "@/components/admin/tabs/ProductsTab";
import { DashboardTab } from "@/components/admin/tabs/DashboardTab";
import { CategoriesTab } from "@/components/admin/tabs/CategoriesTab";
import { HomepageSectionsTab } from "@/components/admin/tabs/HomepageSectionsTab";
import { SellersTab } from "@/components/admin/tabs/SellersTab";
import { SellerListingsTab } from "@/components/admin/tabs/SellerListingsTab";
import { OrdersTab } from "@/components/admin/tabs/OrdersTab";
import { UsersTab } from "@/components/admin/tabs/UsersTab";
import { ReviewsTab } from "@/components/admin/tabs/ReviewsTab";
import { ArchivedOrdersTab } from "@/components/admin/tabs/ArchivedOrdersTab";
import { MonthlyHistoryTab } from "@/components/admin/tabs/MonthlyHistoryTab";
import { PaymentsTab } from "@/components/admin/tabs/PaymentsTab";
import { AiInsightsTab } from "@/components/admin/tabs/AiInsightsTab";
import { KbTab } from "@/components/admin/tabs/KbTab";

const API = import.meta.env.VITE_API_BASE_URL ?? "";

// ─── Status helpers ──────────────────────────────────────────────────────────
const statusConfig: Record<string, { color: string; icon: React.ElementType }> = {
  pending:    { color: "bg-warning text-warning-foreground border-warning-border", icon: Clock },
  confirmed:  { color: "bg-info text-info-foreground border-info-border", icon: CheckCircle2 },
  processing: { color: "bg-info text-info-foreground border-info-border", icon: BarChart3 },
  shipped:    { color: "bg-info text-info-foreground border-info-border", icon: Truck },
  delivered:  { color: "bg-success text-success-foreground border-success-border", icon: CheckCircle2 },
  cancelled:       { color: "bg-destructive/10 text-destructive border-destructive/20", icon: XCircle },
  return_completed: { color: "bg-success text-success-foreground border-success-border", icon: RotateCcw },
};

// ─── Sidebar nav items ───────────────────────────────────────────────────────
const navItems = [
  { id: "dashboard",  label: "Dashboard",       icon: LayoutDashboard },
  { id: "products",   label: "Products",        icon: Package2 },
  { id: "categories", label: "Categories",      icon: Layers },
  { id: "orders",     label: "Orders",          icon: ShoppingCart },
  { id: "archived",   label: "Archived Orders", icon: Archive },
  { id: "users",      label: "Users",           icon: Users },
  { id: "sellers",    label: "Sellers",         icon: Store },
  { id: "seller-listings", label: "Seller Listings", icon: Boxes },
  { id: "reviews",    label: "Reviews",         icon: MessageSquare },
  { id: "monthly",    label: "Monthly History", icon: Calendar },
  { id: "payments",   label: "Payments",        icon: Wallet },
  { id: "returns",    label: "Returns",          icon: RotateCcw },
  { id: "blog",       label: "Blog Posts",       icon: BookOpen },
  { id: "kb",         label: "Knowledge Base",   icon: BookOpen },
  { id: "auditlogs",  label: "Audit Logs",       icon: Activity },
  { id: "qa",         label: "Q&A",              icon: HelpCircle },
  { id: "bulkimport",        label: "Bulk Import",       icon: Upload },
  { id: "homepage-sections", label: "Homepage Sections", icon: LayoutGrid },
  { id: "ai-insights",       label: "TreeBot Insights",   icon: Sparkles },
  { id: "settings",   label: "Settings",         icon: Settings },
];

// ─── AdminSidebar (extracted to module scope + memoized) ─────────────────────
// Previously declared INSIDE AdminPage's render function, creating a new
// component identity on every render — causing React to remount the entire
// sidebar tree on every state change. Now module-level with explicit props.
interface AdminSidebarProps {
  mobile?: boolean;
  activeTab: string;
  onNavigate: (id: string) => void;
  onCloseMobile?: () => void;
  ordersTotal: number;
  adminPreOrdersCount: number;
  archivedTotal: number;
  adminName: string;
}

const AdminSidebar = memo(function AdminSidebar({
  mobile = false,
  activeTab,
  onNavigate,
  onCloseMobile,
  ordersTotal,
  adminPreOrdersCount,
  archivedTotal,
  adminName,
}: AdminSidebarProps) {
  return (
    <aside className="w-64 bg-card border-r flex flex-col h-full">
      <div className="px-6 py-5 border-b">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center">
            <span className="text-primary-foreground text-xs font-bold">TF</span>
          </div>
          <div>
            <p className="font-semibold text-sm text-foreground">Tree Friend</p>
            <p className="text-xs text-muted-foreground">Admin Panel</p>
          </div>
          {mobile && (
            <button
              onClick={onCloseMobile}
              className="ml-auto p-1.5 rounded-lg hover:bg-muted transition-colors"
              aria-label="Close menu"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => { onNavigate(id); if (mobile && onCloseMobile) onCloseMobile(); }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 ${
              activeTab === id
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <Icon className="h-[18px] w-[18px] shrink-0" />
            {label}
            {id === "orders" && ordersTotal > 0 && (
              <span className="ml-auto bg-primary/10 text-primary text-xs font-semibold px-2 py-0.5 rounded-full">
                {ordersTotal + adminPreOrdersCount}
              </span>
            )}
            {id === "archived" && archivedTotal > 0 && (
              <span className="ml-auto bg-muted text-muted-foreground text-xs font-semibold px-2 py-0.5 rounded-full">
                {archivedTotal}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="px-4 py-4 border-t">
        <div className="flex items-center gap-3 px-2">
          <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shrink-0">
            <span className="text-primary-foreground text-xs font-bold">
              {adminName[0] ?? "A"}
            </span>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-foreground truncate">{adminName}</p>
            <p className="text-xs text-muted-foreground">Administrator</p>
          </div>
        </div>
      </div>
    </aside>
  );
});

// ─── AdminPage (refactored) ──────────────────────────────────────────────────
export function AdminPage() {
  // ── Confirm dialog state ──────────────────────────────────────────────────
  const [cdg, setCdg] = useState<{ open: boolean; title: string; message: string; onConfirm: () => void; danger: boolean }>({ open: false, title: "", message: "", onConfirm: () => {}, danger: true });
  const askConfirm = (title: string, message: string, cb: () => void, danger = true) => setCdg({ open: true, title, message, onConfirm: cb, danger });
  const closeCdg = () => setCdg(d => ({ ...d, open: false }));

  // ── Core hooks ────────────────────────────────────────────────────────────
  const qc = useQueryClient();
  const { getToken } = useAuth();
  const apiJson = useApiJson();
  const { data: me } = useMe();

  // ── Tab + sidebar state ───────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // ── Products state ────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [productsPage, setProductsPage] = useState(1);
  const { data: productsData, isLoading: productsLoading } = useListProducts({ limit: 25, page: productsPage, search: debouncedSearch || undefined });
  const [allProducts, setAllProducts] = useState<(Product & { [key: string]: unknown })[]>([]);
  const productsHasMore = productsData ? allProducts.length < (productsData.total ?? 0) : false;

  useEffect(() => { setProductsPage(1); setAllProducts([]); }, [debouncedSearch]);
  useEffect(() => {
    if (productsData?.products) {
      const prods = productsData.products as unknown as (Product & { [key: string]: unknown })[];
      if (productsPage === 1) setAllProducts(prods);
      else setAllProducts(prev => [...prev, ...prods]);
    }
  }, [productsData, productsPage]);

  const [editingProduct, setEditingProduct] = useState<(Product & { [key: string]: unknown }) | null>(null);
  const [showProductModal, setShowProductModal] = useState(false);
  const [editingCategory, setEditingCategory] = useState<{ id: number; name: string; slug: string; parentId: number | null; [key: string]: unknown } | null>(null);
  const [showCategoryModal, setShowCategoryModal] = useState(false);

  // ── Orders (extracted to hook) ────────────────────────────────────────────
  const {
    orders, adminPreOrders, ordersLoading, ordersPage, ordersHasMore, ordersTotal,
    fetchOrders, fetchAdminPreOrders,
  } = useAdminOrders();

  // ── Archived orders (extracted to hook) ───────────────────────────────────
  const {
    archivedOrders, archivedPreOrders, archivedPage, archivedHasMore, archivedTotal,
    archivedLoading, archivedError, activeOrdersCount, fetchArchivedOrders,
  } = useAdminArchived();

  // ── Dashboard stats (extracted to hook) ───────────────────────────────────
  const { dashStats, dashStatsLoading } = useAdminDashboard();

  // ── Monthly records (extracted to hook) ───────────────────────────────────
  const { monthlyRecords, monthlyLoading, fetchMonthlyRecords } = useAdminMonthly(activeTab);

  // ── Other data queries ────────────────────────────────────────────────────
  const { data: users } = useListAllUsers({ query: { queryKey: getListAllUsersQueryKey() } });
  const { data: categories = [] } = useListCategories({ query: { staleTime: 30_000, queryKey: getListCategoriesQueryKey() } });
  const { data: allReviews = [], isLoading: reviewsLoading } = useListAllReviews();

  // ── Mutations ─────────────────────────────────────────────────────────────
  const deleteProduct = useDeleteProduct();
  const deleteCategory = useDeleteCategory();
  const updateOrderStatus = useUpdateOrderStatus();
  const deleteReview = useDeleteReview();
  const toggleUserBlock = useToggleUserBlock();

  // ── Search/filter state ───────────────────────────────────────────────────
  const [orderSearch, setOrderSearch] = useState("");
  const [expandedOrderId, setExpandedOrderId] = useState<number | string | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const [reviewSearch, setReviewSearch] = useState("");
  const [cancelModal, setCancelModal] = useState<{ orderId: number; reason: string } | null>(null);
  const [seedingCategories, setSeedingCategories] = useState(false);

  const debouncedOrderSearch = useDebounce(orderSearch, 300);
  const debouncedUserSearch = useDebounce(userSearch, 300);

  // ── Re-fetch pre-orders when orders tab is active ─────────────────────────
  useEffect(() => {
    if (activeTab === "orders") fetchAdminPreOrders();
  }, [activeTab, fetchAdminPreOrders]);

  // ── Tag counts ────────────────────────────────────────────────────────────
  const { data: tagCounts = {} } = useQuery({
    queryKey: ["products", "tag-counts"],
    queryFn: async () => {
      const { data } = await apiClient.get<Record<string, number>>("/api/products/tag-counts");
      return data;
    },
    staleTime: 30_000,
  });

  // ── Derived/memoized values ───────────────────────────────────────────────
  const products = allProducts;
  const filteredProducts = useMemo(() => {
    if (!debouncedSearch.trim()) return products;
    const q = debouncedSearch.toLowerCase();
    return products.filter(p => {
      const pAny = p as Product & { category?: string };
      return (p.name ?? "").toLowerCase().includes(q) || (pAny.category ?? "").toLowerCase().includes(q);
    });
  }, [products, debouncedSearch]);

  const filteredOrders = useMemo(() => {
    const preOrdersMapped: AdminOrder[] = adminPreOrders.map((o) => ({
      ...(o as unknown as AdminOrder),
      _type: "preorder",
      orderStatus: o.status ?? "pre-order",
      status: o.status,
    }));
    const allOrders = [...orders, ...preOrdersMapped].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return allOrders.filter(o => {
      return !orderSearch ||
        String(o.id).includes(orderSearch) ||
        (o.orderStatus ?? "").toLowerCase().includes(orderSearch.toLowerCase()) ||
        (o.status ?? "").toLowerCase().includes(orderSearch.toLowerCase()) ||
        ((o as AdminOrder & { userName?: string }).userName ?? "").toLowerCase().includes(orderSearch.toLowerCase()) ||
        ((o as AdminOrder & { userEmail?: string }).userEmail ?? "").toLowerCase().includes(orderSearch.toLowerCase());
    });
  }, [orders, adminPreOrders, orderSearch]);

  const filteredReviews = useMemo<(AdminReview & { productName?: string })[]>(
    () => {
      const reviews = allReviews as (AdminReview & { productName?: string })[];
      return !reviewSearch
        ? reviews
        : reviews.filter(r =>
            r.productName?.toLowerCase().includes(reviewSearch.toLowerCase()) ||
            r.userName?.toLowerCase().includes(reviewSearch.toLowerCase()) ||
            r.comment?.toLowerCase().includes(reviewSearch.toLowerCase())
          );
    },
    [allReviews, reviewSearch]
  );

  const recentCombined: AdminOrder[] = useMemo(() => [
    ...(orders as AdminOrder[]).map((o) => ({ ...o, _type: "order" as const })),
    ...adminPreOrders.map((o) => ({
      ...(o as unknown as AdminOrder),
      totalAmount: o.totalAmount ?? (Number(o.discountedPrice ?? 0) * Number(o.quantity ?? 1) + Number(o.deliveryCharge ?? 0)),
      orderStatus: o.status ?? "pre-order",
      _type: "preorder" as const,
      status: o.status,
    })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5) as AdminOrder[],
    [orders, adminPreOrders]
  );

  // ── Event handlers ────────────────────────────────────────────────────────
  function handleDeleteProduct(id: number) {
    askConfirm("Delete Product", "This product will be permanently deleted and cannot be recovered.", () => {
      deleteProduct.mutate({ id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getListProductsQueryKey() }) });
    });
  }

  function handleDeleteCategory(id: number) {
    askConfirm("Delete Category", "This category will be permanently deleted.", () => {
      deleteCategory.mutate({ id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getListCategoriesQueryKey() }) });
    });
  }

  function handleDeleteReview(productId: number, reviewId: number) {
    askConfirm("Delete Review", "This review will be permanently deleted.", () => {
      deleteReview.mutate({ productId, reviewId }, {
        onSuccess: () => qc.invalidateQueries({ queryKey: ["listAllReviews"] }),
      });
    });
  }

  function handleOrderStatus(orderId: number, status: string) {
    if (status === "cancelled") {
      setCancelModal({ orderId, reason: "" });
      return;
    }
    updateOrderStatus.mutate({ id: orderId, data: { orderStatus: status } }, {
      onSuccess: () => fetchOrders(1),
    });
  }

  function confirmCancellation() {
    if (!cancelModal) return;
    updateOrderStatus.mutate(
      { id: cancelModal.orderId, data: { orderStatus: "cancelled", cancellationReason: cancelModal.reason.trim() || null } },
      { onSuccess: () => { fetchOrders(1); setCancelModal(null); } }
    );
  }

  function handleToggleBlock(userId: number, isBlocked: boolean) {
    toggleUserBlock.mutate({ id: userId, data: { isBlocked } }, {
      onSuccess: () => qc.invalidateQueries({ queryKey: getListAllUsersQueryKey() }),
    });
  }

  async function handleSeedCategories() {
    setSeedingCategories(true);
    try {
      await apiJson("/api/categories/seed", { method: "POST" });
      qc.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
    } finally {
      setSeedingCategories(false);
    }
  }

  async function handleArchiveNow() {
    if (!window.confirm("Archive last month's data now?")) return;
    try {
      const result = await apiJson<{ message?: string }>("/api/admin/monthly-records/archive", { method: "POST" });
      alert(result.message ?? "Archived");
      fetchMonthlyRecords();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to archive");
    }
  }

  // ── Render active tab ─────────────────────────────────────────────────────
  function renderActiveTab() {
    switch (activeTab) {
      case "dashboard":  return <DashboardTab />;
      case "products":   return <ProductsTab />;
      case "categories": return <CategoriesTab />;
      case "orders":     return <OrdersTab />;
      case "archived":   return <ArchivedOrdersTab />;
      case "users":      return <UsersTab />;
      case "sellers":    return <SellersTab />;
      case "seller-listings": return <SellerListingsTab />;
      case "reviews":    return <ReviewsTab />;
      case "monthly":    return <MonthlyHistoryTab />;
      case "payments":   return <PaymentsTab />;
      case "settings":   return <SettingsTab />;
      case "returns":    return <ReturnsTab />;
      case "blog":       return <BlogTab />;
      case "kb":         return <KbTab />;
      case "auditlogs":  return <AuditLogsTab />;
      case "qa":         return <QATab />;
      case "bulkimport":        return <BulkImportTab />;
      case "homepage-sections": return <HomepageSectionsTab />;
      case "ai-insights":       return <AiInsightsTab />;
      default:                  return <DashboardTab />;
    }
  }

  const activeNav = navItems.find(n => n.id === activeTab);
  const adminName = `${me?.firstName ?? ""} ${me?.lastName ?? ""}`.trim() || "Admin";

  // ── Admin context value (memoized) ────────────────────────────────────────
  // Previously rebuilt on every render; now memoized so child components
  // using React.memo or useCallback don't get invalidated unnecessarily.
  const adminContextValue = useMemo(() => ({
    search, setSearch,
    orderSearch, setOrderSearch,
    userSearch, setUserSearch,
    reviewSearch, setReviewSearch,
    couponSearch: "", setCouponSearch: () => {},
    allProducts, filteredProducts,
    productsLoading, productsPage, setProductsPage,
    productsHasMore, editingProduct, setEditingProduct,
    showProductModal, setShowProductModal,
    handleDeleteProduct, categories,
    orders, adminPreOrders,
    ordersLoading, ordersPage, ordersHasMore, ordersTotal,
    filteredOrders, expandedOrderId, setExpandedOrderId,
    handleOrderStatusChange: handleOrderStatus, cancelModal, setCancelModal,
    editingCategory, setEditingCategory,
    showCategoryModal, setShowCategoryModal,
    seedingCategories, setSeedingCategories,
    users: users ?? [],
    usersLoading: false,
    reviews: allReviews,
    reviewsLoading,
    archivedOrders, archivedPreOrders,
    archivedPage, archivedHasMore, archivedTotal,
    archivedLoading, archivedError, fetchArchivedOrders,
    coupons: [], couponsLoading: false,
    editingCoupon: null, setEditingCoupon: () => {},
    showCouponModal: false, setShowCouponModal: () => {},
    couponSaving: false, setCouponSaving: () => {}, setCoupons: () => {},
    monthlyRecords, monthlyLoading,
    dashStats, dashStatsLoading, activeOrdersCount,
    askConfirm, getToken,
    setActiveTab,
    totalRevenue: dashStats.totalSales,
    deliveredOrders: dashStats.deliveredOrders,
    recentCombined, statusConfig,
    products: allProducts,
    productsData,
    pendingOrders: dashStats.pendingOrders,
    handleDeleteCategory, handleDeleteReview, handleToggleBlock,
    handleDeleteCoupon: () => {}, handleToggleCoupon: () => {},
    handleArchiveNow,
    fetchOrders: (page: number, append?: boolean) => fetchOrders(page, append),
    fetchAdminPreOrders: () => fetchAdminPreOrders(),
    handleSeedCategories,
    totalOrdersThisMonth: dashStats.totalOrders,
    filteredReviews, filteredCoupons: [],
    debouncedUserSearch,
  }), [
    search, allProducts, filteredProducts, productsLoading, productsPage,
    productsHasMore, editingProduct, showProductModal, categories,
    orders, adminPreOrders, ordersLoading, ordersPage, ordersHasMore, ordersTotal,
    filteredOrders, expandedOrderId, cancelModal,
    editingCategory, showCategoryModal, seedingCategories,
    users, allReviews, reviewsLoading,
    archivedOrders, archivedPreOrders, archivedPage, archivedHasMore, archivedTotal,
    archivedLoading, archivedError,
    monthlyRecords, monthlyLoading,
    dashStats, dashStatsLoading, activeOrdersCount,
    recentCombined, productsData,
    filteredReviews, debouncedUserSearch,
  ]);

  const adminContextValueTyped = adminContextValue as unknown as AdminContextValue;

  // ── Sidebar props ─────────────────────────────────────────────────────────
  const sidebarProps = {
    activeTab,
    onNavigate: (id: string) => setActiveTab(id),
    ordersTotal,
    adminPreOrdersCount: adminPreOrders.length,
    archivedTotal,
    adminName,
  };

  return (
    <AdminContext.Provider value={adminContextValueTyped}>
      <div className="flex h-screen bg-background overflow-hidden font-sans">
        <div className="hidden md:flex shrink-0">
          <AdminSidebar {...sidebarProps} />
        </div>

        {sidebarOpen && (
          <>
            <div className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-sm md:hidden" onClick={() => setSidebarOpen(false)} />
            <div className="fixed inset-y-0 left-0 z-50 md:hidden">
              <AdminSidebar mobile onCloseMobile={() => setSidebarOpen(false)} {...sidebarProps} />
            </div>
          </>
        )}

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <header className="h-16 bg-card border-b flex items-center justify-between px-5 shrink-0">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSidebarOpen(true)}
                className="md:hidden p-2 rounded-lg hover:bg-muted transition-colors"
              >
                <Menu className="h-5 w-5 text-muted-foreground" />
              </button>
              <div>
                <h1 className="font-semibold text-foreground text-sm sm:text-base">{activeNav?.label ?? "Dashboard"}</h1>
                <p className="text-xs text-muted-foreground hidden sm:block">Tree Friend Admin</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center">
                <span className="text-primary-foreground text-xs font-bold">{adminName[0] ?? "A"}</span>
              </div>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
            <div className="max-w-7xl mx-auto">
              {renderActiveTab()}
            </div>
          </main>
        </div>

        {(showProductModal || editingProduct) && (
          <ProductModal
            product={editingProduct}
            categories={categories}
            tagCounts={tagCounts}
            onClose={() => { setShowProductModal(false); setEditingProduct(null); }}
            onProductUpdated={(p) => setAllProducts(prev => prev.map((x) => x.id === p.id ? { ...x, ...p } : x))}
          />
        )}

        <ConfirmDialog open={cdg.open} title={cdg.title} message={cdg.message} onConfirm={() => { cdg.onConfirm(); closeCdg(); }} onCancel={closeCdg} danger={cdg.danger} />

        <CancelOrderModal
          open={!!cancelModal}
          reason={cancelModal?.reason ?? ""}
          onReasonChange={(reason) => setCancelModal(m => m ? { ...m, reason } : m)}
          onClose={() => setCancelModal(null)}
          onConfirm={confirmCancellation}
          isPending={updateOrderStatus.isPending}
        />
      </div>
    </AdminContext.Provider>
  );
}
