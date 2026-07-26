import { useState } from "react";
import type { SellerListingCard, SellerListingVariant } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Truck, MapPin, ChevronLeft } from "lucide-react";

interface SellerListingPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productName: string;
  /** Only sellers with at least one in-stock (availableQuantity > 0) variant. */
  cards: SellerListingCard[];
  onConfirm: (card: SellerListingCard, variant: SellerListingVariant) => void;
}

/**
 * Two-step buyer picker used when "Add to Bag" is clicked somewhere with no
 * per-seller UI of its own (currently: WishlistPage.tsx) and the product has
 * more than one qualifying seller listing. Step 1 lets the buyer pick a
 * seller (price/delivery/location all differ per seller -- an Amazon/Daraz
 * "choose a seller" step, not an implementation detail to hide by
 * auto-picking cheapest); step 2 is the existing single-seller variant
 * picker UI, shown only if that seller has more than one qualifying variant.
 *
 * If there's exactly one qualifying seller, the caller should skip this
 * dialog entirely and go straight to SellerListingVariantPickerDialog (or
 * add directly if that seller also has only one variant) -- this component
 * assumes a real choice between sellers is being offered.
 */
export function SellerListingPickerDialog({
  open,
  onOpenChange,
  productName,
  cards,
  onConfirm,
}: SellerListingPickerDialogProps) {
  const [selectedCard, setSelectedCard] = useState<SellerListingCard | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<number | null>(null);

  function reset() {
    setSelectedCard(null);
    setSelectedVariantId(null);
  }

  function handleOpenChange(o: boolean) {
    onOpenChange(o);
    if (!o) reset();
  }

  function qualifyingVariants(card: SellerListingCard) {
    return card.listing.variants.filter((v) => v.availableQuantity > 0);
  }

  function pickSeller(card: SellerListingCard) {
    const qualifying = qualifyingVariants(card);
    if (qualifying.length === 1) {
      // Only one option from this seller -- no need for a second step.
      onConfirm(card, qualifying[0]);
      handleOpenChange(false);
      return;
    }
    setSelectedCard(card);
  }

  function handleConfirmVariant() {
    if (!selectedCard) return;
    const variant = qualifyingVariants(selectedCard).find((v) => v.id === selectedVariantId);
    if (!variant) return;
    onConfirm(selectedCard, variant);
    handleOpenChange(false);
  }

  const showingVariantStep = selectedCard != null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <div className="flex items-center gap-2">
            {showingVariantStep && (
              <button
                type="button"
                onClick={() => { setSelectedCard(null); setSelectedVariantId(null); }}
                className="text-muted-foreground hover:text-foreground -ml-1"
                aria-label="Back to sellers"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}
            <DialogTitle>{showingVariantStep ? "Choose an option" : "Choose a seller"}</DialogTitle>
          </div>
        </DialogHeader>
        <p className="text-sm text-muted-foreground -mt-2">
          {showingVariantStep ? selectedCard.seller.businessName : productName}
        </p>

        {!showingVariantStep && (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {cards.map((card) => {
              const qualifying = qualifyingVariants(card);
              const prices = qualifying.map((v) => v.discountPrice ?? v.price);
              const minPrice = Math.min(...prices);
              const maxPrice = Math.max(...prices);
              return (
                <button
                  key={card.listing.id}
                  type="button"
                  onClick={() => pickSeller(card)}
                  className="w-full text-left px-4 py-3 rounded-xl border border-border hover:border-foreground/30 hover:bg-muted/30 transition-all text-sm"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{card.seller.businessName}</span>
                    <span className="font-semibold shrink-0">
                      {minPrice === maxPrice ? `Tk${minPrice.toLocaleString()}` : `Tk${minPrice.toLocaleString()}–${maxPrice.toLocaleString()}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      {card.seller.location}
                    </span>
                    {card.listing.deliveryTimeDays != null && (
                      <span className="flex items-center gap-1">
                        <Truck className="h-3 w-3" />
                        {card.listing.deliveryTimeDays}-day delivery
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {showingVariantStep && (
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {qualifyingVariants(selectedCard).map((v) => {
              const label = [v.form, v.height, v.potSize, v.age].filter(Boolean).join(" · ") || `Option #${v.id}`;
              const price = v.discountPrice ?? v.price;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setSelectedVariantId(v.id)}
                  className={`w-full text-left px-4 py-3 rounded-xl border transition-all text-sm flex items-center justify-between gap-3 ${
                    selectedVariantId === v.id ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30 hover:bg-muted/30"
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
        )}

        {showingVariantStep && (
          <DialogFooter>
            <Button onClick={handleConfirmVariant} disabled={selectedVariantId == null} className="w-full sm:w-auto">
              Add to Bag
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
