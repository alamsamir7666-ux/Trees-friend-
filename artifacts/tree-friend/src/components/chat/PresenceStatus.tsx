/**
 * Renders the "Online" / "last seen at <time>" / "Offline" line under
 * the chat participant's name in the chat header. Matches WhatsApp /
 * Telegram conventions.
 */

import { usePresence, formatLastSeen } from "@/hooks/usePresence";

// Renders the "Online" / "last seen at <time>" / "Offline" line under the
// chat participant's name. Matches WhatsApp/Telegram conventions:
//   - Online            → green dot + "Online" (bold green text)
//   - Last seen today   → "last seen today at 5:42 PM" (muted text)
//   - Last seen yest.   → "last seen yesterday at 9:30 AM" (muted text)
//   - Last seen older   → "last seen Mon at 9:30 AM" or "last seen Aug 1"
//   - Never seen        → "Offline" (muted text, no timestamp)
//   - Loading / unknown → empty (don't flicker the header on mount)

interface PresenceStatusProps {
  presence: {
    status: "online" | "offline" | "unknown";
    lastSeenAt: string | null;
    isLoading: boolean;
  };
}

export function PresenceStatus({ presence }: PresenceStatusProps) {
  // While the first fetch is in flight, render an invisible placeholder
  // to reserve vertical space (prevents the header from jumping when the
  // status lands). 11px is the text-[11px] line height we use below.
  if (presence.isLoading || presence.status === "unknown") {
    return <p className="text-[11px] h-[16px]">&nbsp;</p>;
  }

  if (presence.status === "online") {
    return (
      <div className="flex items-center gap-1.5">
        {/* Pulsing green dot — signals "live" online status */}
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75 animate-ping" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
        </span>
        <p className="text-[11px] text-green-600 font-medium">Online</p>
      </div>
    );
  }

  // Offline — show "last seen at <time>" if we have a timestamp,
  // otherwise just "Offline".
  const lastSeenText = formatLastSeen(presence.lastSeenAt);
  return (
    <p className="text-[11px] text-muted-foreground">
      {lastSeenText ?? "Offline"}
    </p>
  );
}
