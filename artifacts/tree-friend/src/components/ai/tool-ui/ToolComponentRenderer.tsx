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
 * Part 2 added:
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
 *
 * v6.2 Part 12 (this revision) — Gap Fix #1 + #2:
 *   - Tool names are now typed as `ToolName` (string-literal union) instead
 *     of `string`. The `TOOL_UI_MAP` keys are checked at compile time — a
 *     typo like `get_order_detail` (missing `s`) is now a TS error, not a
 *     silent runtime miss.
 *   - Tool-result data is now validated with Zod schemas BEFORE rendering
 *     each card. A malformed payload (backend schema drift) is caught at
 *     the boundary — the card renders the error fallback UI instead of
 *     crashing inside React's render phase. This is preventive (validate
 *     before mount) rather than reactive (catch the crash after mount via
 *     ToolCardErrorBoundary). Both layers stay in place — defense in depth.
 *   - Each card component now receives a TYPED data prop (e.g.
 *     `OrderResult`) instead of `unknown`. The `as` casts that lived
 *     inside each card are gone — the type flows from the Zod schema.
 */
import type { ToolResultEntry } from "@/hooks/useAiChat";
import { AlertCircle } from "lucide-react";
import { OrderDetailCard } from "./OrderDetailCard";
import { OrderListCard } from "./OrderListCard";
import { ListingGridCard } from "./ListingGridCard";
import { CareGuideCard } from "./CareGuideCard";
import { KbCitations } from "./KbCitations";
import { ToolCardErrorBoundary } from "./ToolCardErrorBoundary";
import { type ToolName, isToolName } from "./toolNames";
import { validateToolResult } from "./schemas";

// ─── Component registry ───────────────────────────────────────────────────
//
// Each card component now declares its expected `data` prop type — no more
// `data: unknown`. The renderer passes a value that has ALREADY been
// validated by Zod, so the cast inside each card is no longer needed.
//
// The component type is a generic `React.FC<{ data: any; onClose?: () => void }>`
// here because each card has a DIFFERENT data prop type (OrderResult,
// OrdersResult, etc.). We can't express a single typed map that holds
// components with different prop types — TS doesn't support heterogeneous
// maps. Instead, the lookup returns `React.FC<any>` and the actual
// validation + render is dispatched in a switch statement below, where
// each branch is fully typed.
//
// This is the same trade-off as the Vercel AI SDK's streamUI registry:
// the lookup is loose-typed, but the dispatch is strict-typed.

interface ToolComponentProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  /**
   * v6.2 Part 15: the user's most recent question, threaded through to
   * each card's callout picker so the FactCallout can surface the single
   * most relevant fact for what the user actually asked.
   */
  userQuestion?: string;
  onClose?: () => void;
}

type ToolComponent = React.FC<ToolComponentProps>;

// Keys are typed as `ToolName` (string-literal union from toolNames.ts).
// A typo'd key like `get_order_detail` would now be a compile-time error,
// not a silent runtime miss. If the backend adds/removes a tool, update
// toolNames.ts first — then this map's typecheck will guide you to add/
// remove the corresponding entry.
const TOOL_UI_MAP: Partial<Record<ToolName, ToolComponent>> = {
  get_order_details: OrderDetailCard as ToolComponent,
  get_user_orders: OrderListCard as ToolComponent,
  search_seller_listings: ListingGridCard as ToolComponent,
  get_product_care: CareGuideCard as ToolComponent,
  // NOTE: search_knowledge_base is intentionally NOT in this map. Its
  // result data is consumed by KbCitations (rendered separately at the
  // end of the stack), not by a dedicated card component.
};

// ─── Error-envelope detection helper ──────────────────────────────────────
//
// The success-path response shape for each tool has ONE primary field that
// is ALWAYS present when the tool succeeded (even on "no data" outcomes like
// "order not found" returns `{ order: null, error: "Product not found" }`).
//
// executeTool's catch block (aiTools.ts:618-621) returns `{ error: "..." }`
// with NO primary field. We use this map to distinguish a real error envelope
// from a success-path response that happens to include an `error` message.
//
// Kept as `Partial<Record<ToolName, string>>` because tools without UI
// entries (search_catalog, search_knowledge_base) aren't dispatched through
// this code path — no need to specify their primary field.
const TOOL_PRIMARY_SUCCESS_FIELD: Partial<Record<ToolName, string>> = {
  get_order_details: "order",
  get_user_orders: "signed_in",
  search_seller_listings: "listings",
  get_product_care: "product",
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
 *
 * v6.2 Part 12 (Gap Fix #1): each tool result is validated with its Zod
 * schema BEFORE the card renders. On validation failure, the card shows
 * the same error UI as `ok: false` results — a destructive-styled box
 * with a retry hint. This is the industry-standard trust-boundary pattern:
 * untrusted data is validated at the component edge, not inside the
 * component (where a missing field would crash React's render phase and
 * require the ToolCardErrorBoundary to recover).
 */
export function ToolComponentRenderer({
  toolResults,
  userQuestion,
  onClose,
}: {
  toolResults: ToolResultEntry[];
  /**
   * v6.2 Part 15: the user's most recent question, threaded through to
   * each card's callout picker so the FactCallout surfaces the single
   * most relevant fact for what the user actually asked. Optional —
   * if absent, no callout is rendered (graceful degradation to the
   * pre-Part-15 behavior: just the structured grid).
   */
  userQuestion?: string;
  onClose?: () => void;
}) {
  if (!toolResults || toolResults.length === 0) return null;

  const components: React.ReactNode[] = [];

  for (const result of toolResults) {
    // ─── Skip tools without UI ────────────────────────────────────────────
    // Use the type guard so the lookup is type-safe. Unknown tool names
    // (typos on the wire, future tools we haven't added to TOOL_NAMES)
    // are caught here — log + skip.
    if (!isToolName(result.name)) {
      // Don't log here — this is a hot path (runs on every render). The
      // SSE parser in useAiChat should have already logged unknown names
      // when they first arrived. If we got here, the name IS in our
      // TOOL_NAMES list but has no UI component (e.g. search_catalog).
      continue;
    }
    const Component = TOOL_UI_MAP[result.name];
    if (!Component) continue; // no UI registered for this tool — skip

    // ─── Error results (tool execution failed on the backend) ─────────────
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

    // ─── No data sent over the wire ────────────────────────────────────────
    if (result.data === undefined) {
      // Tool succeeded but the backend didn't send result data (too large
      // or not in the TOOLS_WITH_UI set). Skip — the LLM's text already
      // covers it.
      continue;
    }

    // ─── v6.2 Part 12 (Gap Fix #1): runtime Zod validation ────────────────
    //
    // The tool-result payload is untrusted: it crossed a process boundary
    // (backend → SSE → frontend state). Even if the backend TS types match
    // ours, runtime drift happens (DB schema change, partial cache hit,
    // legacy deployment). Validate at the boundary before rendering.
    //
    // On failure: log the validation error + render the same error UI as
    // `ok: false`. The user sees a clear "this failed, try again" message
    // instead of a half-rendered card with undefined fields.
    //
    // The card components no longer need to defensively cast `data` or
    // guard against missing fields — they receive a Zod-validated value.
    const validationResult = validateToolResult(result.name, result.data);
    if (!validationResult.success) {
      // Use console.warn (not console.error) — this is an expected class
      // of failure (backend drift), not a code bug. The ToolCardErrorBoundary
      // catches RENDER errors (code bugs); validation errors are caught
      // here, BEFORE render.
      //

      console.warn(
        `[ToolComponentRenderer] Tool "${result.name}" returned malformed data:`,
        validationResult.error,
        { rawData: result.data },
      );
      components.push(
        <div
          key={`invalid-${result.name}-${result.durationMs ?? 0}`}
          className="border rounded-lg p-3 bg-destructive/5 border-destructive/20 flex items-start gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300"
          role="alert"
        >
          <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs text-destructive font-medium">
              This information couldn't be displayed
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              The data may have changed. Try asking again.
            </p>
          </div>
        </div>,
      );
      continue;
    }

    // ─── Error-envelope detection (ok:true but data is actually an error) ──
    //
    // Bug context: when executeTool's catch block fires (DB connection error,
    // tool implementation threw, etc.), it returns `{ error: "Tool execution
    // failed..." }` — an envelope with NO success-path fields (no signed_in,
    // no orders, no order, no product, no listings).
    //
    // The SSE pipe (routes/ai.ts:1889) checks `event.ok` — which is `true`
    // here (gemini.ts:1423 / groq.ts:930 set ok=true whenever executeTool
    // returned any value, even an error envelope). So the envelope is sent
    // over the wire as `{ ok: true, result: { error: "..." } }`.
    //
    // Without this branch, the frontend would render the success-path card
    // component with `data = { error: "..." }`. The card would access
    // `data.signed_in` (undefined), `data.orders` (undefined), etc. — and
    // either crash or render an empty state that misleads the user (e.g.
    // "Sign in to view your orders" when the real cause was a backend
    // execution failure).
    //
    // Detection: the envelope has `error` set (string) AND the success-path
    // primary field for this tool is absent. The primary field is per-tool:
    //   - get_order_details:    `order`
    //   - get_user_orders:      `signed_in`
    //   - search_seller_listings: `listings`
    //   - get_product_care:     `product`
    //
    // We use the primary-field lookup so we DON'T false-positive on success-
    // path responses that legitimately include `error` alongside the primary
    // data (e.g. OrderDetailCard's success-path shape is
    // `{ order: <data|null>, error?: "Product not found" }`).
    const validatedData = validationResult.data as Record<string, unknown>;
    const primaryField = TOOL_PRIMARY_SUCCESS_FIELD[result.name];
    const isErrorEnvelope =
      typeof validatedData?.error === "string" &&
      (primaryField === undefined || validatedData[primaryField as string] === undefined);

    if (isErrorEnvelope) {
      components.push(
        <div
          key={`error-env-${result.name}-${result.durationMs ?? 0}`}
          className="border rounded-lg p-3 bg-destructive/5 border-destructive/20 flex items-start gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300"
          role="alert"
        >
          <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs text-destructive font-medium">
              {String(validatedData.error) || `${result.name} failed`}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Try asking again — the AI can retry the lookup.
            </p>
          </div>
        </div>,
      );
      continue;
    }

    // ─── Render the validated card ───────────────────────────────────────
    //
    // The data is now typed (via the Zod schema's inferred type) — but
    // TS can't track which schema matched which component through the
    // TOOL_UI_MAP lookup (the map is typed `Partial<Record<ToolName, FC<any>>>`).
    // The cast through `unknown` here is safe because:
    //   1. The schema matched the tool name (we just validated it).
    //   2. Each card declares its expected prop type — TS will catch a
    //      mismatch at the card's import site.
    //
    // v6.2 Part 3: CSS animation (smooth fade-in + slide-up).
    // v6.2 Part 6 (P2-16): wrap each card in ToolCardErrorBoundary so a
    //    render-phase crash (a code bug NOT caught by Zod validation,
    //    e.g. a card referencing a schema-optional field as if required)
    //    doesn't take down the whole chat.
    components.push(
      <ToolCardErrorBoundary
        key={`${result.name}-${result.durationMs ?? 0}`}
        toolName={result.name}
      >
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
          {/* v6.2 Part 15: thread userQuestion through to each card so */}
          {/* its FactCallout can pick the most relevant fact.          */}
          <Component data={validatedData} userQuestion={userQuestion} onClose={onClose} />
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
