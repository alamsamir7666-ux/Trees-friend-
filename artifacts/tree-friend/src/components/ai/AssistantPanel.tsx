/**
 * AssistantPanel — the chat UI itself. Renders the message list + composer.
 *
 * v3.0 UI/UX upgrade — industry-standard chat design:
 *   - Clean header (transparent bg, subtle border, online status dot)
 *   - AI avatar (leaf icon in gradient circle) next to each AI message
 *   - Typing indicator (animated dots) before first token arrives
 *   - Message timestamps (subtle, below each bubble)
 *   - Smooth slide-in animation for new messages
 *   - Scroll-to-bottom button when scrolled up
 *   - Polished empty state with hero + suggestion cards
 *   - Refined composer with focus ring + proper padding
 *
 * v1.5/v2.0/v2.5 features preserved:
 *   - Markdown rendering (bold, italic, code, bullet lists)
 *   - Product chips ([[bracket]] auto-linkified)
 *   - Followup chips (suggested next questions)
 *   - Feedback buttons (👍/👎)
 *   - Off-topic refusal badges
 *   - "Signed in as" indicator
 */
import {
  useEffect, useRef, useState, type FormEvent, type Key, useCallback,
} from "react";
import { useAuth } from "@clerk/react";
import {
  Sparkles, Send, Trash2, X, Loader2, Leaf, ChevronDown, UserCircle2,
} from "lucide-react";
import { useAiChat, type ChatMessage } from "@/hooks/useAiChat";
import { MarkdownText } from "./MarkdownText";
import { ProductChips } from "./ProductChips";
import { FollowupChips } from "./FollowupChips";
import { FeedbackButtons } from "./FeedbackButtons";
import {
  extractFollowups,
  extractProductMentions,
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

interface AssistantPanelProps {
  /** Optional callback when the user closes the panel (sheet mode only). */
  onClose?: () => void;
  /** Optional link to a full-page view (sheet mode shows a "Expand" button). */
  onOpenFullPage?: () => void;
}

export function AssistantPanel({ onClose, onOpenFullPage }: AssistantPanelProps) {
  const { messages, loading, error, send, clear } = useAiChat();
  const { user, isSignedIn } = useAuth();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // ─── Auto-scroll to bottom on new messages / streaming deltas ────────
  // Only auto-scroll if the user is already at (or near) the bottom.
  // If they've scrolled up to read earlier messages, don't yank them down.
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    if (isAtBottom) {
      scrollToBottom("smooth");
    }
  }, [messages, isAtBottom, scrollToBottom]);

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
    if (
      !window.confirm(
        "Clear this conversation? TreeBot will forget everything we discussed.",
      )
    ) {
      return;
    }
    await clear();
  };

  // ─── Typing indicator: show when loading AND the last assistant message ─
  // has no content yet (waiting for first token).
  const isTyping =
    loading &&
    messages.length > 0 &&
    messages[messages.length - 1].role === "assistant" &&
    !messages[messages.length - 1].content;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* ─── Header ───────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-4 py-3 border-b bg-background/80 backdrop-blur-sm">
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
      </header>

      {/* ─── Messages ─────────────────────────────────────────────────── */}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="absolute inset-0 overflow-y-auto scroll-smooth"
        >
          <div className="px-4 py-5">
            {messages.length === 0 ? (
              <EmptyState onPick={send} />
            ) : (
              <div className="space-y-4">
                {messages.map((m, i) => (
                  <MessageRow
                    key={(m.id ?? `m${i}`) as Key}
                    message={m}
                    isStreaming={
                      loading &&
                      m.role === "assistant" &&
                      i === messages.length - 1 &&
                      !!m.content
                    }
                    onPickFollowup={send}
                    disabled={loading}
                    onClose={onClose}
                  />
                ))}
                {isTyping && <TypingIndicator />}
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
            maxLength={2000}
          />
          <button
            type="submit"
            disabled={!input.trim() || loading}
            className="h-9 w-9 shrink-0 rounded-xl bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed hover:bg-primary/90 active:scale-95 transition-all shadow-sm"
            aria-label="Send message"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </form>
        <p className="text-[10px] text-muted-foreground/60 text-center mt-2">
          TreeBot can make mistakes. Always verify plant care advice.
        </p>
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
  key?: Key;
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
            !isStreaming && (
              <span className="text-muted-foreground italic">
                (empty response)
              </span>
            )
          )}
          {isStreaming && (
            <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-primary rounded-sm animate-pulse align-middle" />
          )}
        </div>

        {/* Timestamp + off-topic badge */}
        <div className="flex items-center gap-2 mt-1 px-1">
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
            <span className="text-[10px] text-muted-foreground/60">
              👋 Welcome
            </span>
          )}
        </div>

        {/* v1.5: Product chips */}
        {!isStreaming && productMentions.length > 0 && (
          <ProductChips names={productMentions} onClose={onClose} />
        )}

        {/* v1.5: Follow-up chips */}
        {!isStreaming && followups.length > 0 && (
          <FollowupChips
            followups={followups}
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
        Your AI plant assistant. Ask me anything about trees, plant care,
        gardening, or browse our catalog.
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

// ─── Helpers ────────────────────────────────────────────────────────────

function formatTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}
