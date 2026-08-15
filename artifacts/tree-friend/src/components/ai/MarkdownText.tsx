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
 * Why not use react-markdown?
 *   - Adding react-markdown + remark-gfm + rehype-sanitize is ~80kb gzipped.
 *   - A purpose-built renderer is ~120 lines, ~2kb, and XSS-safe (we control
 *     every output element, no dangerouslySetInnerHTML).
 *
 * Supported syntax:
 *   - **bold** → <strong>
 *   - *italic* → <em>
 *   - `inline code` → <code>
 *   - [text](url) → <a target="_blank" rel="noopener noreferrer">
 *   - ```fenced code``` → <pre><code>
 *   - # / ## / ### headings → <h3> / <h4> / <h5>
 *   - Lines starting with "- " or "• " → bullet list (<ul><li>)
 *   - Double newline → paragraph break
 *   - [[product name]] → bare text (the link wrapper is added separately)
 */
import { type JSX } from "react";

interface Block {
  type: "paragraph" | "list" | "code" | "heading";
  items?: string[]; // for list blocks
  text?: string; // for paragraph blocks
  level?: 1 | 2 | 3; // for heading blocks
}

/**
 * Parses a markdown-ish string into a sequence of blocks (paragraphs,
 * lists, code blocks, headings). Each block is rendered as a separate
 * React element so spacing is predictable and consistent.
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

  for (const raw of lines) {
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
        return (
          <p key={idx} className="leading-relaxed">
            {renderInline(b.text ?? "", `p${idx}`)}
          </p>
        );
      })}
    </div>
  );
}
