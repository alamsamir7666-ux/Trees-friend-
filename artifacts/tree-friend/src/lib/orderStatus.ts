/**
 * Shared order-status badge configuration.
 *
 * Used by OrdersPage.tsx (list view) and OrderDetailPage.tsx (detail
 * view) so order status labels and colors stay consistent. Previously
 * OrdersPage had its own `statusColors` map (incomplete — missing
 * `payment_pending`, `return_requested`, `failed`, `refunded`) while
 * OrderDetailPage had a separate inline map. This module is the single
 * source of truth.
 *
 * The statuses here cover both `orderStatus` (pending, confirmed,
 * processing, shipped, delivered, cancelled, return_completed) and the
 * display-relevant `paymentStatus` values that the buyer might see in
 * the same badge slot (payment_pending, failed, refunded). The two
 * columns are semantically distinct in the schema but the buyer-facing
 * UI collapses them into one visible "status" badge.
 */

export interface OrderStatusConfig {
  /** Human-readable label shown in the badge. */
  label: string;
  /** Tailwind classes for the badge background + text. */
  badge: string;
}

export const orderStatusConfig: Record<string, OrderStatusConfig> = {
  // orderStatus values
  pending: {
    label: "Pending",
    badge: "bg-warning text-warning-foreground",
  },
  confirmed: {
    label: "Confirmed",
    badge: "bg-info text-info-foreground",
  },
  processing: {
    label: "Processing",
    badge: "bg-info text-info-foreground",
  },
  shipped: {
    label: "Shipped",
    badge: "bg-info text-info-foreground",
  },
  delivered: {
    label: "Delivered",
    badge: "bg-success text-success-foreground",
  },
  cancelled: {
    label: "Cancelled",
    badge: "bg-destructive/10 text-destructive",
  },
  return_completed: {
    label: "Refund Completed",
    badge: "bg-success text-success-foreground",
  },
  // paymentStatus values (shown when paymentStatus != orderStatus for
  // bKash orders still awaiting payment)
  payment_pending: {
    label: "Awaiting Payment",
    badge: "bg-warning text-warning-foreground",
  },
  failed: {
    label: "Payment Failed",
    badge: "bg-destructive/10 text-destructive",
  },
  refunded: {
    label: "Refunded",
    badge: "bg-success text-success-foreground",
  },
};

/**
 * Returns the config for an order status, falling back to a generic
 * config that capitalizes the status string. The fallback ensures the
 * UI never crashes on an unknown status (e.g. a new status added
 * server-side before this file was updated).
 */
export function getOrderStatusConfig(status: string): OrderStatusConfig {
  return (
    orderStatusConfig[status] ?? {
      label: status.charAt(0).toUpperCase() + status.slice(1),
      badge: "bg-muted text-muted-foreground",
    }
  );
}

/**
 * The list of filterable order statuses for the OrdersPage filter
 * dropdown. Excludes `return_completed` (that's a return-flow status,
 * not a primary order status the buyer would filter by) and the
 * payment-status values (those are transient, not filter targets).
 */
export const FILTERABLE_ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
] as const;
