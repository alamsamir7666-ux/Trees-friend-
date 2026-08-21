/**
 * toolNames.ts — single source of truth for AI tool names on the frontend.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 *
 * Previously, every frontend module that needed a tool name used a raw string
 * literal:
 *
 *   - `ToolComponentRenderer.tsx`  → `TOOL_UI_MAP = { get_order_details: ... }`
 *   - `AssistantBubble.tsx`        → `TOOL_LABELS = { search_catalog: ... }`
 *   - `Skeletons.tsx`              → `SKELETONS: Record<string, ...>`
 *   - `ToolCardErrorBoundary.tsx`  → `TOOL_DISPLAY_NAMES: Record<string, string>`
 *
 * Four parallel `Record<string, ...>` maps, all keyed by string. If the
 * backend (lib/aiTools.ts) renames or removes a tool, none of these files
 * know at compile time — the registry just silently misses, the UI falls
 * back to "no entry" behavior, and the rich card disappears.
 *
 * This file fixes that by:
 *
 *   1. Listing every backend tool name as a `const` tuple (the source of
 *      truth — kept in sync with `aiTools.ts` `executeTool` switch).
 *   2. Deriving `ToolName` as `typeof TOOL_NAMES[number]` — a string-literal
 *      union, NOT `string`. The compiler now rejects `"get_order_detail"`
 *      (typo, missing `s`) at compile time.
 *   3. Exporting a `toolName(s: string): s is ToolName` type guard so the
 *      SSE parser can narrow an unknown string from the wire to a typed
 *      tool name before lookup.
 *
 * ─── Maintenance contract ────────────────────────────────────────────────────
 *
 * When a tool is added/removed/renamed on the backend:
 *
 *   1. Update `TOOL_NAMES` here (add/remove/rename the literal).
 *   2. Run `pnpm --filter tree-friend run typecheck` — every frontend
 *      `Record<ToolName, ...>` map will now fail to compile if it's missing
 *      the new tool (or still references the old one). That's the safety
 *      net: the compiler forces you to update each map.
 *
 * The maps that depend on `ToolName`:
 *   - `TOOL_UI_MAP`            (ToolComponentRenderer.tsx)  — optional UI
 *   - `TOOL_LABELS`            (AssistantBubble.tsx)         — required label
 *   - `TOOLS_WITH_SKELETONS`    (AssistantBubble.tsx)        — optional
 *   - `TOOL_DISPLAY_NAMES`      (ToolCardErrorBoundary.tsx)   — required label
 *   - `SKELETONS`               (Skeletons.tsx)               — optional
 *
 * Required maps use `Record<ToolName, ...>` (every tool must have an entry).
 * Optional maps use `Partial<Record<ToolName, ...>>` (only tools with UI).
 *
 * ─── Backend source of truth ────────────────────────────────────────────────
 *
 * Cross-reference: artifacts/api-server/src/lib/aiTools.ts:
 *   - `executeTool(name, ...)` switch — defines the canonical tool list.
 *   - `USER_SCOPED_TOOLS` / `CATALOG_TOOLS` — privacy/tiering classification.
 *
 * If you change this file without also changing `executeTool`, or vice
 * versa, the typecheck will pass but the runtime behavior will diverge.
 * The comments above each entry below point to the backend definition.
 */

/**
 * Every tool name the backend's `executeTool` switch can dispatch.
 *
 * `as const` is essential — without it, TS widens the element type to
 * `string` and `ToolName` becomes `string` (useless). `as const` keeps
 * each element as its literal string type, so `typeof TOOL_NAMES[number]`
 * is the union of those literals.
 *
 * Order matches the order in `aiTools.ts`'s `executeTool` switch —
 * keep them in sync for easy diffing.
 */
export const TOOL_NAMES = [
  "search_catalog",
  "get_product_care",
  "get_user_orders",
  "get_order_details",
  "search_knowledge_base",
  "search_seller_listings",
] as const;

/**
 * The string-literal union of all backend tool names.
 *
 * Use this anywhere a tool name is stored, passed, or looked up —
 * instead of `string`. The compiler will reject typos and out-of-sync
 * references at build time.
 *
 * Example:
 *   const name: ToolName = "get_order_detail";  // ❌ compile error (missing s)
 *   const name: ToolName = "get_order_details";  // ✅
 */
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Tools that have a rich UI component registered in `TOOL_UI_MAP`.
 *
 * This is a subset of `ToolName` — the tools that emit `result` data the
 * frontend knows how to render. The backend's `executeTool` returns plain
 * objects for ALL tools, but only these are sent over the SSE wire with
 * `result` attached (see routes/ai.ts's `TOOLS_WITH_UI` set — same names,
 * mirrored here). Other tools' results stay on the server; the LLM's text
 * covers them.
 *
 * Typed as `readonly ToolName[]` so the array element type is the literal
 * union, not `string`. Adding a new UI tool = add to this array AND to
 * `TOOL_UI_MAP` (the typecheck will remind you if you forget one).
 */
export const TOOLS_WITH_UI: readonly ToolName[] = [
  "get_order_details",
  "get_user_orders",
  "search_seller_listings",
  "get_product_care",
  // NOTE: search_knowledge_base is rendered separately by KbCitations
  // (not via TOOL_UI_MAP), but it still has UI. Listed here so the
  // SSE parser knows to forward its `result` data even though no
  // TOOL_UI_MAP entry exists for it.
  "search_knowledge_base",
] as const;

/**
 * Type guard: narrows an unknown string from the wire (SSE payload `name`
 * field) to `ToolName`.
 *
 * Use this in the SSE parser before looking up the tool in any
 * `Record<ToolName, ...>` map. The parser receives `payload.name` as
 * `string` (JSON doesn't carry our TS types) — this guard safely narrows
 * it so the lookup is type-checked.
 *
 * If the backend sends an unknown tool name (typo, future tool we haven't
 * added to `TOOL_NAMES` yet), this returns `false` and the caller can
 * log + skip instead of crashing.
 *
 * Example:
 *   if (isToolName(payload.name)) {
 *     const label = TOOL_LABELS[payload.name];  // ✅ typed access
 *   } else {
 *     logger.warn("Unknown tool name from SSE:", payload.name);
 *   }
 */
export function isToolName(s: string): s is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(s);
}
