import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Search, X, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useListProducts,
  useListListingAttributeOptions,
  useCreateSellerListing,
  useUpdateSellerListing,
  getListMySellerListingsQueryKey,
  type Product,
  type SellerListing,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const PAYMENT_METHODS = [
  { value: "cod", label: "Cash on Delivery" },
  { value: "advance", label: "Advance Payment (bKash)" },
  { value: "both", label: "Both" },
];

// Comparison-critical attributes (plan doc §3a) -- rendered as dropdowns
// sourced from listing_attribute_options for the selected variety's
// category, not free text. condition/description/etc. stay free text below.
const CONTROLLED_FIELDS = [
  { key: "height", attributeName: "height", label: "Height" },
  { key: "potSize", attributeName: "pot_size", label: "Pot Size" },
  { key: "age", attributeName: "age", label: "Age" },
  { key: "rootType", attributeName: "root_type", label: "Root Type" },
] as const;

type Draft = {
  productId: number | null;
  form: string;
  height: string;
  potSize: string;
  age: string;
  rootType: string;
  condition: string;
  price: string;
  discountPrice: string;
  stock: string;
  deliveryTimeDays: string;
  warrantyDays: string;
  returnPolicyText: string;
  paymentMethod: string;
  images: string[];
  videoUrl: string;
  description: string;
  offerText: string;
  certification: string;
  tags: string;
};

function draftFromListing(l: SellerListing): Draft {
  return {
    productId: l.productId,
    form: l.form ?? "",
    height: l.height ?? "",
    potSize: l.potSize ?? "",
    age: l.age ?? "",
    rootType: l.rootType ?? "",
    condition: l.condition ?? "",
    price: String(l.price),
    discountPrice: l.discountPrice != null ? String(l.discountPrice) : "",
    stock: String(l.stock),
    deliveryTimeDays: l.deliveryTimeDays != null ? String(l.deliveryTimeDays) : "",
    warrantyDays: l.warrantyDays != null ? String(l.warrantyDays) : "",
    returnPolicyText: l.returnPolicyText ?? "",
    paymentMethod: l.paymentMethod,
    images: l.images,
    videoUrl: l.videoUrl ?? "",
    description: l.description ?? "",
    offerText: l.offerText ?? "",
    certification: l.certification ?? "",
    tags: l.tags.join(", "),
  };
}

const EMPTY_DRAFT: Draft = {
  productId: null,
  form: "",
  height: "",
  potSize: "",
  age: "",
  rootType: "",
  condition: "",
  price: "",
  discountPrice: "",
  stock: "0",
  deliveryTimeDays: "",
  warrantyDays: "",
  returnPolicyText: "",
  paymentMethod: "cod",
  images: [],
  videoUrl: "",
  description: "",
  offerText: "",
  certification: "",
  tags: "",
};

/**
 * Single-variety picker (search-as-you-type against the admin-owned
 * products/varieties list). A seller creates a listing AGAINST an existing
 * variety, never a new one (plan doc §1.6), so this is intentionally
 * read-only search, not a create-product flow.
 */
function ProductPicker({
  selected,
  onSelect,
  disabled,
}: {
  selected: Product | null;
  onSelect: (p: Product | null) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const { data, isFetching } = useListProducts(
    { search: query.trim(), limit: 8 },
    { query: { enabled: query.trim().length > 1 } } as any,
  );
  const results = data?.products ?? [];

  if (selected) {
    return (
      <div className="flex items-center gap-3 border rounded-xl p-2.5 bg-muted/20">
        {selected.images?.[0] ? (
          <img src={selected.images[0]} alt="" className="h-10 w-10 rounded-lg object-cover shrink-0" />
        ) : (
          <div className="h-10 w-10 rounded-lg bg-muted shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{selected.name}</p>
          {selected.scientificName && <p className="text-xs text-muted-foreground italic truncate">{selected.scientificName}</p>}
        </div>
        {!disabled && (
          <button type="button" onClick={() => onSelect(null)} className="text-muted-foreground hover:text-destructive shrink-0">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search varieties, e.g. Langra Mango"
          className="pl-9 rounded-xl"
        />
      </div>
      {query.trim().length > 1 && (
        <div className="mt-2 border rounded-xl overflow-hidden max-h-56 overflow-y-auto divide-y">
          {isFetching ? (
            <div className="p-3 text-sm text-muted-foreground">Searching…</div>
          ) : results.length === 0 ? (
            <div className="p-3 text-sm text-muted-foreground">No varieties found. Only admin-created varieties can be listed against.</div>
          ) : (
            results.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelect(p)}
                className="w-full flex items-center gap-3 p-2.5 text-left hover:bg-muted/50 transition-colors"
              >
                {p.images?.[0] ? (
                  <img src={p.images[0]} alt="" className="h-9 w-9 rounded-lg object-cover shrink-0" />
                ) : (
                  <div className="h-9 w-9 rounded-lg bg-muted shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{p.name}</p>
                  {p.scientificName && <p className="text-xs text-muted-foreground italic truncate">{p.scientificName}</p>}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Renders a single controlled attribute as a dropdown sourced from
 * listing_attribute_options for the given category, or a plain disabled
 * hint if the category has no options configured yet for that attribute --
 * we do not fall back to a free-text input, since that would let a seller
 * bypass the exact validation the API enforces (plan doc §3a: "Enforce at
 * the API layer... Sellers can call the API directly and bypass client-side
 * dropdown constraints otherwise" -- the corollary is the UI shouldn't
 * offer an input that the API will just reject anyway).
 */
function ControlledAttributeSelect({
  categoryId,
  attributeName,
  label,
  value,
  onChange,
}: {
  categoryId: number;
  attributeName: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { data: options, isLoading } = useListListingAttributeOptions(categoryId, { attributeName: attributeName as any });

  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {isLoading ? (
        <div className="h-9 mt-1 rounded-lg border bg-muted/30 animate-pulse" />
      ) : !options || options.length === 0 ? (
        <p className="text-xs text-muted-foreground mt-1.5 border rounded-lg px-3 py-2 bg-muted/20">
          No {label.toLowerCase()} options configured for this variety's category yet — ask admin to add some.
        </p>
      ) : (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full mt-1 h-9 rounded-lg border border-input px-3 text-sm bg-background"
        >
          <option value="">Not specified</option>
          {options.map((o) => (
            <option key={o.id} value={o.value}>{o.value}</option>
          ))}
        </select>
      )}
    </div>
  );
}

/**
 * Create/edit form for a single seller_listings row. `editing` is passed
 * for update, omitted for create; `onDone` is called after a successful
 * save so the parent (SellerDashboardPage) can close the form and refresh
 * the inventory list.
 */
export function SellerListingForm({ editing, onDone, onCancel }: { editing?: SellerListing; onDone: () => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const { getToken } = useAuth();
  const [product, setProduct] = useState<Product | null>(null);
  const [draft, setDraft] = useState<Draft>(editing ? draftFromListing(editing) : EMPTY_DRAFT);
  const [uploading, setUploading] = useState(false);

  const createListing = useCreateSellerListing();
  const updateListing = useUpdateSellerListing();
  const saving = createListing.isPending || updateListing.isPending;

  // When editing, we only have productId, not the full Product -- resolve
  // it directly by id so the ProductPicker and category-scoped attribute
  // dropdowns can render without a name-based search round-trip.
  useEffect(() => {
    if (!editing || product) return;
    (async () => {
      try {
        const base = import.meta.env.VITE_API_BASE_URL ?? "";
        const res = await fetch(`${base}/api/products/${editing.productId}`);
        if (res.ok) setProduct(await res.json());
      } catch {
        // Non-fatal -- form still works, just without the category-scoped
        // dropdowns until product resolves.
      }
    })();
  }, [editing]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function handleImageUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const token = await getToken();
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append("images", f));
      const base = import.meta.env.VITE_API_BASE_URL ?? "";
      const res = await fetch(`${base}/api/seller-listings/upload-image`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      set("images", [...draft.images, ...(data.urls ?? [])]);
    } catch {
      toast.error("Image upload failed");
    } finally {
      setUploading(false);
    }
  }

  function removeImage(url: string) {
    set("images", draft.images.filter((i) => i !== url));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing && !draft.productId) {
      toast.error("Select a variety to list against");
      return;
    }
    if (!draft.price || isNaN(Number(draft.price)) || Number(draft.price) <= 0) {
      toast.error("Enter a valid price");
      return;
    }

    const body = {
      form: draft.form || undefined,
      height: draft.height || undefined,
      potSize: draft.potSize || undefined,
      age: draft.age || undefined,
      rootType: draft.rootType || undefined,
      condition: draft.condition || undefined,
      price: Number(draft.price),
      discountPrice: draft.discountPrice ? Number(draft.discountPrice) : undefined,
      stock: Number(draft.stock || 0),
      deliveryTimeDays: draft.deliveryTimeDays ? Number(draft.deliveryTimeDays) : undefined,
      warrantyDays: draft.warrantyDays ? Number(draft.warrantyDays) : undefined,
      returnPolicyText: draft.returnPolicyText || undefined,
      paymentMethod: draft.paymentMethod as "cod" | "advance" | "both",
      images: draft.images,
      videoUrl: draft.videoUrl || undefined,
      description: draft.description || undefined,
      offerText: draft.offerText || undefined,
      certification: draft.certification || undefined,
      tags: draft.tags.split(",").map((t) => t.trim()).filter(Boolean),
    };

    if (editing) {
      updateListing.mutate(
        { id: editing.id, data: body },
        {
          onSuccess: () => {
            qc.invalidateQueries({ queryKey: getListMySellerListingsQueryKey() });
            toast.success("Listing updated");
            onDone();
          },
          onError: (err: any) => toast.error(err?.message ?? "Failed to update listing"),
        },
      );
    } else {
      createListing.mutate(
        { data: { ...body, productId: draft.productId! } },
        {
          onSuccess: () => {
            qc.invalidateQueries({ queryKey: getListMySellerListingsQueryKey() });
            toast.success("Listing created — pending admin approval");
            onDone();
          },
          onError: (err: any) => toast.error(err?.message ?? "Failed to create listing"),
        },
      );
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-card border rounded-2xl p-6">
      <div>
        <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Variety *</Label>
        <div className="mt-1.5">
          <ProductPicker selected={product} onSelect={(p) => { setProduct(p); set("productId", p?.id ?? null); }} disabled={!!editing} />
        </div>
        {editing && <p className="text-xs text-muted-foreground mt-1">The variety a listing is against can't be changed after creation.</p>}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">Form</Label>
          <select value={draft.form} onChange={(e) => set("form", e.target.value)} className="w-full mt-1 h-9 rounded-lg border border-input px-3 text-sm bg-background">
            <option value="">Not specified</option>
            <option value="seed">Seed</option>
            <option value="sapling">Sapling</option>
            <option value="grafted">Grafted</option>
            <option value="potted">Potted</option>
          </select>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Condition</Label>
          <Input value={draft.condition} onChange={(e) => set("condition", e.target.value)} placeholder="e.g. Healthy, disease-free" className="mt-1 h-9 rounded-lg text-sm" />
        </div>
      </div>

      {product ? (
        <div className="grid grid-cols-2 gap-3">
          {CONTROLLED_FIELDS.map((f) => (
            <ControlledAttributeSelect
              key={f.key}
              categoryId={product.categoryId}
              attributeName={f.attributeName}
              label={f.label}
              value={draft[f.key]}
              onChange={(v) => set(f.key, v)}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground border rounded-lg px-3 py-2 bg-muted/20">
          Select a variety above to set Height, Pot Size, Age, and Root Type — these come from a fixed list per category, not free text.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">Price (Tk) *</Label>
          <Input type="number" value={draft.price} onChange={(e) => set("price", e.target.value)} placeholder="0" className="mt-1 h-9 rounded-lg text-sm" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Discount Price (Tk)</Label>
          <Input type="number" value={draft.discountPrice} onChange={(e) => set("discountPrice", e.target.value)} placeholder="Optional" className="mt-1 h-9 rounded-lg text-sm" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Stock</Label>
          <Input type="number" value={draft.stock} onChange={(e) => set("stock", e.target.value)} placeholder="0" className="mt-1 h-9 rounded-lg text-sm" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Delivery Time (days)</Label>
          <Input type="number" value={draft.deliveryTimeDays} onChange={(e) => set("deliveryTimeDays", e.target.value)} placeholder="Optional" className="mt-1 h-9 rounded-lg text-sm" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Warranty (days)</Label>
          <Input type="number" value={draft.warrantyDays} onChange={(e) => set("warrantyDays", e.target.value)} placeholder="Optional" className="mt-1 h-9 rounded-lg text-sm" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Payment Method</Label>
          <select value={draft.paymentMethod} onChange={(e) => set("paymentMethod", e.target.value)} className="w-full mt-1 h-9 rounded-lg border border-input px-3 text-sm bg-background">
            {PAYMENT_METHODS.map((m) => (<option key={m.value} value={m.value}>{m.label}</option>))}
          </select>
        </div>
      </div>
      <p className="text-xs text-amber-600 -mt-1">
        Advance payment requires a verified bKash merchant account (Payment Settings tab). Saving credentials
        there isn't enough by itself — an admin has to verify the account first, so selecting advance/both here
        will be rejected until that happens.
      </p>

      <div>
        <Label className="text-xs text-muted-foreground">Return Policy</Label>
        <Textarea value={draft.returnPolicyText} onChange={(e) => set("returnPolicyText", e.target.value)} rows={2} className="mt-1" placeholder="Optional" />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Description</Label>
        <Textarea value={draft.description} onChange={(e) => set("description", e.target.value)} rows={3} className="mt-1" placeholder="Optional" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">Special Offer Text</Label>
          <Input value={draft.offerText} onChange={(e) => set("offerText", e.target.value)} placeholder="Optional" className="mt-1 h-9 rounded-lg text-sm" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Certification</Label>
          <Input value={draft.certification} onChange={(e) => set("certification", e.target.value)} placeholder="Optional" className="mt-1 h-9 rounded-lg text-sm" />
        </div>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Tags (comma-separated)</Label>
        <Input value={draft.tags} onChange={(e) => set("tags", e.target.value)} placeholder="e.g. organic, best-seller" className="mt-1 h-9 rounded-lg text-sm" />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Video URL</Label>
        <Input value={draft.videoUrl} onChange={(e) => set("videoUrl", e.target.value)} placeholder="Optional" className="mt-1 h-9 rounded-lg text-sm" />
      </div>

      <div>
        <Label className="text-xs text-muted-foreground">Images</Label>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {draft.images.map((url) => (
            <div key={url} className="relative">
              <img src={url} alt="" className="h-16 w-16 rounded-lg object-cover border" />
              <button type="button" onClick={() => removeImage(url)} className="absolute -top-1.5 -right-1.5 bg-black/60 hover:bg-black/80 text-white rounded-full p-0.5">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <label className="h-16 w-16 rounded-lg border-2 border-dashed flex items-center justify-center cursor-pointer text-muted-foreground hover:bg-muted/30 transition-colors">
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            <input type="file" accept="image/*" multiple className="hidden" disabled={uploading} onChange={(e) => handleImageUpload(e.target.files)} />
          </label>
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <Button type="submit" className="flex-1 rounded-full" disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : editing ? "Save Changes" : "Create Listing"}
        </Button>
        <Button type="button" variant="outline" className="rounded-full" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
