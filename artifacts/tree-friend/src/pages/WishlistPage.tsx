import { useState } from "react";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { Link } from "wouter";
import { useGetWishlist, useRemoveFromWishlist, useAddToCart, getGetWishlistQueryKey, getGetCartQueryKey, type Product, type ProductVariant } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Heart, ShoppingBag, Trash2 } from "lucide-react";
import { useGuestWishlist } from "@/hooks/useGuestWishlist";
import { useGuestCart } from "@/hooks/useGuestCart";
import { VariantPickerDialog } from "@/components/ui/VariantPickerDialog";

// Normalized wishlist line: guest (localStorage) items don't carry the full
// Product/variants list, only a price snapshot from when they were added --
// so guest "Add to Bag" can't offer variant selection the way the
// logged-in path (which has the real Product with variants) can.
type WishlistLine = {
  id: number;
  productId: number;
  name: string;
  slug: string;
  image: string;
  price: number;
  discountPrice: number | null;
  product: Product | null; // full product only available for logged-in users
};

export function WishlistPage() {
  const qc = useQueryClient();
  const { user, isLoaded } = useUser();
  const isGuest = isLoaded && !user;
  const guestWishlist = useGuestWishlist();
  const guestCart = useGuestCart();
  const [pickerFor, setPickerFor] = useState<Product | null>(null);

  const { data: wishlistData, isLoading: wishlistLoading } = useGetWishlist({
    query: { enabled: !isGuest, queryKey: getGetWishlistQueryKey() },
  });
  const removeFromWishlist = useRemoveFromWishlist();
  const addToCart = useAddToCart();

  const isLoading = !isLoaded || (!isGuest && wishlistLoading);

  const items: WishlistLine[] = isGuest
    ? guestWishlist.items.map((g) => ({
        id: g.productId,
        productId: g.productId,
        name: g.name,
        slug: g.slug,
        image: g.image,
        price: g.price,
        discountPrice: g.discountPrice,
        product: null,
      }))
    : (wishlistData ?? []).map((w) => ({
        id: w.id,
        productId: w.productId,
        name: w.product.name,
        slug: w.product.slug,
        image: w.product.images?.[0] ?? "",
        price: w.product.startingPrice ?? 0,
        discountPrice: null,
        product: w.product,
      }));

  function handleRemove(productId: number) {
    if (isGuest) {
      guestWishlist.removeItem(productId);
      return;
    }
    removeFromWishlist.mutate({ productId }, {
      onSuccess: () => qc.invalidateQueries({ queryKey: getGetWishlistQueryKey() }),
    });
  }

  function addVariantToCart(item: WishlistLine, variant: ProductVariant) {
    if (isGuest) {
      guestCart.addItem({
        productId: item.productId,
        variantId: variant.id,
        quantity: 1,
        name: item.name,
        price: variant.price,
        discountPrice: variant.discountPrice ?? null,
        image: item.image,
      });
      return;
    }
    addToCart.mutate({ data: { productId: item.productId, variantId: variant.id, quantity: 1 } }, {
      onSuccess: () => qc.invalidateQueries({ queryKey: getGetCartQueryKey() }),
    });
  }

  function handleAddToCart(item: WishlistLine) {
    // Guest wishlist entries don't carry variant data (they were snapshotted
    // at add-to-wishlist time without a variant). Send them to the product
    // page to pick one rather than guessing.
    if (!item.product) return;
    const variants = item.product.variants ?? [];
    if (variants.length === 0) return;
    if (variants.length === 1) {
      addVariantToCart(item, variants[0]);
      return;
    }
    setPickerFor(item.product);
  }

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-10">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (!items || items.length === 0) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
        <div className="h-20 w-20 rounded-full bg-muted flex items-center justify-center mb-6">
          <Heart className="h-9 w-9 text-muted-foreground" />
        </div>
        <h2 className="font-serif text-2xl font-medium mb-2">Your wishlist is empty</h2>
        <p className="text-muted-foreground text-sm mb-6">Save products you love and come back to them anytime.</p>
        <Link href="/products"><Button className="rounded-full px-8">Explore Products</Button></Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="bg-muted/30 border-b py-10">
        <div className="container mx-auto px-4">
          <PageBreadcrumb crumbs={[{ label: "Wishlist", icon: <Heart className="h-3 w-3" /> }]} className="mb-3" />
          <h1 className="font-serif text-4xl font-medium">Wishlist</h1>
          <p className="text-muted-foreground mt-1 text-sm">{items.length} saved item{items.length !== 1 ? "s" : ""}</p>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
          {items.map((item) => {
            const img = item.image || "https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=400&q=80&fm=webp";
            const price = item.discountPrice ?? item.price;
            return (
              <div key={item.id} className="group bg-card border rounded-xl overflow-hidden">
                <Link href={`/products/${item.productId}`}>
                  <div className="relative aspect-square overflow-hidden bg-muted/20 cursor-pointer">
                    <img src={img} alt={item.name} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                    <button
                      onClick={(e) => { e.preventDefault(); handleRemove(item.productId); }}
                      className="absolute top-3 right-3 p-2 rounded-full bg-background/80 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity hover:text-destructive text-muted-foreground"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </Link>
                <div className="p-3">
                  <Link href={`/products/${item.productId}`}>
                    <p className="font-medium text-sm leading-snug mb-2 line-clamp-2 cursor-pointer hover:text-accent">{item.name}</p>
                  </Link>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="font-semibold text-sm">
                      {item.product ? `From Tk${price.toLocaleString()}` : `Tk${price.toLocaleString()}`}
                    </span>
                    {item.discountPrice != null && (
                      <span className="text-xs text-muted-foreground line-through">Tk{item.price.toLocaleString()}</span>
                    )}
                  </div>
                  {isGuest ? (
                    <Link href={`/products/${item.productId}`}>
                      <Button size="sm" className="w-full text-xs">
                        <ShoppingBag className="h-3.5 w-3.5 mr-1.5" />
                        View Options
                      </Button>
                    </Link>
                  ) : (
                    <Button
                      size="sm"
                      className="w-full text-xs"
                      onClick={() => handleAddToCart(item)}
                    >
                      <ShoppingBag className="h-3.5 w-3.5 mr-1.5" />
                      Add to Bag
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {pickerFor && (
        <VariantPickerDialog
          open={!!pickerFor}
          onOpenChange={(o) => { if (!o) setPickerFor(null); }}
          productName={pickerFor.name}
          variants={pickerFor.variants ?? []}
          onConfirm={(variant) => {
            const item = items.find((i) => i.productId === pickerFor.id);
            if (item) addVariantToCart(item, variant);
          }}
        />
      )}
    </div>
  );
}
