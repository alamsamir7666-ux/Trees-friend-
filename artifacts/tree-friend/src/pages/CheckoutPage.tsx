import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useLoyalty } from "@/hooks/useLoyalty";
import { useGetCart, useCreateOrder, useValidateCoupon, useListAddresses, getGetCartQueryKey, getListAddressesQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { BKASH_ICON } from "@/lib/preorderIcons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, Tag, MapPin, ChevronDown, ShoppingBag, CreditCard, Sprout } from "lucide-react";
import { Link } from "wouter";
import { useUser } from "@clerk/react";
import { useGuestCart } from "@/hooks/useGuestCart";

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
function allowedMethodsForListingPaymentMethod(pm: string, hasVerifiedPaymentConfig: boolean): PaymentMethod[] {
  if (pm === "cod") return ["cod"];
  if (pm === "advance") return hasVerifiedPaymentConfig ? ["bkash"] : [];
  return hasVerifiedPaymentConfig ? ["bkash", "cod"] : ["cod"];
}

export function CheckoutPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { user, isLoaded: userLoaded } = useUser();
  const isGuest = userLoaded && !user;
  const guestCart = useGuestCart();
  const { data: cart, isLoading: cartLoading } = useGetCart({ query: { enabled: !isGuest, queryKey: getGetCartQueryKey() } });
  const isLoading = !userLoaded || (!isGuest && cartLoading);
  const { data: savedAddresses = [] } = useListAddresses({ query: { retry: false, queryKey: getListAddressesQueryKey() } });
  const createOrder = useCreateOrder();
  const validateCoupon = useValidateCoupon();

  const [address, setAddress] = useState({
    fullName: "", phone: "", street: "", city: "", district: "", postalCode: "",
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
  const [bkashNumber, setBkashNumber] = useState("");
  // Per-seller-group bKash sending numbers (Part 5 fix -- previously
  // `bkashNumber` alone was reused as senderNumber for every seller group
  // that resolved to bkash, which is wrong once different sellers' bKash
  // accounts are actually in play; see routes/orders.ts's doc comment on
  // sellerSenderNumbers). Keyed the same way as sellerPaymentMethod
  // ("null" for the admin-direct group). `bkashNumber` remains the
  // fallback/default for single-group carts, same relationship
  // paymentMethod has to sellerPaymentMethod.
  const [sellerSenderNumber, setSellerSenderNumber] = useState<Record<string, string>>({});
  const [giftWrap, setGiftWrap] = useState(false);
  const [giftMessage, setGiftMessage] = useState("");
  const [usePoints, setUsePoints] = useState(false);
  const { data: loyaltyData } = useLoyalty();
  const [transactionId, setTransactionId] = useState("");

  // Normalize guest (localStorage) and logged-in (server) cart items into one
  // shape so the summary below doesn't need to branch on isGuest. Price
  // always comes from the specific variant or seller listing, never from
  // the product. sellerId/sellerName are null for admin-direct lines and
  // guest items (guest checkout is admin-direct-only -- see routes/orders.ts).
  const items = isGuest
    ? guestCart.items.map(i => ({
        productId: i.productId,
        quantity: i.quantity,
        name: i.name,
        image: i.image,
        price: i.price,
        discountPrice: i.discountPrice,
        sellerId: null as number | null,
        sellerName: null as string | null,
      }))
    : (cart?.items ?? []).map(i => {
        const isListing = i.kind === "seller_listing";
        return {
          productId: i.productId,
          quantity: i.quantity,
          name: i.product.name,
          image: i.product.images[0] ?? "",
          price: isListing ? i.listing!.price : i.variant!.price,
          discountPrice: isListing ? (i.listing!.discountPrice ?? null) : (i.variant!.discountPrice ?? null),
          sellerId: isListing ? i.sellerId : null,
          sellerName: isListing ? (i.seller?.nurseryName ?? null) : null,
        };
      });

  // Group by seller purely for the payment-method and summary UI. Key
  // "null" (string) represents the admin-direct group, matching how the
  // backend reads sellerPaymentMethods (routes/orders.ts).
  const sellerGroups = useMemo(() => {
    const map = new Map<string, { sellerId: number | null; sellerName: string | null; items: typeof items; subtotal: number }>();
    for (const item of items) {
      const key = item.sellerId == null ? "null" : String(item.sellerId);
      if (!map.has(key)) map.set(key, { sellerId: item.sellerId, sellerName: item.sellerName, items: [], subtotal: 0 });
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
  const shipping = subtotal > 2000 ? 0 : 120;
  const giftWrapCost = giftWrap ? 50 : 0;
  const loyaltyDiscount = usePoints ? maxPointsDiscount : 0;
  const total = Math.max(0, subtotal + shipping + giftWrapCost - discount - loyaltyDiscount);

  function methodFor(sellerKey: string): PaymentMethod {
    return sellerPaymentMethod[sellerKey] ?? paymentMethod;
  }
  function setMethodFor(sellerKey: string, method: PaymentMethod) {
    setSellerPaymentMethod((prev) => ({ ...prev, [sellerKey]: method }));
  }
  function senderNumberFor(sellerKey: string): string {
    return sellerSenderNumber[sellerKey] ?? bkashNumber;
  }
  function setSenderNumberFor(sellerKey: string, value: string) {
    setSellerSenderNumber((prev) => ({ ...prev, [sellerKey]: value }));
  }
  // Whether any resolved payment method across all groups needs a sending
  // number, and (Part 5) whether every group that needs one actually has
  // one filled in -- each group now has its own number, so a filled-in
  // number for one seller no longer silently satisfies another seller's
  // requirement.
  const needsSenderNumber = sellerGroups.some((g) => {
    const m = methodFor(g.sellerId == null ? "null" : String(g.sellerId));
    return m === "bkash";
  });
  const missingSenderNumberGroups = sellerGroups.filter((g) => {
    const key = g.sellerId == null ? "null" : String(g.sellerId);
    return methodFor(key) === "bkash" && !senderNumberFor(key).trim();
  });

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
    validateCoupon.mutate({ data: { code: couponCode, orderAmount: subtotal } }, {
      onSuccess: (coupon) => {
        const computed = coupon.discountType === "percentage"
          ? Math.floor(subtotal * (coupon.discountValue / 100))
          : coupon.discountValue;
        setDiscount(computed);
        setCouponApplied(true);
      },
      onError: () => {
        setCouponError("Invalid or expired coupon code.");
      },
    });
  }

  const [submitError, setSubmitError] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError("");
    if (!address.fullName || !address.phone || !address.street || !address.city) {
      setSubmitError("Please fill in all required address fields.");
      return;
    }
    if (needsSenderNumber && !isMultiSeller && !bkashNumber.trim()) {
      setSubmitError("Please enter your sending number.");
      return;
    }
    if (isMultiSeller && missingSenderNumberGroups.length > 0) {
      setSubmitError(
        missingSenderNumberGroups.length === sellerGroups.length
          ? "Please enter a bKash sending number."
          : `Please enter a bKash sending number for: ${missingSenderNumberGroups.map((g) => g.sellerName ?? "Tree Friend").join(", ")}.`,
      );
      return;
    }
    const shippingAddress = {
      fullName: address.fullName,
      phone: address.phone,
      street: address.street,
      city: address.city,
      district: address.district,
      postalCode: address.postalCode || null,
    };

    if (isGuest) {
      fetch(`${import.meta.env.VITE_API_BASE_URL}/api/orders/guest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingAddress,
          paymentMethod,
          transactionId: transactionId || null,
          senderNumber: bkashNumber || null,
          couponCode: couponApplied ? couponCode : null,
          giftWrap,
          giftMessage: giftWrap ? giftMessage : null,
          items: guestCart.items.map(i => ({ productId: i.productId, variantId: i.variantId, quantity: i.quantity })),
        }),
      })
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) { setSubmitError(data.error ?? "Failed to place order."); return; }
          guestCart.clearCart();
          try {
            const key = "treefriend_guest_orders";
            const existing = JSON.parse(localStorage.getItem(key) ?? "[]");
            const summary = {
              trackingId: data.trackingId,
              createdAt: new Date().toISOString(),
              total,
              subtotal,
              discount,
              shipping,
              couponCode: couponApplied ? couponCode : null,
              items: guestCart.items.map(i => ({
                productName: i.name,
                productImage: i.image,
                quantity: i.quantity,
                price: i.discountPrice ?? i.price,
              })),
            };
            localStorage.setItem(key, JSON.stringify([summary, ...existing.filter((o: any) => (o.trackingId ?? o) !== data.trackingId)]));
          } catch {}
          setLocation(`/orders/${data.trackingId}`);
        })
        .catch(() => setSubmitError("Failed to place order. Please try again."));
      return;
    }

    createOrder.mutate({
      data: {
        shippingAddress,
        paymentMethod,
        sellerPaymentMethods: isMultiSeller
          ? Object.fromEntries(sellerGroups.map((g) => {
              const key = g.sellerId == null ? "null" : String(g.sellerId);
              return [key, methodFor(key)];
            }))
          : undefined,
        transactionId: transactionId || null,
        senderNumber: bkashNumber || null,
        sellerSenderNumbers: isMultiSeller
          ? Object.fromEntries(sellerGroups.map((g) => {
              const key = g.sellerId == null ? "null" : String(g.sellerId);
              return [key, senderNumberFor(key) || null];
            }))
          : undefined,
        couponCode: couponApplied ? couponCode : null,
        loyaltyPointsToRedeem: usePoints && maxPointsDiscount > 0 ? Math.ceil(maxPointsDiscount / 1) : 0,
        giftWrap,
        giftMessage: giftWrap ? giftMessage : null,
      },
    }, {
      // Always an array now (routes/orders.ts): a multi-seller cart splits
      // into multiple orders. Redirect to the first one; the order
      // confirmation/detail page links between sibling orders from the
      // same checkout if there's more than one (see OrderDetailPage).
      onSuccess: (orders) => {
        qc.invalidateQueries({ queryKey: getGetCartQueryKey() });
        if (orders.length > 1) {
          try {
            sessionStorage.setItem("last_checkout_order_ids", JSON.stringify(orders.map((o) => o.id)));
          } catch {}
        }
        setLocation(`/orders/${orders[0].id}`);
      },
    });
  }

  if (isLoading) {
    return <div className="container mx-auto px-4 py-10"><Skeleton className="h-96 rounded-xl" /></div>;
  }

  if (items.length === 0) {
    return (
      <div className="py-24 text-center">
        <p className="text-muted-foreground mb-4">No items in cart.</p>
        <Link href="/products"><Button>Shop Now</Button></Link>
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
              Your bag has items from {sellerGroups.length} sellers — this will create {sellerGroups.length} separate orders.
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
                      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAddressPicker ? "rotate-180" : ""}`} />
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
                          {addr.street}, {addr.city}{addr.district ? `, ${addr.district}` : ""}
                          {addr.phone ? ` 📞 ${addr.phone}` : ""}
                        </p>
                        {addr.isDefault && (
                          <span className="inline-block mt-1 text-xs bg-accent/10 text-accent px-2 py-0.5 rounded-full font-medium">Default</span>
                        )}
                      </button>
                    ))}
                    <p className="text-xs text-muted-foreground pl-1">Or enter a new address below</p>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="sm:col-span-2">
                    <Label htmlFor="fullName">Full Name *</Label>
                    <Input id="fullName" value={address.fullName} onChange={e => setAddress(a => ({ ...a, fullName: e.target.value }))} required className="mt-1.5" />
                  </div>
                  <div>
                    <Label htmlFor="phone">Phone *</Label>
                    <Input id="phone" value={address.phone} onChange={e => setAddress(a => ({ ...a, phone: e.target.value }))} required className="mt-1.5" placeholder="01XXXXXXXXX" />
                  </div>
                  <div>
                    <Label htmlFor="postalCode">Postal Code</Label>
                    <Input id="postalCode" value={address.postalCode} onChange={e => setAddress(a => ({ ...a, postalCode: e.target.value }))} className="mt-1.5" />
                  </div>
                  <div className="sm:col-span-2">
                    <Label htmlFor="street">Street Address *</Label>
                    <Input id="street" value={address.street} onChange={e => setAddress(a => ({ ...a, street: e.target.value }))} required className="mt-1.5" placeholder="House, Road, Area" />
                  </div>
                  <div>
                    <Label htmlFor="city">City *</Label>
                    <Input id="city" value={address.city} onChange={e => setAddress(a => ({ ...a, city: e.target.value }))} required className="mt-1.5" />
                  </div>
                  <div>
                    <Label htmlFor="district">District</Label>
                    <Input id="district" value={address.district} onChange={e => setAddress(a => ({ ...a, district: e.target.value }))} className="mt-1.5" />
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
                      <label htmlFor="usePoints" className="font-medium cursor-pointer flex items-center gap-2 text-sm">
                        ? Use {loyaltyData.points} Loyalty Points
                        <span className="text-muted-foreground font-normal">= Tk{maxPointsDiscount} off</span>
                      </label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Up to 20% of your order value{isMultiSeller ? " — applied to your largest order" : ""}
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
                    <label htmlFor="giftWrap" className="font-medium cursor-pointer flex items-center gap-2">
                       🎁 Gift Wrapping
                      <span className="text-sm text-muted-foreground font-normal">+Tk50</span>
                    </label>
                    <p className="text-sm text-muted-foreground mt-0.5">Beautiful gift packaging with a handwritten card</p>
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
                      .map((it) => !isGuest ? (cart?.items ?? []).find(ci => ci.productId === it.productId && ci.sellerId === it.sellerId) : null)
                      .filter((ci): ci is NonNullable<typeof ci> => !!ci && ci.kind === "seller_listing" && !!ci.listing)
                      .map((ci) => allowedMethodsForListingPaymentMethod(ci.listing!.paymentMethod, ci.seller?.hasVerifiedPaymentConfig ?? false));
                    const allowed: PaymentMethod[] = allowedSets.length > 0
                      ? (["bkash", "cod"] as PaymentMethod[]).filter((m) => allowedSets.every((set) => set.includes(m)))
                      : ["bkash", "cod"];
                    const current = methodFor(key);
                    const needsNumber = current === "bkash";

                    return (
                      <div key={key} className="bg-card border rounded-xl p-6">
                        <h3 className="font-medium text-sm mb-4 flex items-center gap-1.5">
                          {g.sellerName ? (
                            <><Sprout className="h-3.5 w-3.5 text-accent" /> {g.sellerName}</>
                          ) : (
                            "Tree Friend"
                          )}
                          <span className="text-muted-foreground font-normal">— Tk{g.subtotal.toLocaleString()}</span>
                          {largestGroupKey === g.sellerId && (discount > 0 || loyaltyDiscount > 0) && (
                            <span className="text-xs bg-green-50 text-green-700 px-2 py-0.5 rounded-full ml-1">Discount applied here</span>
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
                                  disabled ? "opacity-30 cursor-not-allowed border-border" :
                                  current === method ? "border-primary bg-primary/5 text-foreground" : "border-border text-muted-foreground hover:border-foreground/50"
                                }`}
                              >
                                <div className="text-lg font-bold mb-1">
                                  {method === "bkash" ? <img src={BKASH_ICON} className="h-7 w-7 mx-auto" /> : <span className="text-2xl">💵</span>}
                                </div>
                                <div className="text-xs font-semibold">
                                  {method === "bkash" ? "bKash" : "Cash on Delivery"}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                        {needsNumber && (
                          <div className="mt-3">
                            <Label className="text-xs">bKash Sending Number</Label>
                            <Input
                              className="mt-1.5"
                              value={senderNumberFor(key)}
                              onChange={(e) => setSenderNumberFor(key, e.target.value)}
                              placeholder="Number you'll send payment from"
                            />
                          </div>
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
                          {method === "bkash" ? <img src={BKASH_ICON} className="h-7 w-7 mx-auto" /> : <span className="text-2xl">💵</span>}
                        </div>
                        <div className="text-xs font-semibold">
                          {method === "bkash" ? "bKash" : "Cash on Delivery"}
                        </div>
                      </button>
                    ))}
                  </div>

                  {paymentMethod === "bkash" && (
                    <div className="bg-muted/30 rounded-lg p-4 space-y-3 text-sm">
                      <p className="font-medium">bKash Payment Instructions</p>
                      <p className="text-muted-foreground">
                        1. Send Tk{total.toLocaleString()} to our bKash number: <strong>01636575741</strong><br />
                        2. Use "Send Money" option<br />
                        3. Your order will be confirmed automatically after payment
                      </p>
                      <div>
                        <Label>bKash Number</Label>
                        <Input className="mt-1.5" value={bkashNumber} onChange={e => setBkashNumber(e.target.value)} placeholder="Your sending number" />
                      </div>
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
                        onChange={e => setCouponCode(e.target.value)}
                        placeholder="Coupon code"
                        className="flex-1 text-sm"
                      />
                      <Button type="button" variant="outline" size="sm" onClick={handleApplyCoupon} disabled={!couponCode || validateCoupon.isPending}>
                        <Tag className="h-4 w-4 mr-1" /> Apply
                      </Button>
                    </div>
                    {couponError && <p className="text-xs text-destructive mt-1.5">{couponError}</p>}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-sm text-green-600">
                    <CheckCircle2 className="h-4 w-4" />
                    Coupon applied: -Tk{discount.toLocaleString()}{isMultiSeller ? " (largest order)" : ""}
                  </div>
                )}

                {/* Items, grouped by seller when the cart spans more than one */}
                <div className="space-y-3 max-h-72 overflow-y-auto">
                  {sellerGroups.map((g) => (
                    <div key={g.sellerId ?? "admin-direct"}>
                      {isMultiSeller && (
                        <p className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
                          {g.sellerName ? <><Sprout className="h-3 w-3 text-accent" /> {g.sellerName}</> : "Tree Friend"}
                        </p>
                      )}
                      <div className="space-y-1.5">
                        {g.items.map((item, i) => (
                          <div key={`${item.productId}-${i}`} className="flex justify-between text-sm">
                            <span className="text-muted-foreground line-clamp-1 flex-1 pr-2">{item.name} × {item.quantity}</span>
                            <span>Tk{((item.discountPrice ?? item.price) * item.quantity).toLocaleString()}</span>
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
                    <span>{shipping === 0 ? <span className="text-green-600">Free</span> : `Tk${shipping}`}</span>
                  </div>
                  {giftWrap && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">🎁 Gift Wrapping</span>
                      <span>Tk50</span>
                    </div>
                  )}
                  {discount > 0 && (
                    <div className="flex justify-between text-green-600">
                      <span>Coupon Discount</span>
                      <span>-Tk{discount.toLocaleString()}</span>
                    </div>
                  )}
                  {loyaltyDiscount > 0 && (
                    <div className="flex justify-between text-amber-600">
                      <span>? Loyalty Points</span>
                      <span>-Tk{loyaltyDiscount.toLocaleString()}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-semibold text-base pt-2 border-t">
                    <span>Total</span>
                    <span>Tk{total.toLocaleString()}</span>
                  </div>
                </div>

                {submitError && (
                  <p className="text-sm text-destructive text-center">{submitError}</p>
                )}
                {createOrder.isError && (
                  <p className="text-sm text-destructive text-center">Failed to place order. Please try again.</p>
                )}
                <Button
                  type="submit"
                  className="w-full rounded-full"
                  size="lg"
                  disabled={createOrder.isPending}
                >
                  {createOrder.isPending ? "Placing order..." : isMultiSeller ? `Place ${sellerGroups.length} Orders` : "Place Order"}
                </Button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
