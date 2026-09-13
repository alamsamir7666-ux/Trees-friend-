/**
 * HTML sanitization helper for admin-authored rich-text content.
 *
 * Used anywhere admin-authored HTML is rendered to the page via
 * `dangerouslySetInnerHTML`. Without sanitization, a compromised admin
 * account (or a stored XSS payload slipped into the DB) could execute
 * arbitrary JavaScript in every visitor's browser.
 *
 * Strategy: DOMPurify with a conservative allow-list — only the tags and
 * attributes actually used by the RichTextEditor (TipTap) output. Anything
 * else (script, iframe, onclick, on*, javascript:, etc.) is stripped.
 *
 * Why a shared util (not inline in each call site):
 *   1. Centralized config — if the editor adds a new tag/attribute in the
 *      future, there's one place to allow it.
 *   2. Same rules everywhere — prevents drift between BlogArticlePage and
 *      any future surfaces that render admin HTML.
 *   3. Single unit-testable surface.
 */

import DOMPurify from "dompurify";

/**
 * Allow-list of tags the RichTextEditor can emit, plus basic formatting and
 * list/quote semantics. Deliberately excludes:
 *   - script, style, iframe, object, embed, form, input, button (XSS / form
 *     hijack surface)
 *   - a[href] is allowed but javascript: URIs are stripped by DOMPurify's
 *     default URI sanitization (no need to re-implement).
 *
 * `class` and `style` are allowed so the editor's typography classes
 * (e.g. prose headings, alignment) survive sanitization. DOMPurify's
 * default also strips `style` URLs (javascript:, expression()) which is
 * the main XSS vector for `style`.
 */
const ALLOWED_TAGS = [
  // Headings
  "h1", "h2", "h3", "h4", "h5", "h6",
  // Text formatting
  "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "sub", "sup", "small", "abbr",
  // Lists
  "ul", "ol", "li",
  // Quotes
  "blockquote", "q", "cite",
  // Code (inline + block)
  "code", "pre", "kbd", "samp",
  // Links + images (RichTextEditor supports both)
  "a", "img",
  // Tables (TipTap table extension)
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  // Semantic grouping
  "span", "div", "figure", "figcaption", "details", "summary",
];

/**
 * Allowed attributes — anything else is stripped. `src` and `href` are
 * allowed but DOMPurify's URI sanitization strips `javascript:` and
 * similar dangerous schemes by default.
 */
const ALLOWED_ATTR = [
  "href", "src", "alt", "title",
  "class", "style",
  "target", "rel",
  "width", "height",
  "colspan", "rowspan",
  "open", // for <details>
];

/**
 * Hook fired on every attribute after the allow-list filter runs. Adds
 * `rel="noopener noreferrer"` to every `target="_blank"` link so the
 * linked page can't access `window.opener` (reverse tabnabbing).
 */
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("target") === "_blank") {
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/**
 * Sanitize an HTML string for safe rendering via dangerouslySetInnerHTML.
 *
 * Returns "" for null/undefined/non-string input — callers can render the
 * empty result without conditional checks.
 *
 * @param html - Raw HTML from admin-authored content (or other untrusted source).
 * @returns Sanitized HTML with only allow-listed tags + attributes.
 */
export function sanitizeHtml(html: string | null | undefined): string {
  if (html == null || typeof html !== "string" || html === "") return "";
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Strip unknown elements entirely (don't escape them to text).
    KEEP_CONTENT: false,
    // Force DOMPurify to return a string (default behavior — explicit
    // here for readability so future maintainers know the return type).
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
  });
}
