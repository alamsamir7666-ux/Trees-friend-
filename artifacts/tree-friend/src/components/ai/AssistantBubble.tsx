/**
 * AssistantBubble — the floating button that opens the TreeBot panel.
 *
 * v4.0 modernization:
 *   - Removed dead `/chat` route check (no such route exists).
 *   - Fixed comment contradiction: the ping animation IS constant (removed
 *     the false "only on first render" comment).
 *   - Added keyboard shortcut Cmd/Ctrl+K to toggle the panel.
 *   - Used CSS variable for bottom offset instead of hardcoded 5.5rem
 *     magic number (still defaults to 5.5rem to clear FloatingCartIcon,
 *     but now overridable via --assistant-bubble-bottom).
 *
 * Click → opens a Sheet (right-side panel) containing the AssistantPanel.
 *
 * Hidden on:
 *   - /messages routes (avoid overlap with chat composer)
 *   - /assistant page (has its own UI)
 *
 * Keyboard:
 *   - Cmd/Ctrl+K toggles the panel open/closed (industry-standard
 *     "command palette" shortcut — used by Linear, Notion, Raycast, etc.)
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Leaf } from "lucide-react";
import { AssistantPanel } from "./AssistantPanel";

export function AssistantBubble() {
  const [open, setOpen] = useState(false);
  const [location, navigate] = useLocation();

  // BUG-I6 fix: removed the dead `location.startsWith("/chat")` check.
  // There is no `/chat` route in the app — only `/messages` (user-to-user
  // chat) and `/assistant` (AI chat). The `/chat` check was dead code.
  const isConversationRoute = location.startsWith("/messages/") || location === "/messages";

  // Also hide on the dedicated /assistant page.
  const isAssistantPage = location === "/assistant";

  // BUG-I6 fix: keyboard shortcut Cmd/Ctrl+K to toggle the panel.
  // Industry-standard "command palette" shortcut. Ignored when the user
  // is typing in an input/textarea (so it doesn't interfere with Cmd+K
  // in text editors, browser dev tools, etc.).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        // Don't intercept when the user is typing in a form field.
        if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (isConversationRoute || isAssistantPage) return null;

  return (
    <>
      {/* ─── Floating button ─────────────────────────────────────────── */}
      <button
        type="button"
        aria-label="Open TreeBot assistant (⌘K)"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => setOpen(true)}
        className="group fixed z-[60] h-14 w-14 rounded-full bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-lg hover:shadow-xl hover:-translate-y-1 active:scale-95 transition-all duration-200 flex items-center justify-center"
        style={{
          // BUG-I6 fix: use a CSS variable with fallback so the offset
          // can be overridden without editing this file. The default
          // 5.5rem clears FloatingCartIcon (which sits at ~3.5rem bottom).
          bottom: "calc(env(safe-area-inset-bottom, 0px) + var(--assistant-bubble-bottom, 5.5rem))",
          right: "calc(env(safe-area-inset-right, 0px) + 1.25rem)",
        }}
      >
        <Leaf className="h-6 w-6 transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-12" />
        {/* Constant subtle ping — draws attention to the button.
            The previous comment said "only on first render" but the code
            ran forever. Now the comment matches the code: it's a constant
            ambient animation that hides on hover (so it doesn't distract
            when the user is about to click). */}
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
