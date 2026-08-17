/**
 * ToolCardErrorBoundary — React error boundary for AI tool-result cards.
 *
 * v6.2 Part 6 (P2-16): wraps each tool-result component (OrderDetailCard,
 * ListingGridCard, etc.) so a malformed backend payload or a render bug
 * in one card doesn't crash the entire AssistantPanel chat.
 *
 * Industry context:
 *   - ChatGPT, Claude, and Vercel AI SDK's `streamUI` all wrap tool-result
 *     rendering in error boundaries. A single bad tool payload shouldn't
 *     take down the whole conversation.
 *   - The tool-result data is untrusted: it comes from the LLM's tool call
 *     → backend `executeTool` → SSE `tool_result` event → useAiChat's
 *     `ChatMessage.toolResults[]`. Anywhere in that chain the shape could
 *     drift (backend refactor, partial cache hit, LLM hallucinated a
 *     tool name, etc.).
 *
 * Why a class component (not a function component + hook):
 *   - React error boundaries are a class-component feature. There's no hook
 *     equivalent as of React 19 (`componentDidCatch` requires `componentDid*`
 *     lifecycle, which only class components have). The React team has
 *     explicitly stated hooks aren't a fit for error boundaries.
 *
 * What this boundary catches:
 *   - Render-phase exceptions from the wrapped tool card (e.g.
 *     `Cannot read property 'price' of undefined` when the backend
 *     returns an unexpected shape).
 *   - Exceptions from child components the tool card renders (e.g.
 *     a malformed ChatVariantPickerDialog).
 *
 * What it does NOT catch:
 *   - Event handler errors (those bubble up to window.onerror, not React).
 *   - Async errors (fetch rejections, setTimeout callbacks).
 *   - Errors in the parent component (only children are caught).
 *
 * The fallback UI:
 *   - Matches the visual weight of the other tool cards (bordered box).
 *   - Shows a brief explanation + the tool name (so the user knows WHICH
 *     tool failed — useful for debugging).
 *   - Includes a "Dismiss" button that removes the broken card from the
 *     view (via a state flip — the parent re-renders without the broken
 *     child on next render cycle).
 *   - The error is also logged to the console with the tool name + stack
 *     for debugging — production monitoring can pick it up via Sentry
 *     or similar if/when wired.
 */
import { Component, type ReactNode, type ErrorInfo } from "react";
import { AlertCircle, X } from "lucide-react";

interface ToolCardErrorBoundaryProps {
  /** The tool name (e.g. "get_order_details") — shown in the fallback UI
   *  so the user/developer knows which tool's render failed. */
  toolName: string;
  children: ReactNode;
}

interface ToolCardErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  /** A nonce that bumps on each dismiss — used to reset the boundary so
   *  the user can dismiss the fallback and the parent's next render
   *  doesn't re-trigger the boundary. */
  dismissed: boolean;
}

/**
 * Friendly display names for known tools. Falls back to the raw tool name
 * if unmapped (defensive — new tools added to the backend without a
 * frontend label entry should still render gracefully).
 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  get_order_details: "Order details",
  get_user_orders: "Your orders",
  search_seller_listings: "Seller listings",
  get_product_care: "Care guide",
  search_knowledge_base: "Knowledge base",
  search_catalog: "Catalog search",
};

export class ToolCardErrorBoundary extends Component<
  ToolCardErrorBoundaryProps,
  ToolCardErrorBoundaryState
> {
  constructor(props: ToolCardErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, dismissed: false };
  }

  static getDerivedStateFromError(error: Error): Partial<ToolCardErrorBoundaryState> {
    // Update state so the next render shows the fallback UI.
    // We DON'T log here — `componentDidCatch` is the right place for
    // logging (it has the component stack).
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log to the console with full context. In production this should
    // be wired to Sentry / Datadog / similar — for now, console.error
    // is enough for the developer to spot the issue.
    //
    // We DON'T rethrow — the whole point of the boundary is to swallow
    // the error so the chat keeps working.
    const friendlyName = TOOL_DISPLAY_NAMES[this.props.toolName] ?? this.props.toolName;
    console.error(
      `[ToolCardErrorBoundary] Tool "${friendlyName}" (${this.props.toolName}) failed to render:`,
      error,
      errorInfo.componentStack,
    );
  }

  handleDismiss = () => {
    // Mark as dismissed — the parent will re-render this boundary, and
    // since `hasError` is still true but `dismissed` is true, we render
    // null instead of the fallback UI. The broken card effectively
    // disappears from the chat.
    //
    // NOTE: this doesn't reset `hasError` to false — if the parent re-
    // mounts the boundary with the same broken data, it would crash
    // again. Dismissal is one-way: the user removes the broken card
    // and the conversation continues without it.
    this.setState({ dismissed: true });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      // If dismissed, render nothing — the broken card is gone.
      if (this.state.dismissed) return null;

      const friendlyName = TOOL_DISPLAY_NAMES[this.props.toolName] ?? this.props.toolName;

      // Fallback UI — matches the visual weight of other tool cards
      // (bordered, padded) so the chat doesn't feel jarring.
      return (
        <div
          role="alert"
          className="border rounded-lg p-3 bg-destructive/5 border-destructive/20 flex items-start gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300"
        >
          <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-destructive font-medium">
              {friendlyName} couldn't be displayed
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              The data may have changed. Try asking again.
            </p>
          </div>
          <button
            type="button"
            onClick={this.handleDismiss}
            aria-label="Dismiss broken card"
            title="Dismiss"
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex-shrink-0"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
