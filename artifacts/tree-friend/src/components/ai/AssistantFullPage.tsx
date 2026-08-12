/**
 * AssistantFullPage — the /assistant route.
 *
 * v3.0 UI/UX: cleaner header, centered panel with max-width, subtle
 * background tint to distinguish the chat area from the page chrome.
 *
 * Layout:
 *   - Top bar with back link (ghost button style)
 *   - Chat panel capped at max-w-3xl (wider than the sheet version)
 *   - Subtle gradient background for visual warmth
 */
import { ArrowLeft } from "lucide-react";
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
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4 text-primary-foreground"
              >
                <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
                <path d="M2 21c0-3 1.85-5.36 5.08-6" />
              </svg>
            </div>
            <div>
              <div className="font-semibold text-sm">TreeBot Assistant</div>
              <div className="text-xs text-muted-foreground">
                Plant care & catalog help
              </div>
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
