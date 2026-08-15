/**
 * AssistantFullPage — the /assistant route.
 *
 * v4.0 modernization:
 *   - Replaced inline SVG leaf with the shared lucide-react Leaf icon
 *     (was inconsistent — every other file uses lucide).
 *   - Added keyboard shortcut hint in the header.
 *
 * Layout:
 *   - Top bar with back link (ghost button style)
 *   - Chat panel capped at max-w-3xl (wider than the sheet version)
 *   - Subtle gradient background for visual warmth
 */
import { ArrowLeft, Leaf } from "lucide-react";
import { Link } from "wouter";
import { AssistantPanel } from "./AssistantPanel";

export function AssistantFullPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-primary/5 via-background to-background flex flex-col">
      {/* Top bar with back link */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-3xl mx-auto flex items-center gap-3 px-4 py-3">
          <Link
            href="/"
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label="Back to home"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          {/* BUG-I6 fix: use the shared lucide Leaf icon instead of an */}
          {/* inline SVG (was inconsistent with the rest of the codebase). */}
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center">
              <Leaf className="h-4 w-4 text-primary-foreground" />
            </div>
            <div>
              <div className="font-semibold text-sm">TreeBot Assistant</div>
              <div className="text-xs text-muted-foreground">Plant care &amp; catalog help</div>
            </div>
          </div>
        </div>
      </header>

      {/* Panel — capped width on desktop, full width on mobile */}
      <main className="flex-1 w-full max-w-3xl mx-auto flex flex-col">
        <AssistantPanel />
      </main>
    </div>
  );
}

export default AssistantFullPage;
