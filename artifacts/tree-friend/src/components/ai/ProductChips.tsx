/**
 * ProductChips — fetches minimal product info for the slugs mentioned in an
 * AI response and renders them as clickable cards below the message bubble.
 *
 * The slugs come from extractProductMentions() in parseMessage.ts, which
 * pulls [[product name]] tokens out of the AI's response. We then call
 * GET /api/ai/products-by-slug?slugs=... to resolve names → product cards.
 *
 * Wait — actually the AI wraps the product NAME, not the slug. So we
 * can't call products-by-slug. Instead we:
 *   1. Show the product name as a clickable chip
 *   2. On click, navigate to /products?q=<name> (the existing products
 *      page supports ?q= search)
 *
 * This avoids a backend round-trip per chip and is robust to slight
 * name mismatches (the search page is fuzzy). We could add a real
 * products-by-name endpoint later if needed.
 *
 * Behavior:
 *   - Hidden if no product mentions.
 *   - Each chip: small card with product name + a "View" arrow.
 *   - Clicking navigates via wouter's `useLocation` setter.
 *   - On mobile, chips wrap horizontally (no overflow scroll — keep simple).
 */
import { useMemo } from "react";
import { useLocation } from "wouter";
import { ExternalLink } from "lucide-react";

interface ProductChipsProps {
  /** Names extracted via extractProductMentions(). */
  names: string[];
  /** Optional callback to close the parent panel on navigation. */
  onClose?: () => void;
}

export function ProductChips({ names, onClose }: ProductChipsProps) {
  const [, navigate] = useLocation();

  // Dedupe while preserving order (defense-in-depth, even though the
  // parser already does this).
  const uniqueNames = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const n of names) {
      const key = n.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(n);
      }
    }
    return out;
  }, [names]);

  if (uniqueNames.length === 0) return null;

  const handleClick = (name: string) => {
    onClose?.();
    navigate(`/products?q=${encodeURIComponent(name)}`);
  };

  return (
    <div className="flex flex-wrap gap-1.5 mt-2.5">
      {uniqueNames.map((name) => (
        <button
          key={name}
          type="button"
          onClick={() => handleClick(name)}
          className="group inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/5 hover:bg-primary/10 border border-primary/20 hover:border-primary/40 text-xs font-medium text-primary transition-colors"
          title={`Search for "${name}" on TreeFriend`}
        >
          <span className="max-w-[140px] truncate">{name}</span>
          <ExternalLink className="h-3 w-3 opacity-60 group-hover:opacity-100 transition-opacity" />
        </button>
      ))}
    </div>
  );
}
