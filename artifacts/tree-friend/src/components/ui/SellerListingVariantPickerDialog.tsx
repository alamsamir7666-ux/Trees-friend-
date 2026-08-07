import { useState } from "react";
import type { SellerListingVariant } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

interface SellerListingVariantPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sellerName: string;
  variants: SellerListingVariant[];
  onConfirm: (variant: SellerListingVariant) => void;
}

/**
 * Buyer-facing variant picker for a SINGLE seller's listing (Phase 3b Part 2)
 * -- shown when "Add to Bag" is clicked on a seller card in
 * SellerListingsSection.tsx and that listing has more than one qualifying
 * variant. This is a fresh component, not an adaptation of the admin
 * VariantPickerDialog/VariantSelector pair -- those operate on
 * ProductVariant (admin's variantType/name-shaped fields), which
 * SellerListingVariant does not have. Only ever shown the QUALIFYING
 * variants (availableQuantity > 0) the caller passes in -- sold-out
 * variants on the same listing aren't offered as choices here.
 */
export function SellerListingVariantPickerDialog({
  open,
  onOpenChange,
  sellerName,
  variants,
  onConfirm,
}: SellerListingVariantPickerDialogProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null);

  function handleConfirm() {
    const variant = variants.find((v) => v.id === selectedId);
    if (!variant) return;
    onConfirm(variant);
    setSelectedId(null);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setSelectedId(null); }}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Choose an option</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground -mt-2">{sellerName}</p>
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {variants.map((v) => {
            const label = [v.form, v.height, v.potSize, v.age].filter(Boolean).join(" · ") || `Option #${v.id}`;
            const price = v.discountPrice ?? v.price;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => setSelectedId(v.id)}
                className={`w-full text-left px-4 py-3 rounded-xl border transition-all text-sm flex items-center justify-between gap-3 ${
                  selectedId === v.id ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30 hover:bg-muted/30"
                }`}
              >
                <span className="min-w-0">
                  <span className="font-medium block truncate">{label}</span>
                  <span className="text-xs text-muted-foreground">{v.availableQuantity} in stock</span>
                </span>
                <span className="shrink-0 flex items-baseline gap-1.5">
                  <span className="font-semibold">Tk{price.toLocaleString()}</span>
                  {v.discountPrice != null && (
                    <span className="text-xs text-muted-foreground line-through">Tk{v.price.toLocaleString()}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        <DialogFooter>
          <Button onClick={handleConfirm} disabled={selectedId == null} className="w-full sm:w-auto">
            Add to Bag
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
