/**
 * CareGuideCard — rich inline UI for get_product_care tool results.
 *
 * v6.2 Part 2: renders structured care info (sunlight, watering, soil,
 * height, climate, growth rate, bloom season, key benefits, best for,
 * care tips) as a clean card — instead of the AI re-typing all this
 * info in prose.
 *
 * v6.2 Part 15 (UI vs text dedup — industry-standard pattern):
 *   - Adds a `FactCallout` at the TOP of the card that surfaces the single
 *     most relevant fact for the user's specific question (e.g. if they
 *     asked about growth rate, the callout shows the mature height;
 *     if they asked about watering, it shows the watering schedule).
 *   - Adds a 'View full care guide' CTA button at the bottom that
 *     deep-links to /products/<slug> (the existing product detail page).
 *   - Pairs with the system-prompt v1.4.0 change: model now writes ONLY
 *     the direct 1-2 sentence answer to the specific question; it
 *     does NOT restate the structured fields this card already shows.
 *
 * Data shape (from aiTools.ts getProductCare):
 *   { product: { name, slug, scientific_name, description, sunlight,
 *     watering, soil_type, mature_height, climate_zone, growth_rate,
 *     bloom_season, key_benefits, best_for, care_tips, images,
 *     product_status } | null, error?: string }
 */
import { memo } from "react";
import {
  Sun,
  Droplets,
  Mountain,
  Ruler,
  Wind,
  TrendingUp,
  Flower,
  Leaf,
  ArrowRight,
} from "lucide-react";
import { useLocation } from "wouter";
import { useStaggeredReveal } from "@/hooks/useStaggeredReveal";
// v6.2 Part 12 (Gap Fix #1): types flow from the Zod schema. No local
// ProductData / CareResult interfaces — they're now inferred + validated.
import type { CareResult, ProductData } from "./schemas";
import { FactCallout, matchesAnyKeyword } from "./FactCallout";

// ─── v6.2 Part 15: question-driven callout picker ───────────────────────────
//
// Returns { icon, text } for the FactCallout, or null if no rule matches.
// The rule list is ordered by priority — the first matching rule wins.
//
// Keyword matching is case-insensitive + word-boundary aware (so 'soil'
// doesn't false-match inside 'despoil'). See matchesAnyKeyword in
// FactCallout.tsx.
//
// When the user's question is open-ended ('tell me about X mango') with
// no specific keyword, returns null → no callout rendered → just the
// 'At a glance' grid below. Graceful degradation.
function pickCareCallout(
  userQuestion: string | undefined,
  product: ProductData,
): { icon: typeof Sun; text: string } | null {
  // Growth-related → feature mature_height (the quantitative fact the
  // user is most likely to act on). Falls back to growth_rate if height
  // isn't populated for this variety.
  if (matchesAnyKeyword(userQuestion, ["growth", "grow", "fast", "slow", "rate"])) {
    if (product.mature_height) {
      return {
        icon: Ruler,
        text: `It typically reaches ${product.mature_height} under ideal growing conditions.`,
      };
    }
    if (product.growth_rate) {
      return { icon: TrendingUp, text: `Growth rate: ${product.growth_rate}.` };
    }
  }

  // Watering-related → feature the watering schedule + drainage warning
  // (drainage is the most common failure mode for mango trees).
  if (matchesAnyKeyword(userQuestion, ["water", "irrigat", "moisture", "rain"])) {
    if (product.watering) {
      return {
        icon: Droplets,
        text: `Watering: ${product.watering}. Proper drainage is crucial — root rot is the most common failure.`,
      };
    }
  }

  // Soil-related → feature the soil_type + pH.
  if (matchesAnyKeyword(userQuestion, ["soil", "dirt", "ground", "ph", "compost"])) {
    if (product.soil_type) {
      return { icon: Mountain, text: `Soil: ${product.soil_type}.` };
    }
  }

  // Sunlight-related → feature the sunlight requirement with hours/day.
  if (matchesAnyKeyword(userQuestion, ["sun", "light", "shade", "uv"])) {
    if (product.sunlight) {
      return { icon: Sun, text: `Sunlight: ${product.sunlight}.` };
    }
  }

  // Height/size-related → feature mature_height.
  if (matchesAnyKeyword(userQuestion, ["height", "tall", "big", "size", "meter", "feet"])) {
    if (product.mature_height) {
      return { icon: Ruler, text: `Mature height: ${product.mature_height}.` };
    }
  }

  // Climate-related → feature climate_zone.
  if (matchesAnyKeyword(userQuestion, ["climate", "zone", "weather", "temperature", "humid"])) {
    if (product.climate_zone) {
      return { icon: Wind, text: `Climate: ${product.climate_zone}.` };
    }
  }

  // Bloom/fruit-related → feature bloom_season (which mentions fruiting).
  if (matchesAnyKeyword(userQuestion, ["bloom", "flower", "fruit", "ripe", "harvest", "season"])) {
    if (product.bloom_season) {
      return { icon: Flower, text: `Bloom season: ${product.bloom_season}.` };
    }
  }

  return null;
}

interface CareField {
  icon: typeof Sun;
  label: string;
  value: string | null;
  color: string;
}

export const CareGuideCard = memo(function CareGuideCard({
  data,
  userQuestion,
}: {
  data: CareResult;
  /**
   * v6.2 Part 15: the user's most recent question, used by
   * pickCareCallout to surface the single most relevant fact in the
   * FactCallout at the top of the card. Optional — if absent (e.g. the
   * tool was called without a corresponding user question, like a
   * pre-warm call), no callout is rendered, just the at-a-glance grid.
   */
  userQuestion?: string;
}) {
  // v6.2 Part 12 (Gap Fix #1): data is now typed as CareResult from the
  // Zod schema (validated upstream in ToolComponentRenderer). No more
  // `as CareResult` cast — the type flows from the schema.
  const result = data;

  // v6.2 Part 9 (Gap 17 fix — Phase A): pre-compute fields + tips before
  // the early return so we can call useStaggeredReveal unconditionally
  // (Rules of Hooks). When the product is null, these are empty arrays
  // and the hook is a no-op.
  const p = result?.product;
  const fields: CareField[] = p
    ? [
        { icon: Sun, label: "Sunlight", value: p.sunlight, color: "text-amber-500" },
        { icon: Droplets, label: "Watering", value: p.watering, color: "text-blue-500" },
        { icon: Mountain, label: "Soil", value: p.soil_type, color: "text-stone-500" },
        { icon: Ruler, label: "Mature Height", value: p.mature_height, color: "text-green-500" },
        { icon: Wind, label: "Climate", value: p.climate_zone, color: "text-cyan-500" },
        { icon: TrendingUp, label: "Growth Rate", value: p.growth_rate, color: "text-purple-500" },
        { icon: Flower, label: "Bloom Season", value: p.bloom_season, color: "text-pink-500" },
      ].filter((f) => f.value)
    : [];
  const tips = p && Array.isArray(p.care_tips) ? p.care_tips.slice(0, 4) : [];
  // Staggered reveal styles for care fields (30ms apart — fields are small,
  // the user scans them quickly). Capped at 240ms (8 fields × 30ms).
  const fieldStyles = useStaggeredReveal(fields.length, 30, 240);
  // Staggered reveal for care tips (50ms apart — tips are longer text).
  const tipStyles = useStaggeredReveal(tips.length, 50, 300);

  if (!result || !result.product) {
    return (
      <div className="border rounded-lg p-3 bg-muted/30 text-xs text-muted-foreground text-center">
        {result?.error || "Care info not available for this plant."}
      </div>
    );
  }

  // After the early return above, `result.product` is guaranteed non-null.
  // Re-bind to a const so TypeScript narrows it correctly in the JSX below
  // (the early return's narrowing doesn't propagate through the
  // `const p = result?.product` declaration above — TS keeps `p` as
  // `ProductData | null` even after the guard).
  const product = result.product;
  const image = Array.isArray(product.images) ? product.images[0] : null;

  // v6.2 Part 15: pick the callout to feature at the top of the card.
  // Returns null if no rule matches the user's question — in that case
  // the FactCallout component itself returns null (renders nothing) and
  // the card flows straight to the header + grid below.
  const callout = pickCareCallout(userQuestion, product);
  const [, navigate] = useLocation();

  return (
    <div className="border rounded-lg overflow-hidden bg-card shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-300">
      {/* ─── Header: name + scientific name + image ────────────── */}
      <div className="flex items-center gap-3 p-3 border-b bg-muted/30">
        {image ? (
          <img
            src={typeof image === "string" ? image : ((image as { url?: string })?.url ?? "")}
            alt={product.name}
            className="h-12 w-12 rounded object-cover flex-shrink-0"
          />
        ) : (
          <div className="h-12 w-12 rounded bg-muted flex items-center justify-center flex-shrink-0">
            <Leaf className="h-5 w-5 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0">
          <h4 className="text-sm font-semibold truncate">{product.name}</h4>
          {product.scientific_name && (
            <p className="text-[10px] text-muted-foreground italic truncate">
              {product.scientific_name}
            </p>
          )}
        </div>
      </div>

      {/* ─── v6.2 Part 15: Fact callout (top of card) ───────────── */}
      {/* The single most relevant fact for the user's specific question, */}
      {/* picked by pickCareCallout above. Null when no rule matches.   */}
      {callout && (
        <div className="px-3 pt-3">
          <FactCallout icon={callout.icon} text={callout.text} accent="primary" />
        </div>
      )}

      {/* ─── Care fields grid ────────────────────────────────────── */}
      {fields.length > 0 && (
        <div className="p-3 grid grid-cols-2 gap-2">
          {/* v6.2 Part 9 (Gap 17 fix — Phase A): staggered fade-in per
              field. Each field reveals 30ms after the previous one. */}
          {fields.map((f, i) => {
            const Icon = f.icon;
            return (
              <div
                key={f.label}
                style={fieldStyles[i]}
                className="flex items-center gap-2 text-xs animate-in fade-in slide-in-from-bottom-1 duration-200"
              >
                <Icon className={`h-3.5 w-3.5 ${f.color} flex-shrink-0`} />
                <div className="min-w-0">
                  <span className="text-muted-foreground">{f.label}: </span>
                  <span className="font-medium">{f.value}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ─── Key benefits ───────────────────────────────────────── */}
      {Array.isArray(product.key_benefits) && product.key_benefits.length > 0 && (
        <div className="px-3 pb-2">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
            Key Benefits
          </p>
          <div className="flex flex-wrap gap-1">
            {product.key_benefits.slice(0, 5).map((b, i) => (
              <span
                key={i}
                className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20"
              >
                {b}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ─── Care tips ──────────────────────────────────────────── */}
      {tips.length > 0 && (
        <div className="px-3 pb-3">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
            Care Tips
          </p>
          <ul className="space-y-1">
            {/* v6.2 Part 9 (Gap 17 fix — Phase A): staggered fade-in per
                tip. Each tip reveals 50ms after the previous one. */}
            {tips.map((tip, i) => (
              <li
                key={i}
                style={tipStyles[i]}
                className="text-xs text-foreground/80 flex items-start gap-1.5 animate-in fade-in slide-in-from-bottom-1 duration-200"
              >
                <span className="text-primary mt-0.5">•</span>
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ─── Best for ───────────────────────────────────────────── */}
      {Array.isArray(product.best_for) && product.best_for.length > 0 && (
        <div className="px-3 pb-3 flex flex-wrap gap-1">
          {product.best_for.slice(0, 4).map((b, i) => (
            <span
              key={i}
              className="text-[9px] px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground"
            >
              {b}
            </span>
          ))}
        </div>
      )}

      {/* ─── v6.2 Part 15: CTA button — View full care guide ─────── */}
      {/* Deep-links to /products/<slug> (the existing product detail  */}
      {/* page). One click to the full care guide + seller listings.  */}
      <div className="px-3 pb-3 pt-1 border-t bg-muted/20">
        <button
          type="button"
          onClick={() => navigate(`/products/${product.slug}`)}
          className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/40 transition-colors text-xs font-medium text-primary"
          aria-label={`View full care guide for ${product.name}`}
        >
          <Leaf className="h-3.5 w-3.5" />
          View full care guide
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
});
