import { Link } from "wouter";
import { useUser } from "@clerk/react";
import { useGuestSession } from "@/hooks/useGuestSession";
import { apiClient } from "@/lib/apiClient";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, Clock, CreditCard, Truck, ArrowRight, Package2 } from "lucide-react";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";
import { useEffect, useRef } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface OrderItem {
  productId: number;
  productName: string;
  productImage: string;
  quantity: number;
  price: number;
  deliveryCharge: number;
  variantId?: number;
  variantName?: string;
  sellerListingId?: number;
  sellerId?: number;
  sellerListingVariantId?: number;
}

interface Order {
  id: number;
  orderNumber: number | null;
  trackingId: string;
  sellerId: number | null;
  items: OrderItem[];
  totalAmount: number;
  paymentMethod: string;
  paymentStatus: string;
  orderStatus: string;
  checkoutSessionId: string | null;
  paymentSessionId: number | null;
  createdAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTk(n: number): string {
  return `Tk${Math.round(n).toLocaleString("en-US")}`;
}

function paymentStatusBadge(order: Order) {
  if (order.paymentStatus === "paid") {
    return {
      icon: CheckCircle2,
      label: "Paid",
      className: "bg-success/20 text-success-foreground ring-success-border/50",
    };
  }
  if (order.paymentStatus === "payment_pending") {
    return {
      icon: Clock,
      label: "Payment Pending",
      className: "bg-warning/20 text-warning-foreground ring-warning-border/50",
    };
  }
  if (order.paymentStatus === "cancelled") {
    return {
      icon: Clock,
      label: "Cancelled",
      className: "bg-destructive/10 text-destructive ring-destructive/20",
    };
  }
  if (order.paymentMethod === "cod") {
    return {
      icon: Truck,
      label: "Pay on Delivery",
      className: "bg-warning/20 text-warning-foreground ring-warning-border/50",
    };
  }
  return {
    icon: Clock,
    label: order.paymentStatus,
    className: "bg-muted text-muted-foreground ring-border",
  };
}

// ─── Checkout Complete Page ───────────────────────────────────────────────────

export function CheckoutCompletePage() {
  const { user, isLoaded } = useUser();
  const { isVerified } = useGuestSession();
  const redirectAttemptedRef = useRef(false);

  // Extract checkoutSessionId from the URL query string.
  const params = new URLSearchParams(window.location.search);
  const checkoutSessionId = params.get("session");

  // Fetch all sibling orders from this checkout session.
  const { data: orders, isLoading } = useQuery({
    queryKey: ["checkout-complete", checkoutSessionId],
    queryFn: async () => {
      if (!checkoutSessionId) return [];
      const { data } = await apiClient.get<Order[]>("/orders", {
        params: { checkoutSessionId, limit: 100 },
      });
      return Array.isArray(data) ? data : [];
    },
    enabled: !!checkoutSessionId && isLoaded && (!!user || isVerified),
  });

  // If there are bKash orders with a paymentSessionId, redirect to bKash
  // to pay them. This handles the case where the buyer placed both COD
  // and Advance orders — the COD orders are placed, the Advance orders
  // need payment. Redirect only once.
  useEffect(() => {
    if (redirectAttemptedRef.current || !orders || orders.length === 0) return;
    const bkashOrders = orders.filter((o) => o.paymentMethod === "bkash");
    if (bkashOrders.length === 0) return;
    const firstBkash = bkashOrders[0];
    if (firstBkash.paymentStatus === "paid") return; // already paid
    if (!firstBkash.paymentSessionId) return; // no session, fallback to per-order

    redirectAttemptedRef.current = true;
    apiClient
      .post<{ bkashURL: string }>("/bkash/create-payment-session", {
        paymentSessionId: firstBkash.paymentSessionId,
      })
      .then(({ data }) => {
        window.location.href = data.bkashURL;
      })
      .catch(() => {
        // Non-fatal — the buyer can pay from the order detail page.
        redirectAttemptedRef.current = false;
      });
  }, [orders]);

  if (!isLoaded) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10">
        <Skeleton className="h-32 rounded-2xl mb-4" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }

  if (!checkoutSessionId) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10 text-center">
        <p className="text-muted-foreground">No checkout session specified.</p>
        <Link href="/orders">
          <Button className="mt-4 rounded-full">View Your Orders</Button>
        </Link>
      </div>
    );
  }

  if (isLoading || !orders) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10">
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-40 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10 text-center">
        <p className="text-muted-foreground">No orders found for this checkout session.</p>
        <Link href="/products">
          <Button className="mt-4 rounded-full">Continue Shopping</Button>
        </Link>
      </div>
    );
  }

  // Split orders by payment method for display.
  const codOrders = orders.filter((o) => o.paymentMethod === "cod");
  const bkashOrders = orders.filter((o) => o.paymentMethod === "bkash");
  const allPaid = bkashOrders.every((o) => o.paymentStatus === "paid");
  const hasBkashPending = bkashOrders.some((o) => o.paymentStatus === "payment_pending");

  return (
    <div className="min-h-screen bg-[#FAFAF7]">
      {/* Header */}
      <div className="bg-muted/30 border-b py-8">
        <div className="max-w-4xl mx-auto px-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="h-12 w-12 rounded-full bg-success/20 flex items-center justify-center">
              <CheckCircle2 className="h-6 w-6 text-success-foreground" />
            </div>
            <div>
              <h1 className="font-serif text-2xl md:text-3xl font-medium tracking-tight">
                {allPaid ? "Checkout Complete!" : "Order Placed!"}
              </h1>
              <p className="text-muted-foreground text-sm mt-0.5">
                {orders.length} order{orders.length !== 1 ? "s" : ""} from this checkout
                {hasBkashPending && " — Advance payment pending"}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {/* bKash payment banner */}
        {hasBkashPending && (
          <div className="bg-warning/10 border border-warning-border rounded-2xl p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-warning-foreground">
              <Clock className="h-4 w-4 shrink-0" />
              <span>Your Advance Payment orders need to be paid via bKash.</span>
            </div>
            <Button
              size="sm"
              className="rounded-full shrink-0"
              onClick={() => {
                const firstPending = bkashOrders.find((o) => o.paymentStatus === "payment_pending");
                if (firstPending?.paymentSessionId) {
                  apiClient
                    .post<{ bkashURL: string }>("/bkash/create-payment-session", {
                      paymentSessionId: firstPending.paymentSessionId,
                    })
                    .then(({ data }) => {
                      window.location.href = data.bkashURL;
                    })
                    .catch(() => {});
                }
              }}
            >
              <CreditCard className="h-4 w-4 mr-1.5" />
              Pay Now
            </Button>
          </div>
        )}

        {/* Orders grouped by payment method */}
        {codOrders.length > 0 && (
          <div>
            <h2 className="font-serif text-lg font-medium mb-3 flex items-center gap-2">
              <Truck className="h-4 w-4 text-warning-foreground" />
              Cash on Delivery ({codOrders.length})
            </h2>
            <div className="space-y-4">
              {codOrders.map((order) => (
                <OrderCard key={order.id} order={order} />
              ))}
            </div>
          </div>
        )}

        {bkashOrders.length > 0 && (
          <div>
            <h2 className="font-serif text-lg font-medium mb-3 flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-success-foreground" />
              Advance Payment ({bkashOrders.length})
            </h2>
            <div className="space-y-4">
              {bkashOrders.map((order) => (
                <OrderCard key={order.id} order={order} />
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 pt-4">
          <Link href="/orders" className="flex-1">
            <Button variant="outline" className="w-full rounded-full h-11">
              View All Orders
            </Button>
          </Link>
          <Link href="/products" className="flex-1">
            <Button className="w-full rounded-full h-11">
              Continue Shopping <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

// ─── Order Card ───────────────────────────────────────────────────────────────

function OrderCard({ order }: { order: Order }) {
  const badge = paymentStatusBadge(order);
  const BadgeIcon = badge.icon;

  return (
    <div className="bg-card border border-border rounded-2xl p-5 shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 pb-3 mb-3 border-b border-border/60">
        <div className="flex items-center gap-2 min-w-0">
          <Package2 className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-semibold text-foreground">
            Order #{order.orderNumber ?? order.trackingId}
          </span>
        </div>
        <span
          className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.06em] rounded-full px-2 py-0.5 ring-1 ${badge.className}`}
        >
          <BadgeIcon className="h-3 w-3" />
          {badge.label}
        </span>
      </div>

      {/* Items */}
      <div className="space-y-2">
        {order.items.map((item, i) => (
          <div key={i} className="flex items-center gap-3">
            {item.productImage ? (
              <img
                src={item.productImage}
                alt={item.productName}
                className="w-12 h-12 rounded-lg object-cover border border-border shrink-0"
                loading="lazy"
              />
            ) : (
              <NoImagePlaceholder className="w-12 h-12 rounded-lg shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{item.productName}</p>
              {item.variantName && (
                <p className="text-[11px] text-muted-foreground truncate">{item.variantName}</p>
              )}
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-semibold text-foreground">
                {formatTk(item.price * item.quantity)}
              </p>
              <p className="text-[11px] text-muted-foreground">Qty {item.quantity}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="mt-3 pt-3 border-t border-border/60 flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">
          Total: <span className="font-bold text-foreground">{formatTk(order.totalAmount)}</span>
        </span>
        <Link href={`/orders/${order.id}`}>
          <Button variant="ghost" size="sm" className="rounded-full text-success-foreground">
            View Details <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Button>
        </Link>
      </div>
    </div>
  );
}
