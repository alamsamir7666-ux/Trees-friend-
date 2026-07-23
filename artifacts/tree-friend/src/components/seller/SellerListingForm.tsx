import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Search, X, Loader2, Upload, Plus, Trash2 } from "lucide-react";
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

/**
 * One repeatable variant block's local form state (Phase 3a: variant-level
 * fields moved off the listing, see PHASE2_HANDOFF.md). `key` is a stable
 * local identifier for React list rendering/removal -- it is NEVER sent to
 * the API. `id` is the real sellerListingVariantsTable id and is only
 * present for a variant that already exists on the server (loaded from
 * `editing.variants`); a block created via "Add another variant" in this
 * session has `id: undefined`. That id/no-id distinction is exactly what
 * submit uses to decide update-existing vs. create-new, mirroring the PUT
 * handler's own convention (see handleSubmit below).
 */
type VariantDraft = {
  key: string;
  id?: number;
  form: string;
  height: string;
  potSize: string;
  age: string;
  rootType: string;
  condition: string;
  price: string;
  discountPrice: string;
  stock: string;
  deliveryCharge: string;
  isPreOrder: boolean;
};

let nextDraftKey = 0;
function newDraftKey(): string {
  nextDraftKey += 1;
  return `new-${nextDraftKey}`;
}

function emptyVariantDraft(): VariantDraft {
  return {
    key: newDraftKey(),
    form: "",
    height: "",
    potSize: "",
    age: "",
    rootType: "",
    condition: "",
    price: "",
    discountPrice: "",
    stock: "0",
    deliveryCharge: "0",
    isPreOrder: false,
  };
}

function variantDraftFromVariant(v: SellerListing["variants"][number]): VariantDraft {
  return {
    key: `existing-${v.id}`,
    id: v.id,
    form: v.form ?? "",
    height: v.height ?? "",
    potSize: v.potSize ?? "",
    age: v.age ?? "",
    rootType: v.rootType ?? "",
    condition: v.condition ?? "",
    price: String(v.price),
    discountPrice: v.discountPrice != null ? String(v.discountPrice) : "",
    stock: String(v.stock),
    deliveryCharge: String(v.deliveryCharge ?? 0),
    isPreOrder: v.isPreOrder === true,
  };
}

/** Listing-level-only form state (Phase 3a). */
type Draft = {
  productId: number | null;
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
 * Create/edit form for a single seller_listings row, now representing ONE
 * listing containing MULTIPLE variant blocks (Phase 3a, see
 * PHASE2_HANDOFF.md -- price/stock/form/etc. moved to
 * sellerListingVariantsTable). `editing` is passed for update, omitted for
 * create; `onDone` is called after a successful save so the parent
 * (SellerDashboardPage) can close the form and refresh the inventory list.
 */
export function SellerListingForm({ editing, onDone, onCancel }: { editing?: SellerListing; onDone: () => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const { getToken } = useAuth();
  const [product, setProduct] = useState<Product | null>(null);
  const [draft, setDraft] = useState<Draft>(editing ? draftFromListing(editing) : EMPTY_DRAFT);
  const [uploading, setUploading] = useState(false);

  // Variant blocks for this listing. For edit mode, seeded from
  // editing.variants (the nested array Part 0's codegen fix now returns) --
  // each carries its real `id` so submit can tell the API which to update.
  // For create mode, start with a single empty block so the seller always
  // has at least one to fill in (mirrors the backend's ">=1 variant" rule).
  const [variants, setVariants] = useState<VariantDraft[]>(() =>
    editing && editing.variants.length > 0
      ? editing.variants.map(variantDraftFromVariant)
      : [emptyVariantDraft()],
  );
  // Existing (has an id) variants the seller removed from the form this
  // session. Tracked separately from `variants` rather than just filtering
  // them out of that array, because the PUT request needs their ids sent
  // back explicitly as `deletedVariantIds` -- simply omitting them from
  // `variants` would NOT delete them (PUT only touches variants it's told
  // about; anything not mentioned is left alone).
  const [deletedVariantIds, setDeletedVariantIds] = useState<number[]>([]);
  const [variantsError, setVariantsError] = useState("");

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

  function setVariantField<K extends keyof VariantDraft>(variantKey: string, key: K, value: VariantDraft[K]) {
    setVariants((prev) => prev.map((v) => (v.key === variantKey ? { ...v, [key]: value } : v)));
  }

  function addVariant() {
    setVariants((prev) => [...prev, emptyVariantDraft()]);
  }

  function removeVariant(variantKey: string) {
    setVariants((prev) => {
      const target = prev.find((v) => v.key === variantKey);
      const next = prev.filter((v) => v.key !== variantKey);
      // An existing (server-side) variant being removed needs to go on
      // deletedVariantIds so the PUT request actually deletes it -- see
      // the doc comment on the deletedVariantIds state above.
      if (target?.id != null) {
        setDeletedVariantIds((ids) => [...ids, target.id!]);
      }
      return next;
    });
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

  function validateVariantsLocally(): string | null {
    if (variants.length === 0) return "At least one variant (e.g. Seed, Sapling, Grafted, Potted) is required";
    for (const v of variants) {
      const label = v.form || "this variant";
      if (!v.price || isNaN(Number(v.price)) || Number(v.price) <= 0) return `A valid price is required for ${label}`;
      if (v.discountPrice && Number(v.discountPrice) >= Number(v.price)) return `Discount price must be less than regular price for ${label}`;
    }
    return null;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing && !draft.productId) {
      toast.error("Select a variety to list against");
      return;
    }
    const variantIssue = validateVariantsLocally();
    if (variantIssue) {
      setVariantsError(variantIssue);
      return;
    }
    setVariantsError("");

    const listingFields = {
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
      // Update: send every variant block back with its id if it has one
      // (partial update of an existing variant) or without one (create a
      // new variant under this listing), plus deletedVariantIds for any
      // removed this session -- mirrors the PUT handler's documented
      // "update some, create some, delete some in one request" shape.
      const body = {
        ...listingFields,
        variants: variants.map((v) => ({
          ...(v.id != null ? { id: v.id } : {}),
          form: v.form || undefined,
          height: v.height || undefined,
          potSize: v.potSize || undefined,
          age: v.age || undefined,
          rootType: v.rootType || undefined,
          condition: v.condition || undefined,
          price: Number(v.price),
          discountPrice: v.discountPrice ? Number(v.discountPrice) : undefined,
          stock: Number(v.stock || 0),
          deliveryCharge: Number(v.deliveryCharge || 0),
          isPreOrder: v.isPreOrder,
        })),
        deletedVariantIds: deletedVariantIds.length > 0 ? deletedVariantIds : undefined,
      };
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
      // Create: every block is new, so no ids are ever sent.
      const body = {
        ...listingFields,
        productId: draft.productId!,
        variants: variants.map((v) => ({
          form: v.form || undefined,
          height: v.height || undefined,
          potSize: v.potSize || undefined,
          age: v.age || undefined,
          rootType: v.rootType || undefined,
          condition: v.condition || undefined,
          price: Number(v.price),
          discountPrice: v.discountPrice ? Number(v.discountPrice) : undefined,
          stock: Number(v.stock || 0),
          deliveryCharge: Number(v.deliveryCharge || 0),
          isPreOrder: v.isPreOrder,
        })),
      };
      createListing.mutate(
        { data: body },
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
          <Label className="text-xs text-muted-foreground">Delivery Time (days)</Label>
          <Input type="number" value={draft.deliveryTimeDays} onChange={(e) => set("deliveryTimeDays", e.target.value)} placeholder="Optional" className="mt-1 h-9 rounded-lg text-sm" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Warranty (days)</Label>
          <Input type="number" value={draft.warrantyDays} onChange={(e) => set("warrantyDays", e.target.value)} placeholder="Optional" className="mt-1 h-9 rounded-lg text-sm" />
        </div>
        <div className="col-span-2">
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

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Variants *</Label>
          <Button type="button" variant="outline" size="sm" className="rounded-full h-7 text-xs gap-1" onClick={addVariant}>
            <Plus className="h-3 w-3" /> Add another variant
          </Button>
        </div>
        <p className="text-xs text-muted-foreground -mt-1">
          Each variant is a separately priced/stocked option under this listing (e.g. Seed, Sapling, Grafted). A listing needs at least one.
        </p>

        {variants.map((v, i) => (
          <div key={v.key} className="border rounded-xl p-4 space-y-3 bg-muted/10">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Variant {i + 1}</p>
              {variants.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeVariant(v.key)}
                  className="text-muted-foreground hover:text-destructive transition-colors"
                  aria-label="Remove this variant"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">Form</Label>
                <select value={v.form} onChange={(e) => setVariantField(v.key, "form", e.target.value)} className="w-full mt-1 h-9 rounded-lg border border-input px-3 text-sm bg-background">
                  <option value="">Not specified</option>
                  <option value="seed">Seed</option>
                  <option value="sapling">Sapling</option>
                  <option value="grafted">Grafted</option>
                  <option value="potted">Potted</option>
                </select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Condition</Label>
                <Input value={v.condition} onChange={(e) => setVariantField(v.key, "condition", e.target.value)} placeholder="e.g. Healthy, disease-free" className="mt-1 h-9 rounded-lg text-sm" />
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
                    value={v[f.key]}
                    onChange={(val) => setVariantField(v.key, f.key, val)}
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
                <Input type="number" value={v.price} onChange={(e) => setVariantField(v.key, "price", e.target.value)} placeholder="0" className="mt-1 h-9 rounded-lg text-sm" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Discount Price (Tk)</Label>
                <Input type="number" value={v.discountPrice} onChange={(e) => setVariantField(v.key, "discountPrice", e.target.value)} placeholder="Optional" className="mt-1 h-9 rounded-lg text-sm" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Stock</Label>
                <Input type="number" value={v.stock} onChange={(e) => setVariantField(v.key, "stock", e.target.value)} placeholder="0" className="mt-1 h-9 rounded-lg text-sm" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Delivery Charge (Tk)</Label>
                <Input type="number" value={v.deliveryCharge} onChange={(e) => setVariantField(v.key, "deliveryCharge", e.target.value)} placeholder="0" className="mt-1 h-9 rounded-lg text-sm" />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={v.isPreOrder}
                onChange={(e) => setVariantField(v.key, "isPreOrder", e.target.checked)}
                className="rounded border-input"
              />
              <span className="text-muted-foreground">Available for pre-order</span>
            </label>
          </div>
        ))}
        {variantsError && <p className="text-xs text-destructive">{variantsError}</p>}
      </div>

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
