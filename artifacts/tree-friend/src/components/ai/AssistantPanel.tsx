/**
 * AssistantPanel — the chat UI itself. Renders the message list + composer.
 *
 * v4.0 modernization (BUG-I6 + BUG-I7 + BUG-I8):
 *
 * Bug fixes:
 *   - I6: share banner uses `bg-success text-success-foreground` tokens
 *     (was `bg-green-50 text-green-800` — violated design system).
 *   - I7: auto-scroll uses `behavior: "auto"` during streaming deltas
 *     (was `"smooth"` — felt laggy as tokens arrived).
 *   - I8: `isTyping` no longer requires `messages.length > 0` — shows
 *     typing indicator even on the first message.
 *   - Removed dead `key?: Key` prop from MessageRow.
 *   - Added `aria-live="polite"` + `role="log"` to message container
 *     for screen-reader streaming announcements.
 *   - Added character counter (1,500 char soft limit, 2,000 hard limit).
 *
 * New features (rendering previously-dead SSE data):
 *   - Token usage display ("1,247 tokens · gemini-2.5-flash") in message meta.
 *   - "Generating suggestions…" spinner when `followupsLoading` is true.
 *   - Partial tool-call args preview ("Searching for: mang…").
 *   - History loading skeleton between mount and GET /sessions/current.
 *
 * Modernization:
 *   - Polished empty state with gradient hero + suggestion cards.
 *   - Better tool-call chips with progress indication.
 *   - Smooth enter/exit animations.
 *   - Responsive max-width on bubbles.
 *   - Accessible focus states.
 */
import { useEffect, useRef, useState, useMemo, type FormEvent, useCallback } from "react";
import { useAuth, useUser } from "@clerk/react";
import {
  Sparkles,
  Send,
  Trash2,
  X,
  Loader2,
  Leaf,
  ChevronDown,
  UserCircle2,
  Search,
  ShoppingCart,
  FileText,
  BookOpen,
  HelpCircle,
  Download,
  Share2,
  Check,
  // v6.2 Part 5 (P1-6, P1-7, P1-8): Stop / Regenerate / Copy icons.
  // Square is the industry-standard "Stop" affordance (ChatGPT, Claude,
  // Gemini all use a filled square inside the send button while streaming).
  // RotateCw is the industry-standard "Regenerate" affordance.
  // Copy is the industry-standard "Copy to clipboard" affordance.
  Square,
  RotateCw,
  Copy,
  // v6.2 Part 7 (P3-6): Pencil icon for editing user messages.
  // Pencil is the industry-standard "Edit" affordance.
  Pencil,
} from "lucide-react";
import { useAiChat, type ChatMessage, type ActiveToolCall } from "@/hooks/useAiChat";
import { MarkdownText } from "./MarkdownText";
import { ProductChips } from "./ProductChips";
import { ListingChips } from "./ListingChip";
import { ToolComponentRenderer } from "./tool-ui/ToolComponentRenderer";
// v6.2 Part 12 (Gap Fix #2): import the ToolName union + isToolName guard
// so the local maps (TOOL_LABELS, TOOLS_WITH_SKELETONS) are typed against
// the same string-literal union as TOOL_NAMES in toolNames.ts. A typo or
// missing entry is now a compile-time error.
import type { ToolName } from "./tool-ui/toolNames";
import { FollowupChips } from "./FollowupChips";
import { FeedbackButtons } from "./FeedbackButtons";
import {
  extractFollowups,
  extractProductMentions,
  extractListingMentions,
  stripProductMentionMarkers,
} from "./parseMessage";

const SUGGESTIONS = [
  {
    icon: "🌿",
    text: "What indoor plants are easy to care for in Bangladesh?",
  },
  {
    icon: "💧",
    text: "How often should I water a mango sapling?",
  },
  {
    icon: "🏠",
    text: "Recommend shade-loving trees for a balcony",
  },
  {
    icon: "🌱",
    text: "When is the best season to plant a jackfruit tree?",
  },
];

const INPUT_MAX_LENGTH = 2000;
const INPUT_SOFT_LIMIT = 1500;

interface AssistantPanelProps {
  /** Optional callback when the user closes the panel (sheet mode only). */
  onClose?: () => void;
  /** Optional link to a full-page view (sheet mode shows a "Expand" button). */
  onOpenFullPage?: () => void;
}

export function AssistantPanel({ onClose, onOpenFullPage }: AssistantPanelProps) {
  const {
    messages,
    loading,
    error,
    send,
    clear,
    stop,
    regenerate,
    editMessage,
    shareMessage,
    activeToolCalls,
    exportConversation,
    shareConversation,
  } = useAiChat();
  // v5.1: share dialog state
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  // BUG-I8 fix: history loading state — shows skeleton between mount and
  // GET /sessions/current resolution. Previously the user saw EmptyState
  // even if they had prior history.
  const [historyLoading, setHistoryLoading] = useState(true);
  // v6.2 Part 7 (P3-6): edit-mode state.
  //
  // When non-null, the composer is in "edit mode" for the user message
  // with the given id. The textarea is pre-filled with that message's
  // content, the Send button becomes a "Save" button, and a cancel
  // affordance restores the original state.
  //
  // Industry standard (ChatGPT, Claude): clicking the pencil on a user
  // message transforms the composer into an editor. Saving re-sends from
  // that point (truncating everything after). This is more intuitive than
  // requiring the user to manually delete + retype.
  //
  // The state holds { id, originalContent } so we can restore on cancel
  // without re-reading from `messages` (which might have changed if the
  // user navigated away — though they can't navigate within the chat
  // sheet, the defensive copy is still safer).
  const [editingMessage, setEditingMessage] = useState<{
    id: number | string;
    originalContent: string;
  } | null>(null);
  // useAuth() doesn't expose `user` directly (only isSignedIn + userId).
  // useUser() returns the full user object (firstName, username, etc.).
  const { isSignedIn } = useAuth();
  const { user } = useUser();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // ─── Auto-scroll to bottom on new messages / streaming deltas ────────
  // Only auto-scroll if the user is already at (or near) the bottom.
  // If they've scrolled up to read earlier messages, don't yank them down.
  //
  // BUG-I7 fix: use `behavior: "auto"` during streaming (not "smooth").
  // Smooth scroll during rapid token deltas feels laggy — the browser
  // queues up scroll animations faster than it can render them, causing
  // a "rubber-band" effect. "auto" jumps instantly, which is what users
  // expect for streaming chat (ChatGPT, Claude, Gemini all use instant).
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    if (isAtBottom) {
      // During active streaming (loading + last msg is assistant + has content),
      // use instant scroll. For new messages (user sends), use smooth.
      const lastMsg = messages[messages.length - 1];
      const isStreaming = loading && lastMsg?.role === "assistant" && !!lastMsg?.content;
      scrollToBottom(isStreaming ? "auto" : "smooth");
    }
  }, [messages, isAtBottom, loading, scrollToBottom]);

  // ─── Track scroll position to show/hide "scroll to bottom" button ─────
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 80;
    setIsAtBottom(atBottom);
    setShowScrollDown(!atBottom && messages.length > 2);
  }, [messages.length]);

  // ─── Auto-resize textarea ─────────────────────────────────────────────
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  // ─── Mark history as loaded once messages arrive or after timeout ─────
  // The useAiChat hook fetches history on mount. We can't observe its
  // internal state directly, so we use a heuristic: if messages is non-empty
  // on first render OR after a short delay, history has loaded.
  useEffect(() => {
    // If messages arrive immediately (from the GET), mark loaded.
    if (messages.length > 0) {
      setHistoryLoading(false);
      return;
    }
    // Otherwise wait a short time for the GET to resolve. If it comes back
    // empty, we hide the skeleton and show EmptyState.
    const t = setTimeout(() => setHistoryLoading(false), 800);
    return () => clearTimeout(t);
  }, [messages.length]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    // v6.2 Part 7 (P3-6): if we're in edit mode, save the edit instead of
    // sending a new message. This routes the composer's current text to
    // `editMessage(id, text)` which truncates + re-sends from that point.
    if (editingMessage) {
      const editId = editingMessage.id;
      setEditingMessage(null);
      setInput("");
      await editMessage(editId, text);
      return;
    }

    setInput("");
    setIsAtBottom(true);
    await send(text);
  };

  // v6.2 Part 7 (P3-6): start editing a user message.
  //
  // Pre-fills the composer with the message's content + focuses the
  // textarea. The user can then tweak + hit Send (which calls
  // `editMessage` via `handleSubmit`'s edit-mode branch) OR hit Esc
  // / click Cancel to abort.
  //
  // Industry standard (ChatGPT, Claude): the composer transforms into
  // an editor with a visible "editing" banner so the user knows
  // they're editing, not composing new.
  const handleStartEdit = useCallback(
    (message: ChatMessage) => {
      if (loading || message.role !== "user") return;
      setEditingMessage({
        id: message.id ?? Date.now(),
        originalContent: message.content,
      });
      setInput(message.content);
      // Focus the textarea on the next tick (after the input state
      // has been applied). requestAnimationFrame avoids a flash of
      // the old value.
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        // Select-all so the user can immediately retype or arrow-edit.
        textareaRef.current?.select();
      });
    },
    [loading],
  );

  // v6.2 Part 7 (P3-6): cancel edit mode — restore the original input
  // state (empty composer, no editing banner).
  const handleCancelEdit = useCallback(() => {
    setEditingMessage(null);
    setInput("");
    textareaRef.current?.focus();
  }, []);

  const handleClear = async () => {
    if (loading) return;
    if (messages.length === 0) return;
    if (!window.confirm("Clear this conversation? TreeBot will forget everything we discussed.")) {
      return;
    }
    await clear();
  };

  // ─── Typing indicator: show when loading AND the last assistant message ─
  // has no content yet (waiting for first token).
  // BUG-I8 fix: removed the `messages.length > 0` requirement — now shows
  // the typing indicator even on the first message (when the user sends
  // their first message and is waiting for the AI to start responding).
  //
  // v6.2 Part 5 (P1-9 fix): the typing indicator is now HIDDEN when there
  // are active tool calls. The ToolCallChips component already shows
  // "Searching listings…" + a skeleton card — rendering BOTH the typing
  // dots AND the tool chip + skeleton would be 3 stacked progress
  // indicators for the same wait. Industry standard (ChatGPT, Claude):
  // when a tool is running, the tool chip IS the progress indicator.
  // The typing dots are reserved for the "thinking before first token"
  // phase where there's no other progress UI.
  //
  // Also: when `isTyping` is true, the empty streaming bubble (which
  // contains only a tiny pulsing cursor) is now SKIPPED in the render
  // loop below — rendering both an empty bubble AND a typing indicator
  // is redundant (industry standard: only show the typing indicator).
  const lastMsg = messages[messages.length - 1];
  const isTyping =
    loading &&
    messages.length > 0 &&
    lastMsg?.role === "assistant" &&
    !lastMsg?.content &&
    activeToolCalls.length === 0;

  // v6.2 Part 6 (P2-17): ARIA live region announcement text.
  //
  // Industry standard for chat UIs with tool calls (ChatGPT, Claude, Bing
  // Chat): screen readers should announce tool execution status so blind
  // users know what's happening (sighted users see the spinner + skeleton;
  // blind users currently get nothing).
  //
  // The announcement text changes based on `activeToolCalls`:
  //   - 1 tool running: "Searching listings…" (the friendly label from
  //     TOOL_LABELS, defined in ToolCallChips below).
  //   - 2+ tools running: "Running 2 tools…" (parallel calls).
  //   - 0 tools + typing: "TreeBot is thinking…" (the pre-delta phase).
  //   - 0 tools + not typing + loading: "" (silent — the streaming text
  //     itself is announced via the message container's aria-live=polite).
  //
  // The live region is `aria-live="assertive"` (interrupts current
  // announcement) so tool status takes priority over streaming text.
  // Placed in a visually-hidden div so sighted users don't see duplicate
  // info (the ToolCallChips component already shows the visual equivalent).
  //
  // `useMemo` so the string identity is stable when nothing changed —
  // prevents redundant screen-reader announcements.
  const announcement = useMemo(() => {
    if (activeToolCalls.length > 0) {
      if (activeToolCalls.length === 1) {
        const call = activeToolCalls[0];
        const label = TOOL_LABELS[call.name]?.label ?? "Working";
        return `${label}…`;
      }
      return `Running ${activeToolCalls.length} tools…`;
    }
    if (isTyping) return "TreeBot is thinking…";
    return "";
  }, [activeToolCalls, isTyping]);

  const charCount = input.length;
  const overSoftLimit = charCount > INPUT_SOFT_LIMIT;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* ─── Header ───────────────────────────────────────────────────── */}
      <header className="relative flex items-center justify-between px-4 py-3 border-b bg-background/80 backdrop-blur-sm">
        <div className="flex items-center gap-3 min-w-0">
          {/* AI avatar with online status dot */}
          <div className="relative shrink-0">
            <div className="h-10 w-10 rounded-full bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-sm">
              <Leaf className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-success border-2 border-background" />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-sm leading-tight flex items-center gap-1.5">
              TreeBot
              <Sparkles className="h-3 w-3 text-primary/70" />
            </div>
            <div className="text-xs text-muted-foreground truncate flex items-center gap-1 mt-0.5">
              {isSignedIn && user ? (
                <>
                  <UserCircle2 className="h-3 w-3" />
                  <span className="truncate max-w-[100px]">
                    {user.firstName ?? user.username ?? "Signed in"}
                  </span>
                </>
              ) : (
                <span>Plant assistant · online</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          {onOpenFullPage && (
            <button
              type="button"
              onClick={onOpenFullPage}
              className="text-xs px-2.5 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Open full page"
            >
              Expand
            </button>
          )}
          {/* v5.1: Export button (JSON/Markdown download) */}
          <button
            type="button"
            onClick={async () => {
              if (exportLoading || messages.length === 0) return;
              setExportLoading(true);
              try {
                await exportConversation("markdown");
              } catch {
                // best-effort — the hook handles errors
              } finally {
                setExportLoading(false);
              }
            }}
            disabled={loading || messages.length === 0 || exportLoading}
            className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Export conversation"
            aria-label="Export conversation"
          >
            {exportLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
          </button>
          {/* v5.1: Share button (creates a read-only share link) */}
          <button
            type="button"
            onClick={async () => {
              if (shareLoading || messages.length === 0) return;
              if (shareUrl) {
                // Already shared — copy to clipboard
                try {
                  await navigator.clipboard.writeText(shareUrl);
                  setShareCopied(true);
                  setTimeout(() => setShareCopied(false), 2000);
                } catch {
                  // clipboard API not available
                }
                return;
              }
              setShareLoading(true);
              try {
                const result = await shareConversation();
                setShareUrl(result.shareUrl);
                try {
                  await navigator.clipboard.writeText(result.shareUrl);
                  setShareCopied(true);
                  setTimeout(() => setShareCopied(false), 2000);
                } catch {
                  // clipboard API not available — user can copy manually
                }
              } catch {
                // best-effort
              } finally {
                setShareLoading(false);
              }
            }}
            disabled={loading || messages.length === 0 || shareLoading}
            className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title={shareUrl ? "Copy share link" : "Share conversation"}
            aria-label={shareUrl ? "Copy share link" : "Share conversation"}
          >
            {shareLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : shareCopied ? (
              <Check className="h-4 w-4 text-success" />
            ) : (
              <Share2 className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={loading || messages.length === 0}
            className="p-2 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Clear conversation"
            aria-label="Clear conversation"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Close"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {/* v5.1: Share link banner (shows when a share link has been created) */}
        {/* BUG-I6 fix: use design-system tokens (bg-success text-success-foreground) */}
        {/* instead of hardcoded bg-green-50 text-green-800. */}
        {shareUrl && (
          <div className="absolute left-0 right-0 top-full z-20 border-b bg-success px-4 py-2 text-xs text-success-foreground">
            <div className="flex items-center gap-2">
              <Share2 className="h-3 w-3 flex-shrink-0" />
              <span className="flex-1 truncate">Share link copied to clipboard!</span>
              <button
                type="button"
                onClick={() => setShareUrl(null)}
                className="text-success-foreground/80 hover:text-success-foreground"
                aria-label="Dismiss share banner"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}
      </header>

      {/* ─── Messages ─────────────────────────────────────────────────── */}
      <div className="relative flex-1 overflow-hidden">
        {/* v6.2 Part 6 (P2-17): Visually-hidden ARIA live region for tool
            execution status. Sighted users see the ToolCallChips + skeleton;
            blind users get nothing without this live region. The region is
            `assertive` (interrupts current speech) so tool status takes
            priority over streaming text. The visually-hidden utility class
            (Tailwind's `sr-only`) hides it from sighted users while keeping
            it accessible to screen readers. */}
        <div aria-live="assertive" aria-atomic="true" className="sr-only">
          {announcement}
        </div>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          // BUG-I8 fix: add aria-live + role="log" so screen readers
          // announce streaming deltas as they arrive.
          role="log"
          aria-live="polite"
          aria-label="Chat messages"
          className="absolute inset-0 overflow-y-auto scroll-smooth"
        >
          <div className="px-4 py-5">
            {historyLoading ? (
              <HistorySkeleton />
            ) : messages.length === 0 ? (
              <EmptyState onPick={send} />
            ) : (
              <div className="space-y-4">
                {messages.map((m, i) => {
                  // v6.2 Part 5 (P1-9 fix): when isTyping is true, the last
                  // assistant message has empty content + no tool results.
                  // The TypingIndicator (rendered below) handles that state
                  // — skip rendering the empty bubble here so the user
                  // doesn't see an empty bubble + typing dots stacked
                  // (industry-standard: only the typing indicator).
                  //
                  // Bug fix: removed the `(!m.toolResults || m.toolResults.length === 0)`
                  // condition. Previously, when the LLM called a tool (e.g.,
                  // search_knowledge_base) and the tool result arrived but
                  // no text delta had arrived yet, the assistant message had
                  // `toolResults.length > 0` + empty `content`. The skip
                  // condition failed (because of the toolResults check), so
                  // BOTH the empty bubble (with AI logo #1) AND the
                  // TypingIndicator (with AI logo #2) rendered — two AI
                  // logos in what appeared to be a single message area.
                  //
                  // Now we skip the empty bubble whenever `isTyping` is true
                  // (regardless of toolResults). The TypingIndicator handles
                  // the "waiting" state, and tool results render once content
                  // arrives (or once the stream completes + isTyping=false).
                  // This is consistent with industry UX (ChatGPT hides
                  // citations until text arrives).
                  if (
                    isTyping &&
                    i === messages.length - 1 &&
                    m.role === "assistant" &&
                    !m.content
                  ) {
                    return null;
                  }
                  return (
                    <MessageRow
                      key={m.id ?? `m${i}`}
                      message={m}
                      isStreaming={
                        // Bug fix: isStreaming should be true even when content
                        // is empty, as long as loading is true + this is the last
                        // assistant message. Previously, `!!m.content` made
                        // isStreaming=false when content was empty — causing the
                        // "(empty response)" placeholder to flash for a few
                        // milliseconds before the first text delta arrived.
                        // Now isStreaming is true whenever loading + last assistant
                        // message (regardless of content). The streaming dot
                        // (rendered when isStreaming=true) shows instead of the
                        // "(empty response)" placeholder.
                        loading && m.role === "assistant" && i === messages.length - 1
                      }
                      isLast={i === messages.length - 1}
                      // v6.2 Part 15: find the most recent USER message
                      // preceding this ASSISTANT message, so the FactCallout
                      // in each card can pick the most relevant fact for
                      // what the user actually asked. Undefined for user
                      // messages themselves + the first message.
                      userQuestion={
                        m.role === "assistant"
                          ? (() => {
                              for (let j = i - 1; j >= 0; j--) {
                                if (messages[j].role === "user") {
                                  return messages[j].content;
                                }
                              }
                              return undefined;
                            })()
                          : undefined
                      }
                      onRegenerate={regenerate}
                      onStartEdit={handleStartEdit}
                      isEditing={editingMessage?.id === m.id}
                      onShareMessage={shareMessage}
                      onPickFollowup={send}
                      disabled={loading}
                      onClose={onClose}
                    />
                  );
                })}
                {isTyping && <TypingIndicator />}
                {activeToolCalls.length > 0 && <ToolCallChips calls={activeToolCalls} />}
                {error && (
                  <div className="text-center text-xs text-destructive py-2 px-4 rounded-lg bg-destructive/5">
                    {error}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ─── Scroll-to-bottom button ──────────────────────────────── */}
        {showScrollDown && (
          <button
            type="button"
            onClick={() => {
              scrollToBottom("smooth");
              setIsAtBottom(true);
            }}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 h-9 w-9 rounded-full bg-background border shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all flex items-center justify-center z-10"
            aria-label="Scroll to bottom"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ─── Composer ────────────────────────────────────────────────── */}
      <div className="border-t bg-background p-3">
        {/* v6.2 Part 7 (P3-6): Edit-mode banner.
            When editingMessage is set, show a banner above the composer
            announcing "Editing message" with a Cancel button. This matches
            the ChatGPT/Claude pattern — the user knows they're editing,
            not composing new, and can abort. */}
        {editingMessage && (
          <div className="mb-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary/5 border border-primary/20 text-xs">
            <Pencil className="h-3 w-3 text-primary flex-shrink-0" />
            <span className="text-primary font-medium flex-1">Editing message</span>
            <button
              type="button"
              onClick={handleCancelEdit}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Cancel edit"
              title="Cancel (Esc)"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <form
          onSubmit={handleSubmit}
          className="flex items-end gap-2 bg-muted/40 rounded-2xl border border-border focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/20 transition-all px-3 py-2"
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // v6.2 Part 7 (P3-6): Esc cancels edit mode.
              // Industry standard (ChatGPT, Claude): Esc aborts the edit
              // and restores the original composer state.
              if (e.key === "Escape" && editingMessage) {
                e.preventDefault();
                handleCancelEdit();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e as unknown as FormEvent);
              }
            }}
            rows={1}
            placeholder={
              editingMessage ? "Edit your message…" : "Ask about plants, care, gardening…"
            }
            disabled={loading}
            className="flex-1 resize-none bg-transparent border-0 outline-none text-sm placeholder:text-muted-foreground/60 disabled:opacity-60 max-h-[120px] py-1"
            maxLength={INPUT_MAX_LENGTH}
            aria-label={editingMessage ? "Edit your message" : "Type your message"}
          />
          {/* v6.2 Part 5 (P1-6): Stop button while streaming.
              Industry standard (ChatGPT, Claude, Gemini): when the AI is
              generating, the Send button morphs into a Stop button.
              Clicking it aborts the in-flight stream via `stop()` from
              useAiChat — the partial response is kept (so the user sees
              what was generated), and empty bubbles are auto-removed by
              the hook's finally block.

              Visual: a filled square (the universal "Stop" affordance)
              inside the same button shape — keeps muscle memory + layout
              stable. The button is intentionally NOT disabled (otherwise
              the user can't click it). aria-label announces the action. */}
          {loading ? (
            <button
              type="button"
              onClick={stop}
              className="h-9 w-9 shrink-0 rounded-xl bg-foreground text-background flex items-center justify-center hover:bg-foreground/90 active:scale-95 transition-all shadow-sm"
              aria-label="Stop generating"
              title="Stop generating"
            >
              <Square className="h-3.5 w-3.5" fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="h-9 w-9 shrink-0 rounded-xl bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed hover:bg-primary/90 active:scale-95 transition-all shadow-sm"
              aria-label={editingMessage ? "Save edited message" : "Send message"}
              title={editingMessage ? "Save (Enter)" : "Send (Enter)"}
            >
              {/* v6.2 Part 7 (P3-6): show Check icon when editing (Save),
                  Send icon when composing. Industry standard (ChatGPT,
                  Claude) — the icon swap signals the mode change. */}
              {editingMessage ? <Check className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            </button>
          )}
        </form>
        <div className="flex items-center justify-between mt-2 px-1">
          <p className="text-[10px] text-muted-foreground/60">
            TreeBot can make mistakes. Always verify plant care advice.
          </p>
          {/* Character counter — shows when approaching the soft limit */}
          {charCount > INPUT_SOFT_LIMIT * 0.8 && (
            <span
              className={`text-[10px] tabular-nums ${
                overSoftLimit ? "text-warning font-medium" : "text-muted-foreground/60"
              }`}
            >
              {charCount}/{INPUT_MAX_LENGTH}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Message row (avatar + bubble + meta) ───────────────────────────────

function MessageRow({
  message,
  isStreaming,
  isLast,
  userQuestion,
  onRegenerate,
  onStartEdit,
  isEditing,
  onShareMessage,
  onPickFollowup,
  disabled,
  onClose,
}: {
  message: ChatMessage;
  isStreaming: boolean;
  /**
   * v6.2 Part 5 (P1-7): true if this is the last message in the list.
   * Used to gate the Regenerate button — only available on the last
   * assistant message (regenerating mid-history would invalidate
   * every message after it, which is confusing UX).
   */
  isLast: boolean;
  /**
   * v6.2 Part 15: the most recent user message preceding this assistant
   * message (undefined for user messages themselves, and for the first
   * message in the conversation). Threaded through to ToolComponentRenderer
   * so each card's FactCallout can pick the most relevant fact for what
   * the user actually asked.
   */
  userQuestion?: string;
  /**
   * v6.2 Part 5 (P1-7): callback to regenerate this assistant message.
   * The hook finds the user message preceding this one, removes both,
   * and re-sends the user message. The hook guards against concurrent
   * calls (loadingRef.current check).
   */
  onRegenerate: (messageId: number | string) => void;
  /**
   * v6.2 Part 7 (P3-6): callback to start editing a user message.
   * Pre-fills the composer with the message's content + focuses it.
   * The hook truncates the conversation at that point + re-sends on save.
   */
  onStartEdit: (message: ChatMessage) => void;
  /**
   * v6.2 Part 7 (P3-6): true if this message is currently being edited.
   * Used to highlight the message + hide the edit pencil (already editing).
   */
  isEditing: boolean;
  /**
   * v6.2 Part 7 (P3-16): callback to share this assistant message.
   * Creates a share link anchored to this message (#msg-<id>) + copies
   * it to the clipboard. Only callable on persisted (numeric-id) messages.
   */
  onShareMessage: (messageId: number | string) => Promise<void>;
  onPickFollowup: (s: string) => void;
  disabled?: boolean;
  onClose?: () => void;
}) {
  const isUser = message.role === "user";

  // v6.2 Part 5 (P1-8): copy-to-clipboard state.
  // 'idle' | 'copying' | 'copied' — 'copied' shows ✓ for 1.5s, then reverts.
  const [copyStatus, setCopyStatus] = useState<"idle" | "copying" | "copied">("idle");

  // v6.2 Part 7 (P3-16): share-link state.
  // Same 3-state pattern as copy: 'idle' | 'sharing' | 'shared'.
  // 'shared' shows ✓ for 1.5s, then reverts. The shareLoading state is
  // local to this MessageRow (each assistant message tracks its own
  // share status independently).
  const [shareStatus, setShareStatus] = useState<"idle" | "sharing" | "shared">("idle");

  const handleCopy = async () => {
    if (copyStatus !== "idle") return;
    setCopyStatus("copying");
    const text = message.content;
    try {
      // Preferred: async Clipboard API. Works in secure contexts (HTTPS,
      // localhost). Permissionless for plain text.
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback: legacy execCommand('copy'). Works in older browsers
        // + insecure contexts (HTTP, file://). Creates a hidden textarea,
        // selects, copies, removes.
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopyStatus("copied");
      // Revert to idle after 1.5s — same timing as the add-to-cart ✓ flash.
      window.setTimeout(() => setCopyStatus("idle"), 1500);
    } catch {
      setCopyStatus("idle");
      // No toast — the click feedback (no ✓) signals failure. Industry
      // standard (ChatGPT) just silently fails; clipboard may be locked.
    }
  };

  // v6.2 Part 5 (P1-7): regenerate handler. Passes the message id to the
  // hook. The hook handles the find-remove-resend flow + the loadingRef
  // guard. We don't need a local loading state — the hook flips `loading`
  // which disables the action row via the `disabled` prop.
  const handleRegenerate = () => {
    if (disabled || isStreaming || !message.id) return;
    onRegenerate(message.id);
  };

  // v6.2 Part 7 (P3-16): share handler.
  //
  // Calls the hook's `shareMessage(messageId)` which creates a share link
  // anchored to this message (#msg-<id>) + copies it to the clipboard.
  // The hook caches the base share URL so subsequent share calls on other
  // messages reuse the same link (avoids creating multiple share tokens).
  //
  // The 3-state UI matches the Copy button: idle → sharing → shared → idle.
  // 'shared' shows ✓ for 1.5s (signals success), then reverts so the user
  // can share again if needed.
  //
  // Only callable on persisted (numeric-id) messages — the hook guards
  // against ephemeral `pending-*` ids, but we also disable the button in
  // the UI when `typeof message.id !== "number"`.
  const handleShare = async () => {
    if (shareStatus !== "idle" || disabled || isStreaming) return;
    if (typeof message.id !== "number") return;
    setShareStatus("sharing");
    try {
      await onShareMessage(message.id);
      setShareStatus("shared");
      // Revert after 1.5s — matches the Copy button timing.
      window.setTimeout(() => setShareStatus("idle"), 1500);
    } catch {
      setShareStatus("idle");
      // Silent fail — no toast (matches handleCopy's behavior).
    }
  };

  // ─── Parse the AI response ─────────────────────────────────────────
  if (isUser) {
    return (
      <div className="flex justify-end animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="max-w-[80%] sm:max-w-[70%]">
          {/* v6.2 Part 7 (P3-6): highlight the bubble when actively being
              edited (ring-2 ring-primary/40 + slightly elevated shadow).
              Industry standard (ChatGPT): the user sees which message
              they're editing without needing to look at the composer banner. */}
          <div
            className={`px-4 py-2.5 text-sm whitespace-pre-wrap break-words bg-primary text-primary-foreground rounded-2xl rounded-br-md shadow-sm transition-all ${
              isEditing ? "ring-2 ring-primary/40 ring-offset-2 ring-offset-background" : ""
            }`}
          >
            {message.content}
          </div>
          <div className="flex items-center justify-end gap-0.5 mt-1 pr-1">
            {message.createdAt && (
              <span className="text-[10px] text-muted-foreground/60 mr-1">
                {formatTime(message.createdAt)}
              </span>
            )}
            {/* v6.2 Part 7 (P3-6): Edit pencil on user messages.
                Industry standard (ChatGPT, Claude): hover-to-reveal pencil
                icon at the bottom-right of the user bubble. Clicking it
                pre-fills the composer (handleStartEdit in AssistantPanel).
                Disabled during streaming/another send. Hidden when already
                editing this message (isEditing). */}
            {!isEditing && (
              <button
                type="button"
                onClick={() => onStartEdit(message)}
                disabled={disabled}
                className="p-1 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Edit message"
                aria-label="Edit this message"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─── Assistant message ─────────────────────────────────────────────
  const { cleanedContent, followups } = extractFollowups(message.content);
  const displayContent = stripProductMentionMarkers(cleanedContent);
  const productMentions = extractProductMentions(cleanedContent);
  // v6.1: extract [[listing:<id>|<display>]] mentions — distinct from
  // product mentions. These deep-link to SellerListingDetailPage (one
  // click to buy) instead of the variety catalog search.
  const listingMentions = extractListingMentions(cleanedContent);

  // BUG-I7 fix: prefer structured followups from SSE (message.followups)
  // over parsed followups from [followups]...[/followups] block. The
  // structured output path is more reliable (the AI may forget the markers).
  const effectiveFollowups = message.followups?.length ? message.followups : followups;
  const showFollowupsLoading = message.followupsLoading && !isStreaming;

  return (
    <div className="flex gap-2.5 animate-in fade-in slide-in-from-bottom-2 duration-300">
      {/* AI avatar */}
      <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shrink-0 shadow-sm self-end mb-5">
        <Leaf className="h-4 w-4 text-primary-foreground" />
      </div>

      <div className="max-w-[80%] sm:max-w-[70%] min-w-0 flex-1">
        <div className="px-4 py-2.5 text-sm bg-muted/50 text-foreground rounded-2xl rounded-bl-md border border-border/50">
          {displayContent ? (
            <MarkdownText content={displayContent} />
          ) : (
            // Bug fix: don't show "(empty response)" placeholder when the
            // message has tool results (the tool results ARE the content —
            // KB citations, order details, listing grids, etc.). The
            // "(empty response)" placeholder should only appear when the
            // message has NO content AND no tool results (a true empty
            // response from the LLM).
            !isStreaming &&
            (!message.toolResults || message.toolResults.length === 0) && (
              <span className="text-muted-foreground italic">(empty response)</span>
            )
          )}
          {isStreaming && (
            <span
              className="inline-block w-2 h-2 ml-1 bg-primary rounded-full align-middle animate-pulse"
              style={{ animationDuration: "1s" }}
            />
          )}
        </div>

        {/* Timestamp + off-topic badge + token usage */}
        <div className="flex items-center gap-2 mt-1 px-1 flex-wrap">
          {message.createdAt && (
            <span className="text-[10px] text-muted-foreground/60">
              {formatTime(message.createdAt)}
            </span>
          )}
          {message.offTopic && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5">
              ⚠ Off-topic
            </span>
          )}
          {message.greeting && (
            <span className="text-[10px] text-muted-foreground/60">👋 Welcome</span>
          )}
          {/* BUG-I7 fix: render the previously-dead `usage` SSE data. */}
          {/* Shows "1,247 tokens · gemini-2.5-flash" below the message. */}
          {message.usage && !isStreaming && (
            <span className="text-[10px] text-muted-foreground/50 flex items-center gap-1">
              <Sparkles className="h-2.5 w-2.5" />
              {formatUsage(message.usage)}
            </span>
          )}
        </div>

        {/* v1.5: Product chips (variety-level, links to catalog search) */}
        {!isStreaming && productMentions.length > 0 && (
          <ProductChips names={productMentions} onClose={onClose} />
        )}

        {/* v6.1: Listing chips (purchasable, deep-links to SellerListingDetailPage) */}
        {!isStreaming && listingMentions.length > 0 && (
          <ListingChips mentions={listingMentions} onClose={onClose} />
        )}

        {/* v6.2 Part 1: Rich tool-result components (OrderDetailCard, etc.) */}
        {/* v6.2 Part 15: pass userQuestion through to ToolComponentRenderer  */}
        {/* so each card's FactCallout can pick the most relevant fact.       */}
        {!isStreaming && message.toolResults && message.toolResults.length > 0 && (
          <ToolComponentRenderer
            toolResults={message.toolResults}
            userQuestion={userQuestion}
            onClose={onClose}
          />
        )}

        {/* BUG-I7 fix: "Generating suggestions…" spinner when the backend */}
        {/* is computing followups via structured output. */}
        {showFollowupsLoading && (
          <div className="flex items-center gap-1.5 mt-2.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Generating suggestions…</span>
          </div>
        )}

        {/* v1.5: Follow-up chips (prefer structured followups from SSE) */}
        {!isStreaming && effectiveFollowups.length > 0 && !showFollowupsLoading && (
          <FollowupChips
            followups={effectiveFollowups}
            onPick={onPickFollowup}
            disabled={disabled}
          />
        )}

        {/* v1.5: Feedback buttons */}
        {!isStreaming && typeof message.id === "number" && (
          <FeedbackButtons messageId={message.id} />
        )}

        {/* v6.2 Part 5 (P1-7 + P1-8): Copy + Regenerate action row.
            Industry standard (ChatGPT, Claude, Gemini): hover-style
            action buttons appear under each assistant message. Copy
            duplicates the raw markdown text to the clipboard; Regenerate
            re-runs the LLM for the same prompt (only available on the
            LAST assistant message — regenerating mid-history would
            invalidate everything after it).

            Both buttons are disabled while streaming (isStreaming) or
            when the global `disabled` prop is set (during another
            send/stop in flight). The disabled visual is muted opacity
            + not-allowed cursor. */}

        {!isStreaming && (
          <div className="flex items-center gap-0.5 mt-1 -ml-1">
            {/* Copy button */}
            <button
              type="button"
              onClick={handleCopy}
              disabled={copyStatus !== "idle" || disabled}
              className="p-1.5 rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title={copyStatus === "copied" ? "Copied!" : "Copy message"}
              aria-label={
                copyStatus === "copied" ? "Copied to clipboard" : "Copy message to clipboard"
              }
            >
              {copyStatus === "copied" ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>

            {/* v6.2 Part 7 (P3-16): Share button.
                Creates a share link anchored to this message + copies it
                to the clipboard. Industry standard (ChatGPT): each
                assistant message has a share affordance. The 3-state UI
                matches the Copy button (idle → sharing → shared → idle).
                Disabled during streaming + on ephemeral (pending-*)
                messages (no DB id to anchor the share URL to). */}
            {typeof message.id === "number" && (
              <button
                type="button"
                onClick={handleShare}
                disabled={shareStatus !== "idle" || disabled}
                className="p-1.5 rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title={shareStatus === "shared" ? "Link copied!" : "Share message"}
                aria-label={
                  shareStatus === "shared"
                    ? "Share link copied to clipboard"
                    : "Create share link for this message"
                }
              >
                {shareStatus === "shared" ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : shareStatus === "sharing" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Share2 className="h-3.5 w-3.5" />
                )}
              </button>
            )}

            {/* Regenerate button — only on the LAST assistant message.
                Mid-history regeneration is intentionally not supported
                (would invalidate everything after). Industry standard. */}
            {isLast && (
              <button
                type="button"
                onClick={handleRegenerate}
                disabled={disabled}
                className="p-1.5 rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Regenerate response"
                aria-label="Regenerate this response"
              >
                <RotateCw className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Typing indicator (animated dots before first token) ────────────────

function TypingIndicator() {
  return (
    <div className="flex gap-2.5 animate-in fade-in duration-200">
      <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shrink-0 shadow-sm">
        <Leaf className="h-4 w-4 text-primary-foreground" />
      </div>
      <div className="px-4 py-3 bg-muted/50 rounded-2xl rounded-bl-md border border-border/50">
        <div className="flex items-center gap-1">
          <span
            className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce"
            style={{ animationDelay: "0ms" }}
          />
          <span
            className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce"
            style={{ animationDelay: "150ms" }}
          />
          <span
            className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce"
            style={{ animationDelay: "300ms" }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Tool-call progress chips (v3.7) ────────────────────────────────────

/**
 * v3.7: Maps internal tool names to user-friendly labels + icons.
 * Rendered as chips below the assistant bubble while tools execute,
 * so the user sees "Looking up your order..." instead of perceived silence.
 *
 * The tool names come from lib/aiTools.ts on the backend. If a new tool
 * is added there without a corresponding entry here, the chip falls back
 * to a generic label ("Working") + the HelpCircle icon.
 */
// v6.2 Part 1: also imported getToolSkeleton for skeleton loading states.
import { getToolSkeleton } from "./tool-ui/Skeletons";

/**
 * v6.2 Part 12 (Gap Fix #2): typed as `Record<ToolName, ...>` so every
 * tool in TOOL_NAMES MUST have an entry. A new tool added to toolNames.ts
 * without an entry here fails typecheck — no more silent fallback to
 * the generic "Working" label + HelpCircle icon.
 *
 * The `?? { label: "Working", Icon: HelpCircle }` fallback below stays
 * as a defensive measure (TS Record lookup can return undefined at
 * runtime if the object was tampered with).
 */
const TOOL_LABELS: Record<ToolName, { label: string; Icon: typeof Search }> = {
  search_catalog: { label: "Searching catalog", Icon: Search },
  get_product_care: { label: "Loading care guide", Icon: Leaf },
  get_user_orders: { label: "Looking up your orders", Icon: ShoppingCart },
  get_order_details: { label: "Fetching order details", Icon: FileText },
  search_seller_listings: { label: "Finding listings", Icon: Search },
  search_knowledge_base: { label: "Searching knowledge base", Icon: BookOpen },
};

// v6.2 Part 1: tools that have rich skeleton loading states.
// While in-flight, these tools show a skeleton card instead of just a chip.
//
// v6.2 Part 12 (Gap Fix #2): typed as `Set<ToolName>` so adding a tool to
// toolNames.ts and using it in a `.has(name)` call without adding it here
// is caught at compile time (the call site narrows `name` to ToolName first;
// the Set itself is typed so only known ToolName values can be added).
const TOOLS_WITH_SKELETONS = new Set<ToolName>([
  "get_order_details",
  "get_user_orders",
  "search_seller_listings",
  "get_product_care",
]);

function ToolCallChips({ calls }: { calls: ActiveToolCall[] }) {
  // v6.2 Part 1: split calls into skeleton-worthy + chip-only.
  const skeletonCalls = calls.filter((c) => TOOLS_WITH_SKELETONS.has(c.name));
  const chipCalls = calls.filter((c) => !TOOLS_WITH_SKELETONS.has(c.name));

  return (
    <div className="space-y-2 animate-in fade-in slide-in-from-bottom-1 duration-200 pl-10">
      {/* v6.2 Part 1: skeleton cards for tools with rich UI */}
      {skeletonCalls.map((call) => {
        const meta = TOOL_LABELS[call.name];
        const label = meta?.label ?? "Loading";
        const SkeletonComp = getToolSkeleton(call.name);
        return (
          <div key={`skeleton-${call.id}`} className="space-y-1">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="font-medium">{label}…</span>
              {call.argsPreview && (
                <span className="text-muted-foreground/60 font-normal truncate max-w-[120px]">
                  {call.argsPreview}
                </span>
              )}
            </div>
            {/* v6.2 Part 9 (Gap 17 fix — Phase B): live progress text
                from long-running tools. Rendered as a subtle line under
                the spinner label, above the skeleton. Falls back to
                nothing when the tool doesn't emit progress (the common
                case for SQL-based tools). */}
            {call.progress && (
              <div className="text-[10px] text-muted-foreground/70 italic pl-1 animate-in fade-in duration-200">
                {call.progress}
              </div>
            )}
            <SkeletonComp />
          </div>
        );
      })}
      {/* Standard chips for tools without skeletons */}
      {chipCalls.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chipCalls.map((call) => {
            const meta = TOOL_LABELS[call.name];
            const Label = meta?.label ?? "Working";
            const Icon = meta?.Icon ?? HelpCircle;
            return (
              <span
                key={call.id}
                className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-full bg-primary/10 text-primary border border-primary/20"
              >
                <Loader2 className="h-3 w-3 animate-spin" />
                <Icon className="h-3 w-3" />
                <span className="font-medium">{Label}…</span>
                {call.argsPreview && (
                  <span className="text-primary/60 font-normal truncate max-w-[120px]">
                    {call.argsPreview}
                  </span>
                )}
                {/* v6.2 Part 9 (Gap 17 fix — Phase B): progress text inline */}
                {call.progress && (
                  <span className="text-primary/50 font-normal truncate max-w-[100px] animate-in fade-in duration-200">
                    · {call.progress}
                  </span>
                )}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────

function EmptyState({ onPick }: { onPick: (s: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-8 px-2 min-h-[300px]">
      {/* Hero icon */}
      <div className="relative mb-5">
        <div className="h-20 w-20 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shadow-sm border border-primary/10">
          <Leaf className="h-10 w-10 text-primary" />
        </div>
        <div className="absolute -top-1 -right-1 h-6 w-6 rounded-full bg-background border-2 border-primary/20 flex items-center justify-center shadow-sm">
          <Sparkles className="h-3 w-3 text-primary" />
        </div>
      </div>

      <h3 className="font-semibold text-lg mb-1">Hi, I'm TreeBot 🌱</h3>
      <p className="text-sm text-muted-foreground mb-6 max-w-xs leading-relaxed">
        Your AI plant assistant. Ask me anything about trees, plant care, gardening, or browse our
        catalog.
      </p>

      {/* Suggestion cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-md">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.text}
            type="button"
            onClick={() => onPick(s.text)}
            className="group flex items-start gap-2.5 text-left text-sm px-3 py-2.5 rounded-xl border bg-background hover:bg-primary/5 hover:border-primary/30 transition-all hover:shadow-sm"
          >
            <span className="text-lg leading-none mt-0.5">{s.icon}</span>
            <span className="text-foreground/80 group-hover:text-foreground transition-colors">
              {s.text}
            </span>
          </button>
        ))}
      </div>

      <p className="text-[11px] text-muted-foreground/60 mt-6">
        Try Bangla or Banglish — I'll reply in the same language.
      </p>
    </div>
  );
}

// ─── History loading skeleton ───────────────────────────────────────────

/**
 * BUG-I8 fix: skeleton shown between mount and GET /sessions/current
 * resolution. Previously the user saw EmptyState even if they had prior
 * history — now they see a subtle skeleton that matches the chat layout.
 */
function HistorySkeleton() {
  return (
    <div
      className="space-y-4 animate-in fade-in duration-200"
      aria-label="Loading conversation history"
    >
      {/* User message skeleton (right-aligned) */}
      <div className="flex justify-end">
        <div className="max-w-[70%]">
          <div className="h-10 w-48 rounded-2xl rounded-br-md bg-muted/40 animate-pulse" />
          <div className="h-2 w-12 rounded-full bg-muted/30 animate-pulse mt-1 ml-auto" />
        </div>
      </div>
      {/* Assistant message skeleton (left-aligned with avatar) */}
      <div className="flex gap-2.5">
        <div className="h-8 w-8 rounded-full bg-muted/40 animate-pulse shrink-0" />
        <div className="max-w-[70%] flex-1">
          <div className="h-10 w-64 rounded-2xl rounded-bl-md bg-muted/40 animate-pulse" />
          <div className="h-2 w-12 rounded-full bg-muted/30 animate-pulse mt-1" />
        </div>
      </div>
      {/* Another pair */}
      <div className="flex justify-end">
        <div className="max-w-[70%]">
          <div className="h-10 w-40 rounded-2xl rounded-br-md bg-muted/40 animate-pulse" />
        </div>
      </div>
      <div className="flex gap-2.5">
        <div className="h-8 w-8 rounded-full bg-muted/40 animate-pulse shrink-0" />
        <div className="max-w-[70%] flex-1">
          <div className="h-16 w-72 rounded-2xl rounded-bl-md bg-muted/40 animate-pulse" />
          <div className="h-2 w-12 rounded-full bg-muted/30 animate-pulse mt-1" />
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function formatTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/**
 * BUG-I7 fix: formats the `usage` SSE data for display.
 * Shows "1,247 tokens · gemini-2.5-flash" or just the model if no token count.
 */
function formatUsage(usage: NonNullable<ChatMessage["usage"]>): string {
  const parts: string[] = [];
  if (usage.totalTokens != null) {
    parts.push(`${usage.totalTokens.toLocaleString()} tokens`);
  } else if (usage.promptTokens != null && usage.completionTokens != null) {
    const total = usage.promptTokens + usage.completionTokens;
    parts.push(`${total.toLocaleString()} tokens`);
  }
  if (usage.model) {
    // Strip provider prefix for brevity (e.g. "gemini-2.5-flash" not
    // "models/gemini-2.5-flash").
    const model = usage.model.replace(/^models\//, "");
    parts.push(model);
  }
  return parts.join(" · ");
}
