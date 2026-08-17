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
 */
import type { ToolResultEntry } from "@/hooks/useAiChat";
import { OrderDetailCard } from "./OrderDetailCard";

// ─── Component registry ───────────────────────────────────────────────────

interface ToolComponentProps {
  data: unknown;
  onClose?: () => void;
}

const TOOL_UI_MAP: Record<string, React.FC<ToolComponentProps>> = {
  get_order_details: OrderDetailCard,
  // Part 2 will add:
  // get_user_orders: OrderListCard,
  // search_seller_listings: ListingGridCard,
  // get_product_care: CareGuideCard,
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
      // Tool errored — show a compact error card.
      components.push(
        <div
          key={`${result.name}-${result.durationMs ?? 0}`}
          className="border rounded-lg p-3 bg-destructive/5 border-destructive/20"
        >
          <p className="text-xs text-destructive">{result.error || `${result.name} failed`}</p>
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

    components.push(
      <Component
        key={`${result.name}-${result.durationMs ?? 0}`}
        data={result.data}
        onClose={onClose}
      />,
    );
  }

  if (components.length === 0) return null;

  return <div className="space-y-2 mt-2.5">{components}</div>;
}
