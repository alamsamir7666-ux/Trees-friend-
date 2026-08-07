import { useAdminContext } from "@/contexts/AdminContext";
import type { EditingProduct } from "@/contexts/AdminContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Plus, Pencil, Trash2 } from "lucide-react";

export function ProductsTab() {
  const {
    search, setSearch,
    filteredProducts,
    productsLoading, productsPage, productsHasMore,
    setProductsPage,
    setShowProductModal, setEditingProduct,
    handleDeleteProduct,
    categories,
  } = useAdminContext();

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
          <Input
            placeholder="Search products..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 rounded-xl"
          />
        </div>
        <Button onClick={() => setShowProductModal(true)} className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground shrink-0">
          <Plus className="h-4 w-4 mr-1.5" /> Add Product
        </Button>
      </div>

      {productsLoading && productsPage === 1 ? (
        <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
      ) : (
        <div className="bg-card rounded-2xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="px-5 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Product</th>
                  <th className="px-5 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Category</th>
                  <th className="px-5 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Homepage</th>
                  <th className="px-5 py-3.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Price</th>
                  <th className="px-5 py-3.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Stock</th>
                  <th className="px-5 py-3.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-muted/50">
                {filteredProducts.map((p) => {
                  const category = categories.find((c) => c.id === p.categoryId);
                  return (
                  <tr key={p.id} className="hover:bg-primary/5 transition-colors">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        {p.images?.[0] ? (
                          <img src={p.images[0]} alt="" className="h-10 w-10 rounded-xl object-cover border" />
                        ) : (
                          <div className="h-10 w-10 rounded-xl bg-muted border" />
                        )}
                        <div>
                          <p className="font-medium text-foreground">{p.name}</p>
                          {false && (
                            <span className="text-xs bg-primary/10 text-primary border border-primary/20 px-1.5 py-0.5 rounded-md font-medium">Featured</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="capitalize text-muted-foreground text-xs bg-muted px-2.5 py-1 rounded-full font-medium">{category?.name ?? "Uncategorized"}</span>
                    </td>
                    <td className="px-5 py-3.5">
                      {p.homepageTag ? (() => {
                        // homepageTag values are free-text keys created by the admin in
                        // Homepage Sections (see HomepageSectionsTab) — there's no fixed
                        // taxonomy, so only the two built-in defaults get special styling;
                        // any custom section key just falls back to a neutral badge below.
                        const TAG_LABELS: Record<string, { label: string; cls: string }> = {
                          trending:       { label: "🔥 Trending",      cls: "bg-success text-success-foreground border-success-border" },
                          new_arrivals:   { label: "✨ New Arrivals",  cls: "bg-info text-info-foreground border-info-border" },
                        };
                        const cfg = TAG_LABELS[p.homepageTag];
                        return <span className={`text-xs px-2.5 py-1 rounded-full font-medium border ${cfg?.cls ?? "bg-muted text-muted-foreground border-border"}`}>{cfg?.label ?? p.homepageTag}</span>;
                      })() : (
                        <span className="text-xs text-muted-foreground/70">-</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      {/* Phase 4: startingPrice is the admin-set price, permanently
                          null for every product created after Phase 2
                          (PHASE2_HANDOFF.md §5) since admin no longer creates
                          variants at all. listingMinPrice/listingMaxPrice --
                          confirmed present here via toProduct()'s marketplace
                          stats, same as every other list/browse endpoint
                          (products.ts GET /products, verified directly) -- is
                          what sellers are actually charging, which is more
                          useful to admin than a field that will just say
                          "No variants" for every product going forward. */}
                      {p.listingMinPrice != null ? (
                        <p className="font-semibold text-foreground">
                          {p.listingMinPrice === p.listingMaxPrice
                            ? `Tk${Number(p.listingMinPrice).toLocaleString()}`
                            : `Tk${Number(p.listingMinPrice).toLocaleString()}–${Number(p.listingMaxPrice).toLocaleString()}`}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground/70">No listings</p>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      {/* Phase 5: was p.productStatus === "pre_order" (an
                          admin-set product-level flag, removed -- see
                          ProductModal.tsx). Pre-order is seller/variant
                          data; this now reads listingHasPreOrder, true if
                          ANY qualifying seller listing has a variant marked
                          isPreOrder. Note this can't distinguish "the only
                          listing is pre-order" from "one of five listings
                          has one pre-order variant" -- it's a simple
                          existence check, matching what a single boolean
                          badge can represent. */}
                      {(p.listingHasPreOrder ?? false) ? (
                        <span className="font-semibold text-info-foreground">Pre-Order</span>
                      ) : (
                        <>
                          {/* Stock, like Price two rows up, must read the
                              Phase 2 marketplace-derived listingCount, not
                              the frozen admin-owned Product.inStock (which
                              is permanently false for every product created
                              after Phase 2 since admin no longer writes
                              productVariantsTable). listingCount = number of
                              distinct qualifying seller listings; see
                              toProduct()'s doc comment in products.ts. */}
                          <span className={`font-semibold ${(p.listingCount ?? 0) > 0 ? "text-foreground" : "text-destructive"}`}>
                            {(p.listingCount ?? 0) > 0 ? "In Stock" : "Out of Stock"}
                          </span>
                          {(p.listingCount ?? 0) === 0 && <p className="text-xs text-destructive/70">Restock needed</p>}
                        </>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => { setEditingProduct(p as unknown as EditingProduct); setShowProductModal(true); }}
                          className="p-1.5 rounded-lg text-muted-foreground/70 hover:text-info-foreground hover:bg-info/10 transition-colors"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteProduct(p.id)}
                          className="p-1.5 rounded-lg text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
                {productsHasMore && (
                  <tr>
                    <td colSpan={6} className="text-center py-4">
                      <Button onClick={() => setProductsPage((p: number) => p + 1)} disabled={productsLoading} className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground">
                        {productsLoading ? "Loading..." : "Load More Products"}
                      </Button>
                    </td>
                  </tr>
                )}
                {filteredProducts.length === 0 && (
                  <tr><td colSpan={6} className="text-center text-muted-foreground/70 py-12">No products found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
