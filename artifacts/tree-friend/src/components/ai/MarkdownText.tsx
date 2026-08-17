/**
 * Lightweight markdown renderer for TreeBot messages.
 *
 * v4.0 modernization:
 *   - Added link support: `[text](url)` → clickable `<a>` with target=_blank.
 *   - Added fenced code block support: ``` ``` blocks → `<pre><code>`.
 *   - Added heading support: `#` / `##` / `###` → `<h3>` / `<h4>` / `<h5>`.
 *   - Fixed trailing comma in `out.push(<code>…</code>,)` (stylistic).
 *   - Added `aria-label` to code blocks for screen readers.
 *
 * v6.2 Part 6 (P2-12): Added GFM table support.
 *   - Parses GitHub-Flavored Markdown tables:
 *       | Header 1 | Header 2 |
 *       |----------|----------|
 *       | Cell 1   | Cell 2   |
 *   - Alignment row (`:---`, `---:`, `:---:`) controls cell text alignment.
 *   - Renders as a real <table> with proper <thead>/<tbody> + sticky header
 *     styling. Cells support inline markdown (bold/italic/code/links).
 *   - Truncates tables to 20 rows + 8 cols for performance + readability —
 *     larger tables are unwieldy in a chat bubble and the LLM rarely
 *     generates them.
 *
 * Why not use react-markdown?
 *   - Adding react-markdown + remark-gfm + rehype-sanitize is ~80kb gzipped.
 *   - A purpose-built renderer is ~250 lines (with tables), ~4kb, and
 *     XSS-safe (we control every output element, no dangerouslySetInnerHTML).
 *
 * Supported syntax:
 *   - **bold** → <strong>
 *   - *italic* → <em>
 *   - `inline code` → <code>
 *   - [text](url) → <a target="_blank" rel="noopener noreferrer">
 *   - ```fenced code``` → <pre><code>
 *   - # / ## / ### headings → <h3> / <h4> / <h5>
 *   - Lines starting with "- " or "• " → bullet list (<ul><li>)
 *   - GFM tables (header row + separator row + body rows) → <table>
 *   - Double newline → paragraph break
 *   - [[product name]] → bare text (the link wrapper is added separately)
 */
import { type JSX } from "react";

interface Block {
  type: "paragraph" | "list" | "code" | "heading" | "table";
  items?: string[]; // for list blocks
  text?: string; // for paragraph / code / heading blocks
  level?: 1 | 2 | 3; // for heading blocks
  table?: ParsedTable; // for table blocks
}

/**
 * A parsed GFM table.
 *
 * - `headers`: header cells (already trimmed; inline markdown NOT yet rendered).
 * - `rows`: body rows; each row is an array of cell strings.
 * - `aligns`: per-column alignment ('left' | 'center' | 'right' | null).
 *   Driven by the separator row: `:---` = left, `---:` = right,
 *   `:---:` = center, plain `---` = null (default = left via CSS).
 */
interface ParsedTable {
  headers: string[];
  rows: string[][];
  aligns: ("left" | "center" | "right" | null)[];
}

/**
 * Hard caps for performance + chat-bubble readability. The LLM rarely
 * generates larger tables, but if it does, truncating avoids jank.
 */
const MAX_TABLE_ROWS = 20;
const MAX_TABLE_COLS = 8;

/**
 * v6.2 Part 8 (Gap I fix): sentinel character used to temporarily replace
 * escaped pipes (`\|`) before splitting a table row on `|`.
 *
 * Why a control character (U+0001 SOH, "Start of Heading"):
 *   - It's extremely unlikely to appear in plant-care text (it's not
 *     typable on any keyboard + not in any natural language).
 *   - It's a single code unit (won't mess with split/join length math).
 *   - It survives JSON serialization (control chars below U+0020 are
 *     valid in JSON strings, though some linters warn — but we restore
 *     it immediately after split, so it never persists).
 *
 * The flow:
 *   1. Before splitting: replace `\|` with the sentinel.
 *   2. Split on `|` (now only real cell-separator pipes remain).
 *   3. Restore: replace the sentinel back to `|` in each cell.
 *
 * This handles the GFM spec's escaped-pipe rule: `|` inside a cell must
 * be escaped as `\|` so it's not treated as a cell separator.
 */
const ESCAPED_PIPE_SENTINEL = "\u0001";
const ESCAPED_PIPE_REGEX = /\\\|/g;

/**
 * Tests whether a line looks like a GFM table row (contains at least one
 * `|` and isn't a code fence / heading / list item).
 *
 * We're permissive here — the actual table detection requires a header
 * row followed by a separator row (`|---|---|`), so isolated `|` chars
 * in a paragraph won't trigger table parsing.
 */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("```") || trimmed.startsWith("#")) return false;
  // Must have at least one pipe that's not at the very start/end (a single
  // pipe at the start is the GFM convention, but a row needs at least one
  // CELL separator). Be lenient: a single pipe anywhere counts.
  return trimmed.includes("|");
}

/**
 * Tests whether a line is a GFM table separator row.
 *
 * Format: `| --- | :---: | ---: |` (leading/trailing pipes optional,
 * colons optional, dashes ≥3 per column).
 *
 * This is what distinguishes a header row from a paragraph: if the line
 * AFTER a `|`-containing line is a separator, the previous line was a
 * header.
 */
const SEPARATOR_REGEX = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function isTableSeparator(line: string): boolean {
  return SEPARATOR_REGEX.test(line.trim());
}

/**
 * Splits a GFM table row into cells.
 *
 * - Strips leading/trailing `|` (the GFM convention is `| a | b |`, but
 *   the leading/trailing pipes are optional).
 * - v6.2 Part 8 (Gap I fix): temporarily replaces escaped pipes (`\|`)
 *   with a sentinel character before splitting, then restores them in
 *   each cell. This handles the GFM spec's rule that `|` inside a cell
 *   must be escaped as `\|` so it's not treated as a cell separator.
 * - Splits on `|` (now only real cell-separator pipes remain).
 * - Trims each cell (GFM trims cell whitespace per the spec).
 *
 * Example:
 *   `| Mango \| Alphonso | 450 |` → ["Mango | Alphonso", "450"]
 */
function splitRow(line: string): string[] {
  let s = line.trim();
  // Strip leading/trailing pipe if present.
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // v6.2 Part 8 (Gap I fix): replace `\|` with the sentinel before
  // splitting so escaped pipes inside cells aren't treated as separators.
  s = s.replace(ESCAPED_PIPE_REGEX, ESCAPED_PIPE_SENTINEL);
  return s.split("|").map((c) => {
    // Restore the sentinel back to a literal pipe in each cell.
    const restored = c.replace(new RegExp(ESCAPED_PIPE_SENTINEL, "g"), "|");
    return restored.trim();
  });
}

/**
 * Parses a separator row into per-column alignments.
 *
 * `:---`  → 'left'
 * `---:`  → 'right'
 * `:---:` → 'center'
 * `---`   → null (default — CSS uses left-align via text-align: start)
 *
 * Returns an array the same length as the number of separator cells.
 */
function parseAligns(separatorLine: string): ("left" | "center" | "right" | null)[] {
  const cells = splitRow(separatorLine);
  return cells.map((c) => {
    const trimmed = c.trim();
    const startsColon = trimmed.startsWith(":");
    const endsColon = trimmed.endsWith(":");
    if (startsColon && endsColon) return "center";
    if (endsColon) return "right";
    if (startsColon) return "left";
    return null;
  });
}

/**
 * Parses a markdown-ish string into a sequence of blocks (paragraphs,
 * lists, code blocks, headings, tables). Each block is rendered as a
 * separate React element so spacing is predictable and consistent.
 */
function parseBlocks(md: string): Block[] {
  const lines = md.split(/\r?\n/);
  const blocks: Block[] = [];
  let currentList: string[] = [];
  let codeBlock: string[] | null = null;

  const flushList = () => {
    if (currentList.length > 0) {
      blocks.push({ type: "list", items: currentList });
      currentList = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // ─── Fenced code block detection ────────────────────────────────
    // ``` starts a code block, ``` ends it. Lines between are captured
    // verbatim (no inline parsing).
    if (line.trim().startsWith("```")) {
      if (codeBlock !== null) {
        // End of code block.
        flushList();
        blocks.push({ type: "code", text: codeBlock.join("\n") });
        codeBlock = null;
      } else {
        // Start of code block.
        flushList();
        codeBlock = [];
      }
      continue;
    }
    if (codeBlock !== null) {
      codeBlock.push(raw); // preserve original indentation
      continue;
    }

    // ─── Heading detection ──────────────────────────────────────────
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length as 1 | 2 | 3;
      blocks.push({ type: "heading", text: headingMatch[2], level });
      continue;
    }

    // ─── GFM table detection (v6.2 Part 6 / P2-12) ───────────────────
    // A table starts when:
    //   1. The current line looks like a table row (contains |).
    //   2. The NEXT line is a separator row (|---|---|).
    // We then consume consecutive table rows until a blank line or
    // non-table line ends the table.
    //
    // We check i+1 < lines.length before peeking to avoid OOB.
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushList();
      const headers = splitRow(line).slice(0, MAX_TABLE_COLS);
      const aligns = parseAligns(lines[i + 1]).slice(0, MAX_TABLE_COLS);
      // Pad aligns to headers length (missing aligns → null = default).
      while (aligns.length < headers.length) aligns.push(null);
      // Consume the separator.
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]) && lines[i].trim() !== "") {
        const row = splitRow(lines[i]).slice(0, MAX_TABLE_COLS);
        // Pad row to headers length (missing cells → empty string).
        while (row.length < headers.length) row.push("");
        rows.push(row);
        if (rows.length >= MAX_TABLE_ROWS) break;
        i++;
      }
      // Back up one so the outer for loop's i++ lands on the next
      // unprocessed line (the while loop already advanced past the
      // last table row).
      i--;
      blocks.push({ type: "table", table: { headers, rows, aligns } });
      continue;
    }

    // ─── Bullet list detection ──────────────────────────────────────
    if (line.match(/^\s*[-•]\s+/)) {
      const item = line.replace(/^\s*[-•]\s+/, "");
      currentList.push(item);
    } else if (line.trim() === "") {
      // Blank line — paragraph break.
      flushList();
    } else {
      // Regular text line. If we were in a list, close it.
      flushList();
      // If the last block is a paragraph, append to it (markdown soft wrap).
      const last = blocks[blocks.length - 1];
      if (last && last.type === "paragraph" && last.text != null) {
        last.text += " " + line;
      } else {
        blocks.push({ type: "paragraph", text: line });
      }
    }
  }
  // If the document ends inside an unclosed code block, flush it.
  if (codeBlock !== null) {
    blocks.push({ type: "code", text: codeBlock.join("\n") });
  }
  flushList();
  return blocks;
}

/**
 * Renders inline markdown (**bold**, *italic*, `code`, [text](url)) into
 * an array of React elements. We use a tokenizer approach so we never have
 * to call dangerouslySetInnerHTML — every character is rendered via React's
 * escaping.
 *
 * Supports nesting? No — bold-italic (***text***) is rare in our use case
 * and not worth the complexity. Use either bold OR italic.
 */
function renderInline(text: string, keyPrefix: string): JSX.Element[] {
  // Tokenize: match **bold**, *italic*, `code`, [text](url) in a single pass.
  const pattern = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  const out: JSX.Element[] = [];
  let lastIndex = 0;
  let i = 0;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(text)) !== null) {
    // Push any preceding plain text.
    if (m.index > lastIndex) {
      out.push(<span key={`${keyPrefix}-pre-${i}`}>{text.slice(lastIndex, m.index)}</span>);
    }
    if (m[2] != null) {
      out.push(<strong key={`${keyPrefix}-b-${i}`}>{m[2]}</strong>);
    } else if (m[3] != null) {
      out.push(<em key={`${keyPrefix}-i-${i}`}>{m[3]}</em>);
    } else if (m[4] != null) {
      out.push(
        <code
          key={`${keyPrefix}-c-${i}`}
          className="px-1 py-0.5 rounded bg-muted/60 text-[0.85em] font-mono"
        >
          {m[4]}
        </code>,
      );
    } else if (m[5] != null && m[6] != null) {
      // Link: [text](url). Only allow http(s) URLs to prevent javascript:
      // scheme XSS. target=_blank + rel=noopener for security.
      const url = m[6];
      const isSafe = /^https?:\/\//i.test(url);
      out.push(
        isSafe ? (
          <a
            key={`${keyPrefix}-a-${i}`}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:text-primary/80 transition-colors"
          >
            {m[5]}
          </a>
        ) : (
          <span key={`${keyPrefix}-a-${i}`}>{m[5]}</span>
        ),
      );
    }
    lastIndex = m.index + m[0].length;
    i++;
  }
  // Trailing plain text.
  if (lastIndex < text.length) {
    out.push(<span key={`${keyPrefix}-end`}>{text.slice(lastIndex)}</span>);
  }
  return out;
}

/**
 * Renders a parsed GFM table as a styled HTML <table>.
 *
 * Styling:
 *   - `text-xs` for compactness (chat bubble constraint).
 *   - Sticky header (`sticky top-0`) so long tables stay readable when
 *     scrolled inside the chat container.
 *   - Borders via `border-border` (theme-aware).
 *   - Cell padding `px-2 py-1` (tight for chat, but readable).
 *   - Alignment via inline `style` (so we don't have to generate per-cell
 *     Tailwind classes dynamically — keeps the CSS bundle small).
 *
 * Accessibility:
 *   - `<thead>` + `<tbody>` for proper table semantics.
 *   - `scope="col"` on `<th>` for screen readers (announces column headers
 *     when navigating cells).
 *   - The table is wrapped in a `role="region"` + `aria-label` so screen
 *     readers announce it as a navigable region.
 */
function renderTable(table: ParsedTable, key: number): JSX.Element {
  const { headers, rows, aligns } = table;
  return (
    <div
      key={key}
      role="region"
      aria-label="Data table"
      className="my-2 overflow-x-auto rounded-lg border border-border/50"
    >
      <table className="w-full text-xs border-collapse">
        <thead className="sticky top-0 bg-muted/60 backdrop-blur-sm">
          <tr>
            {headers.map((h, ci) => (
              <th
                key={ci}
                scope="col"
                style={{ textAlign: aligns[ci] ?? "left" }}
                className="px-2 py-1.5 font-semibold text-left border-b border-border/50"
              >
                {renderInline(h, `th-${key}-${ci}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className={ri % 2 === 1 ? "bg-muted/20" : ""}>
              {headers.map((_, ci) => (
                <td
                  key={ci}
                  style={{ textAlign: aligns[ci] ?? "left" }}
                  className="px-2 py-1 border-b border-border/30 last:border-0"
                >
                  {renderInline(row[ci] ?? "", `td-${key}-${ri}-${ci}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MarkdownText({ content }: { content: string }) {
  const blocks = parseBlocks(content);
  return (
    <div className="space-y-2">
      {blocks.map((b, idx) => {
        if (b.type === "code" && b.text != null) {
          // Fenced code block — monospace, scrollable, dark background.
          return (
            <pre
              key={idx}
              className="overflow-x-auto rounded-lg bg-muted/80 p-3 text-xs font-mono border border-border/50"
              aria-label="Code block"
            >
              <code className="text-foreground/90">{b.text}</code>
            </pre>
          );
        }
        if (b.type === "heading" && b.text != null) {
          const level = b.level ?? 1;
          const className =
            level === 1
              ? "font-semibold text-base mt-2 mb-1"
              : level === 2
                ? "font-semibold text-sm mt-2 mb-1"
                : "font-medium text-sm mt-1.5 mb-0.5 text-muted-foreground";
          return (
            <p key={idx} className={className}>
              {renderInline(b.text, `h${idx}`)}
            </p>
          );
        }
        if (b.type === "list" && b.items) {
          return (
            <ul key={idx} className="list-disc pl-5 space-y-1 my-1">
              {b.items.map((item, j) => (
                <li key={j}>{renderInline(item, `l${idx}-${j}`)}</li>
              ))}
            </ul>
          );
        }
        if (b.type === "table" && b.table) {
          return renderTable(b.table, idx);
        }
        return (
          <p key={idx} className="leading-relaxed">
            {renderInline(b.text ?? "", `p${idx}`)}
          </p>
        );
      })}
    </div>
  );
}
