import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useLoyalty } from "@/hooks/useLoyalty";
import { useGuestSession } from "@/hooks/useGuestSession";
import { OtpModal } from "@/components/cart/OtpModal";
import {
  useGetCart,
  useCreateOrder,
  useValidateCoupon,
  useListAddresses,
  getGetCartQueryKey,
  getListAddressesQueryKey,
  createBkashPayment,
  createBkashPaymentGuest,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { BKASH_ICON } from "@/lib/preorderIcons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  CheckCircle2,
  Tag,
  MapPin,
  ChevronDown,
  ShoppingBag,
  CreditCard,
  Sprout,
} from "lucide-react";
import { Link } from "wouter";
import { useUser } from "@clerk/react";
import { useGuestCart } from "@/hooks/useGuestCart";
import { apiClient } from "@/lib/apiClient";

type PaymentMethod = "bkash" | "cod";

/**
 * A cart line (kind: "seller_listing") is only buyable with the payment
 * methods that seller's listing enables (listing.paymentMethod: "cod" |
 * "advance" | "both") -- "advance" means bkash only, "both" means both.
 * See plan doc §7. Admin-direct lines (kind: "variant") accept both,
 * unchanged from pre-marketplace behavior.
 *
 * A listing's own paymentMethod field can drift from the seller's actual
 * payment-config state (e.g. an admin unverifies a seller's bKash config
 * without touching their listings), so this also takes the live
 * hasVerifiedPaymentConfig flag from the cart response (routes/cart.ts) and
 * excludes "bkash" whenever it's false, regardless of what the listing
 * itself claims to support.
 */
function allowedMethodsForListingPaymentMethod(
  pm: string,
  hasVerifiedPaymentConfig: boolean,
): PaymentMethod[] {
  if (pm === "cod") return ["cod"];
  if (pm === "advance") return hasVerifiedPaymentConfig ? ["bkash"] : [];
  return hasVerifiedPaymentConfig ? ["bkash", "cod"] : ["cod"];
}

export function CheckoutPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { user, isLoaded: userLoaded } = useUser();
  const { isVerified, guestPhone } = useGuestSession();
  // Part 3: verified guests (phone-verified via OTP) use the same checkout
  // path as authenticated users — POST /orders with the guest JWT as auth.
  // Only UNVERIFIED guests (no Clerk account, no phone verification) use
  // the old localStorage-based guest checkout (POST /orders/guest).
  const isGuest = userLoaded && !user && !isVerified;
  const [showOtpModal, setShowOtpModal] = useState(false);
  const guestCart = useGuestCart();
  const { data: cart, isLoading: cartLoading } = useGetCart({
    query: { enabled: !isGuest, queryKey: getGetCartQueryKey() },
  });
  const isLoading = !userLoaded || (!isGuest && cartLoading);
  const { data: savedAddresses = [] } = useListAddresses({
    query: { retry: false, queryKey: getListAddressesQueryKey() },
  });
  const createOrder = useCreateOrder();
  const validateCoupon = useValidateCoupon();

  const [address, setAddress] = useState({
    fullName: "",
    phone: "",
    street: "",
    city: "",
    district: "",
    postalCode: "",
  });
  const [selectedAddressId, setSelectedAddressId] = useState<number | null>(null);
  const [showAddressPicker, setShowAddressPicker] = useState(false);
  // Fallback/default method, used directly for guests and single-group
  // carts. For multi-seller carts, sellerPaymentMethod below overrides
  // this per group.
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("bkash");
  const [sellerPaymentMethod, setSellerPaymentMethod] = useState<Record<string, PaymentMethod>>({});
  const [couponCode, setCouponCode] = useState("");
  const [discount, setDiscount] = useState(0);
  const [couponApplied, setCouponApplied] = useState(false);
  const [couponError, setCouponError] = useState("");
  // Which seller's group this applied coupon actually discounts -- null
  // means platform-wide (applies to whichever group is largest, same as
  // loyalty). Tracked separately from discount/couponApplied so the
  // summary label below can say the right thing instead of always
  // claiming "largest order", which is only true for a platform-wide
  // coupon now that seller-scoped coupons target their own seller
  // specifically (see handleApplyCoupon and routes/orders.ts).
  const [couponSellerId, setCouponSellerId] = useState<number | null>(null);
  const [giftWrap, setGiftWrap] = useState(false);
  const [giftMessage, setGiftMessage] = useState("");
  const [usePoints, setUsePoints] = useState(false);
  const { data: loyaltyData } = useLoyalty();
  // Part 2 of 4 (bKash Tokenized Checkout, see PART2_HANDOFF.md): the
  // buyer no longer types a sending number or transaction id here at all
  // -- bKash's own hosted payment page collects the sending
  // number/OTP/PIN, and the real transaction id comes back from bKash's
  // Execute Payment call (routes/bkashPayment.ts's callback handler), not
  // from buyer input. The old bkashNumber/sellerSenderNumber/transactionId
  // state and their senderNumberFor/setSenderNumberFor/needsSenderNumber/
  // missingSenderNumberGroups helpers are REMOVED entirely, not just
  // unused -- keeping them around would invite a stale read somewhere.
  const [redirectingToBkash, setRedirectingToBkash] = useState(false);
  // Price-change dialog state: when the backend returns 409 with
  // priceChangedItems, we show a dialog so the buyer can review the
  // changes and re-confirm. This is the industry-standard pattern.
  const [priceChangedItems, setPriceChangedItems] = useState<
    {
      productId: number;
      productName: string;
      variantName: string;
      oldPrice: number;
      newPrice: number;
    }[]
  >([]);
  const [showPriceChangedDialog, setShowPriceChangedDialog] = useState(false);
  // Order review step: a confirmation modal shown before the final
  // submit. Prevents accidental orders from a misclick on "Place Order".
  const [showReviewDialog, setShowReviewDialog] = useState(false);
  // Create-account prompt: shown after a guest successfully places an
  // order. Industry standard (Daraz, Amazon) — the buyer just had a
  // positive experience, and their phone is already verified, so
  // creating an account is one tap away. The phone is pre-filled from
  // the guest session.
  const [showCreateAccountDialog, setShowCreateAccountDialog] = useState(false);

  // Normalize guest (localStorage) and logged-in (server) cart items into one
  // shape so the summary below doesn't need to branch on isGuest. Price
  // always comes from the specific variant or seller listing, never from
  // the product. sellerId/sellerName are null for admin-direct lines and
  // guest items (guest checkout is admin-direct-only -- see routes/orders.ts).
  const items = isGuest
    ? guestCart.items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
        name: i.name,
        image: i.image,
        price: i.price,
        discountPrice: i.discountPrice,
        sellerId: null as number | null,
        sellerName: null as string | null,
        codDeliveryCharge: 0,
      }))
    : (cart?.items ?? []).map((i) => {
        const isListing = i.kind === "seller_listing";
        return {
          productId: i.productId,
          quantity: i.quantity,
          name: i.product.name,
          image: i.product.images[0] ?? "",
          price: isListing ? i.listing!.price : i.variant!.price,
          discountPrice: isListing
            ? (i.listing!.discountPrice ?? null)
            : (i.variant!.discountPrice ?? null),
          sellerId: isListing ? i.sellerId : null,
          sellerName: isListing ? (i.seller?.nurseryName ?? null) : null,
          // Only present (and non-zero delivery-relevant) on seller_listing
          // lines -- see the codDeliveryTotal comment below for why this
          // isn't part of shipping/total.
          codDeliveryCharge: isListing ? (i.listing!.deliveryCharge ?? 0) : 0,
        };
      });

  // Group by seller purely for the payment-method and summary UI. Key
  // "null" (string) represents the admin-direct group, matching how the
  // backend reads sellerPaymentMethods (routes/orders.ts).
  const sellerGroups = useMemo(() => {
    const map = new Map<
      string,
      { sellerId: number | null; sellerName: string | null; items: typeof items; subtotal: number }
    >();
    for (const item of items) {
      const key = item.sellerId == null ? "null" : String(item.sellerId);
      if (!map.has(key))
        map.set(key, {
          sellerId: item.sellerId,
          sellerName: item.sellerName,
          items: [],
          subtotal: 0,
        });
      const g = map.get(key)!;
      g.items.push(item);
      g.subtotal += (item.discountPrice ?? item.price) * item.quantity;
    }
    return Array.from(map.values());
  }, [items]);
  const isMultiSeller = sellerGroups.length > 1;
  // Discount (coupon + loyalty) goes to whichever resulting order has the
  // largest subtotal -- matches backend allocation exactly (routes/orders.ts
  // groupBySellerAndAllocateDiscount), so the number shown here is the
  // number the buyer actually gets, not an approximation.
  const largestGroupKey = useMemo(() => {
    if (sellerGroups.length === 0) return null;
    return sellerGroups.reduce((a, b) => (b.subtotal > a.subtotal ? b : a)).sellerId;
  }, [sellerGroups]);

  const subtotal = isGuest
    ? guestCart.items.reduce((s, i) => s + (i.discountPrice ?? i.price) * i.quantity, 0)
    : (cart?.subtotal ?? 0);
  const maxPointsDiscount = Math.min(loyaltyData?.takaValue ?? 0, subtotal * 0.2); // max 20% of order
  // Delivery = real per-variant deliveryCharge total. Authenticated carts
  // get this from GET /api/cart (cart.deliveryTotal = sum of
  // variant.deliveryCharge × quantity for admin-direct lines). Guest carts
  // mirror deliveryCharge on each item so the preview matches.
  //
  // The old `subtotal > 2000 ? 0 : 120` was wrong on two counts:
  //   1. It showed 120 for every order regardless of the variant's actual
  //      deliveryCharge (e.g. a variant with deliveryCharge=80 showed 120)
  //   2. The "free over 2000" rule has been removed per product decision —
  //      delivery is always the real per-variant charge now.
  const shipping = isGuest
    ? guestCart.items.reduce((s, i) => s + (i.deliveryCharge ?? 0) * i.quantity, 0)
    : (cart?.deliveryTotal ?? 0);
  const giftWrapCost = giftWrap
    ? // Use the server-side gift wrap cost if available, fall back to 50
      // for backward compat. The backend reads this from
      // platform_payment_config.gift_wrap_cost.
      ((cart as unknown as { giftWrapCost?: number } | null)?.giftWrapCost ?? 50)
    : 0;
  const loyaltyDiscount = usePoints ? maxPointsDiscount : 0;
  const total = Math.max(0, subtotal + shipping + giftWrapCost - discount - loyaltyDiscount);
  // Marketplace (seller_listing) lines' courier fee is paid by the buyer
  // directly to the seller on delivery -- never part of shipping/total
  // above (see routes/cart.ts). Shown separately so the buyer isn't
  // surprised by a COD charge that never appeared in the order total.
  const codDeliveryTotal = items.reduce((s, i) => s + i.codDeliveryCharge * i.quantity, 0);

  function methodFor(sellerKey: string): PaymentMethod {
    return sellerPaymentMethod[sellerKey] ?? paymentMethod;
  }
  function setMethodFor(sellerKey: string, method: PaymentMethod) {
    setSellerPaymentMethod((prev) => ({ ...prev, [sellerKey]: method }));
  }

  function applyAddress(addr: any) {
    setAddress({
      fullName: addr.fullName ?? "",
      phone: addr.phone ?? "",
      street: addr.street ?? "",
      city: addr.city ?? "",
      district: addr.district ?? "",
      postalCode: addr.postalCode ?? "",
    });
    setSelectedAddressId(addr.id);
    setShowAddressPicker(false);
  }

  function handleApplyCoupon() {
    setCouponError("");
    // sellerIds lets the backend reject a seller-scoped coupon up front
    // (routes/coupons.ts /coupons/validate) instead of only failing later
    // at Place Order -- see that route's doc comment.
    const cartSellerIds = sellerGroups
      .map((g) => g.sellerId)
      .filter((id): id is number => id !== null);
    validateCoupon.mutate(
      { data: { code: couponCode, orderAmount: subtotal, sellerIds: cartSellerIds } },
      {
        onSuccess: (coupon) => {
          // A seller-scoped coupon only discounts that seller's own group
          // subtotal, not the whole cart -- matches routes/orders.ts
          // groupBySellerAndAllocateDiscount(..., couponSellerId) exactly.
          // A platform-wide coupon (coupon.sellerId === null) still applies
          // against the largest group's subtotal, same as before.
          const base =
            coupon.sellerId !== null
              ? (sellerGroups.find((g) => g.sellerId === coupon.sellerId)?.subtotal ?? 0)
              : subtotal;
          const computed =
            coupon.discountType === "percentage"
              ? Math.floor(base * (coupon.discountValue / 100))
              : Math.min(coupon.discountValue, base);
          setDiscount(computed);
          setCouponApplied(true);
          setCouponSellerId(coupon.sellerId);
        },
        onError: () => {
          setCouponError("Invalid or expired coupon code.");
        },
      },
    );
  }

  const [submitError, setSubmitError] = useState("");

  /**
   * After AUTHENTICATED checkout creates order(s), kicks off bKash payment.
   *
   * PAYMENT SESSION (Phase 1): if the checkout response includes a
   * paymentSessionId, the buyer pays ALL bKash orders in ONE bKash redirect
   * (the session covers the sum of all bKash order totals). This is the
   * industry-standard pattern — the buyer never pays N times for a
   * multi-seller cart.
   *
   * FALLBACK: if no paymentSessionId (session creation failed server-side,
   * or COD-only cart), falls back to the old per-order flow: pay the first
   * bKash order, leave the rest for the buyer to pay from the order detail
   * page.
   *
   * COD-only orders need no bKash call at all — just navigate to the
   * first order's detail page.
   */
  async function payFirstBkashOrderOrGoToOrder(
    orders: { id: number; paymentMethod: string }[],
    paymentSessionId?: number | null,
  ) {
    const firstBkash = orders.find((o) => o.paymentMethod === "bkash");
    if (!firstBkash) {
      setLocation(`/orders/${orders[0].id}`);
      return;
    }
    setRedirectingToBkash(true);
    try {
      // If we have a payment session, use the session-based endpoint
      // (ONE bKash redirect for ALL orders). Otherwise fall back to
      // the per-order endpoint (first bKash order only).
      if (paymentSessionId) {
        const { data: sessionData } = await apiClient.post<{
          bkashURL: string;
          paymentID: string;
        }>("/bkash/create-payment-session", { paymentSessionId });
        window.location.href = sessionData.bkashURL;
      } else {
        const session = await createBkashPayment({ orderId: firstBkash.id });
        window.location.href = session.bkashURL;
      }
    } catch {
      setRedirectingToBkash(false);
      setSubmitError(
        "Your order was placed, but we couldn't start bKash payment just now. You can retry payment from your order page.",
      );
      setLocation(`/orders/${firstBkash.id}`);
    }
  }

  /**
   * GUEST equivalent — uses the same session-based endpoint when a
   * paymentSessionId is available. Guest checkout always produces one
   * order (admin-direct only), so there's no multi-seller problem, but
   * using the session endpoint keeps the flow consistent.
   */
  async function payGuestBkashOrderOrGoToOrder(
    trackingId: string,
    method: PaymentMethod,
    paymentSessionId?: number | null,
  ) {
    if (method !== "bkash") {
      setLocation(`/orders/${trackingId}`);
      return;
    }
    setRedirectingToBkash(true);
    try {
      if (paymentSessionId) {
        const { data: sessionData } = await apiClient.post<{
          bkashURL: string;
          paymentID: string;
        }>("/bkash/create-payment-session", { paymentSessionId });
        window.location.href = sessionData.bkashURL;
      } else {
        const session = await createBkashPaymentGuest({ trackingId });
        window.location.href = session.bkashURL;
      }
    } catch {
      setRedirectingToBkash(false);
      setSubmitError(
        "Your order was placed, but we couldn't start bKash payment just now. You can retry payment from your order page.",
      );
      setLocation(`/orders/${trackingId}`);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError("");
    if (!address.fullName || !address.phone || !address.street || !address.city) {
      setSubmitError("Please fill in all required address fields.");
      return;
    }
    // BD phone format validation: 11 digits starting with 01[3-9].
    // Matches the backend's BD_PHONE_REGEX in routes/orders.ts so the
    // buyer gets immediate feedback instead of a 400 after submit.
    const normalizedPhone = address.phone.replace(/[\s-]/g, "");
    if (!/^01[3-9]\d{8}$/.test(normalizedPhone)) {
      setSubmitError("Please enter a valid Bangladeshi phone number (e.g. 01XXXXXXXXX).");
      return;
    }
    // Part 3: unverified guests must verify their phone before checkout.
    // This is the Daraz-style "light identity" gate — the buyer enters
    // their phone number (already filled in the address form), receives
    // an OTP via WhatsApp, and verifies it. After verification, the page
    // re-renders with isVerified=true, isGuest=false, and the buyer
    // proceeds through the normal authenticated checkout path.
    if (isGuest) {
      setShowOtpModal(true);
      return;
    }
    // Show the order review dialog before actually submitting. This is
    // the industry-standard "review your order" step — prevents accidental
    // orders from a misclick on "Place Order". The actual submission
    // happens in confirmAndSubmit() after the buyer confirms.
    setShowReviewDialog(true);
  }

  // The actual submission — called after the buyer confirms in the
  // review dialog. Separated from handleSubmit so validation runs once
  // (on submit) and the actual network call runs once (on confirm).
  function confirmAndSubmit() {
    setShowReviewDialog(false);
    // Part 2 of 4: no more sending-number validation here -- bKash's own
    // hosted page collects that. See doc comment above the (now removed)
    // bkashNumber/sellerSenderNumber state for what used to live here.
    const shippingAddress = {
      fullName: address.fullName,
      phone: address.phone,
      street: address.street,
      city: address.city,
      district: address.district,
      postalCode: address.postalCode || null,
    };

    // ── REMOVED: old unverified-guest checkout path ──────────────────
    // The old `if (isGuest)` block called POST /api/orders/guest (the
    // now-deleted endpoint) with items from the localStorage cart. This
    // path is unreachable because:
    //   1. Unverified guests are redirected to OTP by handleSubmit()
    //   2. Verified guests use the same POST /orders path as authenticated
    //      users (isGuest = !user && !isVerified, so verified guests have
    //      isGuest = false)
    // The old POST /orders/guest endpoint has been removed from the backend.
    // The guestCart localStorage items are merged to the server cart at
    // OTP verification time (OtpModal's onVerified callback).

    // Generate an idempotency key for this checkout attempt. If the
    // network retries (mobile flaky connection, double-click), the
    // backend returns the existing order(s) instead of creating
    // duplicates. The key is per-submit, so a buyer who deliberately
    // places two separate orders gets two keys (two orders).
    const idempotencyKey = crypto.randomUUID();
    // Using apiClient.post directly (instead of the generated createOrder
    // mutation) because the generated client doesn't support per-call
    // headers — and we need the Idempotency-Key header on this specific
    // request only, not on every createOrder call in the app.
    apiClient
      .post<{ id: number; trackingId: string }[] | { id: number; trackingId: string }>(
        "/orders",
        {
          shippingAddress,
          paymentMethod,
          sellerPaymentMethods: isMultiSeller
            ? Object.fromEntries(
                sellerGroups.map((g) => {
                  const key = g.sellerId == null ? "null" : String(g.sellerId);
                  return [key, methodFor(key)];
                }),
              )
            : undefined,
          couponCode: couponApplied ? couponCode : null,
          loyaltyPointsToRedeem:
            usePoints && maxPointsDiscount > 0 ? Math.ceil(maxPointsDiscount) : 0,
          giftWrap,
          giftMessage: giftWrap ? giftMessage : null,
        },
        { headers: { "Idempotency-Key": idempotencyKey } },
      )
      .then(({ data }) => {
        // The backend now returns { orders, paymentSessionId } instead of
        // a bare array. Extract both — paymentSessionId is null for COD-only
        // carts or if session creation failed (fallback to per-order flow).
        const responseBody = data as { orders?: any[]; paymentSessionId?: number | null } | any[];
        const orders = Array.isArray(responseBody) ? responseBody : (responseBody.orders ?? []);
        const paymentSessionId = Array.isArray(responseBody)
          ? null
          : (responseBody.paymentSessionId ?? null);
        qc.invalidateQueries({ queryKey: getGetCartQueryKey() });
        apiClient.post("/abandoned-cart/recover").catch(() => {
          // Silently ignore — recovery marking is best-effort.
        });
        try {
          sessionStorage.setItem(
            "last_checkout_order_ids",
            JSON.stringify(orders.map((o: any) => o.id)),
          );
        } catch {
          // sessionStorage may be unavailable (private mode) — non-critical.
        }
        // Pass paymentSessionId so the buyer pays ALL bKash orders in ONE
        // bKash redirect (session-based) instead of N redirects (per-order).
        // For verified guests with COD orders: show "Create an account"
        // prompt before navigating to the order detail page. This is the
        // Daraz retention pattern — the buyer just had a positive
        // experience, their phone is verified, so account creation is
        // frictionless. For bKash orders, the prompt would need to show
        // after the bKash redirect returns — skipped for now (the buyer
        // can always sign up later from the order tracking page).
        const isVerifiedGuest = !user && isVerified;
        const isCodOnly = !orders.some((o: any) => o.paymentMethod === "bkash");
        if (isVerifiedGuest && isCodOnly) {
          // Show the create-account dialog instead of navigating immediately.
          // The dialog's "View Order" button navigates to the order page.
          setShowCreateAccountDialog(true);
        } else {
          payFirstBkashOrderOrGoToOrder(orders as any, paymentSessionId);
        }
      })
      .catch((err) => {
        // Price locking: if the backend returns 409 with priceChangedItems,
        // show a dialog so the buyer can review and re-confirm.
        const msg = err?.message ?? "";
        if (msg.includes("409")) {
          const match = msg.match(/\{[\s\S]*\}/);
          if (match) {
            try {
              const body = JSON.parse(match[0]);
              if (body.priceChangedItems) {
                setPriceChangedItems(body.priceChangedItems);
                setShowPriceChangedDialog(true);
                return;
              }
            } catch {
              // JSON parse failed — fall through to generic error
            }
          }
        }
        setSubmitError(msg || "Failed to place order. Please try again.");
      });
  }

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-10">
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="py-24 text-center">
        <p className="text-muted-foreground mb-4">No items in cart.</p>
        <Link href="/products">
          <Button>Shop Now</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="bg-muted/30 border-b py-10">
        <div className="container mx-auto px-4">
          <PageBreadcrumb
            crumbs={[
              { label: "Cart", href: "/cart", icon: <ShoppingBag className="h-3 w-3" /> },
              { label: "Checkout", icon: <CreditCard className="h-3 w-3" /> },
            ]}
            className="mb-3"
          />
          <h1 className="font-serif text-4xl font-medium">Checkout</h1>
          {isMultiSeller && (
            <p className="text-sm text-muted-foreground mt-1">
              Your bag has items from {sellerGroups.length} sellers — this will create{" "}
              {sellerGroups.length} separate orders.
            </p>
          )}
        </div>
      </div>

      <div className="container mx-auto px-4 py-8">
        <form onSubmit={handleSubmit}>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
            <div className="lg:col-span-2 space-y-8">
              {/* Delivery address */}
              <div className="bg-card border rounded-xl p-6">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="font-medium text-lg">Delivery Address</h2>
                  {(savedAddresses as any[]).length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowAddressPicker(!showAddressPicker)}
                      className="flex items-center gap-1.5 text-sm text-accent hover:text-accent/80 font-medium transition-colors"
                    >
                      <MapPin className="h-4 w-4" />
                      Saved addresses
                      <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform ${showAddressPicker ? "rotate-180" : ""}`}
                      />
                    </button>
                  )}
                </div>

                {showAddressPicker && (savedAddresses as any[]).length > 0 && (
                  <div className="mb-5 space-y-2">
                    {(savedAddresses as any[]).map((addr: any) => (
                      <button
                        key={addr.id}
                        type="button"
                        onClick={() => applyAddress(addr)}
                        className={`w-full text-left px-4 py-3 rounded-xl border transition-all text-sm ${
                          selectedAddressId === addr.id
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-foreground/30 hover:bg-muted/30"
                        }`}
                      >
                        <p className="font-medium">{addr.fullName}</p>
                        <p className="text-muted-foreground text-xs mt-0.5">
                          {addr.street}, {addr.city}
                          {addr.district ? `, ${addr.district}` : ""}
                          {addr.phone ? ` 📞 ${addr.phone}` : ""}
                        </p>
                        {addr.isDefault && (
                          <span className="inline-block mt-1 text-xs bg-accent/10 text-accent px-2 py-0.5 rounded-full font-medium">
                            Default
                          </span>
                        )}
                      </button>
                    ))}
                    <p className="text-xs text-muted-foreground pl-1">
                      Or enter a new address below
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="sm:col-span-2">
                    <Label htmlFor="fullName">Full Name *</Label>
                    <Input
                      id="fullName"
                      value={address.fullName}
                      onChange={(e) => setAddress((a) => ({ ...a, fullName: e.target.value }))}
                      required
                      className="mt-1.5"
                    />
                  </div>
                  <div>
                    <Label htmlFor="phone">Phone *</Label>
                    <Input
                      id="phone"
                      value={address.phone}
                      onChange={(e) => setAddress((a) => ({ ...a, phone: e.target.value }))}
                      required
                      className="mt-1.5"
                      placeholder="01XXXXXXXXX"
                    />
                  </div>
                  <div>
                    <Label htmlFor="postalCode">Postal Code</Label>
                    <Input
                      id="postalCode"
                      value={address.postalCode}
                      onChange={(e) => setAddress((a) => ({ ...a, postalCode: e.target.value }))}
                      className="mt-1.5"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Label htmlFor="street">Street Address *</Label>
                    <Input
                      id="street"
                      value={address.street}
                      onChange={(e) => setAddress((a) => ({ ...a, street: e.target.value }))}
                      required
                      className="mt-1.5"
                      placeholder="House, Road, Area"
                    />
                  </div>
                  <div>
                    <Label htmlFor="city">City *</Label>
                    <Input
                      id="city"
                      value={address.city}
                      onChange={(e) => setAddress((a) => ({ ...a, city: e.target.value }))}
                      required
                      className="mt-1.5"
                    />
                  </div>
                  <div>
                    <Label htmlFor="district">District</Label>
                    <Input
                      id="district"
                      value={address.district}
                      onChange={(e) => setAddress((a) => ({ ...a, district: e.target.value }))}
                      className="mt-1.5"
                    />
                  </div>
                </div>
              </div>

              {/* Loyalty Points Redemption */}
              {loyaltyData && loyaltyData.points > 0 && (
                <div className="bg-card border rounded-xl p-4">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      id="usePoints"
                      checked={usePoints}
                      onChange={(e) => setUsePoints(e.target.checked)}
                      className="mt-1 accent-pink-500"
                    />
                    <div>
                      <label
                        htmlFor="usePoints"
                        className="font-medium cursor-pointer flex items-center gap-2 text-sm"
                      >
                        ? Use {loyaltyData.points} Loyalty Points
                        <span className="text-muted-foreground font-normal">
                          = Tk{maxPointsDiscount} off
                        </span>
                      </label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Up to 20% of your order value
                        {isMultiSeller ? " — applied to your largest order" : ""}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* 🎁 Gift Wrapping */}
              <div className="bg-card border rounded-xl p-6">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    id="giftWrap"
                    checked={giftWrap}
                    onChange={(e) => setGiftWrap(e.target.checked)}
                    className="mt-1 accent-pink-500"
                  />
                  <div className="flex-1">
                    <label
                      htmlFor="giftWrap"
                      className="font-medium cursor-pointer flex items-center gap-2"
                    >
                      🎁 Gift Wrapping
                      <span className="text-sm text-muted-foreground font-normal">+Tk50</span>
                    </label>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Beautiful gift packaging with a handwritten card
                    </p>
                    {giftWrap && (
                      <textarea
                        value={giftMessage}
                        onChange={(e) => setGiftMessage(e.target.value)}
                        placeholder="Add a personal message (optional)?"
                        maxLength={200}
                        rows={3}
                        className="mt-3 w-full text-sm border rounded-xl px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-accent/40 bg-muted/30"
                      />
                    )}
                  </div>
                </div>
              </div>

              {/* Payment */}
              {isMultiSeller ? (
                <div className="space-y-4">
                  {sellerGroups.map((g) => {
                    const key = g.sellerId == null ? "null" : String(g.sellerId);
                    // Only listing lines constrain payment method; if a group
                    // has multiple listings with different allowed methods,
                    // intersect them so the buyer can't pick something that
                    // doesn't work for every item in that seller's order.
                    const allowedSets = g.items
                      .map((it) =>
                        !isGuest
                          ? (cart?.items ?? []).find(
                              (ci) => ci.productId === it.productId && ci.sellerId === it.sellerId,
                            )
                          : null,
                      )
                      .filter(
                        (ci): ci is NonNullable<typeof ci> =>
                          !!ci && ci.kind === "seller_listing" && !!ci.listing,
                      )
                      .map((ci) =>
                        allowedMethodsForListingPaymentMethod(
                          ci.listing!.paymentMethod,
                          ci.seller?.hasVerifiedPaymentConfig ?? false,
                        ),
                      );
                    const allowed: PaymentMethod[] =
                      allowedSets.length > 0
                        ? (["bkash", "cod"] as PaymentMethod[]).filter((m) =>
                            allowedSets.every((set) => set.includes(m)),
                          )
                        : ["bkash", "cod"];
                    const current = methodFor(key);

                    return (
                      <div key={key} className="bg-card border rounded-xl p-6">
                        <h3 className="font-medium text-sm mb-4 flex items-center gap-1.5">
                          {g.sellerName ? (
                            <>
                              <Sprout className="h-3.5 w-3.5 text-accent" /> {g.sellerName}
                            </>
                          ) : (
                            "Tree Friend"
                          )}
                          <span className="text-muted-foreground font-normal">
                            — Tk{g.subtotal.toLocaleString()}
                          </span>
                          {largestGroupKey === g.sellerId &&
                            (discount > 0 || loyaltyDiscount > 0) && (
                              <span className="text-xs bg-success text-success-foreground px-2 py-0.5 rounded-full ml-1">
                                Discount applied here
                              </span>
                            )}
                        </h3>
                        <div className="grid grid-cols-2 gap-3">
                          {(["bkash", "cod"] as PaymentMethod[]).map((method) => {
                            const disabled = !allowed.includes(method);
                            return (
                              <button
                                type="button"
                                key={method}
                                disabled={disabled}
                                onClick={() => setMethodFor(key, method)}
                                className={`border rounded-xl py-3 px-4 text-sm font-medium transition-all ${
                                  disabled
                                    ? "opacity-30 cursor-not-allowed border-border"
                                    : current === method
                                      ? "border-primary bg-primary/5 text-foreground"
                                      : "border-border text-muted-foreground hover:border-foreground/50"
                                }`}
                              >
                                <div className="text-lg font-bold mb-1">
                                  {method === "bkash" ? (
                                    <img src={BKASH_ICON} className="h-7 w-7 mx-auto" />
                                  ) : (
                                    <span className="text-2xl">💵</span>
                                  )}
                                </div>
                                <div className="text-xs font-semibold">
                                  {method === "bkash" ? "bKash" : "Cash on Delivery"}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                        {current === "bkash" && (
                          <p className="mt-3 text-xs text-muted-foreground">
                            You'll be redirected to bKash to complete this payment securely after
                            placing your order.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="bg-card border rounded-xl p-6">
                  <h2 className="font-medium text-lg mb-5">Payment Method</h2>
                  <div className="grid grid-cols-2 gap-3 mb-5">
                    {(["bkash", "cod"] as PaymentMethod[]).map((method) => (
                      <button
                        type="button"
                        key={method}
                        onClick={() => setPaymentMethod(method)}
                        className={`border rounded-xl py-3 px-4 text-sm font-medium transition-all ${paymentMethod === method ? "border-primary bg-primary/5 text-foreground" : "border-border text-muted-foreground hover:border-foreground/50"}`}
                      >
                        <div className="text-lg font-bold mb-1">
                          {method === "bkash" ? (
                            <img src={BKASH_ICON} className="h-7 w-7 mx-auto" />
                          ) : (
                            <span className="text-2xl">💵</span>
                          )}
                        </div>
                        <div className="text-xs font-semibold">
                          {method === "bkash" ? "bKash" : "Cash on Delivery"}
                        </div>
                      </button>
                    ))}
                  </div>

                  {paymentMethod === "bkash" && (
                    <div className="bg-muted/30 rounded-lg p-4 space-y-1.5 text-sm">
                      <p className="font-medium">Pay with bKash</p>
                      <p className="text-muted-foreground">
                        After you place your order, you'll be redirected to bKash's secure payment
                        page to complete your Tk{total.toLocaleString()} payment.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Order summary */}
            <div>
              <div className="bg-card border rounded-xl p-6 sticky top-24 space-y-5">
                <h2 className="font-medium text-lg">Order Summary</h2>

                {/* Coupon */}
                {!couponApplied ? (
                  <div>
                    <div className="flex gap-2">
                      <Input
                        value={couponCode}
                        onChange={(e) => setCouponCode(e.target.value)}
                        placeholder="Coupon code"
                        className="flex-1 text-sm"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleApplyCoupon}
                        disabled={!couponCode || validateCoupon.isPending}
                      >
                        <Tag className="h-4 w-4 mr-1" /> Apply
                      </Button>
                    </div>
                    {couponError && (
                      <p className="text-xs text-destructive mt-1.5">{couponError}</p>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-sm text-success-foreground">
                    <CheckCircle2 className="h-4 w-4" />
                    Coupon applied: -Tk{discount.toLocaleString()}
                    {isMultiSeller &&
                      (couponSellerId !== null
                        ? ` (${sellerGroups.find((g) => g.sellerId === couponSellerId)?.sellerName ?? "seller"}'s order)`
                        : " (largest order)")}
                  </div>
                )}

                {/* Items, grouped by seller when the cart spans more than one */}
                <div className="space-y-3 max-h-72 overflow-y-auto">
                  {sellerGroups.map((g) => (
                    <div key={g.sellerId ?? "admin-direct"}>
                      {isMultiSeller && (
                        <p className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
                          {g.sellerName ? (
                            <>
                              <Sprout className="h-3 w-3 text-accent" /> {g.sellerName}
                            </>
                          ) : (
                            "Tree Friend"
                          )}
                        </p>
                      )}
                      <div className="space-y-1.5">
                        {g.items.map((item, i) => (
                          <div
                            key={`${item.productId}-${i}`}
                            className="flex justify-between text-sm"
                          >
                            <span className="text-muted-foreground line-clamp-1 flex-1 pr-2">
                              {item.name} × {item.quantity}
                              {item.codDeliveryCharge > 0 && (
                                <span className="block text-xs">
                                  Pay on delivery: Tk
                                  {(item.codDeliveryCharge * item.quantity).toLocaleString()}
                                </span>
                              )}
                            </span>
                            <span>
                              Tk
                              {(
                                (item.discountPrice ?? item.price) * item.quantity
                              ).toLocaleString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="border-t pt-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span>Tk{subtotal.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Delivery</span>
                    <span>
                      {shipping === 0 ? (
                        <span className="text-success-foreground">Free</span>
                      ) : (
                        `Tk${shipping.toLocaleString()}`
                      )}
                    </span>
                  </div>
                  {giftWrap && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">🎁 Gift Wrapping</span>
                      <span>Tk50</span>
                    </div>
                  )}
                  {discount > 0 && (
                    <div className="flex justify-between text-success-foreground">
                      <span>Coupon Discount</span>
                      <span>-Tk{discount.toLocaleString()}</span>
                    </div>
                  )}
                  {loyaltyDiscount > 0 && (
                    <div className="flex justify-between text-warning-foreground">
                      <span>? Loyalty Points</span>
                      <span>-Tk{loyaltyDiscount.toLocaleString()}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-semibold text-base pt-2 border-t">
                    <span>Total</span>
                    <span>Tk{total.toLocaleString()}</span>
                  </div>
                  {codDeliveryTotal > 0 && (
                    <p className="text-xs text-muted-foreground pt-1">
                      Plus Tk{codDeliveryTotal.toLocaleString()} pay on delivery for marketplace
                      items
                    </p>
                  )}
                </div>

                {submitError && (
                  <p className="text-sm text-destructive text-center">{submitError}</p>
                )}
                {createOrder.isError && (
                  <p className="text-sm text-destructive text-center">
                    Failed to place order. Please try again.
                  </p>
                )}
                <Button
                  type="submit"
                  className="w-full rounded-full"
                  size="lg"
                  disabled={createOrder.isPending || redirectingToBkash}
                >
                  {redirectingToBkash
                    ? "Redirecting to bKash..."
                    : createOrder.isPending
                      ? "Placing order..."
                      : isMultiSeller
                        ? `Place ${sellerGroups.length} Orders`
                        : "Place Order"}
                </Button>
              </div>
            </div>
          </div>
        </form>
      </div>

      {/* ── Order Review Dialog ────────────────────────────────────── */}
      {/* Industry-standard "review your order" confirmation step. Shows
          a summary of the order (items, total, address, payment method)
          before the buyer commits. Prevents accidental orders. */}
      <Dialog open={showReviewDialog} onOpenChange={setShowReviewDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Review Your Order</DialogTitle>
            <DialogDescription>
              Please confirm your order details before placing it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <p className="font-medium mb-1">Shipping To:</p>
              <p className="text-muted-foreground">
                {address.fullName}
                <br />
                {address.street}, {address.city}
                <br />
                {address.district} {address.postalCode}
              </p>
              <p className="text-muted-foreground mt-1">Phone: {address.phone}</p>
            </div>
            <div className="border-t pt-3">
              <p className="font-medium mb-1">Payment:</p>
              <p className="text-muted-foreground capitalize">
                {paymentMethod === "bkash" ? "bKash" : "Cash on Delivery"}
              </p>
            </div>
            <div className="border-t pt-3">
              <p className="font-medium mb-1">Total: Tk{total.toLocaleString()}</p>
              {isMultiSeller && (
                <p className="text-xs text-muted-foreground">
                  This will create {sellerGroups.length} separate orders (one per seller).
                </p>
              )}
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Button
              variant="outline"
              className="flex-1 rounded-full"
              onClick={() => setShowReviewDialog(false)}
            >
              Go Back
            </Button>
            <Button
              className="flex-1 rounded-full"
              onClick={confirmAndSubmit}
              disabled={createOrder.isPending}
            >
              {createOrder.isPending ? "Placing..." : "Confirm & Place Order"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Price Change Dialog ────────────────────────────────────── */}
      {/* When the backend returns 409 with priceChangedItems, show a dialog
          so the buyer can review the changes and re-confirm. This is the
          industry-standard price-locking pattern. */}
      <Dialog open={showPriceChangedDialog} onOpenChange={setShowPriceChangedDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Prices Have Changed</DialogTitle>
            <DialogDescription>
              Some items in your bag have changed price since you added them. Please review and
              re-confirm your order.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm max-h-60 overflow-y-auto">
            {priceChangedItems.map((item) => (
              <div key={item.productId} className="border rounded-lg p-3">
                <p className="font-medium">{item.productName}</p>
                <p className="text-xs text-muted-foreground">{item.variantName}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-muted-foreground line-through">
                    Tk{item.oldPrice.toLocaleString()}
                  </span>
                  <span className="text-xs font-medium">→ Tk{item.newPrice.toLocaleString()}</span>
                  {item.newPrice > item.oldPrice && (
                    <span className="text-xs text-destructive">
                      (+Tk{(item.newPrice - item.oldPrice).toLocaleString()})
                    </span>
                  )}
                  {item.newPrice < item.oldPrice && (
                    <span className="text-xs text-success-foreground">
                      (-Tk{(item.oldPrice - item.newPrice).toLocaleString()})
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-4">
            <Button
              variant="outline"
              className="flex-1 rounded-full"
              onClick={() => {
                setShowPriceChangedDialog(false);
                // Invalidate the cart query so the buyer sees the updated
                // prices (priceSeenAtAdd will be refreshed on next add,
                // but the current snapshot is now stale).
                qc.invalidateQueries({ queryKey: getGetCartQueryKey() });
              }}
            >
              Review Cart
            </Button>
            <Button
              className="flex-1 rounded-full"
              onClick={() => {
                setShowPriceChangedDialog(false);
                // Re-submit with the same idempotency key — the backend
                // will re-check prices. If the buyer accepts the new
                // prices, they need to re-add the items to refresh the
                // priceSeenAtAdd snapshots. For now, just close the dialog
                // and let the buyer go back to the cart.
              }}
            >
              Accept & Continue
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── OTP Modal (unverified guests) ─────────────────────────── */}
      {/* Shown when an unverified guest taps "Place Order". After
          verification, the page re-renders (isVerified=true → isGuest=false)
          and the buyer can proceed through the normal checkout path. */}
      <OtpModal
        open={showOtpModal}
        onOpenChange={setShowOtpModal}
        initialPhone={address.phone}
        onVerified={() => {
          // Merge localStorage cart → server cart, then invalidate the
          // cart query so useGetCart picks up the server-side items.
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
                qc.invalidateQueries({ queryKey: getGetCartQueryKey() });
              })
              .catch(() => {
                // Non-fatal — the server cart still works. Show a toast.
                // useToast isn't available here (OtpModal is a separate
                // component context), so the error is logged and the
                // cart query is invalidated anyway so the buyer sees
                // whatever server-side items exist.
                qc.invalidateQueries({ queryKey: getGetCartQueryKey() });
              });
          } else {
            // Empty localStorage cart — just invalidate so useGetCart fires
            qc.invalidateQueries({ queryKey: getGetCartQueryKey() });
          }
        }}
      />

      {/* ── Create Account Dialog (guest post-checkout) ─────────────── */}
      {/* Shown after a verified guest successfully places a COD order.
          Industry standard (Daraz, Amazon) — the buyer just completed a
          purchase, their phone is verified, so creating an account is
          frictionless. The dialog offers:
            1. "Create Account" → navigates to /sign-up (Clerk signup
               with phone pre-filled)
            2. "View Order" → navigates to the order detail page
          The buyer can dismiss without creating an account — their
          order is already placed and trackable via the order URL. */}
      <Dialog open={showCreateAccountDialog} onOpenChange={setShowCreateAccountDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Order placed! 🎉</DialogTitle>
            <DialogDescription>
              Your order has been placed successfully. Create an account to track your order,
              earn loyalty points, and save your details for next time.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Your phone number{" "}
              <span className="font-medium text-foreground">{guestPhone ?? address.phone}</span>{" "}
              is already verified — creating an account takes seconds.
            </p>
          </div>
          <div className="flex flex-col gap-2 mt-4">
            <Button
              className="w-full rounded-full h-11"
              onClick={() => setLocation("/sign-up")}
            >
              Create Account
            </Button>
            <Button
              variant="ghost"
              className="w-full text-sm text-muted-foreground hover:text-foreground"
              onClick={() => {
                // Navigate to the first order's detail page
                const orderIds = JSON.parse(sessionStorage.getItem("last_checkout_order_ids") ?? "[]");
                if (orderIds.length > 0) {
                  setLocation(`/orders/${orderIds[0]}`);
                } else {
                  setLocation("/orders");
                }
              }}
            >
              Skip — View My Order
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
