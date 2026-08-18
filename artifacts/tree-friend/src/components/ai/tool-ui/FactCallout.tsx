/**
 * FactCallout — small highlighted box that surfaces the SINGLE most relevant
 * fact from a tool result, picked by inspecting the user's question.
 *
 * Industry context (v6.2 Part 15 — UI vs text response deduplication):
 *   Without this component, the AI's text bubble rephrased tool data into
 *   prose, AND the structured card below it showed the same fields as a
 *   grid. The user read the same fact twice (wasted tokens, wasted screen
 *   real estate, felt less polished than ChatGPT/Perplexity).
 *
 *   The fix: the model writes ONLY the direct answer to the specific
 *   question (1-2 sentences). The FactCallout surfaces ONE key quantitative
 *   fact the user is likely to act on (e.g. "8-12 meters height", "5 recent
 *   orders", "Order #1001 is delivered"). The structured grid below the
 *   callout shows the rest of the fields.
 *
 * Visual pattern (matches reference design):
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ [icon]  <single-sentence quantitative fact>             │
 *   │                                                         │
 *   │         bg-primary/10 + border-primary/20 + rounded-lg  │
 *   └─────────────────────────────────────────────────────────┘
 *
 * The accent color is the app's existing `primary` token (deep green) —
 * matches the sage-green callout in the reference design without
 * introducing a new color.
 *
 * Props:
 *   - icon: LucideIcon component (already imported by the caller).
 *   - text: The single sentence to display. If empty/null, the callout
 *           doesn't render (the caller's picker returned null — graceful
 *           degradation to just the structured grid below).
 *   - accent: Optional color override. Defaults to "primary" (green).
 *             Other options: "info" (blue), "warning" (amber), "success"
 *             (green), "destructive" (red). Used by OrderDetailCard to
 *             color-code by status (delivered=success, cancelled=destructive).
 *
 * NOT wrapped in React.memo — the parent (each card) is already memoized.
 */
import type { LucideIcon } from "lucide-react";

type AccentName = "primary" | "info" | "warning" | "success" | "destructive";

const ACCENT_CLASSES: Record<
  AccentName,
  { bg: string; border: string; text: string; iconBg: string; iconText: string }
> = {
  primary: {
    bg: "bg-primary/10",
    border: "border-primary/20",
    text: "text-foreground",
    iconBg: "bg-primary/15",
    iconText: "text-primary",
  },
  info: {
    bg: "bg-info/10",
    border: "border-info/20",
    text: "text-foreground",
    iconBg: "bg-info/15",
    iconText: "text-info",
  },
  warning: {
    bg: "bg-warning/10",
    border: "border-warning/20",
    text: "text-foreground",
    iconBg: "bg-warning/15",
    iconText: "text-warning",
  },
  success: {
    bg: "bg-success/10",
    border: "border-success/20",
    text: "text-foreground",
    iconBg: "bg-success/15",
    iconText: "text-success",
  },
  destructive: {
    bg: "bg-destructive/10",
    border: "border-destructive/20",
    text: "text-foreground",
    iconBg: "bg-destructive/15",
    iconText: "text-destructive",
  },
};

export function FactCallout({
  icon: Icon,
  text,
  accent = "primary",
}: {
  icon: LucideIcon;
  text: string | null | undefined;
  accent?: AccentName;
}) {
  if (!text || text.trim().length === 0) return null;

  const a = ACCENT_CLASSES[accent] ?? ACCENT_CLASSES.primary;

  return (
    <div
      className={`flex items-start gap-2.5 p-2.5 rounded-lg ${a.bg} ${a.border} border`}
      role="note"
    >
      <div
        className={`flex-shrink-0 h-7 w-7 rounded-full ${a.iconBg} flex items-center justify-center`}
      >
        <Icon className={`h-4 w-4 ${a.iconText}`} />
      </div>
      <p className={`text-xs leading-relaxed ${a.text} flex-1 self-center`}>{text}</p>
    </div>
  );
}

// ─── Keyword-matching helper (shared across cards) ─────────────────────────
//
// Each card has its own picker function (pickCareCallout, pickOrderListCallout,
// etc.) but they all use this helper to match the user's question against a
// list of keywords. Keeps the per-card logic small + readable.
//
// Example:
//   if (matchesAnyKeyword(userQuestion, ["growth", "grow", "fast", "slow"])) {
//     return { icon: TrendingUp, text: `Growth rate: ${product.growth_rate}` };
//   }
//
// Case-insensitive. Word-boundary-aware (so "soil" doesn't match "despoil").
// Returns true if ANY of the keywords appear as a whole word in the question.

/**
 * Tests whether any of the given keywords appears as a whole word in the
 * user's question (case-insensitive). Used by per-card callout pickers.
 *
 * Word-boundary aware: "soil" does NOT match inside "despoil". This avoids
 * false positives when a keyword happens to be a substring of an unrelated
 * word.
 *
 * Returns false if `userQuestion` is null/undefined/empty (the picker
 * should fall through to the default case → no callout rendered).
 */
export function matchesAnyKeyword(
  userQuestion: string | null | undefined,
  keywords: string[],
): boolean {
  if (!userQuestion || userQuestion.trim().length === 0) return false;
  const lower = userQuestion.toLowerCase();
  // \b = word boundary on both sides. The keyword is escaped (no regex
  // metachars expected — these are plain English words, but the escape
  // is defensive in case a future keyword contains a special char).
  return keywords.some((kw) => {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(lower);
  });
}
