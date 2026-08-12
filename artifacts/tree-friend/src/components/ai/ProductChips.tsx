/**
 * ProductChips — clickable product mentions below AI replies.
 *
 * v3.0: refined design — green accent, hover lift, external-link icon.
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
          className="group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-primary/5 hover:bg-primary/10 border border-primary/20 hover:border-primary/40 text-xs font-medium text-primary transition-all hover:shadow-sm"
          title={`Search for "${name}" on TreeFriend`}
        >
          <span className="max-w-[140px] truncate">{name}</span>
          <ExternalLink className="h-3 w-3 opacity-60 group-hover:opacity-100 transition-opacity" />
        </button>
      ))}
    </div>
  );
}
