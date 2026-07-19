import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type VariantDraft = {
  form: string;
  name: string;
  price: string;
  discountPrice: string;
  stock: string;
  deliveryCharge: string;
  sku: string;
};

const FORM_OPTIONS = [
  { value: "seed", label: "Seed" },
  { value: "sapling", label: "Sapling" },
  { value: "grafted", label: "Grafted" },
  { value: "potted", label: "Potted" },
];

export function emptyVariantDraft(): VariantDraft {
  return { form: "sapling", name: "Sapling", price: "", discountPrice: "", stock: "0", deliveryCharge: "0", sku: "" };
}

export function VariantEditor({ variants, onChange }: { variants: VariantDraft[]; onChange: (v: VariantDraft[]) => void }) {
  function addVariant() {
    onChange([...variants, emptyVariantDraft()]);
  }

  function removeVariant(idx: number) {
    onChange(variants.filter((_, i) => i !== idx));
  }

  function updateVariant(idx: number, patch: Partial<VariantDraft>) {
    onChange(variants.map((v, i) => (i === idx ? { ...v, ...patch } : v)));
  }

  function handleFormChange(idx: number, form: string) {
    const label = FORM_OPTIONS.find(o => o.value === form)?.label ?? form;
    const current = variants[idx];
    const prevLabel = FORM_OPTIONS.find(o => o.value === current.form)?.label ?? current.form;
    const nameWasAutoFilled = current.name === prevLabel;
    updateVariant(idx, { form, name: nameWasAutoFilled ? label : current.name });
  }

  return (
    <div className="border rounded-xl p-4 bg-muted/20 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Variants *</Label>
          <p className="text-xs text-muted-foreground">At least one required. Each form (Seed, Sapling, Grafted, Potted) has its own price, stock, and delivery charge.</p>
        </div>
        <Button type="button" size="sm" onClick={addVariant} className="rounded-lg bg-pink-500 hover:bg-pink-600 text-white shrink-0">
          <Plus className="h-3.5 w-3.5 mr-1" /> Add Variant
        </Button>
      </div>

      {variants.length === 0 ? (
        <p className="text-xs text-destructive">Add at least one variant before saving — a product can't be sold without a price.</p>
      ) : (
        <div className="space-y-3">
          {variants.map((v, idx) => (
            <div key={idx} className="border rounded-lg p-3 bg-white space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Variant {idx + 1}</span>
                {variants.length > 1 && (
                  <button type="button" onClick={() => removeVariant(idx)} className="p-1 text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <Label className="text-xs text-muted-foreground">Form *</Label>
                  <select
                    value={v.form}
                    onChange={e => handleFormChange(idx, e.target.value)}
                    className="w-full mt-1 h-9 rounded-lg border border-input px-3 text-sm bg-background"
                  >
                    {FORM_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Display Name *</Label>
                  <Input
                    value={v.name}
                    onChange={e => updateVariant(idx, { name: e.target.value })}
                    placeholder="e.g. Grafted - 3ft"
                    className="rounded-lg mt-1 h-9 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Price (Tk) *</Label>
                  <Input
                    type="number"
                    value={v.price}
                    onChange={e => updateVariant(idx, { price: e.target.value })}
                    placeholder="0"
                    className="rounded-lg mt-1 h-9 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Sale Price (Tk)</Label>
                  <Input
                    type="number"
                    value={v.discountPrice}
                    onChange={e => updateVariant(idx, { discountPrice: e.target.value })}
                    placeholder="Optional"
                    className="rounded-lg mt-1 h-9 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Stock</Label>
                  <Input
                    type="number"
                    value={v.stock}
                    onChange={e => updateVariant(idx, { stock: e.target.value })}
                    placeholder="0"
                    className="rounded-lg mt-1 h-9 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Delivery Charge (Tk)</Label>
                  <Input
                    type="number"
                    value={v.deliveryCharge}
                    onChange={e => updateVariant(idx, { deliveryCharge: e.target.value })}
                    placeholder="0"
                    className="rounded-lg mt-1 h-9 text-sm"
                  />
                </div>
                <div className="col-span-2">
                  <Label className="text-xs text-muted-foreground">SKU</Label>
                  <Input
                    value={v.sku}
                    onChange={e => updateVariant(idx, { sku: e.target.value })}
                    placeholder="Optional"
                    className="rounded-lg mt-1 h-9 text-sm"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
