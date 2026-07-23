import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import {
  useCreateProduct, useUpdateProduct,
  getGetFeaturedProductsQueryKey, getGetHomepageProductsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, Plus, Loader2 } from "lucide-react";
import { apiClient } from "@/lib/apiClient";
import { toast } from "sonner";

interface HomepageSection { id: number; key: string; label: string; }

export function ProductModal({ product, categories, tagCounts, onClose, onProductUpdated }: { product?: any; categories: any[]; tagCounts?: Record<string, number>; onClose: () => void; onProductUpdated?: (p: any) => void }) {
  const qc = useQueryClient();
  const { getToken } = useAuth();
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();

  // ── Homepage sections — loaded dynamically from API ──────────────────────
  const [homepageSections, setHomepageSections] = useState<HomepageSection[]>([]);
  const [sectionsLoading, setSectionsLoading]   = useState(true);
  const [addingSectionLabel, setAddingSectionLabel] = useState("");
  const [showAddSection, setShowAddSection]     = useState(false);
  const [addingSection, setAddingSection]       = useState(false);

  useEffect(() => {
    apiClient
      .get<HomepageSection[]>("/api/homepage-sections")
      .then(({ data }) => setHomepageSections(data))
      .catch(() => toast.error("Could not load homepage sections"))
      .finally(() => setSectionsLoading(false));
  }, []);

  async function handleAddSection() {
    if (!addingSectionLabel.trim()) return;
    setAddingSection(true);
    try {
      const { data } = await apiClient.post<HomepageSection>("/api/homepage-sections", {
        label: addingSectionLabel.trim(),
      });
      setHomepageSections(prev => [...prev, data]);
      setAddingSectionLabel("");
      setShowAddSection(false);
      toast.success(`"${data.label}" section created`);
    } catch {
      toast.error("Failed to create section");
    } finally {
      setAddingSection(false);
    }
  }

  const findParentOf = (categoryId: number | undefined) => {
    if (!categoryId || !categories.length) return "";
    const sub = categories.find((cat) => cat.id === categoryId);
    if (!sub) return "";
    // Subcategory: show its parent in the Category dropdown.
    // Leaf top-level category (e.g. "Indoor Plants", no parentId): it IS
    // the category, so self-reference so the dropdown shows it selected.
    return sub.parentId ? String(sub.parentId) : String(sub.id);
  };

  const [form, setForm] = useState({
    name: product?.name ?? "",
    slug: product?.slug ?? "",
    description: product?.description ?? "",
    scientificName: product?.scientificName ?? "",
    parentCategory: findParentOf(product?.categoryId),
    categoryId: product?.categoryId ? String(product.categoryId) : "",
    sunlight: product?.sunlight ?? "",
    watering: product?.watering ?? "",
    soilType: product?.soilType ?? "",
    matureHeight: product?.matureHeight ?? "",
    climateZone: product?.climateZone ?? "",
    growthRate: product?.growthRate ?? "",
    bloomSeason: product?.bloomSeason ?? "",
    images: product?.images?.join(", ") ?? "",
    videoUrl: product?.videoUrl ?? "",
    keyBenefits: (product?.keyBenefits ?? []).join("\n"),
    bestFor: (product?.bestFor ?? []).join("\n"),
    careTips: (product?.careTips ?? []).join("\n"),
    homepageTag: product?.homepageTag ?? "",
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!form.categoryId) {
      alert("Please select a category");
      return;
    }

    const data = {
      name: form.name,
      slug: form.slug || form.name.toLowerCase().replace(/\s+/g, "-"),
      description: form.description,
      scientificName: form.scientificName || undefined,
      categoryId: Number(form.categoryId),
      sunlight: form.sunlight || undefined,
      watering: form.watering || undefined,
      soilType: form.soilType || undefined,
      matureHeight: form.matureHeight || undefined,
      climateZone: form.climateZone || undefined,
      growthRate: form.growthRate || undefined,
      bloomSeason: form.bloomSeason || undefined,
      keyBenefits: form.keyBenefits.split("\n").map((s: string) => s.trim()).filter(Boolean),
      bestFor: form.bestFor.split("\n").map((s: string) => s.trim()).filter(Boolean),
      careTips: form.careTips.split("\n").map((s: string) => s.trim()).filter(Boolean),
      homepageTag: form.homepageTag || null,
      images: String(form.images).split(",").map((s) => s.trim()).filter(Boolean),
      videoUrl: form.videoUrl ?? "",
    };

    const invalidateAll = () => {
      qc.invalidateQueries({ queryKey: getGetFeaturedProductsQueryKey() });
      qc.invalidateQueries({ queryKey: getGetHomepageProductsQueryKey() });
      qc.invalidateQueries({ queryKey: ["products", "tag-counts"] });
      onClose();
    };

    const updateCacheAndClose = (updatedProduct: any) => {
      onProductUpdated?.(updatedProduct);
      qc.setQueriesData(
        { queryKey: ["/api/products"] },
        (old: any) => {
          if (!old?.products) return old;
          return {
            ...old,
            products: old.products.map((p: any) =>
              p.id === updatedProduct.id ? { ...p, ...updatedProduct } : p
            ),
          };
        }
      );
      invalidateAll();
    };

    if (product) {
      updateProduct.mutate({ id: product.id, data }, { onSuccess: updateCacheAndClose });
    } else {
      createProduct.mutate({ data }, { onSuccess: invalidateAll });
    }
  }

  const parentCats = categories.filter((cat: any) => !cat.parentId);
  const subcategoryOptions = categories.filter(
    (cat: any) => cat.parentId && String(cat.parentId) === form.parentCategory
  );
  // A chosen top-level category with no subcategories has nothing to drill
  // into (e.g. "Indoor Plants") -- treat it as a leaf and let products
  // attach directly to it instead of forcing a subcategory pick.
  const selectedParentIsLeaf = !!form.parentCategory && subcategoryOptions.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b sticky top-0 bg-white rounded-t-2xl z-10">
          <h2 className="font-semibold text-lg">{product ? "Edit Product" : "Add New Product"}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">Product Name *</Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required className="mt-1.5 rounded-xl" placeholder="e.g. Alphonso Mango" />
            </div>
            <div>
              <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">Category *</Label>
              <Select
                value={form.parentCategory || ""}
                onValueChange={v => {
                  // If the newly picked category turns out to have no
                  // subcategories, it's a leaf -- select it directly as the
                  // product's categoryId rather than waiting on a subcategory pick.
                  const hasSubs = categories.some((cat: any) => cat.parentId && String(cat.parentId) === v);
                  setForm(f => ({ ...f, parentCategory: v, categoryId: hasSubs ? "" : v }));
                }}
              >
                <SelectTrigger className="mt-1.5 rounded-xl"><SelectValue placeholder="Select category" /></SelectTrigger>
                <SelectContent>
                  {parentCats.map((cat: any) => (
                    <SelectItem key={cat.id} value={String(cat.id)}>{cat.icon ? cat.icon + " " : ""}{cat.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!selectedParentIsLeaf && (
              <div>
                <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">Subcategory *</Label>
                <Select value={form.categoryId} onValueChange={v => setForm(f => ({ ...f, categoryId: v }))} disabled={!form.parentCategory}>
                  <SelectTrigger className="mt-1.5 rounded-xl"><SelectValue placeholder="Select subcategory" /></SelectTrigger>
                  <SelectContent>
                    {subcategoryOptions.map((cat: any) => (
                      <SelectItem key={cat.id} value={String(cat.id)}>{cat.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {selectedParentIsLeaf && (
              <div className="flex items-end">
                <p className="text-xs text-muted-foreground mb-2.5">
                  "{parentCats.find((c: any) => String(c.id) === form.parentCategory)?.name}" has no subcategories, so this product will be added directly under it.
                </p>
              </div>
            )}
            <div>
              <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">Scientific Name</Label>
              <Input value={form.scientificName} onChange={e => setForm(f => ({ ...f, scientificName: e.target.value }))} className="mt-1.5 rounded-xl" placeholder="e.g. Mangifera indica" />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">Homepage Section</Label>
              <Select value={form.homepageTag || "none"} onValueChange={v => setForm(f => ({ ...f, homepageTag: v === "none" ? "" : v }))}>
                <SelectTrigger className="mt-1.5 rounded-xl"><SelectValue placeholder="Not on homepage" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not on homepage</SelectItem>
                  <SelectItem value="trending">🔥 Trending ({tagCounts?.["trending"] ?? 0}/22)</SelectItem>
                  <SelectItem value="new_arrivals">✨ New Arrivals ({tagCounts?.["new_arrivals"] ?? 0}/22)</SelectItem>
                  {sectionsLoading ? (
                    <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> Loading sections…
                    </div>
                  ) : (
                    homepageSections.map(section => (
                      <SelectItem key={section.key} value={section.key}>
                        🌿 {section.label} ({tagCounts?.[section.key] ?? 0}/22)
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {/* Add new section — outside SelectContent to avoid Radix focus/keyboard conflict */}
              {showAddSection ? (
                <div className="flex items-center gap-2 mt-2 w-full min-w-0">
                  <Input
                    autoFocus
                    className="rounded-xl text-sm flex-1 min-w-0 w-full"
                    placeholder="e.g. Fruit Trees"
                    value={addingSectionLabel}
                    onChange={e => setAddingSectionLabel(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleAddSection(); if (e.key === "Escape") { setShowAddSection(false); setAddingSectionLabel(""); } }}
                  />
                  <Button type="button" size="sm" onClick={handleAddSection} disabled={addingSection || !addingSectionLabel.trim()} className="rounded-xl shrink-0">
                    {addingSection ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => { setShowAddSection(false); setAddingSectionLabel(""); }} className="rounded-xl shrink-0 px-2">
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowAddSection(true)}
                  className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Plus className="h-3 w-3" /> Add new section
                </button>
              )}
            </div>
          </div>

          <div>
            <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">Description *</Label>
            <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} required className="mt-1.5 rounded-xl" rows={3} placeholder="Product description..." />
          </div>

          <div className="border rounded-xl p-4 bg-muted/20 space-y-3">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Care Info</Label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">Sunlight</Label>
                <select
                  value={form.sunlight}
                  onChange={e => setForm(f => ({ ...f, sunlight: e.target.value }))}
                  className="w-full mt-1 h-9 rounded-lg border border-input px-3 text-sm bg-background"
                >
                  <option value="">Not specified</option>
                  <option value="full_sun">Full Sun</option>
                  <option value="partial_shade">Partial Shade</option>
                  <option value="full_shade">Full Shade</option>
                </select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Watering</Label>
                <Input value={form.watering} onChange={e => setForm(f => ({ ...f, watering: e.target.value }))} className="rounded-lg mt-1 h-9 text-sm" placeholder="e.g. Water regularly during the first year, then only during dry periods" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Growth Rate</Label>
                <select
                  value={form.growthRate}
                  onChange={e => setForm(f => ({ ...f, growthRate: e.target.value }))}
                  className="w-full mt-1 h-9 rounded-lg border border-input px-3 text-sm bg-background"
                >
                  <option value="">Not specified</option>
                  <option value="slow">Slow</option>
                  <option value="moderate">Moderate</option>
                  <option value="fast">Fast</option>
                </select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Soil Type</Label>
                <Input value={form.soilType} onChange={e => setForm(f => ({ ...f, soilType: e.target.value }))} className="rounded-lg mt-1 h-9 text-sm" placeholder="e.g. Well-drained loamy soil" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Mature Height</Label>
                <Input value={form.matureHeight} onChange={e => setForm(f => ({ ...f, matureHeight: e.target.value }))} className="rounded-lg mt-1 h-9 text-sm" placeholder="e.g. 15-20 ft" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Climate Zone</Label>
                <Input value={form.climateZone} onChange={e => setForm(f => ({ ...f, climateZone: e.target.value }))} className="rounded-lg mt-1 h-9 text-sm" placeholder="e.g. Zone 9-11" />
              </div>
              <div className="col-span-2">
                <Label className="text-xs text-muted-foreground">Bloom / Fruit Season</Label>
                <Input value={form.bloomSeason} onChange={e => setForm(f => ({ ...f, bloomSeason: e.target.value }))} className="rounded-lg mt-1 h-9 text-sm" placeholder="e.g. Spring, Year-round" />
              </div>
            </div>
          </div>

          <div>
            <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">Key Benefits (one per line)</Label>
            <Textarea
              value={form.keyBenefits}
              onChange={e => setForm(f => ({ ...f, keyBenefits: e.target.value }))}
              className="mt-1.5 rounded-xl"
              rows={4}
              placeholder={"Fast fruiting\nDrought tolerant once established\nAttracts pollinators"}
            />
          </div>

          <div>
            <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">Best For (one per line)</Label>
            <Textarea
              value={form.bestFor}
              onChange={e => setForm(f => ({ ...f, bestFor: e.target.value }))}
              className="mt-1.5 rounded-xl"
              rows={3}
              placeholder={"Home gardens\nBalcony pots\nOrchards"}
            />
          </div>

          <div>
            <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">Care Tips (one per line)</Label>
            <Textarea
              value={form.careTips}
              onChange={e => setForm(f => ({ ...f, careTips: e.target.value }))}
              className="mt-1.5 rounded-xl"
              rows={3}
              placeholder={"Water deeply once a week\nPrune after fruiting season\nApply mulch in winter"}
            />
          </div>

          <div>
            <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">Product Images</Label>
            <div className="mt-1.5 space-y-2">
              <div className="flex gap-2">
                <input type="file" accept="image/*" multiple id="product-image-upload" className="hidden"
                  onChange={async (e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (!files.length) return;
                    const currentCount = form.images ? String(form.images).split(",").filter((s: string) => s.trim()).length : 0;
                    if (currentCount + files.length > 4) { alert("Maximum 4 images allowed per product"); return; }
                    const fd = new FormData();
                    files.forEach((f: File) => fd.append("images", f));
                    if (form.name) fd.append("productName", String(form.name));
                    const existingCount = form.images ? String(form.images).split(",").filter((s: string) => s.trim()).length : 0;
                    fd.append("startIndex", String(existingCount));
                    try {
                      const token = await getToken();
                      if (!token) { alert("Not logged in"); return; }
                      const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/products/upload-image`, {
                        method: "POST",
                        headers: { "Authorization": `Bearer ${token}` },
                        body: fd,
                      });
                      if (!res.ok) { const err = await res.json(); alert("Upload error: " + (err.details || err.error)); return; }
                      const data = await res.json();
                      if (data.urls?.length) {
                        setForm((f: any) => ({ ...f, images: [f.images, ...data.urls].filter(Boolean).join(", ") }));
                      }
                    } catch (err) { alert("Upload failed: " + String(err)); }
                  }}
                />
                <Button type="button" variant="outline" className="rounded-xl flex-1"
                  onClick={() => document.getElementById("product-image-upload")?.click()}>
                  📁 Upload Images from Device
                </Button>
              </div>
              {form.images && (
                <div className="flex flex-wrap gap-2">
                  {String(form.images).split(",").map((url, i) => url.trim() && (
                    <div key={i} className="relative">
                      <img src={url.trim()} className="h-16 w-16 object-cover rounded-lg border" />
                      <button type="button" className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 text-xs flex items-center justify-center"
                        onClick={() => setForm(f => ({ ...f, images: String(f.images).split(",").filter((_, j) => j !== i).join(", ") }))}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <Input value={form.images} onChange={e => setForm(f => ({ ...f, images: e.target.value }))} className="rounded-xl text-xs" placeholder="Or paste image URLs here..." />
            </div>
          </div>

          <div>
            <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">YouTube Video URL (optional)</Label>
            <Input value={form.videoUrl ?? ""} onChange={e => setForm(f => ({ ...f, videoUrl: e.target.value }))} className="mt-1.5 rounded-xl" placeholder="https://www.youtube.com/watch?v=..." />
          </div>

          <div className="flex gap-3 pt-2">
            <Button type="submit" disabled={createProduct.isPending || updateProduct.isPending} className="flex-1 rounded-xl bg-pink-500 hover:bg-pink-600 text-white">
              {product ? "Update Product" : "Create Product"}
            </Button>
            <Button type="button" variant="outline" onClick={onClose} className="rounded-xl">Cancel</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
