import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useParams, useLocation, useSearch, Link } from "wouter";
import {
  useGetProduct, useListReviews, useCreateReview, useUpdateReview, useDeleteReview, useAddToCart,
  useAddToWishlist, useRemoveFromWishlist, useGetWishlist, useListProducts, useListCategories,
  useGetReviewEligibility,
  getGetCartQueryKey, getGetWishlistQueryKey, getListReviewsQueryKey,
  getGetReviewEligibilityQueryKey,
  type ProductVariant,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import { useGuestCart } from "@/hooks/useGuestCart";
import { VariantSelector } from "@/components/ui/VariantSelector";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Star, Heart, ShoppingBag, Minus, Plus, ChevronLeft, Check, ShieldCheck, Package, Truck, Bike, Pencil, Trash2, AlertTriangle, Lock,
  ArrowRight, Info, Sun, Droplets, Layers, Ruler, Thermometer, Gauge, Calendar, Sprout, Award, Target, Leaf,
} from "lucide-react";
import { ProductCard } from "@/components/ui/ProductCard";
import { saveRecentlyViewed, useRecentlyViewed } from "@/hooks/useRecentlyViewed";
import { ImageZoom } from "@/components/ui/ImageZoom";
import { ProductQA } from "@/components/ui/ProductQA";
import { SellerListingsSection } from "@/components/ui/SellerListingsSection";
import { StockAlertButton } from "@/components/ui/StockAlertButton";
import { updateSEO } from "@/lib/seo";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { useToast } from "@/hooks/use-toast";

export function ProductDetailPage() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id ?? "0");
  const [, setLocation] = useLocation();
  const searchStr = useSearch();
  const { user } = useUser();

  // Preserve the filter context the user came from so "Back to shop" returns to the right list
  const fromParam = new URLSearchParams(searchStr).get("from") ?? "";
  const backHref = fromParam === "featured"
    ? "/"
    : fromParam
    ? `/products?category=${encodeURIComponent(fromParam)}`
    : "/products";
  const backLabel = fromParam === "featured"
    ? "Back to featured"
    : fromParam
    ? `Back to ${fromParam}`
    : "Back to shop";
  const qc = useQueryClient();

  // Scroll to top is handled globally by ScrollManager in App.tsx.
  // No per-page scrollTo needed - removing it prevents fighting with ScrollManager.

  const { data: product, isLoading } = useGetProduct(id, { query: { enabled: !!id, queryKey: ["product", id] } });
  const { data: categories } = useListCategories();
  const category = categories?.find((c) => c.id === product?.categoryId) ?? null;
  const { data: reviews } = useListReviews(id, { query: { enabled: !!id, queryKey: getListReviewsQueryKey(id) } });
  const { data: wishlist } = useGetWishlist({ query: { enabled: !!user, retry: false, queryKey: getGetWishlistQueryKey() } });
  const { data: eligibility } = useGetReviewEligibility(id, {
    query: {
      enabled: !!user && !!id,
      retry: false,
      queryKey: getGetReviewEligibilityQueryKey(id),
    },
  });

  // The /products list endpoint filters `category` by slug, not id, and
  // Product doesn't carry the category's slug -- so related products are
  // fetched broadly and filtered client-side by categoryId instead.
  const { data: relatedData } = useListProducts(
    { limit: 40 },
    { query: { enabled: !!product?.categoryId, queryKey: ["relatedProducts", product?.categoryId] } }
  );

  const addToCart = useAddToCart();
  const guestCart = useGuestCart();
  const addToWishlist = useAddToWishlist();
  const removeFromWishlist = useRemoveFromWishlist();
  const createReview = useCreateReview();
  const updateReview = useUpdateReview();
  const deleteReview = useDeleteReview();
  const { toast } = useToast();

  const [qty, setQty] = useState(1);
  const [activeImg, setActiveImg] = useState(0);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [justAdded, setJustAdded] = useState(false);
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(null);
  const [showStockSheet, setShowStockSheet] = useState(false);
  const [editingReviewId, setEditingReviewId] = useState<number | null>(null);
  const [editRating, setEditRating] = useState(5);
  const [editComment, setEditComment] = useState("");

  const isWishlisted = wishlist?.some((w) => w.productId === id) ?? false;
  const displayPrice = selectedVariant
    ? (selectedVariant.discountPrice ?? selectedVariant.price)
    : (product?.startingPrice ?? 0);

  const relatedProducts = (relatedData?.products ?? [])
    .filter((p) => p.id !== id && p.categoryId === product?.categoryId)
    .slice(0, 4);
  const recentlyViewed = useRecentlyViewed(id);

  useEffect(() => {
    if (!product) return;
    saveRecentlyViewed(product);
  }, [product?.id]);

  useEffect(() => {
    if (isLoading || !product || product.inStock) return;
    // Wait briefly after loading completes so page fully paints
    const t = setTimeout(() => setShowStockSheet(true), 300);
    return () => clearTimeout(t);
  }, [isLoading, product?.id]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-10">
          <Skeleton className="h-4 w-36 mb-8" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
            {/* Left: image gallery */}
            <div className="space-y-3">
              <Skeleton className="aspect-square w-full rounded-2xl" />
              <div className="grid grid-cols-4 gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="aspect-square rounded-xl" />
                ))}
              </div>
            </div>
            {/* Right: product info */}
            <div className="space-y-4 pt-2">
              <Skeleton className="h-3 w-20 rounded-full" />
              <Skeleton className="h-9 w-4/5" />
              <Skeleton className="h-7 w-3/5" />
              <div className="flex items-center gap-1.5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-4 w-4 rounded-sm" />
                ))}
                <Skeleton className="h-4 w-20 ml-2" />
              </div>
              <div className="flex items-center gap-3 pt-1">
                <Skeleton className="h-9 w-32" />
                <Skeleton className="h-6 w-24" />
              </div>
              <Skeleton className="h-px w-full" />
              <Skeleton className="h-20 w-full rounded-xl" />
              <div className="flex gap-3 pt-1">
                <Skeleton className="h-12 flex-1 rounded-xl" />
                <Skeleton className="h-12 w-12 rounded-xl" />
              </div>
              <div className="grid grid-cols-3 gap-3 pt-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-20 rounded-2xl" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (!product) return <div className="py-20 text-center text-muted-foreground">Product not found</div>;

  updateSEO({
    title: product.name,
    description: product.description,
    image: product.images[0],
    type: "product",
    priceAmount: product.startingPrice ?? 0,
    priceCurrency: "BDT",
  });

  const imgs = (product.images.length > 0 ? product.images : ["https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=600&q=80&fm=webp"]).map((img: string, i: number) =>
    img.includes("res.cloudinary.com")
      ? (i === 0
          ? img.replace("/upload/", "/upload/w_800,h_800,c_fill,q_85/")
          : img.replace("/upload/", "/upload/w_800,h_800,c_fill,f_webp,q_80/"))
      : img
  );

  function handleAddToCart() {
    if (!product) return;
    if (!selectedVariant) {
      toast({ title: "Select an option first", description: "Please choose a variant before adding to bag.", variant: "destructive" });
      return;
    }
    if (!user) {
      guestCart.addItem({
        productId: id,
        variantId: selectedVariant.id,
        quantity: qty,
        name: product.name,
        price: selectedVariant.price,
        discountPrice: selectedVariant.discountPrice ?? null,
        image: product.images[0] ?? "",
      });
      setJustAdded(true);
      setTimeout(() => setJustAdded(false), 2200);
      return;
    }
    addToCart.mutate({ data: { productId: id, variantId: selectedVariant.id, quantity: qty } }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetCartQueryKey() });
        setJustAdded(true);
        setTimeout(() => setJustAdded(false), 2200);
      },
    });
  }

  function handleWishlist() {
    if (!user) { setLocation("/sign-in"); return; }
    if (isWishlisted) {
      removeFromWishlist.mutate({ productId: id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetWishlistQueryKey() }) });
    } else {
      addToWishlist.mutate({ productId: id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetWishlistQueryKey() }) });
    }
  }

  function handleReview() {
    if (!user) { setLocation("/sign-in"); return; }
    createReview.mutate({ productId: id, data: { rating, comment } }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListReviewsQueryKey(id) });
        qc.invalidateQueries({ queryKey: getGetReviewEligibilityQueryKey(id) });
        setComment(""); setRating(5); setShowReviewForm(false);
      },
    });
  }

  function startEditReview(r: { id: number; rating: number; comment: string }) {
    setEditingReviewId(r.id);
    setEditRating(r.rating);
    setEditComment(r.comment);
  }

  function handleUpdateReview() {
    if (editingReviewId == null) return;
    updateReview.mutate({ reviewId: editingReviewId, data: { rating: editRating, comment: editComment } }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListReviewsQueryKey(id) });
        setEditingReviewId(null);
      },
    });
  }

  function handleDeleteReview(reviewId: number) {
    if (!confirm("Delete your review?")) return;
    deleteReview.mutate({ productId: id, reviewId }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListReviewsQueryKey(id) });
        qc.invalidateQueries({ queryKey: getGetReviewEligibilityQueryKey(id) });
      },
    });
  }

  const originalPriceForDisplay = selectedVariant ? selectedVariant.price : (product.startingPrice ?? 0);
  const hasDiscount = selectedVariant ? selectedVariant.discountPrice != null : false;
  const discountPct = hasDiscount && originalPriceForDisplay > 0
    ? Math.round(((originalPriceForDisplay - displayPrice) / originalPriceForDisplay) * 100)
    : null;

  // Determine review UI state
  const canReview = eligibility?.canReview ?? false;
  const alreadyReviewed = eligibility?.reason === "already_reviewed";
  const notPurchased = !user || eligibility?.reason === "not_purchased";

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8">
        <PageBreadcrumb
          crumbs={[
            { label: "Products", href: "/products", icon: <ShoppingBag className="h-3 w-3" /> },
            ...(category ? [{ label: category.name, href: `/products?category=${category.slug}`, icon: <Package className="h-3 w-3" /> }] : []),
            { label: product.name.length > 35 ? product.name.slice(0, 35) + "…" : product.name },
          ]}
          className="mb-4"
        />
        <Link href={backHref}>
          <Button variant="ghost" size="sm" className="mb-6 gap-1 text-muted-foreground capitalize">
            <ChevronLeft className="h-4 w-4" /> {backLabel}
          </Button>
        </Link>

        {/* Image + Details grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 mb-10">
          {/* Images */}
          <div className="space-y-4">
            <div className="aspect-square rounded-2xl overflow-hidden bg-muted/20 border">
              <img src={imgs[activeImg]} alt={product.name} className="w-full h-full object-cover" />
            </div>
            {imgs.length > 1 && (
              <div className="flex gap-3">
                {imgs.map((img, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveImg(i)}
                    className={`w-16 h-16 rounded-xl overflow-hidden border-2 transition-colors ${activeImg === i ? "border-primary" : "border-transparent"}`}
                  >
                    <img src={img} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Details */}
          <div className="flex flex-col">
            <div className="mb-2">
              {category && <Badge variant="secondary" className="uppercase text-xs tracking-wider">{category.name}</Badge>}
            </div>
            <h1 className="font-serif text-3xl md:text-4xl font-medium mb-1">{product.name}</h1>
            {product.scientificName && (
              <p className="text-sm text-muted-foreground italic mb-3">{product.scientificName}</p>
            )}

            <div className="flex items-center gap-2 mb-5">
              <div className="flex">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star key={i} className={`h-4 w-4 ${i < Math.round(product.averageRating) ? "fill-accent text-accent" : "text-muted"}`} />
                ))}
              </div>
              <span className="text-sm text-muted-foreground">({product.reviewCount} reviews)</span>
            </div>

            <div className="flex items-baseline gap-3 mb-6">
              <span className="text-3xl font-semibold">Tk{displayPrice.toLocaleString()}</span>
              {hasDiscount && (
                <>
                  <span className="text-lg text-muted-foreground line-through">Tk{originalPriceForDisplay.toLocaleString()}</span>
                  <Badge className="bg-accent/15 text-accent border-accent/30">{discountPct}% off</Badge>
                </>
              )}
            </div>

            <VariantSelector
              variants={product.variants ?? []}
              selected={selectedVariant}
              onVariantChange={setSelectedVariant}
            />

            <div className="flex items-center gap-2 mb-4 mt-4">
              {product.productStatus === "out_of_stock" || !product.inStock ? (
                <button onClick={() => setShowStockSheet(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-destructive/10 border border-destructive/20 text-destructive text-sm font-medium">
                  🔔 Out of stock — Notify me
                </button>
              ) : product.productStatus === "pre_order" ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-sm font-medium">
                   Pre-order - 5% discount + Ships in 20-23 days
                </span>
              ) : selectedVariant && selectedVariant.stock <= 3 ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-50 border border-red-200 text-red-600 text-sm font-semibold animate-pulse">
                  <AlertTriangle className="h-3.5 w-3.5" /> Only {selectedVariant.stock} left!
                </span>
              ) : selectedVariant && selectedVariant.stock <= 10 ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-sm font-medium">
                  <AlertTriangle className="h-3.5 w-3.5" /> Only {selectedVariant.stock} left
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-green-50 border border-green-200 text-green-700 text-sm font-medium">
                  In stock
                </span>
              )}
            </div>

            <div className="flex items-center gap-3 mb-4">
              <div className="inline-flex items-center border border-border rounded-full h-11">
                <button onClick={() => setQty(Math.max(1, qty - 1))} className="h-full px-3.5 flex items-center justify-center text-muted-foreground hover:text-foreground rounded-l-full transition-colors" aria-label="Decrease quantity">
                  <Minus className="h-4 w-4" />
                </button>
                <span className="w-10 font-medium text-center select-none tabular-nums text-sm">{qty}</span>
                <button onClick={() => setQty(Math.min(selectedVariant?.stock ?? 99, qty + 1))} className="h-full px-3.5 flex items-center justify-center text-muted-foreground hover:text-foreground rounded-r-full transition-colors" aria-label="Increase quantity">
                  <Plus className="h-4 w-4" />
                </button>
              </div>
              {product.productStatus === "pre_order" ? (
                <Link href={`/pre-order-checkout?productId=${product.id}&name=${encodeURIComponent(product.name)}&image=${encodeURIComponent((product.images as string[])[0] ?? "")}&price=${displayPrice}&qty=${qty}&shipmentDate=${encodeURIComponent(localStorage.getItem("nextShipmentDate") ?? "")}`} className="flex-1">
                  <Button
                    className="w-full rounded-full bg-blue-500 text-white hover:bg-blue-600"
                    size="default"
                  >
                    <ShoppingBag className="h-4 w-4 mr-2" /> Pre-Order Now
                  </Button>
                </Link>
              ) : product.productStatus === "out_of_stock" || !product.inStock ? (
                <Button
                  className="flex-1 rounded-full cursor-not-allowed bg-foreground text-background"
                  size="lg"
                  disabled
                >
                  Out of Stock
                </Button>
              ) : (
                <Button
                  className={`flex-1 rounded-full transition-all duration-200 ${justAdded ? "bg-green-600 hover:bg-green-600" : ""}`}
                  size="lg"
                  onClick={handleAddToCart}
                  disabled={addToCart.isPending}
                >
                  {justAdded ? (<><Check className="h-4 w-4 mr-2" /> Added to Bag</>) : (<><ShoppingBag className="h-4 w-4 mr-2" /> Add to Bag</>)}
                </Button>
              )}
              <Button variant="outline" size="icon" className="rounded-full h-12 w-12" onClick={handleWishlist}>
                <Heart className={`h-5 w-5 ${isWishlisted ? "fill-rose-500 text-rose-500" : ""}`} />
              </Button>
            </div>
          </div>
        </div>

        {/* Description + extra fields - full width below the grid */}
        {product.description && (
          <div className="bg-muted/30 border border-border rounded-2xl p-6 mb-6">
            <h3 className="flex items-center gap-2 font-serif text-lg font-medium text-foreground mb-3">
              <Info className="h-5 w-5 text-accent shrink-0" />
              Botanical Description
            </h3>
            <p className="text-muted-foreground leading-relaxed">{product.description}</p>
          </div>
        )}

        {product.keyBenefits.length > 0 && (
          <div className="mb-5 bg-muted/30 border border-border rounded-2xl p-6">
            <h3 className="flex items-center gap-2 font-serif text-lg font-medium text-foreground mb-3">
              <Award className="h-5 w-5 text-accent shrink-0" />
              Key Benefits
            </h3>
            <ul className="space-y-1.5">
              {product.keyBenefits.map((b, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <span className="mt-0.5 shrink-0 h-4 w-4 rounded-full bg-accent/15 text-accent flex items-center justify-center text-[10px] font-bold">✓</span>
                  {b}
                </li>
              ))}
            </ul>
          </div>
        )}

        {(product.sunlight || product.watering || product.soilType || product.matureHeight || product.climateZone || product.growthRate || product.bloomSeason) && (
          <div className="mb-5 border border-border rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-4 bg-primary">
              <Sprout className="h-5 w-5 text-white" />
              <h3 className="font-serif text-lg font-medium text-white">Care Guide</h3>
            </div>
            <div className="divide-y divide-border">
              {[
                { icon: Sun, label: "Sunlight", value: product.sunlight?.replace(/_/g, " "), capitalize: true },
                { icon: Droplets, label: "Watering", value: product.watering },
                { icon: Thermometer, label: "Climate Zone", value: product.climateZone },
                { icon: Layers, label: "Soil Type", value: product.soilType },
                { icon: Gauge, label: "Growth Rate", value: product.growthRate, capitalize: true },
                { icon: Ruler, label: "Mature Height", value: product.matureHeight },
                { icon: Calendar, label: "Bloom Season", value: product.bloomSeason },
              ]
                .filter(row => row.value)
                .map((row, i) => (
                  <div key={i} className="flex items-start gap-4 px-5 py-4">
                    <div className="shrink-0 h-9 w-9 rounded-lg bg-muted/60 flex items-center justify-center">
                      <row.icon className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-4">
                      <p className="text-sm text-muted-foreground shrink-0 sm:w-36">{row.label}</p>
                      <p className={`text-sm font-medium text-foreground ${row.capitalize ? "capitalize" : ""}`}>{row.value}</p>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {product.bestFor.length > 0 && (
          <div className="mb-5 bg-muted/30 border border-border rounded-2xl p-6">
            <h3 className="flex items-center gap-2 font-serif text-lg font-medium text-foreground mb-3">
              <Target className="h-5 w-5 text-accent shrink-0" />
              Best For
            </h3>
            <div className="flex flex-wrap gap-2">
              {product.bestFor.map((b, i) => (
                <span key={i} className="bg-accent/10 text-accent border border-accent/20 rounded-full px-3 py-1 text-xs font-medium">{b}</span>
              ))}
            </div>
          </div>
        )}

        {product.careTips.length > 0 && (
          <div className="mb-5 bg-muted/30 border border-border rounded-2xl p-6">
            <h3 className="flex items-center gap-2 font-serif text-lg font-medium text-foreground mb-3">
              <Leaf className="h-5 w-5 text-accent shrink-0" />
              Care Tips
            </h3>
            <ul className="space-y-1.5">
              {product.careTips.map((tip, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <span className="mt-0.5 shrink-0 h-4 w-4 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-[10px] font-bold">🌱</span>
                  {tip}
                </li>
              ))}
            </ul>
          </div>
        )}

        {product.videoUrl && (
          <div className="mb-6">
            <h3 className="text-xs uppercase tracking-wider font-medium text-foreground mb-2">Product Video</h3>
            <div className="relative w-full" style={{paddingBottom: "56.25%"}}>
              <iframe className="absolute top-0 left-0 w-full h-full rounded-xl"
                src={product.videoUrl.replace("watch?v=", "embed/")}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen />
            </div>
          </div>
        )}

        {/* Reviews */}
        <section className="border-t pt-12 mb-16">
          <div className="flex items-center justify-between mb-8">
            <h2 className="font-serif text-2xl font-medium">Customer Reviews</h2>
            {user && canReview && (
              <Button variant="outline" onClick={() => setShowReviewForm(!showReviewForm)}>
                {showReviewForm ? "Cancel" : "Write a Review"}
              </Button>
            )}
            {user && alreadyReviewed && (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground bg-muted/50 px-3 py-1.5 rounded-full">
                <Check className="h-3.5 w-3.5 text-green-600" /> You've reviewed this product
              </span>
            )}
          </div>

          {showReviewForm && canReview && (
            <div className="bg-muted/30 rounded-2xl p-6 mb-8">
              <h3 className="font-medium mb-4">Your Review</h3>
              <div className="flex gap-2 mb-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <button key={i} onClick={() => setRating(i + 1)}>
                    <Star className={`h-6 w-6 ${i < rating ? "fill-accent text-accent" : "text-muted-foreground"}`} />
                  </button>
                ))}
              </div>
              <Textarea placeholder="Share your experience with this product..." value={comment} onChange={(e) => setComment(e.target.value)} className="mb-4" rows={4} />
              <Button onClick={handleReview} disabled={createReview.isPending || !comment.trim()}>Submit Review</Button>
            </div>
          )}

          {user && notPurchased && !alreadyReviewed && (
            <div className="flex items-start gap-3 bg-muted/40 border border-border rounded-xl px-5 py-4 mb-8 text-sm text-muted-foreground">
              <Lock className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground/60" />
              <div>
                <p className="font-medium text-foreground mb-0.5">Reviews are for verified purchasers</p>
                <p>You need to buy this product before you can leave a review.</p>
                <Link href="/orders"><span className="text-accent underline underline-offset-2 hover:text-accent/80 mt-1 inline-block">View your orders ?</span></Link>
              </div>
            </div>
          )}

          {!user && (
            <div className="flex items-start gap-3 bg-muted/40 border border-border rounded-xl px-5 py-4 mb-8 text-sm text-muted-foreground">
              <Lock className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground/60" />
              <div>
                <p className="font-medium text-foreground mb-0.5">Sign in to leave a review</p>
                <p>Only verified purchasers can review products.</p>
                <Link href="/sign-in"><span className="text-accent underline underline-offset-2 hover:text-accent/80 mt-1 inline-block">Sign in ?</span></Link>
              </div>
            </div>
          )}

          {(reviews ?? []).length === 0 ? (
            <p className="text-muted-foreground text-center py-10">No reviews yet. Be the first to share your experience.</p>
          ) : (
            <div className="space-y-6">
              {(reviews ?? []).map((r) => {
                const isOwner = user?.id === r.userId;
                const isEditing = editingReviewId === r.id;
                return (
                  <div key={r.id} className="border-b pb-6 last:border-0">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <p className="font-medium text-sm">{r.userName}</p>
                        <div className="flex gap-1 mt-1">
                          {Array.from({ length: 5 }).map((_, i) => (
                            <Star key={i} className={`h-3.5 w-3.5 ${i < r.rating ? "fill-accent text-accent" : "text-muted"}`} />
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleDateString()}</span>
                        {isOwner && !isEditing && (
                          <>
                            <button onClick={() => startEditReview(r)} className="p-1.5 rounded-lg text-muted-foreground hover:text-blue-500 hover:bg-blue-50 transition-colors"><Pencil className="h-3.5 w-3.5" /></button>
                            <button onClick={() => handleDeleteReview(r.id)} className="p-1.5 rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-50 transition-colors"><Trash2 className="h-3.5 w-3.5" /></button>
                          </>
                        )}
                      </div>
                    </div>
                    {isEditing ? (
                      <div className="bg-muted/30 rounded-xl p-4 mt-2">
                        <div className="flex gap-1.5 mb-3">
                          {Array.from({ length: 5 }).map((_, i) => (
                            <button key={i} onClick={() => setEditRating(i + 1)}>
                              <Star className={`h-5 w-5 ${i < editRating ? "fill-accent text-accent" : "text-muted-foreground"}`} />
                            </button>
                          ))}
                        </div>
                        <Textarea value={editComment} onChange={(e) => setEditComment(e.target.value)} className="mb-3" rows={3} />
                        <div className="flex gap-2">
                          <Button size="sm" onClick={handleUpdateReview} disabled={updateReview.isPending || !editComment.trim()}>Save</Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingReviewId(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground leading-relaxed">{r.comment}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Trust Badges */}
        <section className="mb-8">
          <div className="flex gap-4 overflow-x-auto pb-2 snap-x snap-mandatory scrollbar-hide">
            <div className="snap-start shrink-0 w-[calc(100%-2rem)] sm:w-[calc(50%-0.5rem)] bg-gradient-to-br from-rose-50 to-pink-50 border border-rose-100 rounded-2xl p-5 flex items-start gap-4">
              <div className="shrink-0 h-12 w-12 rounded-full bg-rose-100 flex items-center justify-center"><ShieldCheck className="h-6 w-6 text-rose-500" /></div>
              <div>
                <p className="font-semibold text-sm text-foreground mb-1">100% Authentic, Healthy Plants</p>
                <p className="text-xs text-muted-foreground leading-relaxed">Every tree and plant sold on Tree Friend is nursery-grown and inspected before dispatch. No mislabeled varieties, ever.</p>
              </div>
            </div>
            <div className="snap-start shrink-0 w-[calc(100%-2rem)] sm:w-[calc(50%-0.5rem)] bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-100 rounded-2xl p-5 flex items-start gap-4">
              <div className="shrink-0 h-12 w-12 rounded-full bg-amber-100 flex items-center justify-center"><Package className="h-6 w-6 text-amber-500" /></div>
              <div>
                <p className="font-semibold text-sm text-foreground mb-1">Careful Plant Packaging</p>
                <p className="text-xs text-muted-foreground leading-relaxed">Saplings and potted plants are packed to survive transit, but minor leaf drop or soil settling can happen in shipping — this doesn't affect the plant's health.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Delivery Options */}
        <section className="mb-16 border rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b bg-muted/30"><h3 className="font-serif text-lg font-medium">Delivery Options</h3></div>
          <div className="divide-y">
            <div className="flex items-start gap-4 px-6 py-5">
              <div className="relative flex flex-col items-center">
                <div className="h-9 w-9 rounded-full bg-accent/10 flex items-center justify-center shrink-0"><Truck className="h-4 w-4 text-accent" /></div>
                <div className="w-px flex-1 bg-border mt-2 min-h-[2rem]" />
              </div>
              <div className="flex-1 pb-2">
                <p className="font-semibold text-sm">Standard Delivery</p>
                <p className="text-xs text-muted-foreground mt-0.5">Delivery Time: 2-5 business days</p>
                <div className="mt-3 inline-flex items-center gap-1.5 bg-accent/8 border border-accent/20 text-accent text-xs font-medium px-3 py-1.5 rounded-full">
                  <span>Tk60 within Dhaka City</span><span className="text-accent/40">·</span><span>Tk120 outside Dhaka</span>
                </div>
              </div>
            </div>
            <div className="flex items-start gap-4 px-6 py-5">
              <div className="h-9 w-9 rounded-full bg-green-100 flex items-center justify-center shrink-0"><Bike className="h-4 w-4 text-green-600" /></div>
              <div className="flex-1">
                <p className="font-semibold text-sm">Dhaka City Same Day Delivery</p>
                <p className="text-xs text-muted-foreground mt-0.5">Delivery Time: Within 24h</p>
                <div className="mt-3 inline-flex items-center gap-1.5 bg-green-50 border border-green-200 text-green-700 text-xs font-medium px-3 py-1.5 rounded-full">
                  <span>3pm - 9pm</span><span className="text-green-400">·</span><span>Except Friday</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <SellerListingsSection productId={product.id} />

        <ProductQA productId={product.id} />

        {recentlyViewed.length > 0 && (
          <section className="border-t pt-12 mb-12">
            <div className="flex items-end justify-between mb-8">
              <div>
                <p className="text-xs uppercase tracking-[0.15em] text-accent-text mb-2 font-medium">Your browsing history</p>
                <h2 className="font-serif text-3xl font-medium">Recently Viewed</h2>
              </div>
              <Link href="/products"><Button variant="ghost" className="text-muted-foreground hover:text-foreground text-sm">View all <ArrowRight className="ml-1 h-4 w-4" /></Button></Link>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
              {recentlyViewed.slice(0, 4).map((p) => (<ProductCard key={p.id} product={p} />))}
            </div>
          </section>
        )}

        {relatedProducts.length > 0 && (
          <section className="border-t pt-12">
            <div className="flex items-end justify-between mb-8">
              <div>
                <p className="text-xs uppercase tracking-[0.15em] text-accent-text mb-2 font-medium">You may also like</p>
                <h2 className="font-serif text-3xl font-medium">Related Products</h2>
              </div>
              {category ? (
                <Link href={`/products?category=${category.slug}`}><Button variant="ghost" className="text-muted-foreground hover:text-foreground text-sm">View all {category.name} <ArrowRight className="ml-1 h-4 w-4" /></Button></Link>
              ) : (
                <Link href="/products"><Button variant="ghost" className="text-muted-foreground hover:text-foreground text-sm">View all <ArrowRight className="ml-1 h-4 w-4" /></Button></Link>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
              {relatedProducts.map((p) => (<ProductCard key={p.id} product={p} />))}
            </div>
          </section>
        )}
      </div>

      {showStockSheet && product && createPortal(
        <>

          <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9999, background: 'white', borderRadius: '20px 20px 0 0', padding: '24px', boxShadow: '0 -8px 32px rgba(0,0,0,0.2)', minHeight: '300px' }}>
            <div style={{ width: 40, height: 4, background: '#e5e7eb', borderRadius: 99, margin: '0 auto 16px' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <p style={{ fontWeight: 700, fontSize: 18, marginBottom: 4, color: '#111' }}>Back in Stock Soon!</p>
                <p style={{ color: '#6b7280', fontSize: 14 }}>Get notified the moment this product is available again.</p>
              </div>
              <button onClick={() => setShowStockSheet(false)} style={{ background: '#f3f4f6', border: 'none', borderRadius: '50%', width: 32, height: 32, cursor: 'pointer', fontSize: 16 }}>✕</button>
            </div>
            <StockAlertButton productId={product.id} productName={product.name} sheetMode />
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
