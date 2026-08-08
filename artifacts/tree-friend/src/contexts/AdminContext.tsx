import { createContext, useContext } from "react";
import type {
  Product,
  Order,
  Category,
  AdminReview,
} from "@workspace/api-client-react";

/**
 * AdminContext — shared state between AdminPage and its tab components.
 *
 * Previously this file was a 145-line god-object where ~30 fields were
 * typed `any` (editingProduct, orders, users, reviews, cancelModal
 * setter, statusConfig icons, etc.). The `any` typing propagated to
 * every consumer: 9 admin tab components all received `any` data, so
 * TypeScript couldn't catch shape drift between the API and the UI.
 *
 * This rewrite introduces proper types for the well-known shapes
 * (products, orders, categories, reviews) using the generated schemas
 * from `@workspace/api-client-react`. For admin-only response shapes
 * that aren't in the OpenAPI spec (e.g. `/admin/dashboard` stats,
 * `/admin/pre-orders` enriched rows, `/admin/orders/archived` rows),
 * we define minimal local interfaces that capture the fields the UI
 * actually reads — better than `any`, narrower than the full backend
 * response. If the API adds fields later, the UI doesn't need to
 * change; if the API removes a field the UI reads, TypeScript will
 * flag it at the consumer.
 */

// ─── Admin-only response shapes (not in OpenAPI spec) ──────────────────────
// These are defined locally because they come from admin-only endpoints
// whose response shapes aren't generated into the api-client-react package.

/** Row from GET /admin/orders (or merged with pre-orders in the UI).
 *  Extends the generated Order with the extra fields the admin
 *  endpoints join in (whatsappPhone, sellerName, etc.) plus pre-order
 *  fields (status, discountedPrice, quantity, deliveryCharge,
 *  productName) used when the UI maps both shapes into one list. */
export interface AdminOrder extends Order {
  /** Pre-order status field (mirrors Order.orderStatus for pre-orders). */
  status?: string;
  /** Buyer's WhatsApp phone, joined from the pre-orders / admin orders
   *  response. Not in the generated Order type. */
  whatsappPhone?: string | null;
  /** Seller display name (joined from sellers table). */
  sellerName?: string | null;
  /** Seller's business name (joined from sellers table). */
  sellerBusinessName?: string | null;
  /** Seller's verification status (joined from sellers table). */
  sellerStatus?: string | null;
  /** Seller's contact email (joined from sellers table). */
  sellerContactEmail?: string | null;
  /** Seller owner's personal name (joined from sellers → users). */
  sellerOwnerName?: string | null;
  /** Seller's contact phone (joined from sellers table). */
  sellerContactPhone?: string | null;
  /** Buyer's display name (joined from users table). */
  userName?: string | null;
  /** Buyer's email (joined from users table). */
  userEmail?: string | null;
  /** Pre-order: discounted unit price. */
  discountedPrice?: number | string;
  /** Pre-order: quantity. */
  quantity?: number;
  /** Pre-order: delivery charge. */
  deliveryCharge?: number | string;
  /** Pre-order: product name. */
  productName?: string;
  /** Pre-order: product image URL. */
  productImage?: string | null;
  /** Discriminator used by the UI to render order vs pre-order rows. */
  _type?: "order" | "preorder";
  [key: string]: unknown;
}

/** Row from GET /admin/pre-orders — enriched with seller context.
 *  Distinct from AdminOrder because pre-orders have a different primary
 *  shape (no items array, no paymentStatus, etc.). */
export interface AdminPreOrder {
  id: number;
  trackingId: string;
  status: string;
  totalAmount?: string | number | null;
  discountedPrice?: string | number | null;
  deliveryCharge?: string | number | null;
  quantity?: number;
  createdAt: string;
  buyerName?: string | null;
  buyerPhone?: string | null;
  whatsappPhone?: string | null;
  sellerId?: number | null;
  sellerName?: string | null;
  sellerLogoUrl?: string | null;
  productName?: string | null;
  productImage?: string | null;
  [key: string]: unknown;
}

/** Row from GET /admin/orders/archived. */
export interface ArchivedOrder {
  id: number;
  trackingId: string;
  orderStatus: string;
  paymentStatus: string;
  totalAmount: string | number;
  createdAt: string;
  archivedAt?: string;
  sellerId?: number | null;
  sellerName?: string | null;
  [key: string]: unknown;
}

/** Row from GET /admin/dashboard. */
export interface DashboardStats {
  totalSales: number;
  totalOrders: number;
  pendingOrders: number;
  deliveredOrders: number;
}

/** Row from GET /admin/monthly-records. */
export interface MonthlyRecord {
  id: number;
  year: number;
  month: number;
  totalSales: number | string;
  totalOrders: number;
  archivedAt?: string;
  [key: string]: unknown;
}

/** Row from GET /admin/users (list-all-users admin endpoint). */
export interface AdminUser {
  id: number;
  clerkId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  role: "user" | "admin" | "seller";
  isBlocked: boolean;
  createdAt: string;
  [key: string]: unknown;
}

/** Generic key/value map for status → color+icon config. */
export interface StatusConfigEntry {
  color: string;
  icon: React.ElementType;
}

/** Cancellation modal state. */
export interface CancelModalState {
  orderId: number;
  reason: string;
}

/** Confirm dialog state used by AdminPage's askConfirm helper. */
export interface ConfirmDialogState {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  danger: boolean;
}

/** Editing target — either a product being created/edited or null. */
export type EditingProduct = (Product & { [key: string]: unknown }) | null;
export type EditingCategory = (Category & { [key: string]: unknown }) | null;
export type EditingCoupon = { id: number; code: string; [key: string]: unknown } | null;

// ─── AdminContextValue ─────────────────────────────────────────────────────

export interface AdminProduct {
  id: number;
  name: string;
  slug: string;
  categoryId: number | null;
  inStock: boolean;
  productStatus: string;
  images: string[];
  homepageTag?: string | null;
  /** Admin /products join: lowest listing price for this product. */
  listingMinPrice?: number | string | null;
  /** Admin /products join: highest listing price for this product. */
  listingMaxPrice?: number | string | null;
  /** Admin /products join: whether any listing has pre-order enabled. */
  listingHasPreOrder?: boolean;
  /** Admin /products join: total active listing count. */
  listingCount?: number;
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

  // Coupons were removed from the admin panel (now managed by sellers in
  // their dashboard). These no-op stubs remain for backward compatibility
  // with any code still referencing the context shape -- they can be
  // removed once all consumers are migrated.
  couponSearch: string;
  setCouponSearch: (v: string) => void;

  // Products
  allProducts: AdminProduct[];
  filteredProducts: AdminProduct[];
  productsLoading: boolean;
  productsPage: number;
  setProductsPage: (v: number | ((prev: number) => number)) => void;
  productsHasMore: boolean;
  editingProduct: EditingProduct;
  setEditingProduct: (v: EditingProduct) => void;
  showProductModal: boolean;
  setShowProductModal: (v: boolean) => void;
  handleDeleteProduct: (id: number) => void;
  categories: AdminCategory[];

  // Orders
  orders: AdminOrder[];
  adminPreOrders: AdminPreOrder[];
  ordersLoading: boolean;
  ordersPage: number;
  ordersHasMore: boolean;
  ordersTotal: number;
  filteredOrders: AdminOrder[];
  expandedOrderId: number | string | null;
  setExpandedOrderId: (v: number | string | null) => void;
  handleOrderStatusChange: (orderId: number, status: string) => void;
  cancelModal: CancelModalState | null;
  setCancelModal: (v: CancelModalState | null) => void;

  // Categories
  editingCategory: EditingCategory;
  setEditingCategory: (v: EditingCategory) => void;
  showCategoryModal: boolean;
  setShowCategoryModal: (v: boolean) => void;
  seedingCategories: boolean;
  setSeedingCategories: (v: boolean) => void;

  // Users
  users: AdminUser[];
  usersLoading: boolean;

  // Reviews
  reviews: AdminReview[];
  reviewsLoading: boolean;

  // Archived
  archivedOrders: ArchivedOrder[];
  archivedPreOrders: AdminPreOrder[];
  archivedPage: number;
  archivedHasMore: boolean;
  archivedTotal: number;
  archivedLoading: boolean;
  archivedError: string | null;
  fetchArchivedOrders: (page: number, append?: boolean) => void;

  // Coupons (removed from admin panel — now seller-managed)
  coupons: { id: number; code: string; [key: string]: unknown }[];
  couponsLoading: boolean;
  editingCoupon: EditingCoupon;
  setEditingCoupon: (v: EditingCoupon) => void;
  showCouponModal: boolean;
  setShowCouponModal: (v: boolean) => void;
  couponSaving: boolean;
  setCouponSaving: (v: boolean) => void;
  setCoupons: (v: { id: number; code: string; [key: string]: unknown }[]) => void;

  // Monthly
  monthlyRecords: MonthlyRecord[];
  monthlyLoading: boolean;

  // Dashboard
  dashStats: DashboardStats;
  dashStatsLoading: boolean;
  activeOrdersCount: number;

  // Shared
  askConfirm: (title: string, message: string, onConfirm: () => void, danger?: boolean) => void;
  getToken: () => Promise<string | null>;
  setActiveTab: (tab: string) => void;

  // Dashboard computed
  totalRevenue: number;
  deliveredOrders: number;
  recentCombined: AdminOrder[];
  statusConfig: Record<string, StatusConfigEntry>;
  products: AdminProduct[];
  productsData: { products?: AdminProduct[]; total?: number } | undefined;
  pendingOrders: number;

  // Handlers
  handleDeleteCategory: (id: number) => void;
  handleDeleteReview: (productId: number, reviewId: number) => void;
  handleToggleBlock: (userId: number, isBlocked: boolean) => void;
  // Coupon handlers removed from admin — sellers manage their own coupons now.
  // Stubs kept here so the context shape stays compatible with any consumer
  // that still references them.
  handleDeleteCoupon: (id: number) => void;
  handleToggleCoupon: (id: number) => void;
  handleArchiveNow: () => void;
  handleSeedCategories: () => void;
  totalOrdersThisMonth: number;
  fetchOrders: (page: number, append?: boolean) => void;
  fetchAdminPreOrders: () => void;

  // Computed
  filteredReviews: AdminReview[];
  filteredCoupons: { id: number; code: string; [key: string]: unknown }[];
  debouncedUserSearch: string;
}

export const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdminContext(): AdminContextValue {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error("useAdminContext must be used within AdminPage");
  return ctx;
}
