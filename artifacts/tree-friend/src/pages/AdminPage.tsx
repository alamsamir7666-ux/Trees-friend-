import { useState, useMemo, useRef, Fragment, useEffect, useCallback } from "react";
import { useDebounce } from "@/hooks/useDebounce";
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
import { useGetMe } from "@workspace/api-client-react";
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
  BookOpen, FileText, Save, LayoutGrid, Store, Boxes, Wallet,
} from "lucide-react";
import { useAuth } from "@clerk/react";
import { apiClient } from "@/lib/apiClient";
import { AdminContext } from "@/contexts/AdminContext";
import { ProductModal } from "@/components/admin/modals/ProductModal";
import { CategoryModal } from "@/components/admin/modals/CategoryModal";
import { ConfirmDialog } from "@/components/admin/modals/ConfirmDialog";
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


const API = import.meta.env.VITE_API_BASE_URL ?? "";

// ??? Status helpers ?????????????????????????????????????????????????????????
const statusConfig: Record<string, { color: string; icon: React.ElementType }> = {
  pending:    { color: "bg-warning text-warning-foreground border-warning-border", icon: Clock },
  confirmed:  { color: "bg-info text-info-foreground border-info-border", icon: CheckCircle2 },
  processing: { color: "bg-info text-info-foreground border-info-border", icon: BarChart3 },
  shipped:    { color: "bg-info text-info-foreground border-info-border", icon: Truck },
  delivered:  { color: "bg-success text-success-foreground border-success-border", icon: CheckCircle2 },
  cancelled:       { color: "bg-destructive/10 text-destructive border-destructive/20", icon: XCircle },
  return_completed: { color: "bg-success text-success-foreground border-success-border", icon: RotateCcw },
};

// ??? Sidebar nav items ???????????????????????????????????????????????????????
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
  { id: "auditlogs",  label: "Audit Logs",       icon: Activity },
  { id: "qa",         label: "Q&A",              icon: HelpCircle },
  { id: "bulkimport",        label: "Bulk Import",       icon: Upload },
  { id: "homepage-sections", label: "Homepage Sections", icon: LayoutGrid },

  { id: "settings",   label: "Settings",         icon: Settings },
];

// ??? Product form ????????????????????????????????????????????????????????????

// ??? Category form ????????????????????????????????????????????????????????????
export function AdminPage() {
  console.log("[AdminPage] component function called - fresh mount or re-render");
  const [cdg, setCdg] = useState<{open:boolean;title:string;message:string;onConfirm:()=>void;danger:boolean}>({open:false,title:"",message:"",onConfirm:()=>{},danger:true});
  const askConfirm = (title:string,message:string,cb:()=>void,danger=true) => setCdg({open:true,title,message,onConfirm:cb,danger});
  const closeCdg = () => setCdg(d=>({...d,open:false}));
  const qc = useQueryClient();
  const adminMountRef = useRef(false);
  useEffect(() => {
    console.log("[AdminPage] MOUNT EFFECT - was already mounted before:", adminMountRef.current);
    adminMountRef.current = true;
  }, []);
  const { getToken } = useAuth();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [productsPage, setProductsPage] = useState(1);
  const { data: productsData, isLoading: productsLoading } = useListProducts({ limit: 25, page: productsPage, search: debouncedSearch || undefined });
  const [allProducts, setAllProducts] = useState<any[]>([]);
  const productsHasMore = productsData ? allProducts.length < (productsData.total ?? 0) : false;
  useEffect(() => { setProductsPage(1); setAllProducts([]); }, [debouncedSearch]);
  useEffect(() => {
    if (productsData?.products) {
      if (productsPage === 1) setAllProducts(productsData.products);
      else setAllProducts(prev => [...prev, ...productsData.products]);
    }
  }, [productsData, productsPage]);
  const [orders, setOrders] = useState<any[]>([]);
  const [adminPreOrders, setAdminPreOrders] = useState<any[]>([]);
  const fetchAdminPreOrders = async () => {
    try {
      const token = await getToken();
      // Now calls the admin-only /admin/pre-orders endpoint (added in
      // admin.ts), which (a) requires admin auth and (b) joins through
      // preOrders.sellerListingVariantId -> variant -> listing -> seller
      // so each pre-order carries the seller fields the redesigned
      // OrdersTab and ArchivedOrdersTab render in their Seller column.
      // Previously called the public GET /pre-orders endpoint which had
      // no auth and returned no seller context -- a leftover from
      // before the marketplace migration.
      const res = await fetch(`${API}/api/admin/pre-orders`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (Array.isArray(data)) setAdminPreOrders(data);
    } catch {}
  };
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersPage, setOrdersPage] = useState(1);
  const [ordersHasMore, setOrdersHasMore] = useState(false);
  const [ordersTotal, setOrdersTotal] = useState(0);
  const [dashStats, setDashStats] = useState<{totalSales:number,totalOrders:number,pendingOrders:number,deliveredOrders:number}>({totalSales:0,totalOrders:0,pendingOrders:0,deliveredOrders:0});
  const [dashStatsLoading, setDashStatsLoading] = useState(true);

  const fetchOrders = async (page: number, append = false) => {
    setOrdersLoading(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API}/api/admin/orders?page=${page}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.orders ?? []);
      setOrders(prev => append ? [...prev, ...list] : list);
      setOrdersHasMore(data.hasMore ?? list.length === 20);
      if (!append) setOrdersTotal(data.total ?? list.length);
      setOrdersPage(page);
    } catch (e: any) { console.error("fetchOrders error:", e?.message, e); }
    setOrdersLoading(false);
  };

  useEffect(() => {
    fetchOrders(1);
    fetchAdminPreOrders();
    setDashStatsLoading(true);
    getToken().then(token =>
      fetch(`${API}/api/admin/dashboard`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => {
          if (!r.ok) throw new Error(`Dashboard fetch failed: ${r.status}`);
          return r.json();
        })
        .then(data => {
          setDashStats({ totalSales: data.totalSales ?? 0, totalOrders: data.totalOrders ?? 0, pendingOrders: data.pendingOrders ?? 0, deliveredOrders: data.totalOrders != null && data.pendingOrders != null ? (data.totalOrders - data.pendingOrders) : 0 });
        })
        .catch((e) => console.error("Dashboard stats error:", e?.message))
        .finally(() => setDashStatsLoading(false))
    );
  }, []);
  const { data: users } = useListAllUsers({ query: { queryKey: getListAllUsersQueryKey() } });
  const { data: me } = useGetMe();
  const { data: categories = [] } = useListCategories({ query: { staleTime: 30_000, queryKey: getListCategoriesQueryKey() } });
  const { data: allReviews = [], isLoading: reviewsLoading } = useListAllReviews();

  const deleteProduct = useDeleteProduct();
  const deleteCategory = useDeleteCategory();
  const updateOrderStatus = useUpdateOrderStatus();
  const deleteReview = useDeleteReview();
  const toggleUserBlock = useToggleUserBlock();

  const [activeTab, setActiveTab] = useState("dashboard");
  useEffect(() => {
    console.log("[activeTab] changed to:", activeTab);
  }, [activeTab]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<any>(null);
  const [showProductModal, setShowProductModal] = useState(false);
  const [editingCategory, setEditingCategory] = useState<any>(null);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [orderSearch, setOrderSearch] = useState("");
  const [expandedOrderId, setExpandedOrderId] = useState<number | string | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const [reviewSearch, setReviewSearch] = useState("");
  const [archivedOrders, setArchivedOrders] = useState<any[]>([]);
  const [archivedPreOrders, setArchivedPreOrders] = useState<any[]>([]);
  const [archivedPage, setArchivedPage] = useState(1);
  const [archivedHasMore, setArchivedHasMore] = useState(false);
  const [archivedTotal, setArchivedTotal] = useState(0);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedError, setArchivedError] = useState<string|null>(null);
  const [activeOrdersCount, setActiveOrdersCount] = useState(0);
  const [seedingCategories, setSeedingCategories] = useState(false);

  // Monthly history state
  const [monthlyRecords, setMonthlyRecords] = useState<any[]>([]);
  const [monthlyLoading, setMonthlyLoading] = useState(false);

  // Debounced search values (prevent filtering on every keystroke)

  const debouncedOrderSearch = useDebounce(orderSearch, 300);
  const debouncedUserSearch = useDebounce(userSearch, 300);

  // Cancellation reason modal state
  const [cancelModal, setCancelModal] = useState<{ orderId: number; reason: string } | null>(null);

  // Fetch monthly records when tab is active
  const fetchMonthlyRecords = useCallback(async () => {
    setMonthlyLoading(true);
    try {
      const token = await getToken();
      const res = await fetch(API+"/api/admin/monthly-records", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      setMonthlyRecords(Array.isArray(data) ? data : []);
    } catch {
      setMonthlyRecords([]);
    } finally {
      setMonthlyLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (activeTab === "orders") fetchAdminPreOrders();
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "monthly") fetchMonthlyRecords();
  }, [activeTab, fetchMonthlyRecords]);

  async function handleArchiveNow() {
    if (!window.confirm("Archive last month's data now?")) return;
    const token = await getToken();
    const res = await fetch(API+"/api/admin/monthly-records/archive", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = await res.json();
    alert(result.message);
    fetchMonthlyRecords();
  }

  const products = allProducts;

  const { data: tagCounts = {} } = useQuery({
    queryKey: ["products", "tag-counts"],
    queryFn: async () => {
      const { data } = await apiClient.get<Record<string, number>>("/api/products/tag-counts");
      return data;
    },
    staleTime: 30_000,
  });

  const filteredProducts = useMemo(() => {
    if (!debouncedSearch.trim()) return products;
    const q = debouncedSearch.toLowerCase();
    return products.filter(p =>
      (p.name ?? "").toLowerCase().includes(q) ||
      (p.category ?? "").toLowerCase().includes(q)
    );
  }, [products, debouncedSearch]);

  const recentCombined = [...orders, ...adminPreOrders.map((o: any) => ({
    id: o.id, createdAt: o.createdAt, totalAmount: o.totalAmount ?? (Number(o.discountedPrice ?? 0) + Number(o.deliveryCharge ?? 0)),
    orderStatus: o.status ?? "pre-order", _type: "preorder"
  } as any))].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5);

  const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
  const fetchArchivedOrders = async (page: number, append = false) => {
    setArchivedLoading(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API}/api/admin/orders/archived?page=${page}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setArchivedOrders(prev => append ? [...prev, ...data.orders] : data.orders);
      if (Array.isArray(data.preOrders)) setArchivedPreOrders(data.preOrders);
      setArchivedHasMore(data.hasMore);
      setArchivedTotal(data.total);
      setArchivedPage(page);
      setArchivedError(null);
    } catch (e: any) {
      setArchivedError(e.message ?? "Failed to load");
    }
    setArchivedLoading(false);
  };

  useEffect(() => {
    fetchArchivedOrders(1);
    // Fetch real order counts for badges
    getToken().then(token =>
      fetch(`${API}/api/admin/orders/stats`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(data => {
          setActiveOrdersCount(data.activeOrders);
          setArchivedTotal(data.archivedOrders);
        })
        .catch(() => {})
    );
  }, []);

  const filteredOrders = useMemo(
    () => {
      const preOrdersMapped = adminPreOrders.map((o: any) => ({ ...o, _type: "preorder", orderStatus: o.status }));
      const allOrders = [...orders, ...preOrdersMapped].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return allOrders.filter(o => {
        return !orderSearch ||
          String(o.id).includes(orderSearch) ||
          ((o as any).orderStatus ?? "").toLowerCase().includes(orderSearch.toLowerCase()) ||
          ((o as any).status ?? "").toLowerCase().includes(orderSearch.toLowerCase()) ||
          ((o as any).userName ?? "").toLowerCase().includes(orderSearch.toLowerCase()) ||
          ((o as any).userEmail ?? "").toLowerCase().includes(orderSearch.toLowerCase());
      });
    },
    [orders, adminPreOrders, orderSearch]
  );

  function handleDeleteProduct(id: number) {
    askConfirm("Delete Product", "This product will be permanently deleted and cannot be recovered.", () => {
      deleteProduct.mutate({ id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getListProductsQueryKey() }) });
    });
  }

  // Filtered reviews with search
  const filteredReviews = useMemo(() =>
    !reviewSearch
      ? (allReviews as any[])
      : (allReviews as any[]).filter(r =>
          r.productName?.toLowerCase().includes(reviewSearch.toLowerCase()) ||
          r.userName?.toLowerCase().includes(reviewSearch.toLowerCase()) ||
          r.comment?.toLowerCase().includes(reviewSearch.toLowerCase())
        ),
    [allReviews, reviewSearch]
  );

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
      const token = await getToken();
      await fetch(API+"/api/categories/seed", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      qc.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
    } finally {
      setSeedingCategories(false);
    }
  }

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const currentMonthOrders = orders.filter(o => new Date(o.createdAt) >= startOfMonth);
  const totalRevenue = dashStats.totalSales;
  const totalOrdersThisMonth = dashStats.totalOrders;
  const pendingOrders = dashStats.pendingOrders;
  const deliveredOrders = dashStats.deliveredOrders;

  // ??? Sidebar ???????????????????????????????????????????????????????????????
  const Sidebar = ({ mobile = false }: { mobile?: boolean }) => (
    <aside className={`${mobile ? "w-64" : "w-64"} bg-card border-r flex flex-col h-full`}>
      <div className="px-6 py-5 border-b">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center">
            <span className="text-primary-foreground text-xs font-bold">EE</span>
          </div>
          <div>
            <p className="font-semibold text-sm text-foreground">Tree Friend</p>
            <p className="text-xs text-muted-foreground">Admin Panel</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => { setActiveTab(id); setSidebarOpen(false); }}
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
                {ordersTotal + adminPreOrders.length}
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
              {(me as any)?.firstName?.[0] ?? "A"}
            </span>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-foreground truncate">{(me as any)?.firstName} {(me as any)?.lastName}</p>
            <p className="text-xs text-muted-foreground">Administrator</p>
          </div>
        </div>
      </div>
    </aside>
  );

  // ??? Dashboard Tab ?????????????????????????????????????????????????????????


  // ??? Categories Tab ?????????????????????????????????????????????????????????


  // ??📦 Orders Tab ????????????????????????????????????????????????????????????


  // ??⭐ Users Tab ?????????????????????????????????????????????????????????????


  // ??? Reviews Tab ???????????????????????????????????????????????????????????


  // ??? Archived Orders Tab ????????????????????????????????????????????????????


  // ??? Monthly History Tab ???????????????????????????????????????????????????


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
      case "auditlogs":  return <AuditLogsTab />;
      case "qa":         return <QATab />;
      case "bulkimport":        return <BulkImportTab />;
      case "homepage-sections": return <HomepageSectionsTab />;
      default:                  return <DashboardTab />;
    }
  }

  const activeNav = navItems.find(n => n.id === activeTab);

  const adminContextValue = {
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

    // Coupons (removed from admin — now managed by sellers in their dashboard)
    coupons: [], couponsLoading: false,
    editingCoupon: null, setEditingCoupon: () => {},
    showCouponModal: false, setShowCouponModal: () => {},
    couponSaving: false, setCouponSaving: () => {}, setCoupons: () => {},

    monthlyRecords, monthlyLoading,
    dashStats, dashStatsLoading, activeOrdersCount,
    askConfirm, getToken,
    setActiveTab,
    totalRevenue, deliveredOrders, recentCombined, statusConfig,
    products: allProducts,
    productsData,
    pendingOrders: dashStats.pendingOrders,
    handleDeleteCategory, handleDeleteReview, handleToggleBlock,
    // Coupon handlers removed from admin — sellers manage their own coupons now.
    handleDeleteCoupon: () => {}, handleToggleCoupon: () => {},
    handleArchiveNow,
    fetchOrders, fetchAdminPreOrders,
    handleSeedCategories,
    totalOrdersThisMonth,
    filteredReviews, filteredCoupons: [],
    debouncedUserSearch,
  };

  return (
    <AdminContext.Provider value={adminContextValue as any}>
    <div className="flex h-screen bg-background overflow-hidden font-sans">
      <div className="hidden md:flex shrink-0">
        <Sidebar />
      </div>

      {sidebarOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-sm md:hidden" onClick={() => setSidebarOpen(false)} />
          <div className="fixed inset-y-0 left-0 z-50 md:hidden">
            <Sidebar mobile />
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
              <span className="text-primary-foreground text-xs font-bold">{(me as any)?.firstName?.[0] ?? "A"}</span>
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
          categories={categories as any[]}
          tagCounts={tagCounts}
          onClose={() => { setShowProductModal(false); setEditingProduct(null); }}
          onProductUpdated={(p) => setAllProducts(prev => prev.map((x: any) => x.id === p.id ? { ...x, ...p } : x))}
        />
      )}

      {/* CategoryModal is now rendered locally inside CategoriesTab, which
          knows the current drill-down level and passes fixedParentId. */}

      {/* Cancellation Reason Modal */}
      <ConfirmDialog open={cdg.open} title={cdg.title} message={cdg.message} onConfirm={()=>{cdg.onConfirm();closeCdg();}} onCancel={closeCdg} danger={cdg.danger} />
      <Dialog open={!!cancelModal} onOpenChange={(open) => { if (!open) setCancelModal(null); }}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Cancel Order</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">Provide a reason for cancellation (optional). This will be visible to the customer.</p>
            <Textarea
              placeholder="e.g. Item out of stock, customer requested cancellation?"
              className="rounded-xl resize-none text-sm"
              rows={3}
              value={cancelModal?.reason ?? ""}
              onChange={e => setCancelModal(m => m ? { ...m, reason: e.target.value } : m)}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="rounded-xl" onClick={() => setCancelModal(null)}>
              Keep Order
            </Button>
            <Button
              className="rounded-xl bg-destructive hover:bg-destructive/90 text-destructive-foreground"
              disabled={updateOrderStatus.isPending}
              onClick={confirmCancellation}
            >
              Confirm Cancellation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </AdminContext.Provider>
  );
}
