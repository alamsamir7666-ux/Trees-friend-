/**
 * AssistantPanel — the chat UI itself. Renders the message list + composer.
 *
 * v1.5 upgrades:
 *   - Markdown rendering (bold, italic, code, bullet lists, paragraphs)
 *     via MarkdownText.tsx — no react-markdown dependency.
 *   - Auto-linkified product mentions: AI wraps product names in
 *     [[double brackets]]; we extract them via parseMessage.ts and render
 *     as clickable chips below the bubble (ProductChips.tsx) that
 *     navigate to /products?q=<name>.
 *   - Suggested follow-up chips: AI appends a [followups]...[/followups]
 *     block to each reply; we extract it and render as clickable chips
 *     (FollowupChips.tsx) that send the suggested question as a new
 *     user message.
 *   - Feedback buttons (👍/👎) on each assistant message (FeedbackButtons.tsx).
 *     Persisted to ai_chat_feedback table via POST /api/ai/feedback.
 *
 * Used in two contexts:
 *   1. Inside a Sheet/Drawer triggered by the floating AssistantBubble.
 *   2. As the main content of the /assistant full-page route.
 */
import { useEffect, useRef, useState, type FormEvent, type Key } from "react";
import { useAuth } from "@clerk/react";
import { Sparkles, Send, Trash2, X, Loader2, UserCircle2 } from "lucide-react";
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
  "What indoor plants are easy to care for in Bangladesh?",
  "How often should I water a mango sapling?",
  "Recommend shade-loving trees for a balcony",
  "When is the best season to plant a jackfruit tree?",
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

  // Auto-scroll to bottom on new messages / streaming deltas.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Auto-resize textarea.
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

  return (
    <div className="flex flex-col h-full bg-background">
      {/* ─── Header ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-primary text-primary-foreground">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-9 w-9 rounded-full bg-primary-foreground/15 flex items-center justify-center shrink-0">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="font-semibold leading-tight">TreeBot</div>
            <div className="text-xs text-primary-foreground/70 truncate flex items-center gap-1">
              {isSignedIn && user ? (
                <>
                  <UserCircle2 className="h-3 w-3" />
                  <span className="truncate max-w-[120px]">
                    {user.firstName ?? user.username ?? "Signed in"}
                  </span>
                  <span className="text-primary-foreground/40">·</span>
                  <span className="truncate">trees & gardening</span>
                </>
              ) : (
                <span>Plant assistant · trees & gardening</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onOpenFullPage && (
            <button
              type="button"
              onClick={onOpenFullPage}
              className="text-xs px-2.5 py-1 rounded-full bg-primary-foreground/10 hover:bg-primary-foreground/20 transition-colors"
              title="Open full page"
            >
              Expand
            </button>
          )}
          <button
            type="button"
            onClick={handleClear}
            disabled={loading || messages.length === 0}
            className="p-1.5 rounded-full hover:bg-primary-foreground/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Clear conversation"
            aria-label="Clear conversation"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-full hover:bg-primary-foreground/10 transition-colors"
              title="Close"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>

      {/* ─── Messages ──────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-5 space-y-3"
      >
        {messages.length === 0 ? (
          <EmptyState onPick={send} />
        ) : (
          messages.map((m, i) => (
            <Bubble
              key={(m.id ?? `m${i}`) as Key}
              message={m}
              isStreaming={
                loading &&
                m.role === "assistant" &&
                i === messages.length - 1
              }
              onPickFollowup={send}
              disabled={loading}
              onClose={onClose}
            />
          ))
        )}
        {error && (
          <div className="text-center text-xs text-destructive py-2">
            {error}
          </div>
        )}
      </div>

      {/* ─── Composer ──────────────────────────────────────────── */}
      <form
        onSubmit={handleSubmit}
        className="border-t bg-background p-3 flex items-end gap-2"
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
          placeholder="Ask TreeBot about plants, care, gardening…"
          disabled={loading}
          className="flex-1 resize-none bg-muted/40 rounded-2xl px-4 py-2.5 text-sm border border-input focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary disabled:opacity-60 max-h-[120px]"
          maxLength={2000}
        />
        <button
          type="submit"
          disabled={!input.trim() || loading}
          className="h-10 w-10 shrink-0 rounded-full bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent hover:text-accent-foreground transition-colors"
          aria-label="Send message"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </button>
      </form>
    </div>
  );
}

// ─── Bubble ───────────────────────────────────────────────────────────────

function Bubble({
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

  // ─── Parse the AI response for v1.5 features ───
  // For user messages: just render the raw content. For assistant: extract
  // the [followups] block + [[product mentions]] + strip their markers.
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] sm:max-w-[75%] px-4 py-2.5 text-sm whitespace-pre-wrap break-words bg-primary text-primary-foreground rounded-2xl rounded-br-md">
          {message.content}
        </div>
      </div>
    );
  }

  // Assistant message — apply parsing.
  const { cleanedContent, followups } = extractFollowups(message.content);
  const displayContent = stripProductMentionMarkers(cleanedContent);
  const productMentions = extractProductMentions(cleanedContent);

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] sm:max-w-[75%]">
        <div className="px-4 py-2.5 text-sm bg-muted/60 text-foreground rounded-2xl rounded-bl-md border">
          {displayContent ? (
            <MarkdownText content={displayContent} />
          ) : (
            <span className="text-muted-foreground italic">
              {isStreaming ? "Thinking…" : "(empty response)"}
            </span>
          )}
          {isStreaming && (
            <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-current opacity-60 animate-pulse" />
          )}
        </div>

        {/* v2.0: off-topic / greeting badges (small, muted) */}
        {message.offTopic && (
          <div className="text-[10px] text-muted-foreground/70 mt-1 ml-1">
            ⚠ Off-topic — refused
          </div>
        )}

        {/* ─── v1.5: Product chips ─── */}
        {!isStreaming && productMentions.length > 0 && (
          <ProductChips names={productMentions} onClose={onClose} />
        )}

        {/* ─── v1.5: Follow-up suggestion chips ─── */}
        {!isStreaming && followups.length > 0 && (
          <FollowupChips
            followups={followups}
            onPick={onPickFollowup}
            disabled={disabled}
          />
        )}

        {/* ─── v1.5: Feedback buttons ─── */}
        {!isStreaming && typeof message.id === "number" && (
          <FeedbackButtons messageId={message.id} />
        )}
      </div>
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────

function EmptyState({ onPick }: { onPick: (s: string) => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-4 py-8">
      <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center mb-3">
        <Sparkles className="h-7 w-7 text-primary" />
      </div>
      <h3 className="font-semibold text-lg mb-1">Hi, I'm TreeBot 🌱</h3>
      <p className="text-sm text-muted-foreground mb-5 max-w-xs">
        I can answer questions about trees, plants, gardening, and our
        TreeFriend catalog. What would you like to know?
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-md">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="text-left text-xs px-3 py-2.5 rounded-xl border bg-background hover:bg-primary/5 hover:border-primary/40 transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground/70 mt-5">
        Try Bangla or Banglish — I'll reply in the same language.
      </p>
    </div>
  );
}
