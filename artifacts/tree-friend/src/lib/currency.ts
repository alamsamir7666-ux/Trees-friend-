import { createContext, useContext, useState, useCallback, type ReactNode, createElement as h } from "react";

type Currency = "BDT" | "USD";

// Approximate exchange rate - update periodically or fetch from API
const BDT_TO_USD = 0.0091;

interface CurrencyContextType {
  currency: Currency;
  setCurrency: (c: Currency) => void;
  format: (amountBdt: number) => string;
  symbol: string;
}

const CurrencyContext = createContext<CurrencyContextType>({
  currency: "BDT",
  setCurrency: () => {},
  format: (n) => `Tk${n.toLocaleString()}`,
  symbol: "Tk",
});

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const stored = (typeof localStorage !== "undefined"
    ? localStorage.getItem("ee_currency")
    : null) as Currency | null;
  const [currency, setCurrencyState] = useState<Currency>(stored ?? "BDT");

  const setCurrency = useCallback((c: Currency) => {
    setCurrencyState(c);
    localStorage.setItem("ee_currency", c);
  }, []);

  const format = useCallback(
    (amountBdt: number) => {
      if (currency === "USD") {
        const usd = amountBdt * BDT_TO_USD;
        return `$${usd.toFixed(2)}`;
      }
      return `Tk${amountBdt.toLocaleString()}`;
    },
    [currency],
  );

  const symbol = currency === "USD" ? "$" : "Tk";

  return h(CurrencyContext.Provider, { value: { currency, setCurrency, format, symbol } }, children);
}

export function useCurrency() {
  return useContext(CurrencyContext);
}
