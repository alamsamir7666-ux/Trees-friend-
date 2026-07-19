import { useState, useEffect } from "react";
import type { ProductVariant } from "@workspace/api-client-react";

interface VariantSelectorProps {
  variants: ProductVariant[];
  selected: ProductVariant | null;
  onVariantChange: (variant: ProductVariant | null) => void;
}

export function VariantSelector({ variants, selected, onVariantChange }: VariantSelectorProps) {
  // Auto-select the only variant when there's exactly one, so single-variant
  // products don't force an extra click before the user can add to cart.
  useEffect(() => {
    if (variants.length === 1 && !selected) {
      onVariantChange(variants[0]);
    }
  }, [variants, selected, onVariantChange]);

  if (variants.length === 0) return null;

  const types = [...new Set(variants.map((v) => v.variantType))];

  return (
    <div className="space-y-3">
      {types.map((type) => {
        const group = variants.filter((v) => v.variantType === type);
        return (
          <div key={type}>
            <p className="text-sm font-medium capitalize mb-2">
              {type}:{" "}
              <span className="text-muted-foreground font-normal">
                {selected?.variantType === type ? selected.name : ""}
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              {group.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => onVariantChange(v)}
                  disabled={v.stock === 0}
                  className={`px-3 py-1.5 text-sm rounded-xl border transition-all ${
                    selected?.id === v.id
                      ? "border-accent bg-accent/10 text-accent font-medium"
                      : v.stock === 0
                        ? "border-border text-muted-foreground/40 line-through cursor-not-allowed"
                        : "border-border hover:border-accent/60 hover:bg-muted/40"
                  }`}
                  aria-pressed={selected?.id === v.id}
                  aria-label={`${type} ${v.name}${v.stock === 0 ? " - out of stock" : ""}`}
                >
                  {v.name}
                  {v.stock > 0 && v.stock <= 5 && (
                    <span className="ml-1.5 text-xs text-amber-500">({v.stock} left)</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      {selected && (
        <p className="text-sm text-muted-foreground">
          Price for {selected.name}:{" "}
          <span className="font-semibold text-foreground">
            Tk{(selected.discountPrice ?? selected.price).toLocaleString()}
          </span>
          {selected.discountPrice != null && (
            <span className="line-through text-muted-foreground ml-2">
              Tk{selected.price.toLocaleString()}
            </span>
          )}
        </p>
      )}
    </div>
  );
}
