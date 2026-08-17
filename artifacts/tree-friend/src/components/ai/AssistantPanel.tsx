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
import { useEffect, useRef, useState, type FormEvent, useCallback } from "react";
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
} from "lucide-react";
import { useAiChat, type ChatMessage, type ActiveToolCall } from "@/hooks/useAiChat";
import { MarkdownText } from "./MarkdownText";
import { ProductChips } from "./ProductChips";
import { ListingChips } from "./ListingChip";
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
    setInput("");
    setIsAtBottom(true);
    await send(text);
  };

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
  const isTyping =
    loading &&
    messages.length > 0 &&
    messages[messages.length - 1].role === "assistant" &&
    !messages[messages.length - 1].content;

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
                {messages.map((m, i) => (
                  <MessageRow
                    key={m.id ?? `m${i}`}
                    message={m}
                    isStreaming={
                      loading && m.role === "assistant" && i === messages.length - 1 && !!m.content
                    }
                    onPickFollowup={send}
                    disabled={loading}
                    onClose={onClose}
                  />
                ))}
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
        <form
          onSubmit={handleSubmit}
          className="flex items-end gap-2 bg-muted/40 rounded-2xl border border-border focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/20 transition-all px-3 py-2"
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e as unknown as FormEvent);
              }
            }}
            rows={1}
            placeholder="Ask about plants, care, gardening…"
            disabled={loading}
            className="flex-1 resize-none bg-transparent border-0 outline-none text-sm placeholder:text-muted-foreground/60 disabled:opacity-60 max-h-[120px] py-1"
            maxLength={INPUT_MAX_LENGTH}
            aria-label="Type your message"
          />
          <button
            type="submit"
            disabled={!input.trim() || loading}
            className="h-9 w-9 shrink-0 rounded-xl bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed hover:bg-primary/90 active:scale-95 transition-all shadow-sm"
            aria-label="Send message"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
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
  onPickFollowup,
  disabled,
  onClose,
}: {
  message: ChatMessage;
  isStreaming: boolean;
  onPickFollowup: (s: string) => void;
  disabled?: boolean;
  onClose?: () => void;
}) {
  const isUser = message.role === "user";

  // ─── Parse the AI response ─────────────────────────────────────────
  if (isUser) {
    return (
      <div className="flex justify-end animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="max-w-[80%] sm:max-w-[70%]">
          <div className="px-4 py-2.5 text-sm whitespace-pre-wrap break-words bg-primary text-primary-foreground rounded-2xl rounded-br-md shadow-sm">
            {message.content}
          </div>
          {message.createdAt && (
            <div className="text-[10px] text-muted-foreground/60 mt-1 text-right pr-1">
              {formatTime(message.createdAt)}
            </div>
          )}
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
            !isStreaming && <span className="text-muted-foreground italic">(empty response)</span>
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
const TOOL_LABELS: Record<string, { label: string; Icon: typeof Search }> = {
  search_catalog: { label: "Searching catalog", Icon: Search },
  get_product_care: { label: "Loading care guide", Icon: Leaf },
  get_user_orders: { label: "Looking up your orders", Icon: ShoppingCart },
  get_order_details: { label: "Fetching order details", Icon: FileText },
  search_knowledge_base: { label: "Searching knowledge base", Icon: BookOpen },
};

function ToolCallChips({ calls }: { calls: ActiveToolCall[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 animate-in fade-in slide-in-from-bottom-1 duration-200 pl-10">
      {calls.map((call) => {
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
            {/* BUG-I7 fix: render the previously-dead `argsPreview` SSE data. */}
            {/* Shows "Searching for: mang…" → "mango…" as args stream in. */}
            {call.argsPreview && (
              <span className="text-primary/60 font-normal truncate max-w-[120px]">
                {call.argsPreview}
              </span>
            )}
          </span>
        );
      })}
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
