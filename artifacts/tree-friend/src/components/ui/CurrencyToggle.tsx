import { useCurrency } from "@/lib/currency";

export function CurrencyToggle() {
  const { currency, setCurrency } = useCurrency();
  return (
    <button
      onClick={() => setCurrency(currency === "BDT" ? "USD" : "BDT")}
      className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-full border border-border hover:bg-muted/60 transition-colors"
      aria-label={`Switch to ${currency === "BDT" ? "USD" : "BDT"}`}
    >
      <span>{currency === "BDT" ? "Tk BDT" : "$ USD"}</span>
      <span className="text-muted-foreground">·</span>
    </button>
  );
}
