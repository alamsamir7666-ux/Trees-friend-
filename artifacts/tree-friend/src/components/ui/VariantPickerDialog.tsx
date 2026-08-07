import { useState } from "react";
import type { ProductVariant } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { VariantSelector } from "@/components/ui/VariantSelector";

interface VariantPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productName: string;
  variants: ProductVariant[];
  onConfirm: (variant: ProductVariant) => void;
}

/**
 * Popup shown when "Add to Bag" is clicked from a product card (home page,
 * listing grid, related products, etc.) for a product that has more than
 * one variant -- the buyer must pick one before it can be added.
 */
export function VariantPickerDialog({ open, onOpenChange, productName, variants, onConfirm }: VariantPickerDialogProps) {
  const [selected, setSelected] = useState<ProductVariant | null>(null);

  function handleConfirm() {
    if (!selected) return;
    onConfirm(selected);
    setSelected(null);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setSelected(null); }}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Choose an option</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground -mt-2">{productName}</p>
        <VariantSelector variants={variants} selected={selected} onVariantChange={setSelected} />
        <DialogFooter>
          <Button onClick={handleConfirm} disabled={!selected} className="w-full sm:w-auto">
            Add to Bag
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
