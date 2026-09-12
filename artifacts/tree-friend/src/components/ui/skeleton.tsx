import { cn } from "@/lib/utils";

type SkeletonProps = React.HTMLAttributes<HTMLDivElement> & {
  /**
   * Visual style of the skeleton placeholder.
   *
   * - `"shimmer"` (default): a soft diagonal highlight sweeps across the
   *   block. Industry-standard pattern (GitHub 2024, Linear, Vercel,
   *   Stripe). Best for primary content placeholders — cards, images,
   *   headings, paragraphs.
   * - `"pulse"`: uniform opacity throb (Tailwind default). Use when the
   *   skeleton is tiny (≤24px) or layered behind another effect, where a
   *   moving gradient would be visually noisy.
   */
  variant?: "shimmer" | "pulse";
};

/**
 * Skeleton placeholder for loading content.
 *
 * Defaults to the modern shimmer effect (see `index.css → .skeleton-shimmer`)
 * which is the perceptually smoother, industry-standard alternative to
 * Tailwind's built-in `animate-pulse`. Pass `variant="pulse"` to opt out.
 *
 * Accessibility: the skeleton is decorative — the parent should set
 * `aria-busy="true"` on the loading region and `aria-hidden="true"` is
 * NOT applied here (it would hide the skeleton from screen readers, which
 * is fine, but we want the parent to make that call so it can also label
 * the region e.g. "Loading products…").
 */
function Skeleton({ className, variant = "shimmer", ...props }: SkeletonProps) {
  return (
    <div
      className={cn(
        "rounded-md",
        variant === "shimmer" ? "skeleton-shimmer" : "animate-pulse bg-primary/10",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
