import { useEffect, useState } from "react";
import { Search, X, Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { apiClient } from "@/lib/apiClient";

interface PickerProduct {
  id: number;
  name: string;
  slug: string;
  price: string;
  discountPrice: string | null;
  images: string[];
  stock: number;
}

interface ProductPickerProps {
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  max?: number;
}

export function ProductPicker({ selectedIds, onChange, max = 3 }: ProductPickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickerProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedDetails, setSelectedDetails] = useState<Record<number, PickerProduct>>({});

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await apiClient.get<{ products: PickerProduct[] }>("/api/products", {
          params: { search: query.trim(), limit: 10 },
        });
        setResults(data.products || []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  // Keep a lookup of full product details for anything currently selected,
  // so chips can render name/image even after the search results change.
  useEffect(() => {
    setSelectedDetails(prev => {
      const next = { ...prev };
      for (const p of results) {
        if (selectedIds.includes(p.id)) next[p.id] = p;
      }
      return next;
    });
  }, [results, selectedIds]);

  const atMax = selectedIds.length >= max;

  const toggle = (p: PickerProduct) => {
    if (selectedIds.includes(p.id)) {
      onChange(selectedIds.filter(id => id !== p.id));
    } else {
      if (atMax) return;
      setSelectedDetails(prev => ({ ...prev, [p.id]: p }));
      onChange([...selectedIds, p.id]);
    }
  };

  const remove = (id: number) => {
    onChange(selectedIds.filter(i => i !== id));
  };

  return (
    <div className="space-y-3">
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedIds.map(id => {
            const p = selectedDetails[id];
            return (
              <div
                key={id}
                className="flex items-center gap-2 bg-accent/10 border border-accent/30 rounded-full pl-1.5 pr-2.5 py-1"
              >
                {p?.images?.[0] ? (
                  <img src={p.images[0]} alt="" className="h-6 w-6 rounded-full object-cover" />
                ) : (
                  <div className="h-6 w-6 rounded-full bg-muted" />
                )}
                <span className="text-xs font-medium max-w-[140px] truncate">
                  {p?.name ?? `Product #${id}`}
                </span>
                <button
                  type="button"
                  onClick={() => remove(id)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          placeholder={atMax ? `Max ${max} products selected` : "Search products to link..."}
          value={query}
          onChange={e => setQuery(e.target.value)}
          disabled={atMax}
          className="pl-9 rounded-xl disabled:opacity-60"
        />
      </div>

      {query.trim() && (
        <div className="border rounded-xl overflow-hidden max-h-56 overflow-y-auto divide-y">
          {loading ? (
            <div className="p-3 text-sm text-muted-foreground">Searching...</div>
          ) : results.length === 0 ? (
            <div className="p-3 text-sm text-muted-foreground">No products found</div>
          ) : (
            results.map(p => {
              const isSelected = selectedIds.includes(p.id);
              const disabled = !isSelected && atMax;
              return (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => toggle(p)}
                  disabled={disabled}
                  className={`w-full flex items-center gap-3 p-2.5 text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    isSelected ? "bg-accent/10" : "hover:bg-muted/50"
                  }`}
                >
                  {p.images?.[0] ? (
                    <img src={p.images[0]} alt="" className="h-9 w-9 rounded-lg object-cover shrink-0" />
                  ) : (
                    <div className="h-9 w-9 rounded-lg bg-muted shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{p.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.discountPrice ? (
                        <>
                          <span className="line-through mr-1">Tk{p.price}</span>
                          <span className="text-accent font-semibold">Tk{p.discountPrice}</span>
                        </>
                      ) : (
                        <>Tk{p.price}</>
                      )}
                    </p>
                  </div>
                  {isSelected && <Check className="h-4 w-4 text-accent shrink-0" />}
                </button>
              );
            })
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {selectedIds.length}/{max} products selected
      </p>
    </div>
  );
}
