import { useMemo } from "react";
import { useTheme } from "next-themes";
import {
  LIGHT_CHART_COLORS,
  DARK_CHART_COLORS,
  type ChartPalette,
} from "@/lib/chartColors";

/**
 * Returns the correct chart color palette for the currently resolved
 * theme. Re-renders the consumer when the theme changes (so charts
 * recolor on toggle without needing a page reload).
 *
 * Usage:
 *   const chart = useChartColors();
 *   <CartesianGrid stroke={chart.gridStroke} />
 *   <XAxis tick={{ fontSize: 10, fill: chart.axisTick }} />
 *   <Area stroke={chart.primary} fill="url(#grad)" />
 *
 * The returned object is referentially stable across renders unless
 * the resolved theme actually changes (memoized), so it's safe to use
 * in useEffect dependency arrays.
 */
export function useChartColors(): ChartPalette {
  const { resolvedTheme } = useTheme();

  return useMemo(() => {
    return resolvedTheme === "dark" ? DARK_CHART_COLORS : LIGHT_CHART_COLORS;
  }, [resolvedTheme]);
}
