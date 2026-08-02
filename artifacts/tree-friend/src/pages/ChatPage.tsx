import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useLocation, Link } from "wouter";
import { useUser } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/apiClient";
import { useCurrency } from "@/lib/currency";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";
import {
  ArrowLeft,
  MessageCircle,
  Send,
  Paperclip,
  Smile,
  Check,
  CheckCheck,
  MoreVertical,
  ShieldCheck,
  ExternalLink,
} from "lucide-react";

const ICON_VERIFIED =
  "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1785076114/0731e6a0-0e45-481d-bfab-5d82aac4e9d7_1_jas2kb.svg";

// ─── Types ─────────────────────────────────────────────────────────────────

interface ConversationInfo {
  id: number;
  buyerId: string;
  sellerId: number;
  sellerName: string;
  sellerLogoUrl: string | null;
  sellerIsVerified: boolean;
  sellerListingId: number | null;
  productName: string | null;
  productImage: string | null;
  productPrice: number | null;
  productSlug: string | null;
  lastMessageAt: string;
  createdAt: string;
}

interface ChatMessage {
  id: number;
  conversationId: number;
  senderId: string;
  content: string;
  messageType: string;
  imageUrl: string | null;
  readByBuyer: boolean;
  readBySeller: boolean;
  createdAt: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
}

function shouldShowDateSeparator(prev: ChatMessage | undefined, curr: ChatMessage): boolean {
  if (!prev) return true;
  return new Date(prev.createdAt).toDateString() !== new Date(curr.createdAt).toDateString();
}

// ─── Component ─────────────────────────────────────────────────────────────

export function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const [, setLocation] = useLocation();
  const { user } = useUser();
  const qc = useQueryClient();
  const { format } = useCurrency();
  const { toast } = useToast();

  const [conversation, setConversation] = useState<ConversationInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check mobile viewport
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // ─── Fetch conversation info ──────────────────────────────────────────
  useEffect(() => {
    if (!conversationId) return;
    const id = parseInt(conversationId);
    if (isNaN(id)) return;

    setIsLoading(true);
    apiClient
      .get(`/conversations/${id}`)
      .then((res) => {
        setConversation(res.data as ConversationInfo);
      })
      .catch((err) => {
        console.error("Failed to fetch conversation:", err);
        toast({ title: "Failed to load conversation", description: "Please try again." });
      })
      .finally(() => setIsLoading(false));
  }, [conversationId]);

  // ─── Fetch messages ───────────────────────────────────────────────────
  const fetchMessages = useCallback(
    async (cursor?: number) => {
      if (!conversationId) return;
      const id = parseInt(conversationId);
      if (isNaN(id)) return;

      const params = new URLSearchParams();
      params.set("limit", "50");
      if (cursor) params.set("cursor", String(cursor));

      try {
        const res = await apiClient.get(`/conversations/${id}/messages?${params}`);
        const data = res.data as { messages: ChatMessage[]; hasMore: boolean };
        const { messages: newMessages, hasMore: more } = data;

        if (cursor) {
          // Prepending older messages
          setMessages((prev) => [...newMessages, ...prev]);
          setLoadingMore(false);
        } else {
          setMessages(newMessages);
          // Scroll to bottom on initial load
          setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
          }, 100);
        }
        setHasMore(more);
      } catch (err) {
        console.error("Failed to fetch messages:", err);
      }
    },
    [conversationId],
  );

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  // ─── Polling for new messages ─────────────────────────────────────────
  useEffect(() => {
    if (!conversationId) return;

    // Poll every 5 seconds for new messages
    pollingRef.current = setInterval(async () => {
      if (!conversationId) return;
      const id = parseInt(conversationId);
      if (isNaN(id)) return;

      try {
        const params = new URLSearchParams();
        params.set("limit", "50");
        if (messages.length > 0) {
          params.set("cursor", String(messages[messages.length - 1].id));
          params.set("direction", "after");
        }

        const res = await apiClient.get(`/conversations/${id}/messages?${params}`);
        const data = res.data as { messages: ChatMessage[]; hasMore: boolean };
        const { messages: newMessages } = data;

        if (newMessages.length > 0) {
          setMessages((prev) => {
            // Deduplicate by id
            const existingIds = new Set(prev.map((m) => m.id));
            const unique = newMessages.filter((m: ChatMessage) => !existingIds.has(m.id)) as ChatMessage[];
            if (unique.length === 0) return prev;
            return [...prev, ...unique];
          });

          // Auto-scroll to bottom if user is near bottom
          const container = messagesContainerRef.current;
          if (container) {
            const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
            if (isNearBottom) {
              setTimeout(() => {
                messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
              }, 50);
            }
          }
        }
      } catch {
        // Silently fail on polling errors
      }
    }, 5000);

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [conversationId, messages]);

  // ─── Send message ─────────────────────────────────────────────────────
  async function handleSendMessage() {
    if (!newMessage.trim() || !conversationId || isSending) return;

    const content = newMessage.trim();
    setNewMessage("");
    setIsSending(true);

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    try {
      const id = parseInt(conversationId);
      const res = await apiClient.post(`/conversations/${id}/messages`, {
        content,
        messageType: "text",
      });

      setMessages((prev) => [...prev, res.data as ChatMessage]);
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 50);

      // Invalidate conversations list to update lastMessage
      qc.invalidateQueries({ queryKey: ["conversations"] });
    } catch (err) {
      console.error("Failed to send message:", err);
      toast({ title: "Failed to send message", description: "Please try again." });
      setNewMessage(content); // Restore message on failure
    } finally {
      setIsSending(false);
    }
  }

  // ─── Load more messages (scroll up) ───────────────────────────────────
  function handleLoadMore() {
    if (hasMore && !loadingMore && messages.length > 0) {
      setLoadingMore(true);
      fetchMessages(messages[0].id);
    }
  }

  // ─── Auto-resize textarea ─────────────────────────────────────────────
  function handleTextareaChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setNewMessage(e.target.value);
    const textarea = e.target;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  }

  // ─── Loading state ────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto px-4 pt-4 pb-16">
        <div className="flex items-center gap-3 mb-4">
          <Skeleton className="w-8 h-8 rounded-full" />
          <Skeleton className="h-5 w-40" />
        </div>
        <Skeleton className="h-96 w-full rounded-2xl" />
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <h1 className="font-serif text-2xl font-medium mb-2">Conversation not found</h1>
        <p className="text-muted-foreground mb-6">This conversation doesn't exist or you don't have access.</p>
        <Link href="/messages">
          <Button>Back to Messages</Button>
        </Link>
      </div>
    );
  }

  const isBuyer = user?.id === conversation.buyerId;

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div className="max-w-3xl mx-auto flex flex-col h-[calc(100dvh-4rem)]">
      {/* ─── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card shrink-0">
        <button
          onClick={() => setLocation("/messages")}
          className="p-1 -ml-1 rounded-full hover:bg-muted/50 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        {/* Avatar */}
        <div className="w-10 h-10 rounded-full overflow-hidden border shrink-0 bg-muted/30">
          {conversation.sellerLogoUrl ? (
            <img src={conversation.sellerLogoUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <NoImagePlaceholder compact />
            </div>
          )}
        </div>

        {/* Name & status */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <h1 className="font-semibold text-sm truncate">{conversation.sellerName}</h1>
            {conversation.sellerIsVerified && (
              <img src={ICON_VERIFIED} alt="Verified" className="w-4 h-4 shrink-0" />
            )}
          </div>
          <p className="text-[11px] text-green-600 font-medium">Online</p>
        </div>

        {/* More options */}
        <button className="p-1.5 rounded-full hover:bg-muted/50 transition-colors">
          <MoreVertical className="w-5 h-5 text-muted-foreground" />
        </button>
      </div>

      {/* ─── Product Context Card ─────────────────────────────────────── */}
      {conversation.productName && (
        <div className="mx-4 mt-3 p-3 bg-card border border-border rounded-xl flex items-center gap-3 shrink-0">
          <div className="w-12 h-12 rounded-lg overflow-hidden bg-muted/30 shrink-0">
            {conversation.productImage ? (
              <img src={conversation.productImage} alt="" className="w-full h-full object-cover" />
            ) : (
              <NoImagePlaceholder compact />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{conversation.productName}</p>
            {conversation.productPrice != null && (
              <p className="text-sm font-bold text-accent">{format(conversation.productPrice)}</p>
            )}
          </div>
          {conversation.sellerListingId && (
            <Link
              href={`/products/${conversation.productSlug ?? conversation.sellerListingId}/listings/${conversation.sellerListingId}`}
              className="shrink-0"
            >
              <Button size="sm" variant="outline" className="gap-1 text-xs">
                <ExternalLink className="w-3 h-3" />
                View Product
              </Button>
            </Link>
          )}
        </div>
      )}

      {/* ─── Messages Area ────────────────────────────────────────────── */}
      <div
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-1 bg-muted/20"
      >
        {/* Load more button */}
        {hasMore && (
          <div className="text-center py-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="text-xs text-muted-foreground"
            >
              {loadingMore ? "Loading..." : "Load earlier messages"}
            </Button>
          </div>
        )}

        {messages.map((msg, i) => {
          const prevMsg = i > 0 ? messages[i - 1] : undefined;
          const isOwn = msg.senderId === user?.id;
          const showDate = shouldShowDateSeparator(prevMsg, msg);

          // Check if this is the last message from the same sender in a sequence
          const nextMsg = i < messages.length - 1 ? messages[i + 1] : undefined;
          const isLastInSequence = !nextMsg || nextMsg.senderId !== msg.senderId;

          return (
            <div key={msg.id}>
              {/* Date separator */}
              {showDate && (
                <div className="flex items-center justify-center py-3">
                  <span className="text-[11px] text-muted-foreground bg-muted/60 px-3 py-1 rounded-full">
                    {formatDate(msg.createdAt)}
                  </span>
                </div>
              )}

              {/* Message bubble */}
              <div className={`flex ${isOwn ? "justify-end" : "justify-start"} ${isLastInSequence ? "mb-2" : "mb-0.5"}`}>
                {/* Seller avatar (only for first in sequence) */}
                {!isOwn && isLastInSequence && (
                  <div className="w-7 h-7 rounded-full overflow-hidden border shrink-0 mr-2 mt-1 bg-muted/30">
                    {conversation.sellerLogoUrl ? (
                      <img src={conversation.sellerLogoUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <NoImagePlaceholder compact />
                      </div>
                    )}
                  </div>
                )}
                {!isOwn && !isLastInSequence && <div className="w-7 mr-2 shrink-0" />}

                <div
                  className={`max-w-[75%] sm:max-w-[65%] ${
                    isOwn
                      ? "bg-accent/10 dark:bg-accent/15 rounded-2xl rounded-br-md"
                      : "bg-card border border-border rounded-2xl rounded-bl-md"
                  } px-3.5 py-2.5`}
                >
                  {/* Image message */}
                  {msg.messageType === "image" && msg.imageUrl && (
                    <div className="mb-2 rounded-lg overflow-hidden">
                      <img src={msg.imageUrl} alt="" className="w-full max-w-[240px] object-cover" loading="lazy" />
                    </div>
                  )}

                  {/* Text content */}
                  <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{msg.content}</p>

                  {/* Timestamp & read receipt */}
                  <div className={`flex items-center gap-1 mt-1 ${isOwn ? "justify-end" : "justify-end"}`}>
                    <span className="text-[10px] text-muted-foreground">{formatTime(msg.createdAt)}</span>
                    {isOwn && (
                      msg.readByBuyer && msg.readBySeller ? (
                        <CheckCheck className="w-3 h-3 text-accent" />
                      ) : (
                        <Check className="w-3 h-3 text-muted-foreground" />
                      )
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* Empty state */}
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mb-4">
              <MessageCircle className="w-8 h-8 text-accent" />
            </div>
            <h2 className="font-serif text-lg font-medium mb-1">Start the conversation</h2>
            <p className="text-sm text-muted-foreground max-w-[240px]">
              Say hello to {conversation.sellerName}! Ask about products, delivery, or anything else.
            </p>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ─── Input Area ────────────────────────────────────────────────── */}
      <div className="px-4 py-3 border-t border-border bg-card shrink-0">
        <div className="flex items-end gap-2">
          {/* Emoji button (placeholder) */}
          <button className="p-2 rounded-full hover:bg-muted/50 transition-colors shrink-0 text-muted-foreground">
            <Smile className="w-5 h-5" />
          </button>

          {/* Attachment button (placeholder) */}
          <button className="p-2 rounded-full hover:bg-muted/50 transition-colors shrink-0 text-muted-foreground">
            <Paperclip className="w-5 h-5" />
          </button>

          {/* Text input */}
          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={newMessage}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              rows={1}
              className="w-full resize-none rounded-2xl border border-border bg-muted/30 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 max-h-[120px] placeholder:text-muted-foreground"
            />
          </div>

          {/* Send button */}
          <Button
            size="icon"
            onClick={handleSendMessage}
            disabled={!newMessage.trim() || isSending}
            className="rounded-full h-10 w-10 shrink-0 bg-accent hover:bg-accent/90 text-accent-foreground"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
