/**
 * FollowupChips — suggested follow-up questions as clickable chips.
 *
 * v3.0: refined design — pill-shaped, subtle bg, hover lift.
 */
import { MessageCircle } from "lucide-react";

interface FollowupChipsProps {
  followups: string[];
  onPick: (s: string) => void;
  disabled?: boolean;
}

export function FollowupChips({ followups, onPick, disabled }: FollowupChipsProps) {
  if (!followups || followups.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2.5">
      {followups.map((q, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onPick(q)}
          disabled={disabled}
          className="group inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-background hover:bg-primary hover:text-primary-foreground border border-border text-xs text-muted-foreground hover:border-primary transition-all hover:shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <MessageCircle className="h-3 w-3 opacity-50 group-hover:opacity-100" />
          <span className="truncate max-w-[200px]">{q}</span>
        </button>
      ))}
    </div>
  );
}
