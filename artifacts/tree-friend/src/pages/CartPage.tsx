import { Link, useLocation } from "wouter";
import { useEffect, useRef } from "react";
import {
  useGetCart,
  useUpdateCartItem,
  useRemoveFromCart,
  getGetCartQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Minus,
  Plus,
  Trash2,
  ShoppingBag,
  ArrowRight,
  ArrowLeft,
  LogIn,
  Sprout,
  AlertCircle,
  AlertTriangle,
  Truck,
  Wallet,
  Info,
} from "lucide-react";
import { useUser } from "@clerk/react";
import { useGuestCart } from "@/hooks/useGuestCart";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";
import { apiClient } from "@/lib/apiClient";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a taka amount with the "Tk" prefix and thousands separators.
 * Centralized so every cart line, summary row, and badge renders identically.
 * `Tk1,300`, `Tk80`, `Tk1,580`.
 */
function formatTk(n: number): string {
  return `Tk${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * Compute a human-readable delivery estimate date range from a seller's
 * `deliveryTimeDays` (e.g. 3 → "Aug 27–29"). Returns null when the input
 * is missing/invalid so the caller can skip the footer entirely.
 *
 * The end date is `deliveryTimeDays + 2` to give a realistic window —
 * same convention used by Amazon / Shopify for "estimated delivery".
 */
function formatDeliveryEstimate(deliveryTimeDays: number | null | undefined): string | null {
  if (deliveryTimeDays == null || deliveryTimeDays <= 0) return null;
  const start = new Date();
  start.setDate(start.getDate() + deliveryTimeDays);
  const end = new Date(start);
  end.setDate(end.getDate() + 2);

  const startStr = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endStr = end.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  // If the range spans months, show both months ("Aug 30 – Sep 1");
  // otherwise collapse to one month ("Aug 27–29").
  if (start.getMonth() === end.getMonth()) {
    const dayRange = `${start.getDate()}–${end.getDate()}`;
    return `${start.toLocaleDateString("en-US", { month: "short" })} ${dayRange}`;
  }
  return `${startStr} – ${endStr}`;
}

// ─── Empty State ──────────────────────────────────────────────────────────────

function EmptyCart() {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center text-center px-4">
      <div className="h-24 w-24 rounded-full bg-muted/60 flex items-center justify-center mb-6">
        <ShoppingBag className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
      </div>
      <h2 className="font-serif text-3xl font-medium mb-2">Your bag is empty</h2>
      <p className="text-muted-foreground mb-8 text-sm max-w-xs">
        Discover trees, saplings, and gardening supplies from trusted nurseries across Bangladesh.
      </p>
      <Link href="/products">
        <Button className="rounded-full px-8 h-12 text-base shadow-md">
          Start Shopping <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </Link>
    </div>
  );
}

// ─── Shared Cart Item Card ────────────────────────────────────────────────────

/**
 * Unified card layout for both guest and authenticated cart items.
 * Visual spec (matches the user's approved design):
 *   - White card, rounded-2xl, subtle shadow, p-4
 *   - Image: w-24 h-24 rounded-xl object-cover (left column)
 *   - Content (flex-1):
 *       Row 1: product name (font-semibold) + Trash2 icon (top-right)
 *       Row 2: variant attributes (text-xs text-muted-foreground, • separator)
 *       Row 3: quantity stepper (left, border rounded-lg h-9 w-24) +
 *              price block (right, current + strikethrough)
 *       Row 4 (optional): blue COD badge if marketplace line with deliveryCharge > 0
 *       Row 5 (optional, with top border): truck icon + green delivery estimate
 *
 * Stock indicators: out-of-stock (red), low-stock ≤5 (orange), at-max-stock
 * (disables + button).
 */
interface CartItemCardProps {
  name: string;
  image: string | null;
  variantLabel: string | null;
  quantity: number;
  price: number; // effective price (discountPrice ?? price)
  originalPrice: number; // base price for strikethrough
  stock: number | null;
  codDeliveryCharge: number; // marketplace per-unit courier fee (0 for admin-direct)
  deliveryEstimate: string | null; // pre-computed "Aug 27–29" or null
  href: string;
  onIncrement: () => void;
  onDecrement: () => void;
  onRemove: () => void;
  disabled?: boolean;
}

function CartItemCard({
  name,
  image,
  variantLabel,
  quantity,
  price,
  originalPrice,
  stock,
  codDeliveryCharge,
  deliveryEstimate,
  href,
  onIncrement,
  onDecrement,
  onRemove,
  disabled,
}: CartItemCardProps) {
  const atMaxStock = stock != null && quantity >= stock;
  const lowStock = stock != null && stock <= 5 && stock > 0;
  const outOfStock = stock != null && stock <= 0;
  const hasDiscount = price < originalPrice;
  const codTotal = codDeliveryCharge * quantity;

  return (
    <div
      className={`bg-card border rounded-2xl p-4 shadow-sm transition-shadow ${
        outOfStock
          ? "border-destructive/40 opacity-70 hover:shadow-sm"
          : "border-border hover:shadow-md"
      }`}
    >
      <div className="flex gap-4">
        {/* Image — wrapped in relative so we can overlay an "Out of stock" badge */}
        <Link href={href} className="shrink-0 relative">
          {image ? (
            <img
              src={image}
              alt={name}
              className={`w-24 h-24 object-cover rounded-xl cursor-pointer ${
                outOfStock ? "grayscale" : ""
              }`}
              loading="lazy"
            />
          ) : (
            <NoImagePlaceholder className="w-24 h-24 rounded-xl cursor-pointer" />
          )}
          {outOfStock && (
            <span className="absolute inset-0 flex items-center justify-center bg-destructive/10 rounded-xl">
              <span className="bg-destructive text-destructive-foreground text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-md">
                Out of stock
              </span>
            </span>
          )}
        </Link>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Row 1: Name + Remove */}
          <div className="flex justify-between items-start gap-2">
            <Link href={href} className="min-w-0 flex-1">
              <h3
                className={`font-semibold text-base leading-snug truncate transition-colors ${
                  outOfStock
                    ? "text-muted-foreground"
                    : "text-foreground hover:text-accent-text"
                }`}
              >
                {name}
              </h3>
            </Link>
            <button
              onClick={onRemove}
              disabled={disabled}
              className="shrink-0 p-1 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/5 transition-colors disabled:opacity-50"
              aria-label={`Remove ${name} from bag`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>

          {/* Row 2: Variant attributes + stock indicators */}
          <div className="mt-0.5 flex items-center gap-2 flex-wrap">
            {variantLabel && (
              <p
                className={`text-xs leading-relaxed ${
                  outOfStock ? "text-muted-foreground/60" : "text-muted-foreground"
                }`}
              >
                {variantLabel}
              </p>
            )}
            {/* Low-stock indicator (only shown when NOT out of stock —
                out-of-stock is shown on the image overlay instead, so the
                buyer's eye goes to the image first). */}
            {!outOfStock && lowStock && (
              <span className="text-xs text-warning-foreground font-medium">
                Only {stock} left
              </span>
            )}
          </div>

          {/* Row 3: Quantity stepper + price block */}
          <div className="flex items-center justify-between mt-3 gap-3">
            {/* Quantity stepper — fully disabled when out of stock */}
            <div
              className={`flex items-center border rounded-lg overflow-hidden h-9 w-24 shrink-0 ${
                outOfStock
                  ? "border-muted opacity-50 pointer-events-none"
                  : "border-input"
              }`}
            >
              <button
                onClick={onDecrement}
                disabled={disabled || outOfStock || quantity <= 1}
                className="w-8 h-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="Decrease quantity"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <span className="flex-1 text-center text-sm font-semibold text-foreground border-x border-input">
                {quantity}
              </span>
              <button
                onClick={onIncrement}
                disabled={disabled || outOfStock || atMaxStock}
                className="w-8 h-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="Increase quantity"
                title={atMaxStock ? `Only ${stock} available` : undefined}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Price block */}
            <div className="text-right">
              <p
                className={`text-lg font-bold leading-tight ${
                  outOfStock ? "text-muted-foreground" : "text-foreground"
                }`}
              >
                {formatTk(price * quantity)}
              </p>
              {hasDiscount && (
                <p className="text-xs text-muted-foreground line-through">
                  {formatTk(originalPrice * quantity)}
                </p>
              )}
            </div>
          </div>

          {/* Row 4: COD badge (marketplace lines only — hidden when OOS) */}
          {codTotal > 0 && !outOfStock && (
            <div className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-info/60 text-info-foreground">
              <Wallet className="h-3.5 w-3.5 shrink-0" />
              <span className="text-xs font-medium">
                {formatTk(codTotal)} due on delivery
              </span>
            </div>
          )}

          {/* Row 5: Delivery estimate footer (marketplace lines only —
              hidden when OOS since the listing can't ship anyway) */}
          {deliveryEstimate && !outOfStock && (
            <div className="mt-3 pt-3 border-t border-border/60 flex items-center gap-2">
              <Truck className="h-4 w-4 text-success-foreground shrink-0" />
              <span className="text-xs text-muted-foreground">Estimated delivery:</span>
              <span className="text-xs font-semibold text-success-foreground">
                {deliveryEstimate}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Guest Cart Page ──────────────────────────────────────────────────────────

function GuestCartPage() {
  const guestCart = useGuestCart();
  const [, setLocation] = useLocation();

  const items = guestCart.items;
  const subtotal = items.reduce((sum, item) => {
    const price = item.discountPrice ?? item.price;
    return sum + price * item.quantity;
  }, 0);
  // Delivery charge = sum of each variant's real deliveryCharge × quantity.
  // The old hardcoded `subtotal > 2000 ? 0 : 120` was wrong: it ignored the
  // actual per-variant deliveryCharge stored on productVariants /
  // sellerListingVariants. The authenticated cart gets the real sum from
  // GET /api/cart (cart.deliveryTotal); the guest cart mirrors the same
  // field on each item so the preview matches.
  const shipping = items.reduce((sum, item) => sum + (item.deliveryCharge ?? 0) * item.quantity, 0);

  if (items.length === 0) return <EmptyCart />;

  return (
    <div className="min-h-screen bg-background">
      <PageHeader itemCount={items.length} />

      <div className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 lg:gap-10">
          {/* Items */}
          <div className="lg:col-span-2 space-y-4">
            <SellerGroupHeader sellerName={null} />
            {items.map((item) => {
              const price = item.discountPrice ?? item.price;
              const stock = item.stock;
              const atMaxStock = stock != null && item.quantity >= stock;
              return (
                <CartItemCard
                  key={`${item.productId}:${item.variantId ?? "null"}`}
                  name={item.name}
                  image={item.image || null}
                  variantLabel={null}
                  quantity={item.quantity}
                  price={price}
                  originalPrice={item.price}
                  stock={stock ?? null}
                  codDeliveryCharge={0}
                  deliveryEstimate={null}
                  href={`/products/${item.productId}`}
                  onIncrement={() =>
                    !atMaxStock &&
                    guestCart.updateQuantity(
                      item.productId,
                      item.quantity + 1,
                      item.variantId,
                      item.sellerListingVariantId,
                    )
                  }
                  onDecrement={() =>
                    item.quantity > 1 &&
                    guestCart.updateQuantity(
                      item.productId,
                      item.quantity - 1,
                      item.variantId,
                      item.sellerListingVariantId,
                    )
                  }
                  onRemove={() =>
                    guestCart.removeItem(
                      item.productId,
                      item.variantId,
                      item.sellerListingVariantId,
                    )
                  }
                />
              );
            })}

            <div className="pt-2">
              <Link href="/products">
                <Button variant="ghost" className="text-sm text-muted-foreground hover:text-foreground">
                  ← Continue Shopping
                </Button>
              </Link>
            </div>
          </div>

          {/* Summary */}
          <div>
            <OrderSummary
              subtotal={subtotal}
              shipping={shipping}
              codDeliveryTotal={0}
              codBreakdown={[]}
              giftWrapCost={0}
              discount={0}
              loyaltyDiscount={0}
              onCheckout={() => setLocation("/checkout")}
              isGuest
              onSignIn={() => setLocation("/sign-in")}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Seller Group Header ──────────────────────────────────────────────────────

function SellerGroupHeader({ sellerName }: { sellerName: string | null }) {
  return (
    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
      <Sprout className="h-4 w-4 text-success-foreground" />
      {sellerName ? `Sold by ${sellerName}` : "Tree Friend"}
    </div>
  );
}

// ─── Page Header ───────────────────────────────────────────────────────────────

interface PageHeaderProps {
  itemCount: number;
  onBack?: () => void;
}

function PageHeader({ itemCount, onBack }: PageHeaderProps) {
  return (
    <div className="bg-muted/30 border-b py-10">
      <div className="container mx-auto px-4">
        {/* Back button — explicit < chevron above the breadcrumb so the
            buyer has a clear "go back" affordance (industry-standard cart
            page pattern, matches the approved design reference). Falls
            back to `history.back()` when no onBack handler is provided. */}
        <button
          onClick={onBack ?? (() => window.history.back())}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 -ml-1"
          aria-label="Go back"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        <PageBreadcrumb
          crumbs={[{ label: "Your Bag", icon: <ShoppingBag className="h-3 w-3" /> }]}
          className="mb-3"
        />
        <h1 className="font-serif text-4xl md:text-5xl font-medium tracking-tight">
          Your Bag
        </h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          {itemCount} item{itemCount !== 1 ? "s" : ""}
        </p>
      </div>
    </div>
  );
}

// ─── Order Summary (restructured: Due now / Due on delivery split) ───────────

interface CodBreakdownEntry {
  sellerName: string;
  amount: number;
}

interface OrderSummaryProps {
  subtotal: number;
  shipping: number;
  codDeliveryTotal: number;
  codBreakdown: CodBreakdownEntry[];
  giftWrapCost: number;
  discount: number;
  loyaltyDiscount: number;
  onCheckout: () => void;
  isGuest?: boolean;
  onSignIn?: () => void;
}

/**
 * Restructured order summary per the approved design.
 *
 * Splits the buyer's financial obligation into:
 *   - "Due now" = subtotal - discount - loyaltyDiscount + shipping + giftWrap
 *     (paid at checkout via bKash or COD platform fee)
 *   - "Due on delivery (COD)" = sum of marketplace sellers' courier fees
 *     (paid directly to each seller's courier on delivery — NOT collected
 *      by the platform at checkout, see routes/cart.ts:buildCart doc comment)
 *   - "Total order value" = due now + due on delivery (the grand total)
 *
 * The "Due on delivery" section lists each marketplace seller with a Sprout
 * icon and their per-seller courier amount, so the buyer sees exactly what
 * they'll owe each seller's courier — no surprise COD charges.
 */
function OrderSummary({
  subtotal,
  shipping,
  codDeliveryTotal,
  codBreakdown,
  giftWrapCost,
  discount,
  loyaltyDiscount,
  onCheckout,
  isGuest,
  onSignIn,
}: OrderSummaryProps) {
  const dueNow = Math.max(
    0,
    subtotal - discount - loyaltyDiscount + shipping + giftWrapCost,
  );
  const totalOrderValue = dueNow + codDeliveryTotal;

  return (
    <div className="bg-card border border-border rounded-2xl p-5 shadow-md sticky top-24 space-y-4">
      <h2 className="font-serif text-xl font-medium text-foreground">Order Summary</h2>

      {/* Top-level line items */}
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Subtotal</span>
          <span className="font-semibold text-foreground">{formatTk(subtotal)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Delivery</span>
          <span className="font-semibold text-foreground">
            {shipping === 0 ? (
              <span className="text-success-foreground">Free</span>
            ) : (
              formatTk(shipping)
            )}
          </span>
        </div>
        {giftWrapCost > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">🎁 Gift Wrapping</span>
            <span className="font-semibold text-foreground">{formatTk(giftWrapCost)}</span>
          </div>
        )}
        {discount > 0 && (
          <div className="flex justify-between text-success-foreground">
            <span>Coupon Discount</span>
            <span className="font-semibold">-{formatTk(discount)}</span>
          </div>
        )}
        {loyaltyDiscount > 0 && (
          <div className="flex justify-between text-warning-foreground">
            <span>⭐ Loyalty Points</span>
            <span className="font-semibold">-{formatTk(loyaltyDiscount)}</span>
          </div>
        )}
      </div>

      {/* Due now section */}
      <div className="border-t border-border pt-3 space-y-2">
        <div className="flex justify-between items-center">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            Due now
            <Info className="h-3.5 w-3.5 text-muted-foreground/70" />
          </span>
          <span className="text-lg font-bold text-foreground">{formatTk(dueNow)}</span>
        </div>

        {/* Due on delivery (COD) section — marketplace courier fees */}
        {codDeliveryTotal > 0 && (
          <div className="space-y-1.5">
            <div className="flex justify-between items-center">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                Due on delivery
                <Info className="h-3.5 w-3.5 text-muted-foreground/70" />
              </span>
              <span className="text-sm font-semibold text-foreground">
                {formatTk(codDeliveryTotal)}
              </span>
            </div>
            {/* Per-seller COD breakdown */}
            <div className="pl-6 space-y-1">
              {codBreakdown.map((entry, i) => (
                <div key={i} className="flex justify-between items-center text-xs">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Sprout className="h-3 w-3 text-success-foreground" />
                    {entry.sellerName}
                  </span>
                  <span className="font-medium text-foreground">{formatTk(entry.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Total order value (grand total) */}
      <div className="border-t border-border pt-3">
        <div className="flex justify-between items-baseline">
          <span className="text-sm font-bold text-foreground">Total order value</span>
          <span className="text-xl font-bold text-foreground">
            {formatTk(totalOrderValue)}
          </span>
        </div>
      </div>

      {/* CTA */}
      <Button
        onClick={onCheckout}
        className="w-full rounded-full h-12 text-base font-semibold shadow-md"
        size="lg"
      >
        Proceed to Checkout <ArrowRight className="ml-2 h-4 w-4" />
      </Button>

      {isGuest && onSignIn && (
        <>
          <Button
            onClick={onSignIn}
            variant="outline"
            className="w-full rounded-full h-11 text-sm font-medium border-primary text-primary hover:bg-primary/5"
            size="lg"
          >
            <LogIn className="mr-2 h-4 w-4" />
            Sign in
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            Sign in to save your bag and earn rewards
          </p>
        </>
      )}

      <Link href="/products">
        <Button variant="ghost" className="w-full text-sm text-muted-foreground hover:text-foreground">
          Continue Shopping
        </Button>
      </Link>
    </div>
  );
}

// ─── Authenticated Cart Page ──────────────────────────────────────────────────

/**
 * Groups cart items by seller for display (plan doc §6: buyer sees which
 * seller they're buying from). Admin-direct (kind: "variant") lines are
 * grouped under a null key, rendered without a seller header -- this is
 * the pre-marketplace behavior and stays visually unchanged when a cart is
 * 100% admin-direct.
 */
function groupBySeller<
  T extends {
    kind: string;
    sellerId?: number | null;
    seller?: { id: number; nurseryName: string; location: string } | null;
  },
>(items: T[]) {
  const groups = new Map<number | null, { seller: T["seller"] | null; items: T[] }>();
  for (const item of items) {
    const key = item.kind === "seller_listing" ? (item.sellerId ?? null) : null;
    let group = groups.get(key);
    if (!group) {
      group = {
        seller: item.kind === "seller_listing" ? (item.seller ?? null) : null,
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return Array.from(groups.values());
}

function AuthenticatedCartPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { data: cart, isLoading } = useGetCart();
  const updateItem = useUpdateCartItem();
  const removeItem = useRemoveFromCart();

  // ── Abandoned cart recovery sync ───────────────────────────────────────────
  //
  // Industry-standard abandoned cart recovery (Shopify, WooCommerce,
  // Magento all do this): whenever the authenticated cart changes, sync
  // a snapshot to the `abandoned_carts` table so the 24-hour cron job
  // (routes/abandonedCart.ts:runAbandonedCartJob) can send a recovery
  // email if the buyer leaves without checking out. The sync endpoint
  // reads the cart from the DB (not from the request body), so it's
  // idempotent — calling it multiple times with the same cart state
  // produces the same result. When the cart is emptied (checkout
  // complete or buyer cleared it), the sync endpoint deletes the
  // abandoned_carts row — no recovery email for an empty cart.
  //
  // Debounced 2s so a rapid add→remove→add sequence fires only one
  // sync, not three. The sync is fire-and-forget (no await, no error
  // handling) — if it fails, the cron job simply won't send a recovery
  // email for this session, which is acceptable (the buyer can still
  // come back and find their cart via the persistent cart_items table).
  const syncAbandonedCartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (syncAbandonedCartTimeoutRef.current) {
      clearTimeout(syncAbandonedCartTimeoutRef.current);
    }
    syncAbandonedCartTimeoutRef.current = setTimeout(() => {
      // Fire-and-forget — errors are logged server-side, not surfaced
      // to the buyer. The buyer's cart experience must not depend on
      // the abandoned cart sync succeeding.
      apiClient.post("/abandoned-cart/sync").catch(() => {
        // Silently ignore — see comment above.
      });
    }, 2000);
    return () => {
      if (syncAbandonedCartTimeoutRef.current) {
        clearTimeout(syncAbandonedCartTimeoutRef.current);
      }
    };
  }, [cart?.items, cart?.subtotal]);

  const items = cart?.items ?? [];
  const subtotal = cart?.subtotal ?? 0;
  // Use the REAL per-variant delivery total computed by the API
  // (cart.deliveryTotal = sum of variant.deliveryCharge × quantity for
  // admin-direct lines). The old hardcoded `subtotal > 2000 ? 0 : 120`
  // was wrong: it showed 120 for every cart regardless of what the
  // variant actually charged (e.g. a variant with deliveryCharge=80
  // showed 120 in the bag). Also removed the "free over 2000" rule
  // entirely — delivery is always the real per-variant charge now.
  const shipping = cart?.deliveryTotal ?? 0;
  const sellerGroups = groupBySeller(items);
  // Marketplace (seller_listing) lines charge their courier fee separately,
  // collected by the seller on delivery -- it's never summed into
  // deliveryTotal/total above (see routes/cart.ts). Surface that as a
  // total across the whole cart so "Delivery: Free" in the summary below
  // doesn't read as "nothing more to pay" when it isn't.
  const codBreakdown = sellerGroups
    .map((g) => ({ seller: g.seller, items: g.items }))
    .filter(
      (g): g is { seller: NonNullable<typeof g.seller>; items: typeof g.items } =>
        g.seller != null,
    )
    .map((g) => ({
      sellerName: g.seller.nurseryName,
      amount: g.items.reduce(
        (sum, item) =>
          sum +
          (item.kind === "seller_listing"
            ? (item.listing?.deliveryCharge ?? 0) * item.quantity
            : 0),
        0,
      ),
    }))
    .filter((entry) => entry.amount > 0);
  const codDeliveryTotal = codBreakdown.reduce((s, e) => s + e.amount, 0);

  function handleUpdate(id: number, quantity: number) {
    if (quantity < 1) return;
    updateItem.mutate(
      { id, data: { quantity } },
      {
        onSuccess: () => qc.invalidateQueries({ queryKey: getGetCartQueryKey() }),
      },
    );
  }

  function handleRemove(id: number) {
    removeItem.mutate(
      { id },
      {
        onSuccess: () => qc.invalidateQueries({ queryKey: getGetCartQueryKey() }),
      },
    );
  }

  // Batch-remove every out-of-stock line in the cart. Called by the
  // "Remove unavailable items" banner action below. Each remove fires
  // an independent DELETE /cart/items/:id — the cart query is
  // invalidated once per success so the UI updates incrementally as
  // each line is removed (better perceived performance than waiting for
  // all N removes to complete before updating the UI).
  function handleRemoveUnavailable(ids: number[]) {
    for (const id of ids) {
      removeItem.mutate(
        { id },
        {
          onSuccess: () => qc.invalidateQueries({ queryKey: getGetCartQueryKey() }),
        },
      );
    }
  }

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-10">
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  if (items.length === 0) return <EmptyCart />;

  // Price-change warning: if any line's price has drifted since the buyer
  // added it to the cart, show a warning banner so the buyer knows the
  // total at checkout may differ from what they saw in the bag. The
  // actual charge always uses the current variant price (after
  // re-validation at checkout) — this is a heads-up, not a price lock.
  //
  // Cast through `any` because the generated API client (lib/api-client-react)
  // doesn't yet know about the `priceChangedCount` field added to the cart
  // response in routes/cart.ts:buildCart. The field IS sent by the backend
  // (verified in the route handler), but the OpenAPI spec + generated
  // client haven't been regenerated to include it. This is the standard
  // pattern for backend-first evolution — regenerate the client later.
  const priceChangedCount =
    (cart as unknown as { priceChangedCount?: number })?.priceChangedCount ?? 0;

  // Out-of-stock detection: collect every cart line whose variant/listing
  // has stock <= 0. These lines are rendered with a disabled, dimmed card
  // (see CartItemCard) AND surfaced in a page-level banner with a
  // "Remove unavailable items" action so the buyer can clear them in one
  // click instead of removing each one individually. Industry-standard
  // pattern (Amazon, Shopify both do this at the top of the cart page).
  const outOfStockItems = items
    .map((item) => {
      const stock =
        item.kind === "seller_listing"
          ? (item.listing?.stock ?? 0)
          : (item.variant?.stock ?? 0);
      return { id: item.id, name: item.product.name, outOfStock: stock <= 0 };
    })
    .filter((x) => x.outOfStock);
  const outOfStockIds = outOfStockItems.map((x) => x.id);

  return (
    <div className="min-h-screen bg-background">
      <PageHeader itemCount={items.length} />

      {outOfStockItems.length > 0 && (
        <div className="bg-destructive/10 border-b border-destructive/20">
          <div className="container mx-auto px-4 py-3 flex items-start justify-between gap-3 text-sm text-destructive">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                {outOfStockItems.length} item{outOfStockItems.length !== 1 ? "s" : ""} in your bag{" "}
                {outOfStockItems.length !== 1 ? "are" : "is"} no longer available. Remove{" "}
                {outOfStockItems.length !== 1 ? "them" : "it"} to continue to checkout.
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleRemoveUnavailable(outOfStockIds)}
              disabled={removeItem.isPending}
              className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/5 hover:text-destructive"
            >
              {removeItem.isPending ? (
                "Removing..."
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  Remove {outOfStockItems.length !== 1 ? "items" : "item"}
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {priceChangedCount > 0 && (
        <div className="bg-warning/40 border-b border-warning-border">
          <div className="container mx-auto px-4 py-3 flex items-start gap-2 text-sm text-warning-foreground">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              Prices for {priceChangedCount} item{priceChangedCount !== 1 ? "s" : ""} in your bag
              have changed since you added them. The total at checkout will reflect the current
              prices.
            </span>
          </div>
        </div>
      )}

      <div className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 lg:gap-10">
          {/* Items, grouped by seller */}
          <div className="lg:col-span-2 space-y-6">
            {sellerGroups.map((group, gi) => (
              <div key={group.seller?.id ?? "admin-direct"} className="space-y-3">
                <SellerGroupHeader
                  sellerName={group.seller?.nurseryName ?? null}
                />
                {sellerGroups.length > 1 && gi > 0 && <div className="border-t border-border" />}
                {group.items.map((item) => {
                  const isListing = item.kind === "seller_listing";
                  const price = isListing
                    ? (item.listing!.discountPrice ?? item.listing!.price)
                    : (item.variant!.discountPrice ?? item.variant!.price);
                  const originalPrice = isListing ? item.listing!.price : item.variant!.price;
                  const stock = isListing ? item.listing!.stock : item.variant!.stock;
                  const img = item.product.images?.[0] ?? null;
                  const variantLabel = isListing
                    ? [item.listing!.height, item.listing!.potSize, item.listing!.age]
                        .filter(Boolean)
                        .join(" · ")
                    : item.variant!.name;
                  const codDeliveryCharge = isListing
                    ? (item.listing!.deliveryCharge ?? 0)
                    : 0;
                  // Delivery estimate is ONLY shown for marketplace
                  // (seller_listing) lines because delivery time is set
                  // BY THE SELLER per-listing (sellerListingsTable.
                  // deliveryTimeDays). Admin-direct variant lines have no
                  // seller, so there's no per-listing delivery promise to
                  // surface — showing a fabricated "3-5 days" estimate
                  // would be misleading. This is intentional, not a gap.
                  // If/when admin-direct products get a delivery-time
                  // field on productVariantsTable, this branch will
                  // extend to cover them.
                  const deliveryEstimate = isListing
                    ? formatDeliveryEstimate(item.listing!.deliveryTimeDays)
                    : null;

                  return (
                    <CartItemCard
                      key={item.id}
                      name={item.product.name}
                      image={img}
                      variantLabel={variantLabel || null}
                      quantity={item.quantity}
                      price={price}
                      originalPrice={originalPrice}
                      stock={stock ?? null}
                      codDeliveryCharge={codDeliveryCharge}
                      deliveryEstimate={deliveryEstimate}
                      href={`/products/${item.productId}`}
                      onIncrement={() => handleUpdate(item.id, item.quantity + 1)}
                      onDecrement={() => handleUpdate(item.id, item.quantity - 1)}
                      onRemove={() => handleRemove(item.id)}
                      // Disable the remove button (and stepper, via
                      // CartItemCard's own outOfStock/disabled logic)
                      // while a batch remove is in flight, so the buyer
                      // can't fire concurrent DELETEs on the same line.
                      disabled={removeItem.isPending}
                    />
                  );
                })}
              </div>
            ))}
            {sellerGroups.length > 1 && (
              <div className="bg-muted/40 border border-border rounded-xl px-4 py-3 flex items-start gap-2 text-xs text-muted-foreground">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground/70" />
                <span>
                  Items from different sellers ship separately and become separate orders at checkout.
                </span>
              </div>
            )}
          </div>

          {/* Summary */}
          <div>
            <OrderSummary
              subtotal={subtotal}
              shipping={shipping}
              codDeliveryTotal={codDeliveryTotal}
              codBreakdown={codBreakdown}
              giftWrapCost={0}
              discount={0}
              loyaltyDiscount={0}
              onCheckout={() => setLocation("/checkout")}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Export ────────────────────────────────────────────────────────────────────

export function CartPage() {
  const { user, isLoaded } = useUser();

  if (!isLoaded) {
    return (
      <div className="container mx-auto px-4 py-10">
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  return user ? <AuthenticatedCartPage /> : <GuestCartPage />;
}
