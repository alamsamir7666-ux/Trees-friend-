/**
 * Lightweight markdown renderer for TreeBot messages.
 *
 * Why not use react-markdown?
 *   - Adding react-markdown + remark-gfm + rehype-sanitize is ~80kb gzipped
 *     for features we don't need (tables, code blocks, HTML, etc.).
 *   - TreeBot's prompt constrains formatting to: **bold**, bullet lists,
 *     and line breaks. That's it.
 *   - A purpose-built renderer is ~50 lines, ~1kb, and impossible to
 *     XSS-inject because we control every output element.
 *
 * Supported syntax (matches what the system prompt asks the AI to use):
 *   - **bold** → <strong>
 *   - *italic* → <em>
 *   - `inline code` → <code>
 *   - Lines starting with "- " or "• " → bullet list (<ul><li>)
 *   - Double newline → paragraph break
 *   - [[product name]] → bare text (the link wrapper is added separately)
 *
 * Note: the caller should already have called stripProductMentionMarkers()
 * if it wants the brackets removed, OR pass the raw content and wrap
 * mentions itself. This renderer treats [[...]] as opaque text — it does
 * NOT remove the brackets, so the caller can post-process.
 */
import { type JSX } from "react";

interface Block {
  type: "paragraph" | "list";
  items?: string[]; // for list blocks
  text?: string; // for paragraph blocks
}

/**
 * Parses a markdown-ish string into a sequence of blocks (paragraphs and
 * bullet lists). Each block is rendered as a separate React element so
 * spacing is predictable and consistent.
 */
function parseBlocks(md: string): Block[] {
  const lines = md.split(/\r?\n/);
  const blocks: Block[] = [];
  let currentList: string[] = [];

  const flushList = () => {
    if (currentList.length > 0) {
      blocks.push({ type: "list", items: currentList });
      currentList = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.match(/^\s*[-•]\s+/)) {
      // Bullet item.
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
  flushList();
  return blocks;
}

/**
 * Renders inline markdown (**bold**, *italic*, `code`) into an array of
 * React elements. We use a tokenizer approach so we never have to call
 * dangerouslySetInnerHTML — every character is rendered via React's
 * escaping.
 *
 * Supports nesting? No — bold-italic (***text***) is rare in our use case
 * and not worth the complexity. Use either bold OR italic.
 */
function renderInline(text: string, keyPrefix: string): JSX.Element[] {
  // Tokenize: match **bold**, *italic*, `code` in a single pass.
  // Regex captures one of: code, bold, italic. Iterate matches.
  const pattern = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;
  const out: JSX.Element[] = [];
  let lastIndex = 0;
  let i = 0;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(text)) !== null) {
    // Push any preceding plain text.
    if (m.index > lastIndex) {
      out.push(
        <span key={`${keyPrefix}-pre-${i}`}>{text.slice(lastIndex, m.index)}</span>,
      );
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
