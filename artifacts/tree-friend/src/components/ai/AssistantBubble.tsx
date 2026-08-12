/**
 * AssistantBubble — the floating green button that opens the TreeBot panel.
 *
 * Renders as a fixed-position circular button at the bottom-right corner.
 * Sits ABOVE the FloatingCartIcon (higher z-index + offset) so the two
 * never overlap.
 *
 * Click → opens a Sheet (right-side panel) containing the AssistantPanel.
 *
 * Hidden on:
 *   - /chat and /messages routes (avoid overlap with the chat composer)
 *   - same convention as FloatingCartIcon
 *
 * The bubble uses a leaf icon (lucide `Leaf`) instead of a generic chat
 * bubble to reinforce the "plant expert" identity.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Leaf } from "lucide-react";
import { AssistantPanel } from "./AssistantPanel";

export function AssistantBubble() {
  const [open, setOpen] = useState(false);
  const [location, navigate] = useLocation();

  // Hide on conversation routes (mirrors FloatingCartIcon's logic).
  const isConversationRoute =
    location.startsWith("/chat") ||
    location.startsWith("/messages/") ||
    location === "/messages";

  // Also hide on the dedicated /assistant page (it has its own UI).
  const isAssistantPage = location === "/assistant";

  if (isConversationRoute || isAssistantPage) return null;

  return (
    <>
      {/* ─── Floating button ─────────────────────────────────────── */}
      <button
        type="button"
        aria-label="Open TreeBot assistant"
        onClick={() => setOpen(true)}
        className="fixed z-[60] h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-xl hover:shadow-2xl hover:-translate-y-0.5 transition-all duration-200 flex items-center justify-center group"
        style={{
          // Sit above the FloatingCartIcon (which is at z-9999 / inline-style
          // positioned by user). Use a small extra bottom offset so the
          // two buttons don't visually collide.
          bottom: "calc(env(safe-area-inset-bottom, 0px) + 5.5rem)",
          right: "calc(env(safe-area-inset-right, 0px) + 1.25rem)",
        }}
      >
        <Leaf className="h-6 w-6 transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-12" />
        {/* Subtle pulsing ring to attract attention on first visit */}
        <span className="absolute inset-0 rounded-full bg-primary/30 animate-ping opacity-20 pointer-events-none" />
      </button>

      {/* ─── Sheet (right side panel) ───────────────────────────────── */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-md p-0 flex flex-col h-full"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>TreeBot Assistant</SheetTitle>
          </SheetHeader>
          <AssistantPanel
            onClose={() => setOpen(false)}
            onOpenFullPage={() => {
              setOpen(false);
              navigate("/assistant");
            }}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
