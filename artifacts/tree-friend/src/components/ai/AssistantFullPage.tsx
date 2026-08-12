/**
 * AssistantFullPage — the /assistant route.
 *
 * Full-screen variant of the AssistantPanel. Used when the user clicks
 * "Expand" inside the floating Sheet. Especially useful on mobile where
 * the side panel takes the full screen anyway, but a dedicated page also
 * means users can bookmark /assistant or share the link.
 *
 * Layout:
 *   - Capped at max-w-2xl so the conversation doesn't stretch absurdly
 *     wide on large desktop monitors.
 *   - Header with a back button (returns to the previous page).
 *   - Body is the AssistantPanel itself (no onClose — full page, no sheet).
 */
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { AssistantPanel } from "./AssistantPanel";

export function AssistantFullPage() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top bar with back link */}
      <div className="flex items-center gap-3 px-4 py-3 border-b">
        <Link
          href="/"
          className="p-2 rounded-full hover:bg-muted transition-colors"
          aria-label="Back to home"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <div className="font-semibold">TreeBot Assistant</div>
          <div className="text-xs text-muted-foreground">
            Plant care & catalog help
          </div>
        </div>
      </div>

      {/* Panel — capped width on desktop, full width on mobile */}
      <div className="flex-1 w-full max-w-2xl mx-auto flex flex-col">
        <AssistantPanel />
      </div>
    </div>
  );
}

export default AssistantFullPage;
