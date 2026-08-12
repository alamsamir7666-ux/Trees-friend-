/**
 * AssistantBubble — the floating button that opens the TreeBot panel.
 *
 * v3.0 UI/UX: cleaner, more polished design.
 *   - Subtle shadow instead of harsh pulsing ring
 *   - Gentle hover lift + icon rotation
 *   - Gradient background for visual depth
 *   - Notification dot when there's a new message (future use)
 *
 * Click → opens a Sheet (right-side panel) containing the AssistantPanel.
 *
 * Hidden on:
 *   - /chat and /messages routes (avoid overlap with chat composer)
 *   - /assistant page (has its own UI)
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

  // Also hide on the dedicated /assistant page.
  const isAssistantPage = location === "/assistant";

  if (isConversationRoute || isAssistantPage) return null;

  return (
    <>
      {/* ─── Floating button ─────────────────────────────────────────── */}
      <button
        type="button"
        aria-label="Open TreeBot assistant"
        onClick={() => setOpen(true)}
        className="group fixed z-[60] h-14 w-14 rounded-full bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-lg hover:shadow-xl hover:-translate-y-1 active:scale-95 transition-all duration-200 flex items-center justify-center"
        style={{
          bottom: "calc(env(safe-area-inset-bottom, 0px) + 5.5rem)",
          right: "calc(env(safe-area-inset-right, 0px) + 1.25rem)",
        }}
      >
        <Leaf className="h-6 w-6 transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-12" />
        {/* Subtle ping — only on first render (no constant animation) */}
        <span className="absolute inset-0 rounded-full bg-primary/20 animate-ping opacity-30 pointer-events-none group-hover:opacity-0 transition-opacity" />
      </button>

      {/* ─── Sheet (right side panel) ─────────────────────────────────── */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-md p-0 flex flex-col h-full border-l shadow-xl"
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
