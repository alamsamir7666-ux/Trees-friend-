/**
 * ChatVariantPickerDialog — variant picker for the chat's ListingGridCard.
 *
 * v6.2 Part 5 (Bug 4 fix): when a chat-listed seller listing has MORE than
 * one variant (e.g. Mango tree as Sapling / Grafted / Potted at different
 * prices), the Cart button can't silently add `variants[0]` — the buyer may
 * want a different variant. This dialog lets the buyer pick one before
 * add-to-cart, mirroring the marketplace's SellerListingVariantPickerDialog
 * but tailored to the chat tool result shape.
 *
 * Why a new component (instead of reusing SellerListingVariantPickerDialog):
 *   - That dialog expects `SellerListingVariant` from the generated API
 *     client (with `id`, `form`, `height`, `potSize`, `age`, `price`,
 *     `discountPrice`, `availableQuantity`). The chat's tool result
 *     uses a different field shape (`variantId`, `rootType`, `potSize`,
 *     `age`, `height`, `condition`, `price`, `discountPrice`,
 *     `availableQuantity`, `deliveryCharge`, `isPreOrder`).
 *   - We want to filter out variants that are truly unpurchasable
 *     (availableQuantity === 0 AND !isPreOrder). The marketplace dialog
 *     relies on the caller to pre-filter; we self-filter here so the
 *     ListingGridCard doesn't have to.
 *   - We display the delivery charge + pre-order badge inline, which
 *     the marketplace dialog doesn't.
 *
 * Accessibility:
 *   - The variant buttons are real <button> elements (keyboard-accessible
 *     by default — Tab moves between them, Enter/Space selects).
 *   - The dialog is built on Radix Dialog (via shadcn/ui), which handles
 *     focus trap, escape-to-close, and aria-modal automatically.
 *   - Each variant button has an `aria-pressed` state and a descriptive
 *     `aria-label` so screen readers announce selection state.
 *
 * Industry-standard patterns (Amazon, Daraz, Shopify variant pickers):
 *   - One variant per row, full-width tap target.
 *   - Selected variant has a primary-colored border + tinted background.
 *   - Sold-out variants are visually disabled (greyed out, not removed —
 *     the buyer should see they exist).
 *   - Price + strikethrough (when there's an actual discount > 0 and
 *     < original price — see Bug 3 fix) per variant.
 *   - Stock count + delivery charge shown inline.
 *   - "Add to Bag" CTA at the bottom, disabled until a variant is selected.
 */
import { useState, useEffect, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Truck, Package } from "lucide-react";

export interface ChatListingVariant {
  variantId: number;
  form: string | null;
  height: string | null;
  price: number;
  discountPrice: number | null;
  availableQuantity: number;
  deliveryCharge: number;
  isPreOrder: boolean;
}

interface ChatVariantPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productName: string;
  sellerName: string;
  variants: ChatListingVariant[];
  /**
   * Called with the chosen variant when the user clicks "Add to Bag".
   * The dialog handles its own dismissal + state reset; the caller just
   * performs the add-to-cart with the selected variant.
   */
  onConfirm: (variant: ChatListingVariant) => void;
}

function formatPrice(price: number | null): string {
  if (price === null || price === undefined) return "—";
  return `৳${price.toLocaleString()}`;
}

/**
 * Builds a human-readable label for a variant by joining its non-null
 * attributes. Falls back to "Option #<id>" if all attributes are null
 * (defensive — shouldn't happen but better than an empty label).
 *
 * Examples:
 *   { form: "Sapling", height: "3ft", ... } → "Sapling · 3ft"
 *   { form: null, height: null, ... }       → "Option #42"
 */
function buildVariantLabel(v: ChatListingVariant): string {
  const parts = [v.form, v.height].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : `Option #${v.variantId}`;
}

export function ChatVariantPickerDialog({
  open,
  onOpenChange,
  productName,
  sellerName,
  variants,
  onConfirm,
}: ChatVariantPickerDialogProps) {
  // Selected variant ID. Reset when the dialog closes so the next open
  // starts fresh (the buyer might be adding a different listing next time).
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // v6.2 Part 5: reset selection on close. Without this, if the buyer
  // opens the picker, selects a variant, clicks Cancel, then reopens,
  // the previous selection would still be highlighted — confusing.
  useEffect(() => {
    if (!open) setSelectedId(null);
  }, [open]);

  function handleConfirm() {
    const variant = variants.find((v) => v.variantId === selectedId);
    if (!variant) return;
    onConfirm(variant);
    setSelectedId(null);
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setSelectedId(null);
      }}
    >
      {/* stopPropagation so clicking inside the dialog doesn't bubble
          up to a parent onClick (e.g. the ListingGridCard's outer div
          if it ever gains one). Defensive. */}
      <DialogContent onClick={(e) => e.stopPropagation()} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Choose an option</DialogTitle>
        </DialogHeader>
        <div className="-mt-2 space-y-0.5">
          <p className="text-sm font-medium truncate">{productName}</p>
          <p className="text-xs text-muted-foreground truncate">{sellerName}</p>
        </div>

        {/* Variant list — scrollable when there are many. Each variant
            is a real <button> for keyboard accessibility. */}
        <div className="space-y-2 max-h-80 overflow-y-auto -mx-1 px-1">
          {variants.map((v) => {
            const label = buildVariantLabel(v);
            const effectivePrice = v.discountPrice ?? v.price;
            // Bug 3 fix: only show strikethrough when there's an actual
            // discount (> 0 AND < original). Avoids showing a strikethrough
            // when discountPrice is 0 (free) or equal to price (no discount).
            const hasDiscount =
              v.discountPrice != null && v.discountPrice > 0 && v.discountPrice < v.price;
            // A variant is "sold out" only when it has no stock AND is not
            // pre-order. Pre-order variants are selectable (the buyer
            // orders in advance).
            const soldOut = v.availableQuantity <= 0 && !v.isPreOrder;
            const isSelected = selectedId === v.variantId;

            return (
              <button
                key={v.variantId}
                type="button"
                disabled={soldOut}
                onClick={() => setSelectedId(v.variantId)}
                aria-pressed={isSelected}
                aria-label={`${label}${soldOut ? " (sold out)" : ""}${
                  isSelected ? " (selected)" : ""
                }`}
                className={`w-full text-left px-3 py-2.5 rounded-xl border transition-all text-sm flex items-center justify-between gap-3 disabled:opacity-50 disabled:cursor-not-allowed ${
                  isSelected
                    ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                    : "border-border hover:border-foreground/30 hover:bg-muted/30"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium block truncate">{label}</span>
                  <span className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                    {soldOut ? (
                      <span className="text-destructive">Sold out</span>
                    ) : (
                      <span>{v.availableQuantity} in stock</span>
                    )}
                    {v.isPreOrder && (
                      <Badge
                        variant="outline"
                        className="text-[8px] h-3.5 px-1 bg-warning/10 text-warning border-warning/20"
                      >
                        Pre-order
                      </Badge>
                    )}
                    {v.deliveryCharge > 0 && (
                      <span className="flex items-center gap-0.5">
                        <Truck className="h-2.5 w-2.5" />
                        {formatPrice(v.deliveryCharge)}
                      </span>
                    )}
                  </span>
                </span>
                <span className="shrink-0 flex items-baseline gap-1.5">
                  <span className="font-semibold">{formatPrice(effectivePrice)}</span>
                  {hasDiscount && (
                    <span className="text-xs text-muted-foreground line-through">
                      {formatPrice(v.price)}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <DialogFooter>
          <Button
            onClick={handleConfirm}
            disabled={selectedId == null}
            className="w-full sm:w-auto"
          >
            <Package className="h-4 w-4 mr-1.5" />
            Add to Bag
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Helper for consumers: returns true if the picker should be shown for
 * a listing (i.e. there are 2+ selectable variants). Single-variant
 * listings skip the picker and add directly.
 *
 * A "selectable" variant is one that is either in-stock or pre-order.
 * Sold-out variants don't count toward the threshold — a listing with
 * 3 variants where 2 are sold out has only 1 selectable variant and
 * should add directly (no picker).
 */
export function shouldShowVariantPicker(variants: ChatListingVariant[]): boolean {
  const selectable = variants.filter((v) => v.availableQuantity > 0 || v.isPreOrder);
  return selectable.length > 1;
}

// Re-export for consumers that want to render their own dialog wrapper
// (currently unused but provided for future flexibility).
export type { ReactNode };
