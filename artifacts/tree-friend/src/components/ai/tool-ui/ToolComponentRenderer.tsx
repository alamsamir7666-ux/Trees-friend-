/**
 * ToolComponentRenderer — maps tool names → rich React components (v6.2 Part 1).
 *
 * Industry standard: same pattern as Vercel AI SDK's `streamUI` +
 * tool-component registry. The chat hook captures tool result data from
 * the `tool_result` SSE event (useAiChat.ts), stores it on the
 * `ChatMessage.toolResults` field, and this component renders the matching
 * rich UI inline in the chat.
 *
 * Registry pattern: add new components by adding an entry to TOOL_UI_MAP.
 * Each entry maps a tool name to a React component that receives the tool's
 * result data as props.
 *
 * Part 1 components:
 *   - get_order_details → OrderDetailCard (order with timeline, items, buttons)
 *
 * Part 2 will add:
 *   - get_user_orders → OrderListCard
 *   - search_seller_listings → ListingGridCard
 *   - get_product_care → CareGuideCard
 *
 * v6.2 Part 6 changes:
 *   - P2-16: Each tool card is wrapped in <ToolCardErrorBoundary> so a
 *     malformed payload crashes only that one card, not the whole chat.
 *   - P2-14: All cards (OrderDetailCard, OrderListCard, ListingGridCard,
 *     CareGuideCard) are now wrapped in React.memo — they don't re-render
 *     when the parent's SSE deltas arrive (only their own data prop
 *     changes triggers re-render).
 *   - P2-11: KbCitations rendered at the end of the stack — extracts
 *     source info from any `search_knowledge_base` tool results in this
 *     message's toolResults and renders them as numbered citation chips
 *     (Perplexity/Bing Chat pattern).
 */
import type { ToolResultEntry } from "@/hooks/useAiChat";
import { AlertCircle } from "lucide-react";
import { OrderDetailCard } from "./OrderDetailCard";
import { OrderListCard } from "./OrderListCard";
import { ListingGridCard } from "./ListingGridCard";
import { CareGuideCard } from "./CareGuideCard";
import { KbCitations } from "./KbCitations";
import { ToolCardErrorBoundary } from "./ToolCardErrorBoundary";

// ─── Component registry ───────────────────────────────────────────────────

interface ToolComponentProps {
  data: unknown;
  onClose?: () => void;
}

const TOOL_UI_MAP: Record<string, React.FC<ToolComponentProps>> = {
  get_order_details: OrderDetailCard,
  get_user_orders: OrderListCard,
  search_seller_listings: ListingGridCard,
  get_product_care: CareGuideCard,
};

/**
 * Renders all tool-result components for a given message.
 *
 * Called by AssistantPanel after the text bubble + chips. Renders each
 * tool result as a rich component in the vertical stack (same pattern as
 * ProductChips / ListingChips — stacked below the text bubble).
 *
 * Tools without a registered component are silently skipped (the LLM's
 * text response already covers them).
 */
export function ToolComponentRenderer({
  toolResults,
  onClose,
}: {
  toolResults: ToolResultEntry[];
  onClose?: () => void;
}) {
  if (!toolResults || toolResults.length === 0) return null;

  const components: React.ReactNode[] = [];

  for (const result of toolResults) {
    const Component = TOOL_UI_MAP[result.name];
    if (!Component) continue; // no UI registered for this tool — skip

    if (!result.ok) {
      // v6.2 Part 3: enhanced error state with retry hint.
      components.push(
        <div
          key={`error-${result.name}-${result.durationMs ?? 0}`}
          className="border rounded-lg p-3 bg-destructive/5 border-destructive/20 flex items-start gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300"
        >
          <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs text-destructive font-medium">
              {result.error || `${result.name} failed`}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Try asking again — the AI can retry the lookup.
            </p>
          </div>
        </div>,
      );
      continue;
    }

    if (result.data === undefined) {
      // Tool succeeded but the backend didn't send result data (too large
      // or not in the TOOLS_WITH_UI set). Skip — the LLM's text already
      // covers it.
      continue;
    }

    // v6.2 Part 3: CSS animation (smooth fade-in + slide-up).
    // v6.2 Part 6 (P2-16): wrap each card in ToolCardErrorBoundary so a
    // malformed payload crashes only this card, not the whole chat.
    // The boundary's `toolName` prop is used in the fallback UI so the
    // user knows which tool failed.
    components.push(
      <ToolCardErrorBoundary
        key={`${result.name}-${result.durationMs ?? 0}`}
        toolName={result.name}
      >
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
          <Component data={result.data} onClose={onClose} />
        </div>
      </ToolCardErrorBoundary>,
    );
  }

  // v6.2 Part 6 (P2-11): render KB source citations at the end of the
  // stack — they reference all `search_knowledge_base` tool results in
  // this message. Rendered AFTER the rich cards so the user reads the
  // answer first, then sees where it came from (matches the natural
  // reading order; matches Perplexity/Bing Chat layout).
  const hasKbCitations = toolResults.some(
    (r) => r.name === "search_knowledge_base" && r.ok && r.data != null,
  );
  if (hasKbCitations) {
    components.push(<KbCitations key="kb-citations" toolResults={toolResults} />);
  }

  if (components.length === 0) return null;

  return <div className="space-y-2 mt-2.5">{components}</div>;
}
