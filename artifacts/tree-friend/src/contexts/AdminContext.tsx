import { createContext, useContext } from "react";

export interface AdminProduct {
  id: number;
  name: string;
  categoryId: number | null;
  inStock: boolean;
  productStatus: string;
  [key: string]: unknown;
}

export interface AdminCategory {
  id: number;
  name: string;
  slug: string;
  parentId: number | null;
  [key: string]: unknown;
}

export interface AdminContextValue {
  // Search
  search: string;
  setSearch: (v: string) => void;
  orderSearch: string;
  setOrderSearch: (v: string) => void;
  userSearch: string;
  setUserSearch: (v: string) => void;
  reviewSearch: string;
  setReviewSearch: (v: string) => void;
  couponSearch: string;
  setCouponSearch: (v: string) => void;

  // Products
  allProducts: AdminProduct[];
  filteredProducts: AdminProduct[];
  productsLoading: boolean;
  productsPage: number;
  setProductsPage: (v: any) => void;
  productsHasMore: boolean;
  editingProduct: any;
  setEditingProduct: (v: any) => void;
  showProductModal: boolean;
  setShowProductModal: (v: boolean) => void;
  handleDeleteProduct: (id: number) => void;
  categories: AdminCategory[];

  // Orders
  orders: any[];
  adminPreOrders: any[];
  ordersLoading: boolean;
  ordersPage: number;
  ordersHasMore: boolean;
  ordersTotal: number;
  filteredOrders: any[];
  expandedOrderId: number | string | null;
  setExpandedOrderId: (v: number | string | null) => void;
  handleOrderStatusChange: (orderId: number, status: string) => void;
  cancelModal: { orderId: number; reason: string } | null;
  setCancelModal: (v: any) => void;

  // Categories
  editingCategory: any;
  setEditingCategory: (v: any) => void;
  showCategoryModal: boolean;
  setShowCategoryModal: (v: boolean) => void;
  seedingCategories: boolean;
  setSeedingCategories: (v: boolean) => void;

  // Users
  users: any[];
  usersLoading: boolean;

  // Reviews
  reviews: any[];
  reviewsLoading: boolean;

  // Archived
  archivedOrders: any[];
  archivedPreOrders: any[];
  archivedPage: number;
  archivedHasMore: boolean;
  archivedTotal: number;
  archivedLoading: boolean;
  archivedError: string | null;
  fetchArchivedOrders: (page: number, append?: boolean) => void;

  // Coupons
  coupons: any[];
  couponsLoading: boolean;
  editingCoupon: any;
  setEditingCoupon: (v: any) => void;
  showCouponModal: boolean;
  setShowCouponModal: (v: boolean) => void;
  couponSaving: boolean;
  setCouponSaving: (v: boolean) => void;
  setCoupons: (v: any) => void;

  // Monthly
  monthlyRecords: any[];
  monthlyLoading: boolean;

  // Dashboard
  dashStats: { totalSales: number; totalOrders: number; pendingOrders: number; deliveredOrders: number };
  dashStatsLoading: boolean;
  activeOrdersCount: number;

  // Shared
  askConfirm: (title: string, message: string, onConfirm: () => void, danger?: boolean) => void;
  getToken: () => Promise<string | null>;
  setActiveTab: (tab: string) => void;

  // Dashboard computed
  totalRevenue: number;
  deliveredOrders: number;
  recentCombined: any[];
  statusConfig: Record<string, { color: string; icon: any }>;
  products: AdminProduct[];
  productsData: any;
  pendingOrders: number;

  // Handlers
  handleDeleteCategory: (id: number) => void;
  handleDeleteReview: (productId: number, reviewId: number) => void;
  handleToggleBlock: (userId: number, isBlocked: boolean) => void;
  handleDeleteCoupon: (id: number) => void;
  handleToggleCoupon: (id: number) => void;
  handleArchiveNow: () => void;
  handleSeedCategories: () => void;
  totalOrdersThisMonth: number;
  fetchOrders: (page: number, append?: boolean) => void;
  fetchAdminPreOrders: () => void;

  // Computed
  filteredReviews: any[];
  filteredCoupons: any[];
  debouncedUserSearch: string;
}

export const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdminContext(): AdminContextValue {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error("useAdminContext must be used within AdminPage");
  return ctx;
}
