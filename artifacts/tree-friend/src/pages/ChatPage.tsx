import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useLocation, Link } from "wouter";
import { useUser } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/apiClient";
import { useCurrency } from "@/lib/currency";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";
import { EmojiPicker } from "@/components/ui/EmojiPicker";
import {
  AttachmentMenu,
  fileIconFor,
  formatFileSize,
  isAllowedFile,
  classifyFile,
} from "@/components/ui/AttachmentMenu";
import { uploadAttachment } from "@/lib/uploadAttachment";
import { usePresence, formatLastSeen } from "@/hooks/usePresence";
import { useLongPress } from "@/hooks/useLongPress";
import { useSwipeToReply } from "@/hooks/useSwipeToReply";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  MessageCircle,
  Send,
  Check,
  CheckCheck,
  MoreVertical,
  ExternalLink,
  Download,
  X,
  Loader2,
  Film,
  Music,
  Pencil,
  Trash2,
  Ban,
  Copy,
  Info,
  Store,
  Package,
  Settings,
  Search,
  RefreshCw,
  AlertCircle,
  ShoppingBag,
  CornerUpLeft,
  Reply,
} from "lucide-react";

const ICON_VERIFIED =
  "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1785076114/0731e6a0-0e45-481d-bfab-5d82aac4e9d7_1_jas2kb.svg";



// ─── Extracted chat sub-modules ────────────────────────────────────────────
// ChatPage.tsx was 2,833 lines, mixing the main component with six
// sub-components, all the types, and all the helpers. Each piece now
// lives in its own file under @/components/chat/. This file retains
// only the main ChatPage component itself.
import type {
  ConversationInfo,
  ConversationListItem,
  ConversationListResponse,
  ChatMessage,
  PendingAttachment,
} from "@/components/chat/types";
import {
  EDIT_DELETE_WINDOW_MS,
  isWithinEditWindow,
  formatTime,
  formatDate,
  shouldShowDateSeparator,
  attachmentUrl,
  classifyMessage,
} from "@/components/chat/helpers";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { PresenceStatus } from "@/components/chat/PresenceStatus";
import { MessageAttachment } from "@/components/chat/MessageAttachment";
import { PendingAttachmentPreview } from "@/components/chat/PendingAttachmentPreview";
import { ConversationsSidebar } from "@/components/chat/ConversationsSidebar";



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

  // Presence tracking for the OTHER party in this conversation. The hook
  // polls GET /api/presence/:clerkUserId every 15s and returns the current
  // status. Pass null while the conversation hasn't loaded yet — the hook
  // is a no-op in that case (no polling). Empty string is also treated as
  // "no presence" (the backend returns "" for otherPartyClerkId if the
  // seller's user row was missing).
  const otherPartyClerkId = conversation?.otherPartyClerkId
    ? conversation.otherPartyClerkId
    : null;
  const presence = usePresence(otherPartyClerkId);
  const [loadingMore, setLoadingMore] = useState(false);
  // Lightbox state — when set, the full image opens in a modal overlay.
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  // Pending attachments staged in the composer (not yet uploaded).
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);

  // ─── Edit / Delete state ────────────────────────────────────────────────
  // The message currently being edited (inline). When set, the composer
  // switches to edit mode: the textarea is pre-filled with the message's
  // content, Send becomes Save, and a Cancel button appears. Hitting Enter
  // (or clicking Save) calls PATCH /messages/:id; Esc cancels.
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  // The id of the message whose action menu (Edit / Delete) is open. Only
  // one menu can be open at a time. Toggling it via long-press on mobile
  // or hover-then-click on desktop.
  const [openMenuMessageId, setOpenMenuMessageId] = useState<number | null>(null);
  // Pending delete confirmation. We don't use a confirm() dialog — instead,
  // clicking Delete in the menu opens a small inline confirm popover on the
  // bubble itself ("Delete? This can't be undone. [Cancel] [Delete]").
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  // Track in-flight requests so we can disable buttons and show spinners.
  const [editSaving, setEditSaving] = useState(false);
  const [deleteSavingId, setDeleteSavingId] = useState<number | null>(null);

  // ─── Reply state (swipe-to-reply + action-menu Reply) ───────────────────
  // When non-null, the composer shows a reply-preview bar above the textarea
  // and the next sent message will include `replyToId` pointing at this msg.
  // Cleared on send, on cancel (X button), and when navigating away.
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);

  // ─── Left sidebar (3-dot menu) state ────────────────────────────────────
  // Tapping the header ⋮ button opens a left-side Sheet showing the list of
  // conversations the current user has had in their CURRENT role:
  //   - viewerRole === "buyer"  → buyerConversations (sellers they've chatted with)
  //   - viewerRole === "seller" → sellerConversations (users/buyers they've chatted with)
  // The list is fetched on first open and cached. We refetch on manual retry
  // (error state) but not on every open — that would be wasteful and would
  // cause the sidebar to flash a loading spinner every time.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [conversationList, setConversationList] = useState<ConversationListResponse | null>(null);
  const [sidebarLoading, setSidebarLoading] = useState(false);
  const [sidebarError, setSidebarError] = useState<string | null>(null);
  const [sidebarSearch, setSidebarSearch] = useState("");

  const loadConversationList = useCallback(() => {
    if (!user) return;
    setSidebarLoading(true);
    setSidebarError(null);
    apiClient
      .get("/api/conversations")
      .then((res) => {
        setConversationList(res.data as ConversationListResponse);
      })
      .catch((err: unknown) => {
        const serverDetail =
          (err as { response?: { data?: { detail?: string; error?: string } } })
            ?.response?.data?.detail ??
          (err as { response?: { data?: { error?: string } } })
            ?.response?.data?.error;
        const fallback = (err as { message?: string })?.message ?? "Unknown error";
        setSidebarError(serverDetail ?? fallback);
         
        console.error("Failed to fetch conversation list:", err);
      })
      .finally(() => setSidebarLoading(false));
  }, [user]);

  // Fetch on first sidebar open (and only when user is available).
  // Subsequent opens reuse the cached list — user can pull-to-refresh via
  // the retry button in the error state, or by closing & reopening after
  // some time. We deliberately don't refetch on every open to avoid spam.
  useEffect(() => {
    if (sidebarOpen && user && !conversationList && !sidebarLoading) {
      loadConversationList();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarOpen, user]);

  // Reset search when sidebar closes so the next open starts fresh.
  useEffect(() => {
    if (!sidebarOpen) setSidebarSearch("");
  }, [sidebarOpen]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // ─── Scroll-position tracking ─────────────────────────────────────────
  // We use a ref + IntersectionObserver instead of reading scroll math
  // inside the polling callback. The old approach computed `isNearBottom`
  // from `scrollHeight - scrollTop - clientHeight` SYNCHRONOUSLY after
  // setMessages — but React hadn't re-rendered yet, so scrollHeight was
  // stale and the check was unreliable. The IntersectionObserver watches
  // a sentinel div at the bottom of the message list and tells us, at
  // any time, whether the user can currently see it.
  const isNearBottomRef = useRef(true);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  // Latest message id, kept in a ref so the polling effect can depend on
  // [conversationId] only and not re-create the interval on every new
  // message (which caused interval churn and missed polls).
  const latestMessageIdRef = useRef<number | null>(null);
  // Track whether the initial scroll-to-bottom has happened, so we don't
  // fight the browser's restored scroll position on a refresh.
  const didInitialScrollRef = useRef(false);

  // ─── Fetch conversation info ──────────────────────────────────────────
  useEffect(() => {
    if (!conversationId) return;
    const id = parseInt(conversationId);
    if (isNaN(id)) return;

    setIsLoading(true);
    apiClient
      .get(`/api/conversations/${id}`)
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
        const res = await apiClient.get(`/api/conversations/${id}/messages?${params}`);
        const data = res.data as { messages: ChatMessage[]; hasMore: boolean };
        const { messages: newMessages, hasMore: more } = data;

        if (cursor) {
          // Prepending older messages — preserve scroll position so the
          // user doesn't get yanked to a different spot.
          setMessages((prev) => [...newMessages, ...prev]);
          setLoadingMore(false);
        } else {
          setMessages(newMessages);
          // Update latest message id ref so polling starts from the right
          // cursor without depending on the `messages` state.
          if (newMessages.length > 0) {
            latestMessageIdRef.current = newMessages[newMessages.length - 1].id;
          }
          // Mark that we need to do the initial scroll-to-bottom. The
          // actual scroll is handled by a separate effect that runs after
          // the messages render, so layout is correct.
          didInitialScrollRef.current = false;
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

  // ─── Reset edit/menu state on conversation change ───────────────────────
  // If the user navigates to a different chat (or the same chat refreshes),
  // bail out of any in-flight edit / open menu / delete-confirmation state.
  // Otherwise the composer would stay in edit mode with the previous
  // message's content, or a stale menu could appear over the wrong bubble.
  useEffect(() => {
    setEditingMessage(null);
    setOpenMenuMessageId(null);
    setPendingDeleteId(null);
    setNewMessage("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [conversationId]);

  // ─── Initial scroll-to-bottom ───────────────────────────────────────────
  // Runs after messages first render. We set scrollTop DIRECTLY on the
  // messages container instead of calling scrollIntoView() on the bottom
  // sentinel — scrollIntoView() scrolls ALL scrollable ancestors, including
  // the window/document. When the Footer is rendered below the chat (which
  // it is, on every route), the document becomes taller than the viewport,
  // and scrollIntoView() would yank the WINDOW down to reveal the Footer.
  // Setting scrollTop on the container only scrolls that one element,
  // leaving the window alone. This matches WhatsApp/Telegram behavior.
  useEffect(() => {
    if (didInitialScrollRef.current) return;
    if (messages.length === 0) return;
    const raf = requestAnimationFrame(() => {
      const container = messagesContainerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
      didInitialScrollRef.current = true;
      isNearBottomRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [messages.length]);

  // ─── IntersectionObserver: track whether user is near the bottom ────────
  // This replaces the old scroll-math check (`scrollHeight - scrollTop -
  // clientHeight < 150`) which was unreliable because it ran before React
  // committed new messages. The observer fires whenever the sentinel
  // enters/leaves the viewport, keeping `isNearBottomRef` accurate at all
  // times. Polling and send-message both read this ref to decide whether
  // to auto-scroll.
  useEffect(() => {
    const sentinel = bottomSentinelRef.current;
    const container = messagesContainerRef.current;
    if (!sentinel || !container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          isNearBottomRef.current = entry.isIntersecting;
        }
      },
      // root is the scroll container; rootMargin lets us treat "within
      // 150px of the bottom" as "at the bottom", matching the old threshold.
      { root: container, rootMargin: "0px 0px 150px 0px", threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // ─── Polling for new messages ─────────────────────────────────────────
  // Deps are [conversationId] ONLY — not [conversationId, messages].
  // The old dependency on `messages` caused the interval to be torn down
  // and re-created on every single new message, which meant:
  //   1. The 5-second timer kept restarting, so during an active
  //      conversation polling was effectively disabled.
  //   2. Each re-creation was wasted work.
  // We now read the latest message id from a ref instead.
  useEffect(() => {
    if (!conversationId) return;

    pollingRef.current = setInterval(async () => {
      if (!conversationId) return;
      const id = parseInt(conversationId);
      if (isNaN(id)) return;

      try {
        const params = new URLSearchParams();
        params.set("limit", "50");
        const cursor = latestMessageIdRef.current;
        if (cursor != null) {
          params.set("cursor", String(cursor));
          params.set("direction", "after");
        }

        const res = await apiClient.get(`/api/conversations/${id}/messages?${params}`);
        const data = res.data as { messages: ChatMessage[]; hasMore: boolean };
        const { messages: newMessages } = data;

        if (newMessages.length > 0) {
          // Update the ref BEFORE setMessages so the next poll uses the
          // correct cursor even if React hasn't re-rendered yet.
          latestMessageIdRef.current =
            newMessages[newMessages.length - 1].id;

          setMessages((prev) => {
            // Merge by id: the polling endpoint can return BOTH brand-new
            // messages AND updated versions of already-known messages
            // (e.g. the other party edited or deleted an in-window message).
            // For each message from the server: if we already have it, merge
            // the fields (so edits/deletes propagate); otherwise append.
            const byId = new Map(prev.map((m) => [m.id, m]));
            let changed = false;
            for (const m of newMessages as ChatMessage[]) {
              const existing = byId.get(m.id);
              if (existing) {
                // Only update if something actually differs — avoids
                // needless re-renders when the server returns the same
                // message we already have.
                if (
                  existing.content !== m.content ||
                  existing.editedAt !== m.editedAt ||
                  existing.isDeleted !== m.isDeleted ||
                  existing.readByBuyer !== m.readByBuyer ||
                  existing.readBySeller !== m.readBySeller
                ) {
                  byId.set(m.id, { ...existing, ...m });
                  changed = true;
                }
              } else {
                byId.set(m.id, m);
                changed = true;
              }
            }
            if (!changed) return prev;
            // Re-sort by id (proxy for createdAt, since ids are serial) to
            // keep chronological order with new messages at the end.
            return Array.from(byId.values()).sort((a, b) => a.id - b.id);
          });

          // Auto-scroll to bottom ONLY if the user is already there.
          // Reading the ref is safe — it's updated by the
          // IntersectionObserver, not by stale scroll math.
          // We set scrollTop directly on the container (NOT scrollIntoView)
          // so the window doesn't get yanked down to reveal the Footer.
          if (isNearBottomRef.current) {
            requestAnimationFrame(() => {
              const container = messagesContainerRef.current;
              if (container) {
                container.scrollTo({
                  top: container.scrollHeight,
                  behavior: "smooth",
                });
              }
            });
          }
        }
      } catch {
        // Silently fail on polling errors — a transient network blip
        // shouldn't spam the user with toasts.
      }
    }, 5000);

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [conversationId]);

  // ─── Send message (text + pending attachments) ──────────────────────────
  // Unified send handler. If there are pending attachments, uploads them
  // one-by-one with progress and appends each to the message list. The
  // text (if any) is sent as the caption of the FIRST attachment; if
  // there's no attachment, the text is sent as a standalone text message.
  // This matches WhatsApp/Telegram behavior: type a caption, attach
  // photos, hit send → one combined send action.
  async function handleSendMessage() {
    if (isSending) return;
    if (!conversationId) return;

    const hasText = newMessage.trim().length > 0;
    const hasAttachments = pendingAttachments.length > 0;
    if (!hasText && !hasAttachments) return;

    const id = parseInt(conversationId);
    if (isNaN(id)) return;

    const caption = hasText ? newMessage.trim() : "";
    // Snapshot the pending list so we can clear state immediately and let
    // the user keep typing while the upload runs.
    const toUpload = [...pendingAttachments];
    // Snapshot the reply target so we can clear state immediately and
    // include replyToId in the POST body even if the user starts a new
    // reply before this send completes.
    const replyTarget = replyingTo;

    setIsSending(true);
    setNewMessage("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    // Clear pending attachments from the composer, but keep the object URLs
    // alive in `toUpload` so we can revoke them after upload finishes.
    setPendingAttachments([]);
    // Clear the reply preview immediately — the user is committed to this
    // send now. If the send fails we restore the text (below) but we don't
    // restore the reply target, since the parent message is still in the
    // thread and the user can swipe again. This matches WhatsApp.
    setReplyingTo(null);

    // ─── Text-only path: single JSON POST, no upload ────────────────────
    if (toUpload.length === 0) {
      try {
        const res = await apiClient.post(`/api/conversations/${id}/messages`, {
          content: caption,
          messageType: "text",
          // Include replyToId when replying to a specific message. The
          // API validates it (must point to a real message in the same
          // conversation) and 400s if invalid — in which case the catch
          // block restores the text so the user can retry.
          ...(replyTarget ? { replyToId: replyTarget.id } : {}),
        });
        setMessages((prev) => [...prev, res.data as ChatMessage]);
        latestMessageIdRef.current = (res.data as ChatMessage).id;
        scrollToBottom("smooth");
        qc.invalidateQueries({ queryKey: ["conversations"] });
      } catch (err) {
        console.error("Failed to send message:", err);
        toast({ title: "Failed to send message", description: "Please try again." });
        setNewMessage(caption); // Restore so the user can retry
        // Restore the reply target too so the user doesn't lose context.
        // If the send failed because replyToId was invalid (400), the
        // retry will fail again with the same error — but that's rare
        // and the user can manually dismiss the reply preview if needed.
        if (replyTarget) setReplyingTo(replyTarget);
      } finally {
        setIsSending(false);
      }
      return;
    }

    // ─── Attachment path: upload each file via multipart/form-data ──────
    // The first upload carries the caption (if any); subsequent uploads
    // are attachment-only. Each upload is sequential so progress is
    // predictable and the server creates messages in the right order.
    let firstError: string | null = null;
    const sentMessages: ChatMessage[] = [];

    for (let i = 0; i < toUpload.length; i++) {
      const pending = toUpload[i];
      // Update the LOCAL copy of the pending list so the user sees
      // progress. This doesn't re-render the composer (we already cleared
      // state), but it lets us show a progress overlay on each thumbnail
      // if we ever render them inline. For now it's mostly for the toast
      // on error.
      try {
        const sent = await uploadAttachment(
          pending.file,
          id,
          i === 0 ? caption : undefined,
          (percent) => {
            // Optional: could update a progress state per-attachment here.
            // Skipping for now since the composer is cleared on send and
            // the message list shows the uploaded message once it lands.
            void percent;
          },
          // Only the first upload in the batch carries the replyToId.
          // If the user is replying with multiple attachments, the reply
          // context attaches to the first one; subsequent attachments are
          // standalone (matches WhatsApp behavior for multi-attach replies).
          i === 0 && replyTarget ? replyTarget.id : undefined,
        );
        sentMessages.push(sent as ChatMessage);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Upload failed";
        console.error(`Failed to upload ${pending.file.name}:`, err);
        if (firstError === null) firstError = msg;
      }
    }

    // Revoke all object URLs we created for previews.
    for (const p of toUpload) {
      if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    }

    if (sentMessages.length > 0) {
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const unique = sentMessages.filter((m) => !existingIds.has(m.id));
        return [...prev, ...unique];
      });
      latestMessageIdRef.current =
        sentMessages[sentMessages.length - 1].id;
      scrollToBottom("smooth");
      qc.invalidateQueries({ queryKey: ["conversations"] });
    }

    if (firstError) {
      toast({
        title: "Some attachments failed to send",
        description: firstError,
        variant: "destructive",
      });
      // If we also had a caption and ALL uploads failed, restore the text
      // so the user doesn't lose what they typed.
      if (sentMessages.length === 0 && caption) {
        setNewMessage(caption);
      }
    }

    setIsSending(false);
  }

  // ─── Scroll helper ────────────────────────────────────────────────────
  // Always scrolls to bottom. Used after sending (user intent is clear)
  // and never after polling (polling checks isNearBottomRef instead).
  // Sets scrollTop DIRECTLY on the messages container — never calls
  // scrollIntoView() because that would also scroll the window/document
  // and reveal the Footer below the chat.
  function scrollToBottom(behavior: ScrollBehavior) {
    requestAnimationFrame(() => {
      const container = messagesContainerRef.current;
      if (container) {
        container.scrollTo({ top: container.scrollHeight, behavior });
      }
    });
  }

  // ─── Edit message handlers ───────────────────────────────────────────
  // Start editing: pre-fill the textarea with the current content,
  // focus it, and switch the composer into edit mode (Send button
  // becomes Save, a Cancel button appears, attachments are hidden).
  function handleStartEdit(msg: ChatMessage) {
    if (!isWithinEditWindow(msg)) {
      toast({
        title: "Can't edit",
        description: "Messages can only be edited within 15 minutes of sending.",
        variant: "destructive",
      });
      return;
    }
    setEditingMessage(msg);
    setNewMessage(msg.content);
    setOpenMenuMessageId(null);
    // Focus + select-all so the user can immediately start retyping
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        // Trigger auto-resize for the new content
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
      }
    });
  }

  function handleCancelEdit() {
    setEditingMessage(null);
    setNewMessage("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  async function handleSaveEdit() {
    if (!editingMessage || !conversationId) return;
    if (editSaving) return;

    const trimmed = newMessage.trim();
    if (trimmed.length === 0) {
      toast({ title: "Message can't be empty", variant: "destructive" });
      return;
    }
    if (trimmed === editingMessage.content) {
      // No change — just cancel
      handleCancelEdit();
      return;
    }

    const id = parseInt(conversationId);
    if (isNaN(id)) return;

    setEditSaving(true);
    try {
      const res = await apiClient.patch(
        `/api/conversations/${id}/messages/${editingMessage.id}`,
        { content: trimmed },
      );
      const updated = res.data as ChatMessage;
      setMessages((prev) =>
        prev.map((m) => (m.id === updated.id ? { ...m, ...updated } : m)),
      );
      handleCancelEdit();
      qc.invalidateQueries({ queryKey: ["conversations"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to edit message";
      toast({ title: "Edit failed", description: msg, variant: "destructive" });
    } finally {
      setEditSaving(false);
    }
  }

  // ─── Delete message handler ──────────────────────────────────────────
  // Soft-deletes the message. The server nulls out the content/media and
  // sets isDeleted=true; we update local state to match. The bubble then
  // re-renders as a tombstone ("This message was deleted").
  async function handleConfirmDelete(messageId: number) {
    if (!conversationId) return;
    if (deleteSavingId !== null) return;

    const id = parseInt(conversationId);
    if (isNaN(id)) return;

    setDeleteSavingId(messageId);
    try {
      const res = await apiClient.delete(
        `/api/conversations/${id}/messages/${messageId}`,
      );
      const updated = res.data as ChatMessage;
      setMessages((prev) =>
        prev.map((m) => (m.id === updated.id ? { ...m, ...updated } : m)),
      );
      setPendingDeleteId(null);
      setOpenMenuMessageId(null);
      qc.invalidateQueries({ queryKey: ["conversations"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete message";
      toast({ title: "Delete failed", description: msg, variant: "destructive" });
    } finally {
      setDeleteSavingId(null);
    }
  }

  // ─── Copy message handler ────────────────────────────────────────────
  // Always available on any message (own or other party's, any age).
  // Uses the async Clipboard API with a fallback to a hidden textarea +
  // document.execCommand('copy') for browsers/contexts where the async
  // API is unavailable (older Safari, insecure contexts, etc.).
  async function handleCopyMessage(msg: ChatMessage) {
    const text = msg.content ?? "";
    if (!text) {
      toast({ title: "Nothing to copy", variant: "destructive" });
      return;
    }
    setOpenMenuMessageId(null);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback: hidden textarea + execCommand
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast({ title: "Copied to clipboard" });
    } catch (err) {
      console.error("Copy failed:", err);
      toast({ title: "Failed to copy", variant: "destructive" });
    }
  }

  // ─── Pending attachment management ────────────────────────────────────
  // Called by AttachmentMenu when the user picks files. Validates each
  // file, creates a preview URL for images/videos, and stages it in the
  // composer. Nothing is uploaded yet.
  const handleFilesSelected = useCallback((files: File[]) => {
    const valid: PendingAttachment[] = [];
    const errors: string[] = [];

    for (const file of files) {
      const result = isAllowedFile(file);
      if (!result.ok) {
        errors.push(result.reason ?? `"${file.name}" is not allowed.`);
        continue;
      }
      const kind = classifyFile(file.type || null);
      const previewUrl =
        kind === "image" || kind === "video"
          ? URL.createObjectURL(file)
          : null;
      valid.push({
        localId: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        previewUrl,
        kind,
        progress: null,
        status: "pending",
      });
    }

    if (errors.length > 0) {
      toast({
        title: errors.length === 1 ? "File not added" : `${errors.length} files not added`,
        description: errors.join(" "),
        variant: "destructive",
      });
    }
    if (valid.length > 0) {
      setPendingAttachments((prev) => [...prev, ...valid]);
    }
  }, [toast]);

  // Remove a single pending attachment and revoke its preview URL.
  const removePendingAttachment = useCallback((localId: string) => {
    setPendingAttachments((prev) => {
      const target = prev.find((p) => p.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.localId !== localId);
    });
  }, []);

  // Revoke any remaining preview URLs on unmount.
  useEffect(() => {
    return () => {
      pendingAttachments.forEach((p) => {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      });
    };
    // We intentionally only run this on unmount; pendingAttachments is
    // captured at cleanup time via the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Emoji picker callback ───────────────────────────────────────────
  // Insert the picked emoji at the caret position inside the textarea
  // rather than just appending to the end — that matches what every
  // other chat app does and lets users place an emoji mid-message.
  const handleEmojiSelect = useCallback((emoji: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setNewMessage((prev) => prev + emoji);
      return;
    }
    const start = textarea.selectionStart ?? newMessage.length;
    const end = textarea.selectionEnd ?? newMessage.length;
    const next = newMessage.slice(0, start) + emoji + newMessage.slice(end);
    setNewMessage(next);

    // Restore caret to just after the inserted emoji, on the next tick
    // (React hasn't re-rendered with the new value yet).
    requestAnimationFrame(() => {
      textarea.focus();
      const pos = start + emoji.length;
      textarea.setSelectionRange(pos, pos);
    });
  }, [newMessage]);

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
    // In edit mode: Enter saves (no shift), Esc cancels.
    if (editingMessage) {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancelEdit();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSaveEdit();
      }
      return;
    }
    // Reply mode: Esc cancels the reply (matches WhatsApp desktop).
    if (replyingTo && e.key === "Escape") {
      e.preventDefault();
      setReplyingTo(null);
      return;
    }
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

        {/* Avatar + Name + Status — wrapped in a Popover so tapping the
            nursery/seller name opens a Messenger-style "profile" popup with
            a "View Store" action. Buyers see "View Store" (links to
            /store/:sellerId); sellers see "View Product" only if a product
            is attached. The whole avatar+name+status block is the trigger
            so users have a generous tap target (WhatsApp/Messenger put the
            whole header area as the tap zone). */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-3 flex-1 min-w-0 text-left rounded-lg -mx-1 px-1 py-1 hover:bg-muted/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label={`View ${conversation.displayName} profile`}
            >
              {/* Avatar */}
              <div className="w-10 h-10 rounded-full overflow-hidden border shrink-0 bg-muted/30">
                {conversation.displayAvatarUrl ? (
                  <img src={conversation.displayAvatarUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <NoImagePlaceholder compact />
                  </div>
                )}
              </div>

              {/* Name & status */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <h1 className="font-semibold text-sm truncate">{conversation.displayName}</h1>
                  {conversation.displayIsVerified && (
                    <img src={ICON_VERIFIED} alt="Verified" className="w-4 h-4 shrink-0" />
                  )}
                </div>
                {/* Presence status: Online / Last seen at <time> / Offline
                    Industry-standard WhatsApp/Telegram-style. Driven by the
                    usePresence hook, which polls GET /api/presence/:id every 15s.
                    While the initial presence is loading we show a neutral
                    "loading…" text so the header doesn't flicker. */}
                <PresenceStatus presence={presence} />
              </div>
            </button>
          </PopoverTrigger>

          {/* ─── Profile popup ─────────────────────────────────────────
              Messenger-style "See profile" sheet. Renders a larger avatar,
              the nursery/seller name + verified badge, the live presence
              status, and a vertical list of action rows. "View Store" is
              the primary action and only shows for buyers (sellers don't
              need a link to their own store from inside a customer chat). */}
          <PopoverContent
            align="start"
            sideOffset={8}
            className="w-72 p-0 overflow-hidden"
          >
            {/* Header — large avatar + name + presence */}
            <div className="flex flex-col items-center text-center px-4 pt-5 pb-4 gap-2 border-b border-border">
              <div className="w-20 h-20 rounded-full overflow-hidden border-2 border-border shrink-0 bg-muted/30">
                {conversation.displayAvatarUrl ? (
                  <img
                    src={conversation.displayAvatarUrl}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <NoImagePlaceholder compact />
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 justify-center">
                <h2 className="font-semibold text-base truncate">{conversation.displayName}</h2>
                {conversation.displayIsVerified && (
                  <img src={ICON_VERIFIED} alt="Verified" className="w-4 h-4 shrink-0" />
                )}
              </div>
              <PresenceStatus presence={presence} />
            </div>

            {/* Action list */}
            <div className="py-1">
              {/* View Store — primary action. Only buyers see this, since
                  sellers chatting with a customer don't need a link to
                  their own storefront. */}
              {isBuyer && (
                <Link
                  href={`/store/${conversation.sellerId}`}
                  className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/60 transition-colors"
                >
                  <Store className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="flex-1">View Store</span>
                  <ExternalLink className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                </Link>
              )}

              {/* View Product — only if the conversation is tied to a
                  specific seller listing (product inquiry). */}
              {conversation.productName && conversation.sellerListingId && (
                <Link
                  href={`/products/${conversation.productSlug ?? conversation.sellerListingId}/listings/${conversation.sellerListingId}`}
                  className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/60 transition-colors"
                >
                  <Package className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="flex-1 truncate">View Product</span>
                  <ExternalLink className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                </Link>
              )}
            </div>
          </PopoverContent>
        </Popover>

        {/* More options — opens the left-side conversation sidebar.
            Buyers see sellers they've chatted with; sellers see users (buyers)
            they've chatted with. Sellers additionally see a Settings entry at
            the bottom of the sidebar. */}
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          className="p-1.5 rounded-full hover:bg-muted/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Open conversation list"
        >
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
          const nextMsg = i < messages.length - 1 ? messages[i + 1] : undefined;
          // Look up the parent message for the reply-context bar. If the
          // parent isn't in the loaded window (e.g. user scrolled back past
          // it), we pass null and the bar simply doesn't render.
          const parentMessage = msg.replyToId
            ? messages.find((m) => m.id === msg.replyToId) ?? null
            : null;
          const parentSenderName = parentMessage
            ? parentMessage.senderId === user?.id
              ? "You"
              : conversation.displayName
            : "";
          return (
            <MessageBubble
              key={msg.id}
              msg={msg}
              prevMsg={prevMsg}
              nextMsg={nextMsg}
              sellerLogoUrl={conversation.sellerLogoUrl}
              otherPartyName={conversation.displayName}
              parentMessage={parentMessage}
              parentSenderName={parentSenderName}
              currentUserId={user?.id}
              isMenuOpen={openMenuMessageId === msg.id}
              isDeleteConfirmOpen={pendingDeleteId === msg.id}
              isDeleting={deleteSavingId === msg.id}
              onToggleMenu={(id) => setOpenMenuMessageId(id)}
              onOpenDeleteConfirm={(id) => setPendingDeleteId(id)}
              onCloseDeleteConfirm={() => setPendingDeleteId(null)}
              onConfirmDelete={(id) => void handleConfirmDelete(id)}
              onStartEdit={handleStartEdit}
              onCopyMessage={handleCopyMessage}
              onImageClick={(src) => setLightboxSrc(src)}
              onReply={(m) => {
                setReplyingTo(m);
                // Focus the textarea so the user can immediately start
                // typing their reply. Wrapped in setTimeout to ensure
                // the ReplyPreview has rendered (which can affect layout)
                // before we focus.
                setTimeout(() => textareaRef.current?.focus(), 0);
              }}
            />
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
              Say hello to {conversation.displayName}! Ask about products, delivery, or anything else.
            </p>
          </div>
        )}

        {/* Bottom anchor for scroll-to-bottom + IntersectionObserver sentinel.
            The sentinel is a 1px-tall div that the observer watches; when
            it's intersecting the scroll container, the user is near the
            bottom and auto-scroll on new messages is appropriate. */}
        <div ref={bottomSentinelRef} className="h-px w-full" />
        <div ref={messagesEndRef} />
      </div>

      {/* ─── Pending attachment preview strip ─────────────────────────────── */}
      {/* Rendered ABOVE the input bar so it never interferes with the
          textarea layout. Horizontally scrollable if the user adds many
          attachments. Each thumbnail has an X button to remove it. */}
      {pendingAttachments.length > 0 && (
        <div className="px-4 pt-2.5 border-t border-border bg-card shrink-0">
          <div className="flex gap-2 overflow-x-auto pb-2.5 -mx-1 px-1">
            {pendingAttachments.map((p) => (
              <PendingAttachmentPreview
                key={p.localId}
                attachment={p}
                onRemove={() => removePendingAttachment(p.localId)}
              />
            ))}
          </div>
        </div>
      )}

      {/* ─── Input Area ────────────────────────────────────────────────── */}
      {/* In edit mode, the composer switches: emoji/attachment buttons are
          hidden, an "Editing message" banner appears above the textarea,
          and the Send button becomes Save (with a Cancel button next to it).
          
          pb-[env(safe-area-inset-bottom)] adds bottom padding on devices
          with a home indicator (iPhone X+) so the send button isn't
          covered by the system gesture bar. On Android with 3-button nav,
          this evaluates to 0 — the system nav bar is below the viewport
          and not our concern. The shadow-sm + border-t together create a
          clear visual separator so the input bar doesn't visually merge
          with the OS navigation bar (which often shares the same white
          background and made the input bar look "floating" in user
          testing). */}
      <div className="px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] border-t border-border bg-card shadow-[0_-1px_3px_0_rgb(0_0_0/0.04)] shrink-0">
        {editingMessage && (
          <div className="flex items-center justify-between mb-2 px-1">
            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Pencil className="w-3 h-3" />
              Editing message
              <span className="opacity-70">· Esc to cancel</span>
            </span>
            <button
              type="button"
              onClick={handleCancelEdit}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
        {/* ─── Reply preview bar ─────────────────────────────────────────
            Shown when the user has activated reply mode (via swipe or the
            Reply action in the long-press menu). Displays a quote-style
            preview of the message being replied to, with a cancel (X)
            button. Matches WhatsApp/Telegram/iMessage conventions.
            Hidden in edit mode (editing and replying are mutually exclusive
            — you can't edit a message AND reply to another at the same
            time; the composer is single-purpose). */}
        {replyingTo && !editingMessage && (
          <div className="flex items-stretch gap-2 mb-2.5 px-1">
            <div
              className={cn(
                "w-0.5 rounded-full shrink-0",
                replyingTo.senderId === user?.id ? "bg-accent" : "bg-primary",
              )}
            />
            <div className="min-w-0 flex-1 py-0.5">
              <p
                className={cn(
                  "text-[11px] font-semibold truncate",
                  replyingTo.senderId === user?.id ? "text-accent" : "text-primary",
                )}
              >
                {replyingTo.senderId === user?.id ? "You" : conversation.displayName}
              </p>
              <p className="text-[11px] text-muted-foreground truncate">
                {replyingTo.isDeleted
                  ? "This message was deleted"
                  : replyingTo.content?.trim()
                    ? replyingTo.content
                    : classifyMessage(replyingTo) !== "text"
                      ? `${classifyMessage(replyingTo)[0].toUpperCase()}${classifyMessage(replyingTo).slice(1)}`
                      : "No content"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setReplyingTo(null)}
              className="p-1 -mr-1 rounded-full hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors self-center shrink-0"
              aria-label="Cancel reply"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          {/* Emoji picker — hidden in edit mode (editing is text-only) */}
          {!editingMessage && (
            <EmojiPicker
              onSelect={handleEmojiSelect}
              align="start"
            />
          )}

          {/* Attachment menu — hidden in edit mode */}
          {!editingMessage && (
            <AttachmentMenu
              onFilesSelected={handleFilesSelected}
              align="center"
            />
          )}

          {/* Text input */}
          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={newMessage}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder={
                editingMessage
                  ? "Edit your message..."
                  : pendingAttachments.length > 0
                  ? "Add a caption..."
                  : "Type a message..."
              }
              rows={1}
              className={cn(
                "w-full resize-none rounded-2xl border bg-muted/30 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:border-accent/50 max-h-[120px] placeholder:text-muted-foreground",
                editingMessage
                  ? "border-accent/50 focus:ring-accent/40"
                  : "border-border focus:ring-accent/30",
              )}
            />
          </div>

          {editingMessage ? (
            <>
              {/* Cancel edit button */}
              <Button
                size="icon"
                variant="outline"
                onClick={handleCancelEdit}
                disabled={editSaving}
                className="rounded-full h-10 w-10 shrink-0"
                aria-label="Cancel edit"
              >
                <X className="w-4 h-4" />
              </Button>
              {/* Save edit button */}
              <Button
                size="icon"
                onClick={handleSaveEdit}
                disabled={editSaving || newMessage.trim().length === 0}
                className="rounded-full h-10 w-10 shrink-0 bg-accent hover:bg-accent/90 text-accent-foreground"
                aria-label="Save edit"
              >
                {editSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
              </Button>
            </>
          ) : (
            /* Send button — enabled when there's text OR pending attachments */
            <Button
              size="icon"
              onClick={handleSendMessage}
              disabled={
                isSending ||
                (newMessage.trim().length === 0 && pendingAttachments.length === 0)
              }
              className="rounded-full h-10 w-10 shrink-0 bg-accent hover:bg-accent/90 text-accent-foreground"
            >
              {isSending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </Button>
          )}
        </div>
      </div>

      {/* ─── Left sidebar: conversation list ─────────────────────────────
          Opened via the header ⋮ button. Shows the list of conversations
          the current user has had IN THEIR CURRENT ROLE in this chat:
            - viewerRole === "buyer"  → buyerConversations (sellers list)
            - viewerRole === "seller" → sellerConversations (users/buyers list)
          Sellers also see a "Settings" entry at the bottom — placeholder
          only, no functionality yet (to be discussed later).
          Tapping a conversation navigates to /messages/:id and closes the
          sidebar. */}
      <ConversationsSidebar
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        viewerRole={conversation.viewerRole}
        conversationList={conversationList}
        isLoading={sidebarLoading}
        error={sidebarError}
        onRetry={loadConversationList}
        searchQuery={sidebarSearch}
        onSearchChange={setSidebarSearch}
        currentConversationId={conversation.id}
        isSellerUser={
          // A user is "a seller" if they have ANY seller-side conversations
          // in the API response. This determines whether the Settings entry
          // shows up at the bottom of the sidebar (per the user's request:
          // "Only seller see a setting option").
          !!conversationList && conversationList.sellerConversations.length > 0
        }
        onNavigate={setLocation}
      />

      {/* ─── Image lightbox ────────────────────────────────────────────── */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4 animate-in fade-in-0"
          onClick={() => setLightboxSrc(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
        >
          <button
            type="button"
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white"
            onClick={() => setLightboxSrc(null)}
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <a
            href={lightboxSrc}
            target="_blank"
            rel="noopener noreferrer"
            download
            className="absolute top-4 left-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white"
            onClick={(e) => e.stopPropagation()}
            aria-label="Download"
            title="Download"
          >
            <Download className="w-5 h-5" />
          </a>
          <img
            src={lightboxSrc}
            alt="Attachment preview"
            className="max-w-[92vw] max-h-[88vh] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
