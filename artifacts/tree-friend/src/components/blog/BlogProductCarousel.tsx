import { Link } from "wouter";
import { ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";

interface LinkedProduct {
  id: number;
  name: string;
  slug: string;
  images: string[];
  startingPrice: number | null;
  inStock: boolean;
}

function ProductMiniCard({ product }: { product: LinkedProduct }) {
  const outOfStock = !product.inStock;

  return (
    <Link
      href={`/products/${product.id}`}
      className="shrink-0 w-40 snap-start bg-white border rounded-2xl overflow-hidden hover:shadow-md transition-shadow"
    >
      <div className="relative aspect-square bg-muted">
        {product.images?.[0] ? (
          <img src={product.images[0]} alt={product.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">
            No image
          </div>
        )}
      </div>
      <div className="p-2.5 space-y-1.5">
        <p className="text-xs font-medium leading-snug line-clamp-2 min-h-[2rem]">{product.name}</p>
        {product.startingPrice != null && (
          <span className="text-sm font-bold">From Tk{product.startingPrice.toLocaleString()}</span>
        )}
        <Button
          size="sm"
          disabled={outOfStock}
          className="w-full h-8 text-xs rounded-lg bg-accent hover:bg-accent/90 text-white pointer-events-none"
        >
          {outOfStock ? "Out of stock" : (<><ShoppingBag className="h-3.5 w-3.5 mr-1" /> View Product</>)}
        </Button>
      </div>
    </Link>
  );
}

export function BlogProductCarousel({ products }: { products: LinkedProduct[] }) {
  if (!products || products.length === 0) return null;

  return (
    <div className="my-8">
      <h3 className="font-serif text-lg font-medium mb-3">Featured in this article</h3>
      <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-2 -mx-4 px-4 sm:mx-0 sm:px-0">
        {products.map((p) => (
          <ProductMiniCard key={p.id} product={p} />
        ))}
      </div>
    </div>
  );
}
