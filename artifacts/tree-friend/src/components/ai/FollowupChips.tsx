/**
 * FollowupChips — renders the suggested follow-up questions extracted
 * from the AI's [followups]...[/followups] block as clickable chips.
 *
 * Clicking a chip sends that question as a new user message — the same
 * as if the user had typed it. This keeps the conversation flowing with
 * minimal friction (no typing required).
 */
import { Send } from "lucide-react";

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
          className="group inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-muted/50 hover:bg-primary/10 hover:border-primary/30 border border-border text-xs text-foreground/80 hover:text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span className="truncate max-w-[220px]">{q}</span>
          <Send className="h-2.5 w-2.5 opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
      ))}
    </div>
  );
}
