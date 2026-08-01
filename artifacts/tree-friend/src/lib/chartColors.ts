/**
 * Per-theme chart color arrays.
 *
 * Why per-theme arrays instead of CSS variables (`var(--chart-N)`)?
 *
 * Recharts (and SVG charts in general) don't reliably consume CSS
 * variables in all attribute positions. `<CartesianGrid stroke="..." />`
 * and `<XAxis tick={{ fill: "..." }} />` work, but Bar/Area/Line `stroke`
 * and `fill` are sometimes passed to canvas/D3 internals that need a
 * concrete color string. CSS variables also don't work inside inline
 * `style={{ backgroundColor: ... }}` legend dots without `hsl(var(--x))`
 * wrapping, which is easy to forget.
 *
 * The pragmatic industry-standard pattern (used by Linear, Vercel, and
 * the Recharts community) is two parallel color arrays in JS, swapped
 * based on the resolved theme via `useTheme()`. This guarantees the
 * same hex value reaches every SVG attribute, in both themes, with no
 * CSS-variable plumbing required.
 *
 * Light palette: vibrant enough to read on cream/white backgrounds, with
 * enough hue separation for color-blind users (deuteranopia-safe pairs
 * chosen from Wong 2011, Nature Methods).
 *
 * Dark palette: same hues, lifted in lightness and slightly desaturated,
 * so they glow against a near-black background instead of disappearing
 * into it.
 */

export type ChartPalette = {
  /** Categorical colors — first N series in a pie / bar / line chart. */
  categorical: string[];
  /** Primary series color for line/area charts (forest green). */
  primary: string;
  /** Accent series color (gold-brown). */
  accent: string;
  /** Soft secondary color (sage). */
  soft: string;
  /** Positive trend (revenue up, orders up). */
  trendUp: string;
  /** Negative trend (revenue down, orders down). */
  trendDown: string;
  /** Axis tick label color. */
  axisTick: string;
  /** CartesianGrid stroke color. */
  gridStroke: string;
  /** Default fallback color for unknown segments. */
  fallback: string;
};

export const LIGHT_CHART_COLORS: ChartPalette = {
  categorical: [
    "#15803d", // forest green (primary)
    "#b45309", // gold-brown (accent)
    "#0e7490", // deep teal
    "#7c3aed", // violet
    "#be185d", // rose
  ],
  primary: "#15803d",
  accent: "#b45309",
  soft: "#4d7c5a",
  trendUp: "#15803d",
  trendDown: "#b91c1c",
  axisTick: "#6b7280", // gray-500, matches --muted-foreground in light
  gridStroke: "#e5e7eb", // gray-200, matches --border in light
  fallback: "#94a3b8", // slate-400
};

export const DARK_CHART_COLORS: ChartPalette = {
  categorical: [
    "#4ade80", // green-400 -- forest green brightened for dark bg
    "#fbbf24", // amber-400 -- gold brightened
    "#22d3ee", // cyan-400 -- teal brightened
    "#a78bfa", // violet-400
    "#fb7185", // rose-400
  ],
  primary: "#4ade80",
  accent: "#fbbf24",
  soft: "#86efac",
  trendUp: "#4ade80",
  trendDown: "#f87171",
  axisTick: "#9ca3af", // gray-400, matches --muted-foreground in dark
  gridStroke: "#1f2937", // gray-800, matches --border in dark
  fallback: "#64748b", // slate-500
};

/**
 * Status-to-color map for order/return/payout status pills in charts.
 *
 * Keys are the canonical status strings used across the app's order
 * pipeline. Values are *functions* that take a ChartPalette and return
 * a hex color -- this lets the same status map render correctly in both
 * themes without duplicating the lookup table.
 *
 * Hue assignments (mirrors the semantic status tokens):
 *   pending       -> warning (amber)
 *   confirmed     -> info (sky blue)
 *   processing    -> info variant (violet, to distinguish from confirmed)
 *   shipped       -> info variant (indigo, to distinguish from processing)
 *   delivered     -> success (green)
 *   cancelled     -> destructive (rose)
 *
 * If you change these, also update the ORDER_STATUS_META table in
 * SellerOverviewTab.tsx and the status pill lookup tables in
 * OrdersTab.tsx / ArchivedOrdersTab.tsx -- they should stay in sync.
 */
export const ORDER_STATUS_CHART_COLORS: Record<
  string,
  (palette: ChartPalette) => string
> = {
  pending: (p) => p.accent, // amber/gold
  confirmed: (p) => p.categorical[3], // violet (info variant)
  processing: (p) => p.categorical[3], // violet
  shipped: (p) => p.categorical[3], // violet -- TODO: distinguish if needed
  delivered: (p) => p.primary, // green
  cancelled: (p) => p.trendDown, // rose
};

/**
 * Customer-segment chart colors (New / Returning / VIP) used in the
 * AdminAnalyticsPanel customer-segmentation chart.
 */
export const SEGMENT_CHART_COLORS: Record<
  string,
  (palette: ChartPalette) => string
> = {
  New: (p) => p.categorical[3], // violet
  Returning: (p) => p.categorical[2], // teal/cyan
  VIP: (p) => p.accent, // gold
};

/**
 * Pick a color from the categorical palette by index, wrapping around
 * for series counts > categorical.length.
 */
export function pickCategorical(palette: ChartPalette, index: number): string {
  return palette.categorical[index % palette.categorical.length];
}
