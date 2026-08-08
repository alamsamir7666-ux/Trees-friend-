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
  const [cdg, setCdg] = useState<{open:boolean;title:string;message:string;onConfirm:()=>void;danger:boolean}>({open:false,title:"",message:"",onConfirm:()=>{},danger:true});
  const askConfirm = (title:string,message:string,cb:()=>void,danger=true) => setCdg({open:true,title,message,onConfirm:cb,danger});
  const closeCdg = () => setCdg(d=>({...d,open:false}));
  const qc = useQueryClient();
  const adminMountRef = useRef(false);
  useEffect(() => {
    adminMountRef.current = true;
  }, []);
  const { getToken } = useAuth();
  const apiJson = useApiJson();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [productsPage, setProductsPage] = useState(1);
  const { data: productsData, isLoading: productsLoading } = useListProducts({ limit: 25, page: productsPage, search: debouncedSearch || undefined });
  const [allProducts, setAllProducts] = useState<(Product & { [key: string]: unknown })[]>([]);
  const productsHasMore = productsData ? allProducts.length < (productsData.total ?? 0) : false;
  useEffect(() => { setProductsPage(1); setAllProducts([]); }, [debouncedSearch]);
  useEffect(() => {
    if (productsData?.products) {
      // Cast through unknown — Product from the generated client doesn't
      // have the index signature our local AdminProduct type adds, but
      // the runtime shape is identical. The index signature is what lets
      // admin UI components read dynamic fields (homepageTag, images, etc.)
      // without `as any` casts at every access site.
      const prods = productsData.products as unknown as (Product & { [key: string]: unknown })[];
      if (productsPage === 1) setAllProducts(prods);
      else setAllProducts(prev => [...prev, ...prods]);
    }
  }, [productsData, productsPage]);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [adminPreOrders, setAdminPreOrders] = useState<AdminPreOrder[]>([]);
  // apiJson is created further down (after the order/preOrder state).
  // Forward-declare via ref so fetchAdminPreOrders / fetchOrders can use it.
  // (Simpler than reordering all the hooks.)
  const fetchAdminPreOrders = useCallback(async (api: ReturnType<typeof useApiJson>) => {
    try {
      // Calls the admin-only /admin/pre-orders endpoint (added in
      // admin.ts), which (a) requires admin auth and (b) joins through
      // preOrders.sellerListingVariantId -> variant -> listing -> seller
      // so each pre-order carries the seller fields the redesigned
      // OrdersTab and ArchivedOrdersTab render in their Seller column.
      // Previously called the public GET /pre-orders endpoint which had
      // no auth and returned no seller context -- a leftover from
      // before the marketplace migration.
      const data = await api<AdminPreOrder[]>("/api/admin/pre-orders");
      if (Array.isArray(data)) setAdminPreOrders(data);
    } catch {}
  }, []);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersPage, setOrdersPage] = useState(1);
  const [ordersHasMore, setOrdersHasMore] = useState(false);
  const [ordersTotal, setOrdersTotal] = useState(0);
  const [dashStats, setDashStats] = useState<{totalSales:number,totalOrders:number,pendingOrders:number,deliveredOrders:number}>({totalSales:0,totalOrders:0,pendingOrders:0,deliveredOrders:0});
  const [dashStatsLoading, setDashStatsLoading] = useState(true);

  const fetchOrders = useCallback(async (api: ReturnType<typeof useApiJson>, page: number, append = false) => {
    setOrdersLoading(true);
    try {
      const data = await api<{ orders?: AdminOrder[]; total?: number; hasMore?: boolean } | AdminOrder[]>(`/api/admin/orders?page=${page}`);
      const list: AdminOrder[] = Array.isArray(data) ? data : (data.orders ?? []);
      setOrders(prev => append ? [...prev, ...list] : list);
      setOrdersHasMore(Array.isArray(data) ? list.length === 20 : (data.hasMore ?? list.length === 20));
      if (!append) setOrdersTotal(Array.isArray(data) ? list.length : (data.total ?? list.length));
      setOrdersPage(page);
    } catch (e) {
      console.error("fetchOrders error:", e instanceof Error ? e.message : e);
    }
    setOrdersLoading(false);
  }, []);

  useEffect(() => {
    fetchOrders(apiJson, 1);
    fetchAdminPreOrders(apiJson);
    setDashStatsLoading(true);
    apiJson<{ totalSales?: number; totalOrders?: number; pendingOrders?: number }>("/api/admin/dashboard")
      .then((data) => {
        const totalOrders = data.totalOrders ?? 0;
        const pendingOrders = data.pendingOrders ?? 0;
        setDashStats({
          totalSales: data.totalSales ?? 0,
          totalOrders,
          pendingOrders,
          deliveredOrders: totalOrders - pendingOrders,
        });
      })
      .catch((e) => console.error("Dashboard stats error:", e instanceof Error ? e.message : e))
      .finally(() => setDashStatsLoading(false));
  }, [apiJson, fetchOrders, fetchAdminPreOrders]);
  const { data: users } = useListAllUsers({ query: { queryKey: getListAllUsersQueryKey() } });
  const { data: me } = useMe();
  const { data: categories = [] } = useListCategories({ query: { staleTime: 30_000, queryKey: getListCategoriesQueryKey() } });
  const { data: allReviews = [], isLoading: reviewsLoading } = useListAllReviews();

  const deleteProduct = useDeleteProduct();
  const deleteCategory = useDeleteCategory();
  const updateOrderStatus = useUpdateOrderStatus();
  const deleteReview = useDeleteReview();
  const toggleUserBlock = useToggleUserBlock();

  const [activeTab, setActiveTab] = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<(Product & { [key: string]: unknown }) | null>(null);
  const [showProductModal, setShowProductModal] = useState(false);
  const [editingCategory, setEditingCategory] = useState<{ id: number; name: string; slug: string; parentId: number | null; [key: string]: unknown } | null>(null);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [orderSearch, setOrderSearch] = useState("");
  const [expandedOrderId, setExpandedOrderId] = useState<number | string | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const [reviewSearch, setReviewSearch] = useState("");
  const [archivedOrders, setArchivedOrders] = useState<ArchivedOrder[]>([]);
  const [archivedPreOrders, setArchivedPreOrders] = useState<AdminPreOrder[]>([]);
  const [archivedPage, setArchivedPage] = useState(1);
  const [archivedHasMore, setArchivedHasMore] = useState(false);
  const [archivedTotal, setArchivedTotal] = useState(0);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedError, setArchivedError] = useState<string|null>(null);
  const [activeOrdersCount, setActiveOrdersCount] = useState(0);
  const [seedingCategories, setSeedingCategories] = useState(false);

  // Monthly history state
  const [monthlyRecords, setMonthlyRecords] = useState<MonthlyRecord[]>([]);
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
      const data = await apiJson<MonthlyRecord[]>("/api/admin/monthly-records");
      setMonthlyRecords(Array.isArray(data) ? data : []);
    } catch {
      setMonthlyRecords([]);
    } finally {
      setMonthlyLoading(false);
    }
  }, [apiJson]);

  useEffect(() => {
    if (activeTab === "orders") fetchAdminPreOrders(apiJson);
  }, [activeTab, apiJson, fetchAdminPreOrders]);

  useEffect(() => {
    if (activeTab === "monthly") fetchMonthlyRecords();
  }, [activeTab, fetchMonthlyRecords]);

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
    return products.filter(p => {
      // `category` isn't on the Product schema (products have
      // categoryId, not a denormalized category string), but the
      // admin /products endpoint may join it in. Read defensively.
      const pAny = p as Product & { category?: string };
      return (
        (p.name ?? "").toLowerCase().includes(q) ||
        (pAny.category ?? "").toLowerCase().includes(q)
      );
    });
  }, [products, debouncedSearch]);

  const recentCombined: AdminOrder[] = [
    ...(orders as AdminOrder[]).map((o) => ({
      ...o,
      _type: "order" as const,
    })),
    ...adminPreOrders.map((o) => ({
      ...(o as unknown as AdminOrder),
      totalAmount: o.totalAmount ?? (Number(o.discountedPrice ?? 0) * Number(o.quantity ?? 1) + Number(o.deliveryCharge ?? 0)),
      orderStatus: o.status ?? "pre-order",
      _type: "preorder" as const,
      status: o.status,
    })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5) as AdminOrder[];

  const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
  const fetchArchivedOrders = useCallback(async (page: number, append = false) => {
    setArchivedLoading(true);
    try {
      const data = await apiJson<{ orders: ArchivedOrder[]; preOrders?: AdminPreOrder[]; hasMore: boolean; total: number; error?: string }>(`/api/admin/orders/archived?page=${page}`);
      setArchivedOrders(prev => append ? [...prev, ...data.orders] : data.orders);
      if (Array.isArray(data.preOrders)) setArchivedPreOrders(data.preOrders);
      setArchivedHasMore(data.hasMore);
      setArchivedTotal(data.total);
      setArchivedPage(page);
      setArchivedError(null);
    } catch (e) {
      setArchivedError(e instanceof Error ? e.message : "Failed to load");
    }
    setArchivedLoading(false);
  }, [apiJson]);

  useEffect(() => {
    fetchArchivedOrders(1);
    // Fetch real order counts for badges
    apiJson<{ activeOrders?: number; archivedOrders?: number }>("/api/admin/orders/stats")
      .then((data) => {
        setActiveOrdersCount(data.activeOrders ?? 0);
        setArchivedTotal(data.archivedOrders ?? 0);
      })
      .catch(() => {});
  }, [apiJson, fetchArchivedOrders]);

  const filteredOrders = useMemo(
    () => {
      // Map pre-orders into AdminOrder shape so the combined list has a
      // single type. The pre-order's `status` field is preserved on the
      // mapped object so the orders tab can read it for pre-order rows.
      const preOrdersMapped: AdminOrder[] =
        adminPreOrders.map((o) => ({
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
    },
    [orders, adminPreOrders, orderSearch]
  );

  function handleDeleteProduct(id: number) {
    askConfirm("Delete Product", "This product will be permanently deleted and cannot be recovered.", () => {
      deleteProduct.mutate({ id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getListProductsQueryKey() }) });
    });
  }

  // Filtered reviews with search. `allReviews` comes from the generated
  // `useListAllReviews()` hook which returns `AdminReview[]` (with the
  // joined productName field the search filters on).
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
      onSuccess: () => fetchOrders(apiJson, 1),
    });
  }

  function confirmCancellation() {
    if (!cancelModal) return;
    updateOrderStatus.mutate(
      { id: cancelModal.orderId, data: { orderStatus: "cancelled", cancellationReason: cancelModal.reason.trim() || null } },
      { onSuccess: () => { fetchOrders(apiJson, 1); setCancelModal(null); } }
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
              {(me)?.firstName?.[0] ?? "A"}
            </span>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-foreground truncate">{(me)?.firstName} {(me)?.lastName}</p>
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
    // Wrap fetchOrders / fetchAdminPreOrders so consumers can call them
    // with the original (page, append?) / () signature — the underlying
    // implementations take `apiJson` as the first arg, but that's an
    // internal detail. The wrappers close over `apiJson` so consumers
    // don't need to pass it.
    fetchOrders: (page: number, append?: boolean) => fetchOrders(apiJson, page, append),
    fetchAdminPreOrders: () => fetchAdminPreOrders(apiJson),
    handleSeedCategories,
    totalOrdersThisMonth,
    filteredReviews, filteredCoupons: [],
    debouncedUserSearch,
  };

  // Cast through `unknown` because the generated `Category[]`, `AdminUser[]`,
  // `AdminReview[]` types from `@workspace/api-client-react` don't structurally
  // match our local `AdminCategory[]`, `AdminUser[]`, `Review[]` shapes (the
  // generated types lack the `[key: string]: unknown` index signature our
  // local interfaces add). Runtime shapes are identical; the cast just
  // bridges the index-signature gap without forcing `as any` at every
  // consumer access site.
  const adminContextValueTyped = adminContextValue as unknown as AdminContextValue;

  return (
    <AdminContext.Provider value={adminContextValueTyped}>
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
              <span className="text-primary-foreground text-xs font-bold">{(me)?.firstName?.[0] ?? "A"}</span>
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
