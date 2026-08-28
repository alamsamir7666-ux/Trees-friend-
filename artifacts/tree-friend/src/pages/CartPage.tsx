import { Link, useLocation } from "wouter";
import { useEffect, useRef, useState } from "react";
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
  Info,
  ShieldCheck,
  CreditCard,
} from "lucide-react";
import { useUser } from "@clerk/react";
import { useGuestCart } from "@/hooks/useGuestCart";
import { useGuestSession } from "@/hooks/useGuestSession";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";
import { apiClient } from "@/lib/apiClient";
import { OtpModal } from "@/components/cart/OtpModal";
import { useToast } from "@/hooks/use-toast";

// ─── Types ────────────────────────────────────────────────────────────────────

type PaymentMethod = "bkash" | "cod";

/**
 * Per-item payment method selection made in the bag. Keyed by cart line id
 * (for authenticated carts) or by a synthetic composite key (for guest
 * carts, which have no server-side line id).
 *
 * Stored to sessionStorage on "Proceed to Checkout" so CheckoutPage can
 * pick it up as the default per-seller payment method — turning the bag
 * into the "choose how to pay" step and checkout into the "confirm and
 * place" step. This matches the user's approved design: each item card
 * shows its own Advance / COD radio selector.
 */
const BAG_PAYMENT_METHODS_KEY = "treefriend_bag_payment_methods";

function lineKeyFor(
  productId: number,
  variantId?: number | null,
  sellerListingVariantId?: number | null,
) {
  if (sellerListingVariantId != null) return `slv:${productId}:${sellerListingVariantId}`;
  return `v:${productId}:${variantId ?? "null"}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTk(n: number): string {
  return `Tk${Math.round(n).toLocaleString("en-US")}`;
}

function formatDeliveryEstimate(deliveryTimeDays: number | null | undefined): string | null {
  if (deliveryTimeDays == null || deliveryTimeDays <= 0) return null;
  const start = new Date();
  start.setDate(start.getDate() + deliveryTimeDays);
  const end = new Date(start);
  end.setDate(end.getDate() + 2);
  const startStr = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endStr = end.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (start.getMonth() === end.getMonth()) {
    return `${start.toLocaleDateString("en-US", { month: "short" })} ${start.getDate()}–${end.getDate()}`;
  }
  return `${startStr} – ${endStr}`;
}

/**
 * Human-readable badge label for the seller header pill.
 * Reflects what the SELLER chose for their listing — NOT the platform's
 * current bKash availability. The platform verification state is a
 * checkout-time concern (it gates whether bKash can actually be used),
 * not a bag-display concern. The badge should always say what the listing
 * itself supports.
 */
function paymentBadgeLabel(paymentMethod: string): string {
  if (paymentMethod === "cod") return "Payment: COD only";
  if (paymentMethod === "advance") return "Payment: Advance only";
  return "Payment: Advance or COD";
}

/**
 * Compact per-item payment-method badge. Shown on seller-listing cart
 * items where the listing supports exactly one payment method (COD or
 * Advance). For "both" listings, the ItemPaymentSelector radio below
 * the item already makes the choice explicit, so no badge is needed
 * there — the badge is only for items where the buyer has no choice.
 *
 * Color coding matches the ItemPaymentSelector:
 *   COD only     → warning (amber)   — pay on delivery
 *   Advance only → success (green)   — pay now via bKash
 */
function PaymentMethodBadge({ method }: { method: "cod" | "advance" }) {
  if (method === "cod") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.06em] rounded-full px-2 py-0.5 bg-warning/20 text-warning-foreground ring-1 ring-warning-border/50 whitespace-nowrap shrink-0"
        title="This listing only supports Cash on Delivery"
      >
        <Truck className="h-3 w-3 shrink-0" />
        COD only
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.06em] rounded-full px-2 py-0.5 bg-success/20 text-success-foreground ring-1 ring-success-border/50 whitespace-nowrap shrink-0"
      title="This listing only supports Advance Payment (bKash)"
    >
      <CreditCard className="h-3 w-3 shrink-0" />
      Advance only
    </span>
  );
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

// ─── Seller Group Header ──────────────────────────────────────────────────────

function SellerGroupHeader({
  sellerName,
  paymentBadge,
}: {
  sellerName: string | null;
  paymentBadge: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 pb-3 mb-3 border-b border-border/60">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground min-w-0">
        <Sprout className="h-4 w-4 text-success-foreground shrink-0" />
        <span className="truncate">{sellerName ? `Sold by ${sellerName}` : "Tree Friend"}</span>
      </div>
      <span className="shrink-0 inline-flex items-center text-[11px] font-medium rounded-full px-2.5 py-1 bg-success/15 text-success-foreground ring-1 ring-success-border/40">
        {paymentBadge}
      </span>
    </div>
  );
}

// ─── Per-item Payment Method Radio ────────────────────────────────────────────

/**
 * Radio selector for choosing how to pay for a single item. Mirrors the
 * design's "Choose payment method for this item" section: two options
 * (Advance Payment / Cash on Delivery), each showing what the buyer pays
 * now vs on delivery.
 *
 * Disabled when the listing doesn't support that method (e.g. a "cod"-
 * only listing grays out the Advance option).
 */
function ItemPaymentSelector({
  allowed,
  selected,
  onSelect,
  itemPrice,
  codCharge,
  quantity,
}: {
  allowed: PaymentMethod[];
  selected: PaymentMethod;
  onSelect: (m: PaymentMethod) => void;
  itemPrice: number;
  codCharge: number;
  quantity: number;
}) {
  const lineTotal = itemPrice * quantity;
  const codTotal = (itemPrice + codCharge) * quantity;
  const advanceAvailable = allowed.includes("bkash");
  const codAvailable = allowed.includes("cod");

  return (
    <div
      className="mt-2.5 pt-3 border-t border-border/60 space-y-1.5"
      role="radiogroup"
      aria-label="Choose payment method for this item"
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-0.5">
        Choose payment method for this item
      </p>

      {/* Advance Payment option */}
      <button
        type="button"
        role="radio"
        aria-checked={selected === "bkash"}
        disabled={!advanceAvailable}
        onClick={() => onSelect("bkash")}
        className={`w-full text-left rounded-xl border-[1.5px] px-3 py-2.5 transition-all ${
          !advanceAvailable
            ? "opacity-40 cursor-not-allowed border-border bg-muted/20"
            : selected === "bkash"
              ? "border-success-foreground bg-card"
              : "border-border bg-card hover:border-muted-foreground/40"
        }`}
      >
        <div className="flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Radio — filled green with white inner dot when selected */}
            <span
              className={`h-[18px] w-[18px] rounded-full border-2 shrink-0 flex items-center justify-center transition-colors ${
                selected === "bkash" && advanceAvailable
                  ? "border-success-foreground bg-success-foreground"
                  : "border-muted-foreground/30 bg-transparent"
              }`}
            >
              {selected === "bkash" && advanceAvailable && (
                <span className="h-1.5 w-1.5 rounded-full bg-card" />
              )}
            </span>
            <CreditCard
              className={`h-[18px] w-[18px] shrink-0 transition-colors ${
                selected === "bkash" && advanceAvailable
                  ? "text-success-foreground"
                  : "text-foreground"
              }`}
            />
            <div className="min-w-0">
              <p className="text-[13.5px] font-bold text-foreground leading-tight">
                Advance Payment
              </p>
              <p className="text-[11.5px] text-muted-foreground leading-tight mt-0.5 truncate">
                Pay item price now. Delivery due on delivery.
              </p>
            </div>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[9px] uppercase tracking-wide text-muted-foreground font-medium leading-tight">
              Pay now
            </p>
            <p
              className={`text-[13.5px] font-bold tabular-nums leading-tight transition-colors ${
                selected === "bkash" && advanceAvailable
                  ? "text-success-foreground"
                  : "text-warning-foreground"
              }`}
            >
              {formatTk(lineTotal)}
            </p>
          </div>
        </div>
      </button>

      {/* COD option */}
      <button
        type="button"
        role="radio"
        aria-checked={selected === "cod"}
        disabled={!codAvailable}
        onClick={() => onSelect("cod")}
        className={`w-full text-left rounded-xl border-[1.5px] px-3 py-2.5 transition-all ${
          !codAvailable
            ? "opacity-40 cursor-not-allowed border-border bg-muted/20"
            : selected === "cod"
              ? "border-success-foreground bg-card"
              : "border-border bg-card hover:border-muted-foreground/40"
        }`}
      >
        <div className="flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className={`h-[18px] w-[18px] rounded-full border-2 shrink-0 flex items-center justify-center transition-colors ${
                selected === "cod" && codAvailable
                  ? "border-success-foreground bg-success-foreground"
                  : "border-muted-foreground/30 bg-transparent"
              }`}
            >
              {selected === "cod" && codAvailable && (
                <span className="h-1.5 w-1.5 rounded-full bg-card" />
              )}
            </span>
            <Truck
              className={`h-[18px] w-[18px] shrink-0 transition-colors ${
                selected === "cod" && codAvailable ? "text-success-foreground" : "text-foreground"
              }`}
            />
            <div className="min-w-0">
              <p className="text-[13.5px] font-bold text-foreground leading-tight">
                Cash on Delivery
              </p>
              <p className="text-[11.5px] text-muted-foreground leading-tight mt-0.5 truncate">
                Pay full amount (item + delivery) on delivery.
              </p>
            </div>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[9px] uppercase tracking-wide text-muted-foreground font-medium leading-tight">
              Pay on delivery
            </p>
            <p
              className={`text-[13.5px] font-bold tabular-nums leading-tight transition-colors ${
                selected === "cod" && codAvailable
                  ? "text-success-foreground"
                  : "text-warning-foreground"
              }`}
            >
              {formatTk(codTotal)}
            </p>
          </div>
        </div>
      </button>
    </div>
  );
}

// ─── Cart Item Card ───────────────────────────────────────────────────────────

interface CartItemCardProps {
  name: string;
  image: string | null;
  variantLabel: string | null;
  quantity: number;
  price: number;
  originalPrice: number;
  stock: number | null;
  codDeliveryCharge: number;
  deliveryEstimate: string | null;
  href: string;
  onIncrement: () => void;
  onDecrement: () => void;
  onRemove: () => void;
  disabled?: boolean;
  // Per-item payment selector (new design). When both are undefined the
  // selector is hidden — used by the guest cart (payment method is chosen
  // at checkout for guests).
  paymentSelector?: {
    allowed: PaymentMethod[];
    selected: PaymentMethod;
    onSelect: (m: PaymentMethod) => void;
    itemPrice: number;
  };
  // The listing's payment method. Only set for seller-listing items —
  // used to show a compact "COD only" or "Advance only" badge on items
  // where the buyer has no payment choice. For "both" listings, the
  // radio selector (paymentSelector prop) handles the UI instead.
  paymentMethod?: "cod" | "advance" | "both";
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
  paymentSelector,
  paymentMethod,
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
      {/* Item content row */}
      <div className="flex gap-3">
        <Link href={href} className="shrink-0 relative">
          {image ? (
            <img
              src={image}
              alt={name}
              className={`w-20 h-20 object-cover rounded-xl cursor-pointer ${
                outOfStock ? "grayscale" : ""
              }`}
              loading="lazy"
            />
          ) : (
            <NoImagePlaceholder className="w-20 h-20 rounded-xl cursor-pointer" />
          )}
          {outOfStock && (
            <span className="absolute inset-0 flex items-center justify-center bg-destructive/10 rounded-xl">
              <span className="bg-destructive text-destructive-foreground text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-md">
                Out of stock
              </span>
            </span>
          )}
        </Link>

        <div className="flex-1 min-w-0">
          {/* Name + remove */}
          <div className="flex justify-between items-start gap-2">
            <Link href={href} className="min-w-0 flex-1">
              <h3
                className={`font-semibold text-sm leading-snug truncate transition-colors ${
                  outOfStock ? "text-muted-foreground" : "text-foreground hover:text-accent-text"
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

          {/* Variant + payment method + stock */}
          <div className="mt-0.5 flex items-center gap-2 flex-wrap">
            {variantLabel && (
              <p
                className={`text-[11px] leading-relaxed ${outOfStock ? "text-muted-foreground/60" : "text-muted-foreground"}`}
              >
                {variantLabel}
              </p>
            )}
            {/* Per-item payment-method badge. Only shown for seller-listing
             items where the listing supports exactly one method (COD or
             Advance). For "both" listings, the ItemPaymentSelector radio
             below makes the choice explicit — no badge needed there.
             Hidden when out of stock (consistent with the selector). */}
            {paymentMethod && paymentMethod !== "both" && !outOfStock && (
              <PaymentMethodBadge method={paymentMethod} />
            )}
            {!outOfStock && lowStock && (
              <span className="text-[11px] text-warning-foreground font-medium">
                Only {stock} left
              </span>
            )}
          </div>

          {/* Quantity stepper */}
          <div
            className={`flex items-center border rounded-lg overflow-hidden h-8 w-24 mt-2 shrink-0 ${
              outOfStock ? "border-muted opacity-50 pointer-events-none" : "border-input"
            }`}
          >
            <button
              onClick={onDecrement}
              disabled={disabled || outOfStock || quantity <= 1}
              className="w-7 h-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Decrease quantity"
            >
              <Minus className="h-3 w-3" />
            </button>
            <span className="flex-1 text-center text-sm font-semibold text-foreground border-x border-input">
              {quantity}
            </span>
            <button
              onClick={onIncrement}
              disabled={disabled || outOfStock || atMaxStock}
              className="w-7 h-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Increase quantity"
              title={atMaxStock ? `Only ${stock} available` : undefined}
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* Price block (right column) */}
        <div className="text-right shrink-0">
          <p
            className={`text-base font-bold leading-tight ${outOfStock ? "text-muted-foreground" : "text-foreground"}`}
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

      {/* Per-item payment selector (new design) */}
      {paymentSelector && !outOfStock && (
        <ItemPaymentSelector
          allowed={paymentSelector.allowed}
          selected={paymentSelector.selected}
          onSelect={paymentSelector.onSelect}
          itemPrice={price}
          codCharge={codDeliveryCharge}
          quantity={quantity}
        />
      )}

      {/* Delivery footer — matches the reference design's two-row layout:
          row 1: delivery charge (amber/brown theme), row 2: estimated delivery (green theme).
          When there's no charge (e.g. free delivery), only the estimate row is shown. */}
      {!outOfStock && (codTotal > 0 || deliveryEstimate) && (
        <div className="mt-3 pt-3 border-t border-border/60 space-y-1.5">
          {codTotal > 0 && (
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-[12px] text-warning-foreground">
                <Truck className="h-3.5 w-3.5 text-warning-foreground" />
                Delivery charge
              </span>
              <span className="text-[12px] font-bold text-warning-foreground tabular-nums">
                {formatTk(codTotal)}
              </span>
            </div>
          )}
          {deliveryEstimate && (
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Truck className="h-3.5 w-3.5 text-success-foreground" />
                Estimated delivery
              </span>
              <span className="text-[12px] font-bold text-success-foreground">
                {deliveryEstimate}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Order Summary ────────────────────────────────────────────────────────────

interface CodBreakdownEntry {
  sellerName: string;
  /** Full amount due on delivery to this seller's courier: COD item prices + delivery charges. */
  amount: number;
}

interface OrderSummaryProps {
  subtotal: number;
  /** Sum of ALL marketplace delivery charges (always due on delivery, regardless of item payment method). */
  deliveryTotal: number;
  /** Sum of item prices paid via bKash (Advance) now. */
  dueNow: number;
  /** Per-seller breakdown of everything due on delivery (COD item prices + delivery charges). */
  codBreakdown: CodBreakdownEntry[];
  onCheckout: () => void;
  isGuest?: boolean;
  onSignIn?: () => void;
}

/**
 * Order summary matching the approved design.
 *
 * The math correctly distinguishes:
 *   - Subtotal = sum of ALL item prices (regardless of payment method)
 *   - Delivery Charge = sum of ALL marketplace delivery charges (always COD)
 *   - Due now = item prices for items the buyer chose to pay via Advance (bKash)
 *   - Due on delivery = item prices for COD items + ALL delivery charges
 *   - Total order value = Due now + Due on delivery = Subtotal + Delivery
 *
 * Example (all items COD, Tk1,300 items + Tk280 delivery):
 *   Subtotal (item price)              Tk1,300
 *   Delivery Charge                    Tk280  [DUE ON DELIVERY]
 *   ─────────────────────────────────────────
 *   Due now (You'll be charged now)    Tk0
 *   Due on delivery (COD)
 *     Haven Garden                     Tk1,180  (Tk1,100 items + Tk80 delivery)
 *     Green Garden                     Tk400    (Tk200 items + Tk200 delivery)
 *   Total due on delivery              Tk1,580
 *   ─────────────────────────────────────────
 *   Total order value                  Tk1,580
 *
 * Example (all items Advance, Tk1,300 items + Tk280 delivery):
 *   Subtotal (item price)              Tk1,300
 *   Delivery Charge                    Tk280  [DUE ON DELIVERY]
 *   ─────────────────────────────────────────
 *   Due now (You'll be charged now)    Tk1,300
 *   Due on delivery (COD)
 *     Haven Garden                     Tk80     (delivery only, items paid now)
 *     Green Garden                     Tk200
 *   Total due on delivery              Tk280
 *   ─────────────────────────────────────────
 *   Total order value                  Tk1,580
 */
function OrderSummary({
  subtotal,
  deliveryTotal,
  dueNow,
  codBreakdown,
  onCheckout,
  isGuest,
  onSignIn,
}: OrderSummaryProps) {
  const codTotal = codBreakdown.reduce((s, e) => s + e.amount, 0);
  const totalOrderValue = dueNow + codTotal;

  return (
    <div className="bg-card border border-border rounded-2xl p-5 shadow-md sticky top-24 space-y-4">
      <h2 className="font-serif text-xl font-medium text-foreground">Order Summary</h2>

      {/* Top lines */}
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">
            Subtotal <span className="text-xs">(item price)</span>
          </span>
          <span className="font-semibold text-foreground">{formatTk(subtotal)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">Delivery Charge</span>
          <span className="flex items-center gap-2">
            {deliveryTotal === 0 ? (
              <span className="font-semibold text-success-foreground">Free</span>
            ) : (
              <>
                <span className="font-semibold text-foreground">{formatTk(deliveryTotal)}</span>
                <span className="text-[10px] font-medium uppercase tracking-wide text-warning-foreground bg-warning/40 px-1.5 py-0.5 rounded">
                  Due on delivery
                </span>
              </>
            )}
          </span>
        </div>
      </div>

      {/* Due now */}
      <div className="border-t border-border pt-3">
        <div className="flex justify-between items-baseline">
          <span className="text-sm font-semibold text-foreground">
            Due now{" "}
            <span className="text-xs font-normal text-muted-foreground">
              (You'll be charged now)
            </span>
          </span>
          <span className="text-lg font-bold text-success-foreground">{formatTk(dueNow)}</span>
        </div>
      </div>

      {/* Due on delivery breakdown */}
      {codTotal > 0 && (
        <div className="border-t border-border pt-3 space-y-2">
          <div className="flex justify-between items-baseline">
            <span className="text-sm font-semibold text-foreground">
              Due on delivery{" "}
              <span className="text-xs font-normal text-muted-foreground">(COD)</span>
            </span>
          </div>
          <div className="pl-3 space-y-1.5">
            {codBreakdown.map((entry, i) => (
              <div key={i} className="flex justify-between items-center text-sm">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Sprout className="h-3 w-3 text-success-foreground shrink-0" />
                  {entry.sellerName}
                </span>
                <span className="font-medium text-foreground">{formatTk(entry.amount)}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-between items-center text-sm pt-1">
            <span className="font-semibold text-foreground">Total due on delivery</span>
            <span className="font-bold text-warning-foreground">{formatTk(codTotal)}</span>
          </div>
        </div>
      )}

      {/* Total order value */}
      <div className="border-t border-border pt-3">
        <div className="flex justify-between items-baseline">
          <span className="text-sm font-bold text-foreground">Total order value</span>
          <span className="text-xl font-bold text-foreground">{formatTk(totalOrderValue)}</span>
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

      <Link href="/products" className="block">
        <Button
          variant="ghost"
          className="w-full text-sm text-success-foreground hover:text-success-foreground/80"
        >
          Continue Shopping
        </Button>
      </Link>
    </div>
  );
}

// ─── Guest Cart Page ──────────────────────────────────────────────────────────

function GuestCartPage() {
  const guestCart = useGuestCart();
  const [, setLocation] = useLocation();
  const [showOtpModal, setShowOtpModal] = useState(false);
  const { toast } = useToast();

  const items = guestCart.items;
  const subtotal = items.reduce((sum, item) => {
    const price = item.discountPrice ?? item.price;
    return sum + price * item.quantity;
  }, 0);

  if (items.length === 0) return <EmptyCart />;

  // Group by seller for display
  const groups = new Map<string | null, { sellerName: string | null; items: typeof items }>();
  for (const item of items) {
    const key = item.sellerName ?? null;
    if (!groups.has(key)) groups.set(key, { sellerName: key, items: [] });
    groups.get(key)!.items.push(item);
  }
  const sellerGroups = Array.from(groups.values());
  const sellerCount = sellerGroups.filter((g) => g.sellerName).length;

  return (
    <div className="min-h-screen bg-[#FAFAF7]">
      {/* Phone verification banner */}
      <div className="bg-info/30 border-b border-info-border">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3 text-sm text-info-foreground">
          <span className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            Verify your phone number to check out securely.
          </span>
          <Button size="sm" onClick={() => setShowOtpModal(true)} className="shrink-0 rounded-full">
            Verify Phone
          </Button>
        </div>
      </div>

      <OtpModal
        open={showOtpModal}
        onOpenChange={setShowOtpModal}
        onVerified={() => {
          const guestItems = guestCart.items;
          if (guestItems.length > 0) {
            apiClient
              .post("/cart/merge", {
                items: guestItems.map((i) => ({
                  productId: i.productId,
                  variantId: i.variantId ?? null,
                  sellerListingVariantId: i.sellerListingVariantId ?? null,
                  quantity: i.quantity,
                })),
              })
              .then(() => {
                guestCart.clearCart();
              })
              .catch(() => {
                toast({
                  title: "Couldn't sync your bag",
                  description:
                    "Some items from your bag may not have transferred. Please re-add them if missing.",
                  variant: "destructive",
                });
              });
          }
        }}
      />

      {/* Header */}
      <div className="bg-muted/30 border-b py-8">
        <div className="max-w-6xl mx-auto px-4">
          <button
            onClick={() => window.history.back()}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 -ml-1"
            aria-label="Go back"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <h1 className="font-serif text-3xl md:text-4xl font-medium tracking-tight">Your Bag</h1>
          <p className="text-muted-foreground mt-1.5 text-sm">
            {items.length} item{items.length !== 1 ? "s" : ""}
            {sellerCount > 1 && ` from ${sellerCount} sellers`}
          </p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 lg:gap-10">
          {/* Items grouped by seller */}
          <div className="lg:col-span-2 space-y-4">
            {sellerGroups.map((group) => {
              // Determine payment badge from items — guests don't have the
              // listing's paymentMethod in localStorage, so we show a generic
              // "Payment: chosen at checkout" badge.
              return (
                <div
                  key={group.sellerName ?? "tree-friend"}
                  className="bg-card border border-border rounded-2xl p-4 shadow-sm"
                >
                  <SellerGroupHeader
                    sellerName={group.sellerName}
                    paymentBadge="Payment: chosen at checkout"
                  />
                  <div className="space-y-3">
                    {group.items.map((item) => {
                      const price = item.discountPrice ?? item.price;
                      const stock = item.stock ?? null;
                      const atMaxStock = stock != null && item.quantity >= stock;
                      return (
                        <CartItemCard
                          key={lineKeyFor(
                            item.productId,
                            item.variantId,
                            item.sellerListingVariantId,
                          )}
                          name={item.name}
                          image={item.image || null}
                          variantLabel={null}
                          quantity={item.quantity}
                          price={price}
                          originalPrice={item.price}
                          stock={stock}
                          codDeliveryCharge={item.deliveryCharge ?? 0}
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
                  </div>
                </div>
              );
            })}
          </div>

          {/* Multi-seller info */}
          {sellerCount > 1 && (
            <div className="lg:col-span-2 bg-muted/40 border border-border rounded-xl px-4 py-3 flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground/70" />
              <span>
                Items from different sellers ship separately and become separate orders at checkout.
              </span>
            </div>
          )}

          {/* Order summary — right sidebar on desktop, full-width on mobile */}
          <div className="lg:col-span-1">
            <OrderSummary
              subtotal={subtotal}
              deliveryTotal={items.reduce((s, i) => s + (i.deliveryCharge ?? 0) * i.quantity, 0)}
              dueNow={0}
              codBreakdown={sellerGroups
                .filter((g) => g.sellerName)
                .map((g) => ({
                  sellerName: g.sellerName!,
                  // Guest cart: all items are COD (no Advance option for
                  // unverified guests), so each seller's COD total = item
                  // prices + delivery charges.
                  amount: g.items.reduce(
                    (s, i) =>
                      s + ((i.discountPrice ?? i.price) + (i.deliveryCharge ?? 0)) * i.quantity,
                    0,
                  ),
                }))}
              onCheckout={() => setShowOtpModal(true)}
              isGuest
              onSignIn={() => setLocation("/sign-in")}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Authenticated Cart Page ──────────────────────────────────────────────────

function AuthenticatedCartPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { data: cart, isLoading } = useGetCart();
  const updateItem = useUpdateCartItem();
  const removeItem = useRemoveFromCart();

  // Per-item payment method selection. Keyed by cart line id. Default is
  // "bkash" when the listing allows it, else "cod". The buyer can change
  // this per item via the radio selector in each card.
  const [itemPaymentMethods, setItemPaymentMethods] = useState<Record<string, PaymentMethod>>({});

  // Abandoned cart sync (debounced 2s) — same pattern as before.
  const syncAbandonedCartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (syncAbandonedCartTimeoutRef.current) clearTimeout(syncAbandonedCartTimeoutRef.current);
    syncAbandonedCartTimeoutRef.current = setTimeout(() => {
      apiClient.post("/abandoned-cart/sync").catch(() => {});
    }, 2000);
    return () => {
      if (syncAbandonedCartTimeoutRef.current) clearTimeout(syncAbandonedCartTimeoutRef.current);
    };
  }, [cart?.items, cart?.subtotal]);

  const items = cart?.items ?? [];
  const subtotal = cart?.subtotal ?? 0;

  // Initialize / refresh per-item payment method defaults whenever the
  // cart changes. Only tracks "both" listings where the selector is
  // actually shown — "cod" and "advance" listings have no buyer-facing
  // choice, so their effective method is derived on the fly in dueNow /
  // handleCheckout (no state needed). This keeps the selection stable
  // across cart refreshes while still respecting listing changes.
  useEffect(() => {
    setItemPaymentMethods((prev) => {
      const next: Record<string, PaymentMethod> = {};
      for (const item of items) {
        if (item.kind !== "seller_listing" || !item.listing) continue;
        // Track all "both" listings — the selector is shown for all of
        // them regardless of platform bKash verification. Platform
        // verification is a checkout-time concern (orders.ts falls back
        // to COD if bKash isn't available), not a bag-display concern.
        // This was previously gated on platformBkashVerified, which
        // contradicted the rendering (the selector was shown but the
        // selection was silently dropped on cart refresh).
        if (item.listing.paymentMethod !== "both") continue;
        const current = prev[item.id];
        // Both "bkash" and "cod" are valid for "both" listings — keep
        // the buyer's previous pick, default to "bkash" (pay now) for
        // new items.
        next[item.id] = current === "cod" ? "cod" : "bkash";
      }
      return next;
    });
  }, [items]);

  function handleUpdate(id: number, quantity: number) {
    if (quantity < 1) return;
    updateItem.mutate(
      { id, data: { quantity } },
      { onSuccess: () => qc.invalidateQueries({ queryKey: getGetCartQueryKey() }) },
    );
  }

  function handleRemove(id: number) {
    removeItem.mutate(
      { id },
      { onSuccess: () => qc.invalidateQueries({ queryKey: getGetCartQueryKey() }) },
    );
  }

  function handleRemoveUnavailable(ids: number[]) {
    for (const id of ids) {
      removeItem.mutate(
        { id },
        { onSuccess: () => qc.invalidateQueries({ queryKey: getGetCartQueryKey() }) },
      );
    }
  }

  if (isLoading) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-10">
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  if (items.length === 0) return <EmptyCart />;

  // Group by seller
  const groups = new Map<
    number | null,
    {
      sellerId: number | null;
      seller: (typeof items)[number]["seller"] | null;
      items: typeof items;
    }
  >();
  for (const item of items) {
    const key = item.kind === "seller_listing" ? (item.sellerId ?? null) : null;
    if (!groups.has(key)) {
      groups.set(key, {
        sellerId: key,
        seller: item.kind === "seller_listing" ? (item.seller ?? null) : null,
        items: [],
      });
    }
    groups.get(key)!.items.push(item);
  }
  const sellerGroups = Array.from(groups.values());
  const sellerCount = sellerGroups.filter((g) => g.seller).length;

  // Price-change + out-of-stock detection (same as before)
  const priceChangedCount =
    (cart as unknown as { priceChangedCount?: number })?.priceChangedCount ?? 0;
  const outOfStockItems = items
    .map((item) => {
      const stock =
        item.kind === "seller_listing" ? (item.listing?.stock ?? 0) : (item.variant?.stock ?? 0);
      return { id: item.id, name: item.product.name, outOfStock: stock <= 0 };
    })
    .filter((x) => x.outOfStock);
  const outOfStockIds = outOfStockItems.map((x) => x.id);

  // COD breakdown per seller for the summary. Each entry is the FULL amount
  // the buyer pays that seller's courier on delivery: COD item prices + the
  // seller's delivery charges. (Delivery charges are ALWAYS due on delivery
  // for marketplace items, regardless of whether the item itself is paid via
  // Advance or COD — see routes/cart.ts's buildCart doc comment.)
  //
  // For an Advance item: only its delivery charge goes into the COD breakdown
  // (the item price was paid now via bKash).
  // For a COD item: item price + delivery charge both go into the breakdown.
  const codBreakdown = sellerGroups
    .filter((g): g is typeof g & { seller: NonNullable<typeof g.seller> } => g.seller != null)
    .map((g) => {
      return {
        sellerName: g.seller.nurseryName ?? g.seller.businessName,
        amount: g.items.reduce((sum, item) => {
          if (item.kind !== "seller_listing" || !item.listing) return sum;
          const listingPm = item.listing.paymentMethod;
          // Derive effective method: explicit buyer selection wins; otherwise
          // default from the listing's paymentMethod. No platform verification
          // gate — the bag reflects what the seller chose. Checkout handles
          // the actual bKash availability enforcement.
          const method = itemPaymentMethods[item.id] ?? (listingPm === "cod" ? "cod" : "bkash");
          const itemPrice = (item.listing.discountPrice ?? item.listing.price) * item.quantity;
          const delivery = (item.listing.deliveryCharge ?? 0) * item.quantity;
          // Delivery is always due on delivery. Item price is due on delivery
          // only when the method is COD.
          return sum + delivery + (method === "cod" ? itemPrice : 0);
        }, 0),
      };
    })
    .filter((e) => e.amount > 0);

  // Total of ALL marketplace delivery charges (always due on delivery).
  const deliveryTotal = items.reduce(
    (sum, item) =>
      sum +
      (item.kind === "seller_listing" ? (item.listing?.deliveryCharge ?? 0) * item.quantity : 0),
    0,
  );

  // Due now = sum of (item price × qty) for items where the buyer selected
  // "bkash" (advance payment). COD items contribute 0 to "due now" — the
  // buyer pays the full amount (item + delivery) on delivery instead.
  // For listings that aren't "both" (i.e. "cod" or "advance"), there's no
  // per-item selector shown so the buyer never explicitly picks — the
  // default is derived from the listing's own paymentMethod:
  //   "cod"     → COD (pay on delivery, not now)
  //   "advance" → bKash (pay now)
  //   "both"    → buyer's selection via the radio (defaults to "bkash")
  const dueNow = items.reduce((sum, item) => {
    if (item.kind !== "seller_listing")
      return sum + (item.variant!.discountPrice ?? item.variant!.price) * item.quantity;
    const listingPm = item.listing!.paymentMethod;
    // Derive the effective method: explicit buyer selection wins; otherwise
    // default from the listing's paymentMethod. The platform verification
    // state is NOT gated here — the bag should reflect what the seller chose
    // for their listing. If bKash isn't actually available at checkout,
    // orders.ts will fall back to COD at that point.
    const method = itemPaymentMethods[item.id] ?? (listingPm === "cod" ? "cod" : "bkash");
    if (method !== "bkash") return sum; // COD — pay on delivery, not now
    return sum + (item.listing!.discountPrice ?? item.listing!.price) * item.quantity;
  }, 0);

  function handleCheckout() {
    // Persist per-item payment methods so CheckoutPage can read them as
    // defaults. Keyed by cart line id → "bkash" | "cod". CheckoutPage
    // groups by seller and uses the first item's method per seller.
    //
    // For listings where no selector was shown ("cod" / "advance" / "both"
    // when platform bKash is unverified), the method is derived from the
    // listing's own paymentMethod — same logic as the dueNow calculation
    // above — so CheckoutPage gets the correct default per seller even
    // without an explicit buyer selection.
    const methodsToPersist: Record<string, PaymentMethod> = {};
    for (const item of items) {
      if (item.kind !== "seller_listing") continue;
      const listingPm = item.listing!.paymentMethod;
      methodsToPersist[item.id] =
        itemPaymentMethods[item.id] ?? (listingPm === "cod" ? "cod" : "bkash");
    }
    try {
      sessionStorage.setItem(BAG_PAYMENT_METHODS_KEY, JSON.stringify(methodsToPersist));
    } catch {
      // sessionStorage unavailable (private mode) — non-critical, checkout
      // will just fall back to its own defaults.
    }
    setLocation("/checkout");
  }

  return (
    <div className="min-h-screen bg-[#FAFAF7]">
      {/* Banners */}
      {outOfStockItems.length > 0 && (
        <div className="bg-destructive/10 border-b border-destructive/20">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-start justify-between gap-3 text-sm text-destructive">
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
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-start gap-2 text-sm text-warning-foreground">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              Prices for {priceChangedCount} item{priceChangedCount !== 1 ? "s" : ""} in your bag
              have changed since you added them. The total at checkout will reflect the current
              prices.
            </span>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="bg-muted/30 border-b py-8">
        <div className="max-w-6xl mx-auto px-4">
          <button
            onClick={() => window.history.back()}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 -ml-1"
            aria-label="Go back"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <h1 className="font-serif text-3xl md:text-4xl font-medium tracking-tight">Your Bag</h1>
          <p className="text-muted-foreground mt-1.5 text-sm">
            {items.length} item{items.length !== 1 ? "s" : ""}
            {sellerCount > 1 && ` from ${sellerCount} sellers`}
          </p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 lg:gap-10">
          {/* Items grouped by seller */}
          <div className="lg:col-span-2 space-y-4">
            {sellerGroups.map((group) => {
              // Determine the seller's payment badge from the listings in
              // this group. If all listings support the same method, show
              // that method's label. If listings have different methods
              // (e.g. one COD-only and one Advance-only from the same
              // nursery), show "Mixed payment methods" — the per-item
              // badges on each card make the individual listing's method
              // clear. Previously this used a cascade that picked
              // "advance" whenever any advance listing existed, silently
              // mislabeling COD-only items in the same group.
              const listingsPaymentMethods = group.items
                .filter(
                  (
                    i,
                  ): i is typeof i & {
                    kind: "seller_listing";
                    listing: NonNullable<typeof i.listing>;
                  } => i.kind === "seller_listing" && !!i.listing,
                )
                .map((i) => i.listing.paymentMethod);
              const uniqueMethods = [...new Set(listingsPaymentMethods)];
              const sellerBadge =
                uniqueMethods.length === 0
                  ? "Payment: chosen at checkout"
                  : uniqueMethods.length === 1
                    ? paymentBadgeLabel(uniqueMethods[0])
                    : "Mixed payment methods";

              return (
                <div
                  key={group.sellerId ?? "admin-direct"}
                  className="bg-card border border-border rounded-2xl p-4 shadow-sm"
                >
                  <SellerGroupHeader
                    sellerName={group.seller?.nurseryName ?? null}
                    paymentBadge={sellerBadge}
                  />
                  <div className="space-y-3">
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
                      const codDeliveryCharge = isListing ? (item.listing!.deliveryCharge ?? 0) : 0;
                      const deliveryEstimate = isListing
                        ? formatDeliveryEstimate(item.listing!.deliveryTimeDays)
                        : null;

                      // Per-item payment selector: ONLY shown when the listing
                      // is "both" — that's the only case where the buyer has a
                      // real choice to make. For "cod" listings the buyer pays
                      // on delivery (no choice). For "advance" listings the
                      // buyer pays now (no choice). The platform verification
                      // state is NOT gated here — the bag reflects what the
                      // seller chose. If bKash isn't actually available at
                      // checkout, orders.ts will fall back to COD at that point.
                      const listingPaymentMethod = item.listing!.paymentMethod;
                      const showItemPaymentSelector = isListing && listingPaymentMethod === "both";
                      const paymentSelector = showItemPaymentSelector
                        ? {
                            allowed: ["bkash", "cod"] as PaymentMethod[],
                            selected: itemPaymentMethods[item.id] ?? "bkash",
                            onSelect: (m: PaymentMethod) =>
                              setItemPaymentMethods((prev) => ({ ...prev, [item.id]: m })),
                            itemPrice: price,
                          }
                        : undefined;

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
                          disabled={removeItem.isPending}
                          paymentMethod={
                            isListing
                              ? (item.listing!.paymentMethod as "cod" | "advance" | "both")
                              : undefined
                          }
                          paymentSelector={paymentSelector}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Multi-seller info */}
          {sellerCount > 1 && (
            <div className="lg:col-span-2 bg-muted/40 border border-border rounded-xl px-4 py-3 flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground/70" />
              <span>
                Items from different sellers ship separately and become separate orders at checkout.
              </span>
            </div>
          )}

          {/* Order summary — right sidebar on desktop, full-width on mobile */}
          <div className="lg:col-span-1">
            <OrderSummary
              subtotal={subtotal}
              deliveryTotal={deliveryTotal}
              dueNow={dueNow}
              codBreakdown={codBreakdown}
              onCheckout={handleCheckout}
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
  const { isVerified } = useGuestSession();

  if (!isLoaded) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-10">
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  if (user || isVerified) return <AuthenticatedCartPage />;
  return <GuestCartPage />;
}
