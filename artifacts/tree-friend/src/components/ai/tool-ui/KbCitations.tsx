/**
 * KbCitations — renders source attribution chips for KB-grounded answers.
 *
 * v6.2 Part 6 (P2-11): industry-standard RAG citations (Perplexity, Bing
 * Chat, ChatGPT with browsing). When the AI calls the `search_knowledge_base`
 * tool, the backend returns the matched KB entries with their source info
 * (title, type, URL). This component renders those sources as numbered
 * citation chips below the assistant message — so the user can see WHERE
 * the answer came from and click through to the source.
 *
 * Data shape (from the search_knowledge_base tool result in aiTools.ts):
 *   { results: [{ title, content, keywords, category, product,
 *     source: { type, title, url } | null, relevance_score }], count }
 *
 * We extract the unique sources (multiple KB entries often share a source —
 * e.g. 3 entries from "Mango Care Guide — Bangladesh Horticulture Board"),
 * dedupe by URL (or title when URL is null), and render up to 5 chips.
 *
 * Industry-standard citation UX:
 *   - Numbered chips ([1], [2], …) — Perplexity/Bing Chat pattern.
 *   - Clickable when the source has a URL — opens in a new tab with
 *     rel=noopener noreferrer (security).
 *   - Non-clickable when the source is internal (URL null) — shows just
 *     the title as a static chip.
 *   - Source type icon (BookOpen for articles, Video for YouTube, etc.)
 *     so the user knows what kind of source it are clicking into.
 *   - "Sources" label above the chips for clarity (matches the AI's
 *     text response often saying "Based on X, Y, Z…").
 *
 * Why a separate component (not part of CareGuideCard):
 *   - The KB tool is called by BOTH the AI (when it decides to invoke
 *     `search_knowledge_base` directly) AND by the chat route (auto-inject
 *     into the prompt). The CareGuideCard only renders when the AI calls
 *     `get_product_care`. KB citations need to appear whenever the
 *     `search_knowledge_base` tool was used, regardless of which other
 *     tool cards also appear.
 *   - Keeping citations as a separate component lets the
 *     ToolComponentRenderer place them at the END of the tool stack
 *     (after the rich cards) — the natural reading order.
 */
import { memo } from "react";
import { BookOpen, Video, FileText, ExternalLink, Link2 } from "lucide-react";
import type { ToolResultEntry } from "@/hooks/useAiChat";
// v6.2 Part 12 (Gap Fix #1): types flow from the Zod schema. The local
// KbEntry / KbToolResult interfaces are gone — they're now inferred +
// validated. validateKbResult runs safeParse at the boundary so
// extractKbCitations consumes only typed data.
import { validateKbResult } from "./schemas";

/**
 * A deduped source ready to render as a chip.
 */
interface Citation {
  /** 1-indexed citation number — matches the [1], [2] convention. */
  number: number;
  /** Display title (falls back to "Untitled source" if missing). */
  title: string;
  /** URL if clickable, null if internal. */
  url: string | null;
  /** Source type — drives the icon. */
  type: string;
}

/**
 * Extracts unique citation sources from a list of tool results.
 *
 * Walks all `search_knowledge_base` tool results in the array, collects
 * the entries, dedupes by URL (or title when URL is null), and returns
 * up to 5 sources. The order preserves first-appearance so the numbers
 * match the order the AI cited them.
 *
 * Exported so it can be unit-tested in isolation if we add tests later.
 */
export function extractKbCitations(toolResults: ToolResultEntry[]): Citation[] {
  const citations: Citation[] = [];
  const seen = new Set<string>();

  for (const result of toolResults) {
    if (result.name !== "search_knowledge_base") continue;
    if (!result.ok || !result.data) continue;
    // v6.2 Part 12 (Gap Fix #1): validate the KB result with the Zod
    // schema before consuming. If the backend drifts (e.g. results field
    // renamed), we skip this entry instead of crashing. The KbCitations
    // component is rendered by ToolComponentRenderer AFTER the rich cards
    // and isn't wrapped in ToolCardErrorBoundary — so this safeParse is
    // the primary defense (no boundary fallback).
    const data = validateKbResult(result.data);
    if (!data) continue;

    for (const entry of data.results) {
      const source = entry.source;
      if (!source) continue;
      const title = source.title?.trim() || entry.title?.trim() || "Untitled source";
      // Privacy fix (defense-in-depth): the backend now strips `url` from the
      // tool result (aiTools.ts searchKb). We also strip it here on the
      // frontend as a second layer — if the backend ever drifts and starts
      // including URLs again, the frontend won't render clickable external
      // links (especially YouTube video links) in the chat response.
      // The system prompt explicitly says "Do not attribute it to any specific
      // person or source" — rendering a clickable YouTube URL violates this.
      const url = null;
      const type = source.type?.trim() || "article";

      // Dedupe key: URL if present, otherwise title (so two URL-less
      // sources with the same title don't both appear).
      const dedupeKey = url ?? `title:${title.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      citations.push({
        number: citations.length + 1,
        title,
        url,
        type,
      });
      if (citations.length >= 5) return citations;
    }
  }

  return citations;
}

/**
 * Picks an icon for a source type. Defaults to FileText for unknown types.
 *
 * The backend's source types include: "article", "youtube", "blog",
 * "pdf", "website". We map the common ones; unknown types get a generic
 * FileText icon (the catch-all for "document-like thing").
 */
function iconForType(type: string): typeof BookOpen {
  const t = type.toLowerCase();
  if (t.includes("youtube") || t.includes("video")) return Video;
  if (t.includes("article") || t.includes("blog")) return BookOpen;
  if (t.includes("pdf") || t.includes("document")) return FileText;
  if (t.includes("website") || t.includes("link")) return Link2;
  return FileText;
}

/**
 * Truncates a title to a max length, adding an ellipsis if needed.
 * Keeps chat bubbles compact — long source titles can wrap and break
 * the chip layout.
 */
function truncateTitle(title: string, max = 40): string {
  if (title.length <= max) return title;
  return title.slice(0, max - 1).trimEnd() + "…";
}

export const KbCitations = memo(function KbCitations({
  toolResults,
}: {
  toolResults: ToolResultEntry[];
}) {
  const citations = extractKbCitations(toolResults);
  if (citations.length === 0) return null;

  return (
    <div className="mt-2.5 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
        Sources
      </p>
      <div className="flex flex-wrap gap-1.5">
        {citations.map((citation) => {
          const Icon = iconForType(citation.type);
          const label = truncateTitle(citation.title);
          // Extract URL to a local + check validity — TypeScript narrows
          // `url` to `string` inside the `if (isClickable)` block via
          // the const reference. Avoids the non-null assertion lint.
          const url = citation.url;
          const isClickable = url != null && url.length > 0 && /^https?:\/\//i.test(url);

          const content = (
            <>
              <span className="text-[9px] font-mono tabular-nums bg-muted/60 text-muted-foreground rounded px-1 py-0.5 mr-1.5">
                {citation.number}
              </span>
              <Icon className="h-3 w-3 flex-shrink-0" />
              <span className="truncate ml-1">{label}</span>
              {isClickable && (
                <ExternalLink className="h-2.5 w-2.5 ml-1 flex-shrink-0 opacity-60" />
              )}
            </>
          );

          // Render as a real <a> when clickable, otherwise a <span>.
          // Both share the same visual treatment; only the semantics differ.
          const className =
            "inline-flex items-center text-[11px] px-2 py-1 rounded-full border bg-background/60 transition-colors " +
            (isClickable
              ? "border-border hover:border-primary/40 hover:bg-primary/5 cursor-pointer"
              : "border-border/60 text-muted-foreground");

          if (isClickable && url) {
            return (
              <a
                key={citation.number}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className={className}
                title={citation.title}
                aria-label={`Source ${citation.number}: ${citation.title}`}
              >
                {content}
              </a>
            );
          }
          return (
            <span
              key={citation.number}
              className={className}
              title={citation.title}
              aria-label={`Source ${citation.number}: ${citation.title}`}
            >
              {content}
            </span>
          );
        })}
      </div>
    </div>
  );
});
