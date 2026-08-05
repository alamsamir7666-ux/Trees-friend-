import { Link, useLocation } from "wouter";
import { useGetCart, useUpdateCartItem, useRemoveFromCart, getGetCartQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Minus, Plus, Trash2, ShoppingBag, ArrowRight, LogIn, Sprout } from "lucide-react";
import { useUser } from "@clerk/react";
import { useGuestCart } from "@/hooks/useGuestCart";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";

function EmptyCart() {
  return (
    <div className="min-h-[60vh] lg:min-h-[70vh] flex flex-col items-center justify-center text-center px-4 lg:px-8">
      <div className="h-20 w-20 lg:h-24 lg:w-24 rounded-full bg-muted flex items-center justify-center mb-6 lg:mb-8">
        <ShoppingBag className="h-9 w-9 lg:h-11 lg:w-11 text-muted-foreground" />
      </div>
      <h2 className="font-serif text-2xl lg:text-3xl font-medium mb-2 lg:mb-3">Your bag is empty</h2>
      <p className="text-muted-foreground mb-6 lg:mb-8 text-sm lg:text-base">Discover our rituals and find your favourites.</p>
      <Link href="/products">
        <Button className="rounded-full px-8">Start Shopping</Button>
      </Link>
    </div>
  );
}

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
  const shipping = items.reduce(
    (sum, item) => sum + (item.deliveryCharge ?? 0) * item.quantity,
    0,
  );
  const total = subtotal + shipping;

  if (items.length === 0) return <EmptyCart />;

  return (
    <div className="min-h-screen bg-background">
      <div className="bg-muted/30 border-b py-6 md:py-8 lg:py-10">
        <div className="container mx-auto px-4 md:px-6 lg:px-8 max-w-5xl xl:max-w-7xl">
          <h1 className="font-serif text-4xl font-medium">Your Bag</h1>
          <p className="text-muted-foreground mt-1 text-sm">{items.length} item{items.length !== 1 ? "s" : ""}</p>
        </div>
      </div>

      <div className="container mx-auto px-4 md:px-6 lg:px-8 py-6 md:py-8 lg:py-10 max-w-5xl xl:max-w-7xl">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 lg:gap-10">
          {/* Items */}
          <div className="lg:col-span-2 space-y-4 lg:space-y-5">
            {items.map((item) => {
              const price = item.discountPrice ?? item.price;
              const img = item.image || null;
              return (
                <div key={item.productId} className="flex gap-4 lg:gap-6 bg-card border rounded-xl p-4 lg:p-6">
                  <Link href={`/products/${item.productId}`}>
                    {img ? (
                      <img src={img} alt={item.name} className="w-24 h-24 lg:w-32 lg:h-32 object-cover rounded-lg shrink-0 cursor-pointer" />
                    ) : (
                      <NoImagePlaceholder className="w-24 h-24 lg:w-32 lg:h-32 rounded-lg shrink-0 cursor-pointer" />
                    )}
                  </Link>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-start">
                      <div className="min-w-0">
                        <Link href={`/products/${item.productId}`}>
                          <h3 className="font-medium text-sm lg:text-base leading-snug truncate hover:text-accent cursor-pointer">{item.name}</h3>
                        </Link>
                      </div>
                      <button
                        onClick={() => guestCart.removeItem(item.productId)}
                        className="text-muted-foreground hover:text-destructive p-1 ml-2 transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="flex items-center justify-between mt-3 lg:mt-4">
                      <div className="flex items-center border rounded-full overflow-hidden">
                        <button
                          onClick={() => guestCart.updateQuantity(item.productId, item.quantity - 1)}
                          className="px-3 py-1.5 lg:px-4 lg:py-2 text-muted-foreground hover:text-foreground"
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                        <span className="px-3 lg:px-4 text-sm lg:text-base font-medium">{item.quantity}</span>
                        <button
                          onClick={() => guestCart.updateQuantity(item.productId, item.quantity + 1)}
                          className="px-3 py-1.5 lg:px-4 lg:py-2 text-muted-foreground hover:text-foreground"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold lg:text-lg">Tk{(price * item.quantity).toLocaleString()}</p>
                        {item.discountPrice && (
                          <p className="text-xs text-muted-foreground line-through">Tk{(item.price * item.quantity).toLocaleString()}</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Summary */}
          <div>
            <div className="bg-card border rounded-xl p-6 lg:shadow-lg sticky top-24">
              <h2 className="font-medium text-lg lg:text-xl mb-5">Order Summary</h2>
              <div className="space-y-3 text-sm mb-5">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>Tk{subtotal.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Delivery</span>
                  <span>{shipping === 0 ? <span className="text-success-foreground">Free</span> : `Tk${shipping.toLocaleString()}`}</span>
                </div>
                <div className="border-t pt-3 flex justify-between font-semibold text-base lg:text-lg">
                  <span>Total</span>
                  <span>Tk{total.toLocaleString()}</span>
                </div>
              </div>
              <Button className="w-full rounded-full" size="lg" onClick={() => setLocation("/checkout")}>
                Checkout
              </Button>
              <Button className="w-full rounded-full mt-2 bg-primary hover:bg-primary/90 text-primary-foreground border-0" size="lg" onClick={() => setLocation("/sign-in")}>
                <LogIn className="mr-2 h-4 w-4" />
                Sign in
              </Button>
              <p className="text-xs text-muted-foreground text-center mt-2">Sign in to save your bag and earn rewards</p>
              <Link href="/products">
                <Button variant="ghost" className="w-full mt-2 text-sm text-muted-foreground">
                  Continue Shopping
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Groups cart items by seller for display (plan doc §6: buyer sees which
 * seller they're buying from). Admin-direct (kind: "variant") lines are
 * grouped under a null key, rendered without a seller header -- this is
 * the pre-marketplace behavior and stays visually unchanged when a cart is
 * 100% admin-direct.
 */
function groupBySeller<T extends { kind: string; sellerId?: number | null; seller?: { id: number; nurseryName: string; location: string } | null }>(items: T[]) {
  const groups = new Map<number | null, { seller: T["seller"] | null; items: T[] }>();
  for (const item of items) {
    const key = item.kind === "seller_listing" ? (item.sellerId ?? null) : null;
    if (!groups.has(key)) groups.set(key, { seller: item.kind === "seller_listing" ? (item.seller ?? null) : null, items: [] });
    groups.get(key)!.items.push(item);
  }
  return Array.from(groups.values());
}

function AuthenticatedCartPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { data: cart, isLoading } = useGetCart();
  const updateItem = useUpdateCartItem();
  const removeItem = useRemoveFromCart();

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
  const total = subtotal + shipping;
  const sellerGroups = groupBySeller(items);
  // Marketplace (seller_listing) lines charge their courier fee separately,
  // collected by the seller on delivery -- it's never summed into
  // deliveryTotal/total above (see routes/cart.ts). Surface that as a
  // total across the whole cart so "Delivery: Free" in the summary below
  // doesn't read as "nothing more to pay" when it isn't.
  const codDeliveryTotal = items.reduce(
    (sum, item) => sum + (item.kind === "seller_listing" ? (item.listing?.deliveryCharge ?? 0) * item.quantity : 0),
    0,
  );

  function handleUpdate(id: number, quantity: number) {
    if (quantity < 1) return;
    updateItem.mutate({ id, data: { quantity } }, {
      onSuccess: () => qc.invalidateQueries({ queryKey: getGetCartQueryKey() }),
    });
  }

  function handleRemove(id: number) {
    removeItem.mutate({ id }, {
      onSuccess: () => qc.invalidateQueries({ queryKey: getGetCartQueryKey() }),
    });
  }

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 md:px-6 lg:px-8 py-10 max-w-5xl xl:max-w-7xl">
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (items.length === 0) return <EmptyCart />;

  return (
    <div className="min-h-screen bg-background">
      <div className="bg-muted/30 border-b py-6 md:py-8 lg:py-10">
        <div className="container mx-auto px-4 md:px-6 lg:px-8 max-w-5xl xl:max-w-7xl">
          <PageBreadcrumb crumbs={[{ label: "Your Bag", icon: <ShoppingBag className="h-3 w-3" /> }]} className="mb-3" />
          <h1 className="font-serif text-4xl font-medium">Your Bag</h1>
          <p className="text-muted-foreground mt-1 text-sm">{items.length} item{items.length !== 1 ? "s" : ""}</p>
        </div>
      </div>

      <div className="container mx-auto px-4 md:px-6 lg:px-8 py-6 md:py-8 lg:py-10 max-w-5xl xl:max-w-7xl">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 lg:gap-10">
          {/* Items, grouped by seller */}
          <div className="lg:col-span-2 space-y-6 lg:space-y-8">
            {sellerGroups.map((group, gi) => (
              <div key={group.seller?.id ?? "admin-direct"} className="space-y-4">
                {group.seller && (
                  <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                    <Sprout className="h-3.5 w-3.5 text-accent" />
                    Sold by {group.seller.nurseryName}
                  </div>
                )}
                {sellerGroups.length > 1 && gi > 0 && <div className="border-t" />}
                {group.items.map((item) => {
                  const isListing = item.kind === "seller_listing";
                  const price = isListing
                    ? (item.listing!.discountPrice ?? item.listing!.price)
                    : (item.variant!.discountPrice ?? item.variant!.price);
                  const originalPrice = isListing ? item.listing!.price : item.variant!.price;
                  const img = item.product.images?.[0] ?? null;
                  const label = isListing
                    ? [item.listing!.height, item.listing!.potSize, item.listing!.age].filter(Boolean).join(" · ")
                    : item.variant!.name;
                  return (
                    <div key={item.id} className="flex gap-4 lg:gap-6 bg-card border rounded-xl p-4 lg:p-6">
                      <Link href={`/products/${item.productId}`}>
                        {img ? (
                          <img src={img} alt={item.product.name} className="w-24 h-24 lg:w-32 lg:h-32 object-cover rounded-lg shrink-0 cursor-pointer" />
                        ) : (
                          <NoImagePlaceholder className="w-24 h-24 lg:w-32 lg:h-32 rounded-lg shrink-0 cursor-pointer" />
                        )}
                      </Link>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start">
                          <div className="min-w-0">
                            {label && <p className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">{label}</p>}
                            <Link href={`/products/${item.productId}`}>
                              <h3 className="font-medium text-sm lg:text-base leading-snug truncate hover:text-accent cursor-pointer">{item.product.name}</h3>
                            </Link>
                          </div>
                          <button
                            onClick={() => handleRemove(item.id)}
                            className="text-muted-foreground hover:text-destructive p-1 ml-2 transition-colors"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                        <div className="flex items-center justify-between mt-3 lg:mt-4">
                          <div className="flex items-center border rounded-full overflow-hidden">
                            <button
                              onClick={() => handleUpdate(item.id, item.quantity - 1)}
                              className="px-3 py-1.5 lg:px-4 lg:py-2 text-muted-foreground hover:text-foreground"
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </button>
                            <span className="px-3 lg:px-4 text-sm lg:text-base font-medium">{item.quantity}</span>
                            <button
                              onClick={() => handleUpdate(item.id, item.quantity + 1)}
                              className="px-3 py-1.5 lg:px-4 lg:py-2 text-muted-foreground hover:text-foreground"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <div className="text-right">
                            <p className="font-semibold lg:text-lg">Tk{(price * item.quantity).toLocaleString()}</p>
                            {price < originalPrice && (
                              <p className="text-xs text-muted-foreground line-through">Tk{(originalPrice * item.quantity).toLocaleString()}</p>
                            )}
                            {isListing && item.listing!.deliveryCharge > 0 && (
                              <p className="text-xs text-muted-foreground mt-0.5">
                                Pay on delivery: Tk{(item.listing!.deliveryCharge * item.quantity).toLocaleString()}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
            {sellerGroups.length > 1 && (
              <p className="text-xs text-muted-foreground italic">
                Items from different sellers ship separately and become separate orders at checkout.
              </p>
            )}
          </div>

          {/* Summary */}
          <div>
            <div className="bg-card border rounded-xl p-6 lg:shadow-lg sticky top-24">
              <h2 className="font-medium text-lg lg:text-xl mb-5">Order Summary</h2>
              <div className="space-y-3 text-sm mb-5">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>Tk{subtotal.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Delivery</span>
                  <span>{shipping === 0 ? <span className="text-success-foreground">Free</span> : `Tk${shipping.toLocaleString()}`}</span>
                </div>
                <div className="border-t pt-3 flex justify-between font-semibold text-base lg:text-lg">
                  <span>Total</span>
                  <span>Tk{total.toLocaleString()}</span>
                </div>
                {codDeliveryTotal > 0 && (
                  <p className="text-xs text-muted-foreground pt-1">
                    Plus Tk{codDeliveryTotal.toLocaleString()} pay on delivery for marketplace items
                  </p>
                )}
              </div>
              <Button className="w-full rounded-full" size="lg" onClick={() => setLocation("/checkout")}>
                Proceed to Checkout <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
              <Link href="/products">
                <Button variant="ghost" className="w-full mt-2 text-sm text-muted-foreground">
                  Continue Shopping
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CartPage() {
  const { user, isLoaded } = useUser();

  if (!isLoaded) {
    return (
      <div className="container mx-auto px-4 md:px-6 lg:px-8 py-10 max-w-5xl xl:max-w-7xl">
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return user ? <AuthenticatedCartPage /> : <GuestCartPage />;
}
