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
} from "lucide-react";

const ICON_VERIFIED =
  "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1785076114/0731e6a0-0e45-481d-bfab-5d82aac4e9d7_1_jas2kb.svg";

// ─── Types ─────────────────────────────────────────────────────────────────

interface ConversationInfo {
  id: number;
  buyerId: string;
  sellerId: number;
  viewerRole: "buyer" | "seller";
  displayName: string;
  displayAvatarUrl: string | null;
  displayIsVerified: boolean;
  /**
   * Clerk user ID of the OTHER party in the conversation (the person the
   * current user is chatting with). Used to query their presence status
   * (online/offline/last-seen) via GET /api/presence/:clerkUserId.
   * May be empty string if the seller's user row was missing on the
   * backend — in that case we just don't show a presence status.
   */
  otherPartyClerkId: string;
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

// ─── Conversation list (sidebar) types ────────────────────────────────────
// Mirrors the shape returned by GET /api/conversations. The same shape is
// used for both buyer-side and seller-side conversations; the backend fills
// `sellerName` with the other party's display name (nursery name for buyer
// conversations, buyer's first/last name for seller conversations).
interface ConversationListItem {
  id: number;
  sellerId: number;
  sellerName: string;
  sellerLogoUrl: string | null;
  sellerIsVerified: boolean;
  sellerListingId: number | null;
  productName: string | null;
  productImage: string | null;
  productPrice: number | null;
  lastMessage: string | null;
  lastMessageAt: string;
  unreadCount: number;
  createdAt: string;
}

interface ConversationListResponse {
  buyerConversations: ConversationListItem[];
  sellerConversations: ConversationListItem[];
}

interface ChatMessage {
  id: number;
  conversationId: number;
  senderId: string;
  content: string;
  messageType: string;
  imageUrl: string | null;
  // New attachment fields (may be missing on older messages; treat as null)
  fileUrl?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  fileMimeType?: string | null;
  attachmentType?: string | null;
  readByBuyer: boolean;
  readBySeller: boolean;
  createdAt: string;
  // Edit tracking — ISO string or null. UI shows "edited" next to the
  // timestamp when non-null. Matches WhatsApp/Telegram/Signal semantics.
  editedAt?: string | null;
  // Soft-delete tracking — when true, render the bubble as a tombstone
  // ("This message was deleted") instead of the original content/media.
  isDeleted?: boolean;
  deletedAt?: string | null;
}

// ─── Pending attachment (staged in the composer, not yet uploaded) ──────────
// When the user picks a file via the AttachmentMenu, we stage it here
// instead of uploading immediately. The upload only happens when the user
// clicks Send. This matches the industry-standard preview-then-send flow
// used by WhatsApp, Telegram, Messenger, etc.

interface PendingAttachment {
  /** Stable local id (used as React key + for removal). */
  localId: string;
  file: File;
  /** Object URL for client-side thumbnail preview (images/videos only). */
  previewUrl: string | null;
  kind: "image" | "video" | "audio" | "document";
  /** Upload progress 0-100; null means "not started". */
  progress: number | null;
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * 15-minute edit/delete window, matching WhatsApp's "Delete for everyone"
 * and Telegram's edit window. The server enforces this independently
 * (defense in depth), but the UI also checks so we can hide the Edit /
 * Delete actions entirely on older messages — no point offering an action
 * the user can't actually complete.
 */
const EDIT_DELETE_WINDOW_MS = 15 * 60 * 1000;

function isWithinEditWindow(msg: ChatMessage): boolean {
  const ageMs = Date.now() - new Date(msg.createdAt).getTime();
  return ageMs <= EDIT_DELETE_WINDOW_MS;
}

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

/**
 * Resolve which URL to use for an attachment message. fileUrl is the
 * canonical field; imageUrl is the legacy one. We prefer fileUrl, then
 * fall back to imageUrl for older messages that only set the legacy field.
 */
function attachmentUrl(msg: ChatMessage): string | null {
  return msg.fileUrl ?? msg.imageUrl ?? null;
}

/**
 * Classify a message for rendering. The server populates
 * `attachmentType` on new messages, but old messages (and messages
 * created via the legacy JSON endpoint without fileMimeType) may not
 * have it. We fall back to inferring from `messageType` + `imageUrl`.
 */
function classifyMessage(msg: ChatMessage): "text" | "image" | "video" | "audio" | "document" {
  const a = msg.attachmentType;
  if (a === "image" || a === "video" || a === "audio" || a === "document") return a;
  // Legacy message: type=image with imageUrl, no attachmentType
  if (msg.messageType === "image" && attachmentUrl(msg)) return "image";
  // Otherwise: text (even if it's an unknown attachment type, treat as text
  // and let the message body show the content string)
  return "text";
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
        // eslint-disable-next-line no-console
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

    setIsSending(true);
    setNewMessage("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    // Clear pending attachments from the composer, but keep the object URLs
    // alive in `toUpload` so we can revoke them after upload finishes.
    setPendingAttachments([]);

    // ─── Text-only path: single JSON POST, no upload ────────────────────
    if (toUpload.length === 0) {
      try {
        const res = await apiClient.post(`/api/conversations/${id}/messages`, {
          content: caption,
          messageType: "text",
        });
        setMessages((prev) => [...prev, res.data as ChatMessage]);
        latestMessageIdRef.current = (res.data as ChatMessage).id;
        scrollToBottom("smooth");
        qc.invalidateQueries({ queryKey: ["conversations"] });
      } catch (err) {
        console.error("Failed to send message:", err);
        toast({ title: "Failed to send message", description: "Please try again." });
        setNewMessage(caption); // Restore so the user can retry
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
          return (
            <MessageBubble
              key={msg.id}
              msg={msg}
              prevMsg={prevMsg}
              nextMsg={nextMsg}
              sellerLogoUrl={conversation.sellerLogoUrl}
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

// ─── MessageBubble (per-message sub-component) ───────────────────────────────
// Extracted from the inline .map() so each bubble can use the useLongPress
// hook independently (React hooks can't be called inside .map() callbacks).
//
// This component is responsible for:
//   - Rendering the date separator above the bubble (if needed)
//   - Rendering the avatar (for the other party, last-in-sequence only)
//   - Rendering the bubble itself (text / image / video / audio / document)
//   - Rendering the soft-delete tombstone for deleted messages
//   - Attaching long-press (mobile) + right-click (desktop) handlers that
//     open the Edit/Delete action menu — the WhatsApp/Telegram standard
//   - Rendering the action menu as a bottom sheet on mobile (large touch
//     targets, easy to reach) and a popover on desktop (compact, anchored
//     to the bubble)
//   - Rendering the inline delete-confirmation dialog

interface MessageBubbleProps {
  msg: ChatMessage;
  prevMsg: ChatMessage | undefined;
  nextMsg: ChatMessage | undefined;
  sellerLogoUrl: string | null;
  currentUserId: string | undefined;
  isMenuOpen: boolean;
  isDeleteConfirmOpen: boolean;
  isDeleting: boolean;
  onToggleMenu: (id: number | null) => void;
  onOpenDeleteConfirm: (id: number) => void;
  onCloseDeleteConfirm: () => void;
  onConfirmDelete: (id: number) => void;
  onStartEdit: (msg: ChatMessage) => void;
  onCopyMessage: (msg: ChatMessage) => void;
  onImageClick: (src: string) => void;
}

function MessageBubble({
  msg,
  prevMsg,
  nextMsg,
  sellerLogoUrl,
  currentUserId,
  isMenuOpen,
  isDeleteConfirmOpen,
  isDeleting,
  onToggleMenu,
  onOpenDeleteConfirm,
  onCloseDeleteConfirm,
  onConfirmDelete,
  onStartEdit,
  onCopyMessage,
  onImageClick,
}: MessageBubbleProps) {
  const isOwn = msg.senderId === currentUserId;
  const showDate = shouldShowDateSeparator(prevMsg, msg);
  const kind = classifyMessage(msg);
  const hasAttachment = kind !== "text";
  const hasCaption = !!(msg.content && msg.content.trim().length > 0);
  const isDeleted = !!msg.isDeleted;
  // Edit/delete are only available on the user's own messages, within
  // the 15-minute window, and not on already-deleted ones.
  const canEditDelete = isOwn && !isDeleted && isWithinEditWindow(msg);
  // Copy is available on any non-deleted message that has text content.
  // We allow copying the OTHER party's messages too — that's standard
  // WhatsApp/Telegram behavior.
  const canCopy = !isDeleted && hasCaption;
  // Whether the action menu should show ANY actions at all. If neither
  // edit/delete nor copy is available (e.g. a deleted tombstone or an
  // attachment-only message with no caption), there's nothing to show,
  // so we don't open the menu in the first place.
  const hasAnyAction = canEditDelete || canCopy;
  const isLastInSequence = !nextMsg || nextMsg.senderId !== msg.senderId;

  // Long-press handler — opens the action menu. This is the primary
  // affordance on mobile (WhatsApp/Telegram/iMessage all use long-press).
  // We also get free desktop parity via onContextMenu (right-click).
  //
  // IMPORTANT: The long-press handlers are ALWAYS attached (as long as
  // there's at least one action to show). Previously they were gated on
  // `canEditDelete`, which meant long-pressing an old message or a
  // message from the other party did NOTHING — the user got no feedback
  // at all and reported "long press shows nothing". Now we always
  // attach the handlers as long as the menu would have something to
  // show, and the menu conditionally renders Edit/Delete vs just Copy.
  const { handlers: longPressHandlers, justFiredRef } = useLongPress(
    () => {
      if (!hasAnyAction) return;
      onToggleMenu(isMenuOpen ? null : msg.id);
    },
    { threshold: 500 },
  );

  // Image click → lightbox, BUT suppress the synthetic click that fires
  // right after a long-press (otherwise long-pressing an image would open
  // the lightbox instead of the action menu).
  const handleImageClick = (src: string) => {
    if (justFiredRef.current) {
      justFiredRef.current = false;
      return;
    }
    onImageClick(src);
  };

  // When the menu/confirm is open, clicks on the bubble itself should
  // close it (matches WhatsApp — tap anywhere on the bubble dismisses
  // the menu).
  const handleBubbleClick = () => {
    if (justFiredRef.current) {
      justFiredRef.current = false;
      return;
    }
    if (isMenuOpen) {
      onToggleMenu(null);
    }
  };

  return (
    <div>
      {/* Date separator */}
      {showDate && (
        <div className="flex items-center justify-center py-3">
          <span className="text-[11px] text-muted-foreground bg-muted/60 px-3 py-1 rounded-full">
            {formatDate(msg.createdAt)}
          </span>
        </div>
      )}

      {/* Message bubble row — full width so justify-end/justify-start can push the
          bubble to the correct edge. Without w-full, the flex row collapses to
          its content and alignment has no effect. */}
      <div className={`flex w-full ${isOwn ? "justify-end" : "justify-start"} ${isLastInSequence ? "mb-2" : "mb-0.5"}`}>
        {/* Other party's avatar — only on last message of a sequence */}
        {!isOwn && isLastInSequence && (
          <div className="w-7 h-7 rounded-full overflow-hidden border shrink-0 mr-2 mt-1 bg-muted/30">
            {sellerLogoUrl ? (
              <img src={sellerLogoUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <NoImagePlaceholder compact />
              </div>
            )}
          </div>
        )}
        {/* Spacer so consecutive messages from the other party align */}
        {!isOwn && !isLastInSequence && <div className="w-7 mr-2 shrink-0" />}

        {/* Bubble wrapper — long-press + context-menu target.
            max-w is anchored HERE (on the flex item) so it references the
            flex row's width (= 100% of container), NOT the bubble's own
            content width. Putting max-w on the inner bubble instead creates
            a circular sizing dependency: the wrapper sizes to the bubble,
            the bubble's max-width is 75% of the wrapper, which makes the
            browser collapse both to ~75% of the bubble's natural width —
            that was the "bubbles look vertical / Hello splits into Hel/lo"
            bug. */}
        <div
          className="relative group max-w-[75%] sm:max-w-[65%] min-w-0"
          onClick={handleBubbleClick}
          {...(hasAnyAction ? longPressHandlers : {})}
        >
          {/* ─── Soft-deleted tombstone ─────────────────────────── */}
          {isDeleted ? (
            <div
              className={cn(
                "w-fit px-3.5 py-2.5 rounded-2xl",
                isOwn
                  ? "bg-accent/15 dark:bg-accent/25 rounded-br-md"
                  : "bg-muted/40 border border-border rounded-2xl rounded-bl-md",
              )}
            >
              <p className="text-sm italic text-muted-foreground flex items-center gap-1.5">
                <Ban className="w-3.5 h-3.5 shrink-0" />
                This message was deleted
              </p>
              <div className="flex items-center gap-1 mt-1 whitespace-nowrap">
                <span className="text-[10px] text-muted-foreground">
                  {formatTime(msg.createdAt)}
                </span>
                {isOwn && (
                  msg.readByBuyer && msg.readBySeller ? (
                    <CheckCheck className="w-3 h-3 text-accent/70" />
                  ) : (
                    <Check className="w-3 h-3 text-muted-foreground/70" />
                  )
                )}
              </div>
            </div>
          ) : (
            <div
              className={cn(
                "w-fit px-3.5 py-2.5 overflow-hidden",
                isOwn
                  ? "bg-accent/20 dark:bg-accent/30 rounded-2xl rounded-br-md"
                  : "bg-card border border-border rounded-2xl rounded-bl-md",
                // Image messages: drop horizontal padding so the image
                // can stretch edge-to-edge inside the bubble.
                kind === "image" && "p-1.5",
                // Subtle selection-style highlight while the action menu
                // is open, so the user can see WHICH message they're
                // acting on (matches WhatsApp's blue tint).
                isMenuOpen && "ring-2 ring-accent/40",
              )}
            >
              {/* ─── Attachment rendering ──────────────────────────── */}
              {hasAttachment && (
                <MessageAttachment
                  msg={msg}
                  kind={kind}
                  isOwn={isOwn}
                  onImageClick={handleImageClick}
                />
              )}

              {/* Caption (for attachment messages with text) */}
              {hasAttachment && hasCaption && (
                <p className="text-sm leading-relaxed whitespace-pre-wrap break-words mt-1.5 px-1">
                  {msg.content}
                </p>
              )}

              {/* Text-only content (no attachment) */}
              {!hasAttachment && (
                <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{msg.content}</p>
              )}

              {/* Timestamp, edited label & read receipt.
                  whitespace-nowrap prevents the timestamp + "edited" label
                  from wrapping onto two lines on narrow bubbles (the
                  "09:42 PM" + "· edited" pair was wrapping awkwardly). */}
              <div className={`flex items-center gap-1 mt-1 whitespace-nowrap ${hasAttachment ? "px-1" : ""}`}>
                <span className="text-[10px] text-muted-foreground">{formatTime(msg.createdAt)}</span>
                {msg.editedAt && (
                  <span className="text-[10px] text-muted-foreground italic">· edited</span>
                )}
                {isOwn && (
                  msg.readByBuyer && msg.readBySeller ? (
                    <CheckCheck className="w-3 h-3 text-accent" />
                  ) : (
                    <Check className="w-3 h-3 text-muted-foreground" />
                  )
                )}
              </div>
            </div>
          )}

          {/* ─── Desktop hover affordance ──────────────────────────── */}
          {/* A small ... button INSIDE the bubble (top corner) that appears on
              hover. This is a secondary affordance for desktop users who
              don't know they can right-click. Mobile users use long-press.
              Hidden on touch-only devices to avoid the "floating grey square"
              bug from the previous implementation. */}
          {hasAnyAction && !isDeleted && !isDeleteConfirmOpen && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleMenu(isMenuOpen ? null : msg.id);
              }}
              className={cn(
                "absolute top-1 z-10 p-1 rounded-full bg-card/80 backdrop-blur-sm border border-border shadow-sm hover:bg-card transition-opacity hidden sm:block",
                isOwn ? "left-1" : "right-1",
                isMenuOpen
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100 focus:opacity-100",
              )}
              aria-label="Message actions"
            >
              <MoreVertical className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          )}

          {/* ─── Desktop: action menu popover ─────────────────────────── */}
          {/* Rendered INSIDE the relative group wrapper so absolute
              positioning is relative to the bubble itself. right:100%
              means "right edge of popover at right edge of bubble" which
              places the popover to the LEFT of the bubble (for own
              messages). Vice versa for the other party's messages. */}
          {isMenuOpen && !isDeleteConfirmOpen && (
            <div
              className="hidden sm:block absolute top-0 z-50 min-w-[200px] bg-card border border-border rounded-lg shadow-lg py-1"
              style={
                isOwn
                  ? { right: "100%", marginRight: "8px" }
                  : { left: "100%", marginLeft: "8px" }
              }
              onClick={(e) => e.stopPropagation()}
            >
              {canEditDelete && (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onStartEdit(msg);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/60 transition-colors text-left"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenDeleteConfirm(msg.id);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-destructive/10 text-destructive transition-colors text-left"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </button>
                </>
              )}
              {canCopy && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyMessage(msg);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/60 transition-colors text-left"
                >
                  <Copy className="w-3.5 h-3.5" />
                  Copy text
                </button>
              )}
              {!canEditDelete && isOwn && !isDeleted && (
                <div className="px-3 py-2 text-[11px] text-muted-foreground flex items-start gap-1.5 border-t border-border mt-1">
                  <Info className="w-3 h-3 shrink-0 mt-0.5" />
                  <span>
                    Edit &amp; delete are only available within 15 minutes of sending.
                  </span>
                </div>
              )}
            </div>
          )}

          {/* ─── Desktop: delete confirmation popover ──────────────────── */}
          {isDeleteConfirmOpen && (
            <div
              className="hidden sm:block absolute top-0 z-50 min-w-[240px] bg-card border border-border rounded-lg shadow-lg p-3"
              style={
                isOwn
                  ? { right: "100%", marginRight: "8px" }
                  : { left: "100%", marginLeft: "8px" }
              }
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-sm font-medium mb-1">Delete message?</p>
              <p className="text-xs text-muted-foreground mb-3">
                This can't be undone. The other person will see "This message was deleted".
              </p>
              <div className="flex gap-2 justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseDeleteConfirm();
                  }}
                  className="h-8 text-xs"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onConfirmDelete(msg.id);
                  }}
                  disabled={isDeleting}
                  className="h-8 text-xs gap-1"
                >
                  {isDeleting ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Trash2 className="w-3 h-3" />
                  )}
                  Delete
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── Action menu ──────────────────────────────────────────────── */}
      {/* Mobile: bottom sheet (large touch targets, thumb-friendly).
          Desktop: anchored popover (rendered above inside the bubble wrapper). */}
      {isMenuOpen && !isDeleteConfirmOpen && (
        <>
          {/* Click-away catcher — covers the whole screen so tapping
              outside the menu closes it. */}
          <div
            className="fixed inset-0 z-40"
            onClick={(e) => {
              e.stopPropagation();
              onToggleMenu(null);
            }}
          />

          {/* Mobile: bottom sheet */}
          <div
            className="sm:hidden fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border rounded-t-2xl shadow-2xl pb-[env(safe-area-inset-bottom)] animate-in slide-in-from-bottom-4 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drag handle indicator */}
            <div className="flex justify-center pt-2 pb-1">
              <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
            </div>
            <div className="px-2 pb-2">
              {canEditDelete && (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onStartEdit(msg);
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl hover:bg-muted/60 active:bg-muted transition-colors text-left"
                  >
                    <Pencil className="w-5 h-5 shrink-0" />
                    <span className="text-base">Edit message</span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenDeleteConfirm(msg.id);
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl hover:bg-destructive/10 active:bg-destructive/15 text-destructive transition-colors text-left"
                  >
                    <Trash2 className="w-5 h-5 shrink-0" />
                    <span className="text-base">Delete message</span>
                  </button>
                </>
              )}
              {canCopy && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyMessage(msg);
                  }}
                  className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl hover:bg-muted/60 active:bg-muted transition-colors text-left"
                >
                  <Copy className="w-5 h-5 shrink-0" />
                  <span className="text-base">Copy text</span>
                </button>
              )}
              {!canEditDelete && isOwn && !isDeleted && (
                <div className="mx-2 my-2 px-3 py-2.5 rounded-xl bg-muted/50 text-[12px] text-muted-foreground flex items-start gap-2">
                  <Info className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    Edit &amp; delete are only available within 15 minutes of sending.
                  </span>
                </div>
              )}
            </div>
            <div className="border-t border-border" />
            <div className="px-2 py-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleMenu(null);
                }}
                className="w-full flex items-center justify-center px-4 py-3.5 rounded-xl hover:bg-muted/60 active:bg-muted transition-colors text-base font-medium"
              >
                Cancel
              </button>
            </div>
          </div>

        </>
      )}

      {/* ─── Delete confirmation ──────────────────────────────────────── */}
      {/* Same pattern: bottom sheet on mobile, popover on desktop. */}
      {isDeleteConfirmOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/20"
            onClick={(e) => {
              e.stopPropagation();
              onCloseDeleteConfirm();
            }}
          />
          {/* Mobile: bottom sheet */}
          <div
            className="sm:hidden fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border rounded-t-2xl shadow-2xl pb-[env(safe-area-inset-bottom)] animate-in slide-in-from-bottom-4 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-center pt-2 pb-1">
              <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
            </div>
            <div className="px-5 py-4">
              <p className="text-base font-semibold mb-1">Delete message?</p>
              <p className="text-sm text-muted-foreground mb-4">
                This can't be undone. The other person will see "This message was deleted".
              </p>
              <div className="flex flex-col gap-2">
                <Button
                  variant="destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onConfirmDelete(msg.id);
                  }}
                  disabled={isDeleting}
                  className="h-11 gap-2"
                >
                  {isDeleting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  Delete
                </Button>
                <Button
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseDeleteConfirm();
                  }}
                  className="h-11"
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── PresenceStatus (chat header sub-component) ────────────────────────────
// Renders the "Online" / "last seen at <time>" / "Offline" line under the
// chat participant's name. Matches WhatsApp/Telegram conventions:
//   - Online            → green dot + "Online" (bold green text)
//   - Last seen today   → "last seen today at 5:42 PM" (muted text)
//   - Last seen yest.   → "last seen yesterday at 9:30 AM" (muted text)
//   - Last seen older   → "last seen Mon at 9:30 AM" or "last seen Aug 1"
//   - Never seen        → "Offline" (muted text, no timestamp)
//   - Loading / unknown → empty (don't flicker the header on mount)

interface PresenceStatusProps {
  presence: {
    status: "online" | "offline" | "unknown";
    lastSeenAt: string | null;
    isLoading: boolean;
  };
}

function PresenceStatus({ presence }: PresenceStatusProps) {
  // While the first fetch is in flight, render an invisible placeholder
  // to reserve vertical space (prevents the header from jumping when the
  // status lands). 11px is the text-[11px] line height we use below.
  if (presence.isLoading || presence.status === "unknown") {
    return <p className="text-[11px] h-[16px]">&nbsp;</p>;
  }

  if (presence.status === "online") {
    return (
      <div className="flex items-center gap-1.5">
        {/* Pulsing green dot — signals "live" online status */}
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75 animate-ping" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
        </span>
        <p className="text-[11px] text-green-600 font-medium">Online</p>
      </div>
    );
  }

  // Offline — show "last seen at <time>" if we have a timestamp,
  // otherwise just "Offline".
  const lastSeenText = formatLastSeen(presence.lastSeenAt);
  return (
    <p className="text-[11px] text-muted-foreground">
      {lastSeenText ?? "Offline"}
    </p>
  );
}

// ─── MessageAttachment (inline sub-component) ──────────────────────────────

interface MessageAttachmentProps {
  msg: ChatMessage;
  kind: "image" | "video" | "audio" | "document";
  isOwn: boolean;
  onImageClick: (src: string) => void;
}

function MessageAttachment({ msg, kind, onImageClick }: MessageAttachmentProps) {
  const url = attachmentUrl(msg);
  if (!url) return null;

  // ─── Image: inline preview, click to open lightbox ──────────────────
  if (kind === "image") {
    return (
      <div
        className="rounded-xl overflow-hidden cursor-zoom-in bg-muted/30"
        onClick={() => onImageClick(url)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onImageClick(url);
          }
        }}
      >
        <img
          src={url}
          alt={msg.fileName ?? "Image attachment"}
          className="w-full max-w-[280px] max-h-[360px] object-cover"
          loading="lazy"
        />
      </div>
    );
  }

  // ─── Video: native <video> element with controls ────────────────────
  if (kind === "video") {
    return (
      <div className="rounded-xl overflow-hidden bg-black/90 max-w-[280px]">
        <video
          src={url}
          controls
          playsInline
          className="w-full max-h-[360px]"
          preload="metadata"
        />
      </div>
    );
  }

  // ─── Audio: native <audio> element with download fallback ──────────
  if (kind === "audio") {
    return (
      <div className="flex items-center gap-2 min-w-[200px]">
        <audio src={url} controls preload="metadata" className="flex-1 min-w-0" />
      </div>
    );
  }

  // ─── Document: file chip with icon, name, size, download button ────
  const Icon = fileIconFor(msg.fileMimeType ?? null);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      download={msg.fileName ?? undefined}
      className="flex items-center gap-3 px-3 py-2.5 min-w-[220px] max-w-full rounded-lg bg-muted/40 hover:bg-muted/70 transition-colors group"
    >
      <span className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
        <Icon className="w-4 h-4" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium truncate">{msg.fileName ?? "Document"}</span>
        <span className="block text-[11px] text-muted-foreground mt-0.5">
          {msg.fileSize ? formatFileSize(msg.fileSize) : "Download"}
          {msg.fileMimeType && <span className="opacity-70"> · {msg.fileMimeType.split("/")[1]?.toUpperCase()}</span>}
        </span>
      </span>
      <Download className="w-4 h-4 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
    </a>
  );
}

// ─── PendingAttachmentPreview (composer thumbnail before send) ──────────────

interface PendingAttachmentPreviewProps {
  attachment: PendingAttachment;
  onRemove: () => void;
}

/**
 * Renders a single pending attachment as a thumbnail (for images/videos) or
 * a file chip (for audio/documents) in the composer's preview strip, before
 * the user clicks Send. Each preview has an X button to remove it.
 *
 * For images, we show the actual decoded image via a blob URL so the user
 * sees exactly what they're about to send. For videos, we show the first
 * frame via a <video> element with `preload="metadata"`. For audio and
 * documents, we show a compact file chip with icon + name + size.
 */
function PendingAttachmentPreview({
  attachment,
  onRemove,
}: PendingAttachmentPreviewProps) {
  const { file, previewUrl, kind } = attachment;

  // ─── Image thumbnail ─────────────────────────────────────────────────
  if (kind === "image" && previewUrl) {
    return (
      <div className="relative shrink-0 w-20 h-20 rounded-lg overflow-hidden border border-border bg-muted/30 group">
        <img
          src={previewUrl}
          alt={file.name}
          className="w-full h-full object-cover"
        />
        <PreviewRemoveButton onClick={onRemove} />
      </div>
    );
  }

  // ─── Video thumbnail (first frame) ───────────────────────────────────
  if (kind === "video" && previewUrl) {
    return (
      <div className="relative shrink-0 w-20 h-20 rounded-lg overflow-hidden border border-border bg-black/90 group">
        <video
          src={previewUrl}
          className="w-full h-full object-cover"
          preload="metadata"
          muted
        />
        {/* Play icon overlay to signal it's a video */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-7 h-7 rounded-full bg-black/60 flex items-center justify-center">
            <Film className="w-3.5 h-3.5 text-white" />
          </div>
        </div>
        <PreviewRemoveButton onClick={onRemove} />
      </div>
    );
  }

  // ─── Audio / document file chip ─────────────────────────────────────
  const Icon = fileIconFor(file.type || null);
  return (
    <div className="relative shrink-0 flex items-center gap-2 pl-2.5 pr-7 py-2 rounded-lg border border-border bg-muted/30 max-w-[200px]">
      <span className="shrink-0 w-8 h-8 rounded-md bg-primary/10 text-primary flex items-center justify-center">
        {kind === "audio" ? (
          <Music className="w-4 h-4" />
        ) : (
          <Icon className="w-4 h-4" />
        )}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-xs font-medium truncate">{file.name}</span>
        <span className="block text-[10px] text-muted-foreground mt-0.5">
          {formatFileSize(file.size)}
        </span>
      </span>
      <PreviewRemoveButton onClick={onRemove} compact />
    </div>
  );
}

/**
 * The X button overlaid on a pending attachment preview. Styled to be
 * visible against any background (semi-transparent dark circle with a
 * white X). `compact` variant is for the file chip (smaller, positioned
 * at the top-right of the chip rather than overlaid).
 */
function PreviewRemoveButton({
  onClick,
  compact = false,
}: {
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label="Remove attachment"
      className={cn(
        "rounded-full bg-black/70 hover:bg-black/90 text-white flex items-center justify-center transition-colors",
        compact
          ? "absolute top-1 right-1 w-4 h-4"
          : "absolute top-1 right-1 w-5 h-5",
      )}
    >
      <X className={compact ? "w-2.5 h-2.5" : "w-3 h-3"} />
    </button>
  );
}

// ─── Conversations sidebar (left Sheet) ────────────────────────────────────
// Extracted as its own component for clarity. Renders a Radix Sheet sliding
// in from the LEFT, containing:
//   1. A header with a context-aware title ("Sellers" / "Users")
//   2. A search input (filters by name / last message / product name)
//   3. The list of conversations for the current viewer role
//   4. A "Settings" entry pinned to the bottom — ONLY for users who are
//      sellers (detected via sellerConversations.length > 0). Placeholder
//      only; no onClick handler yet (to be discussed later per user's note).
//
// The conversation list mirrors MessagesPage's row layout (avatar, name,
// verified badge, last message preview, time, unread badge) so users get a
// familiar mental model between the two surfaces.

interface ConversationsSidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  viewerRole: "buyer" | "seller";
  conversationList: ConversationListResponse | null;
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  currentConversationId: number;
  isSellerUser: boolean;
  /** wouter's setLocation — used to navigate to a conversation when its row
      is tapped. Passed down from ChatPage so this component doesn't need
      its own useLocation hook (which would create a second router
      subscription). */
  onNavigate: (path: string) => void;
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;

  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

function ConversationsSidebar({
  open,
  onOpenChange,
  viewerRole,
  conversationList,
  isLoading,
  error,
  onRetry,
  searchQuery,
  onSearchChange,
  currentConversationId,
  isSellerUser,
  onNavigate,
}: ConversationsSidebarProps) {
  // Which list to show depends on the user's role in the CURRENT conversation:
  //   - buyer  → they've been chatting WITH sellers → buyerConversations
  //   - seller → they've been chatting WITH buyers  → sellerConversations
  // The backend fills `sellerName` with the OTHER party's display name in
  // both cases (nursery name for buyer-side, buyer's name for seller-side),
  // so we can render the rows identically regardless of role.
  const list =
    viewerRole === "buyer"
      ? conversationList?.buyerConversations ?? []
      : conversationList?.sellerConversations ?? [];

  const filtered = searchQuery
    ? list.filter(
        (c) =>
          c.sellerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.lastMessage?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.productName?.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : list;

  // Context-aware labels: buyers see "Sellers" (the nurseries they've chatted
  // with); sellers see "Users" (the buyers who've messaged them).
  const listLabel = viewerRole === "buyer" ? "Sellers" : "Users";
  const headerTitle = viewerRole === "buyer" ? "Your Sellers" : "Your Customers";
  const headerSubtitle =
    viewerRole === "buyer"
      ? "Nurseries you've messaged"
      : "Buyers who've messaged you";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="w-80 sm:max-w-sm p-0 flex flex-col"
      >
        {/* Visually-hidden title/description for screen readers (Radix Dialog
            requires a title for accessibility). */}
        <SheetHeader className="sr-only">
          <SheetTitle>{headerTitle}</SheetTitle>
          <SheetDescription>{headerSubtitle}</SheetDescription>
        </SheetHeader>

        {/* ─── Header ─────────────────────────────────────────────────── */}
        <div className="px-4 pt-5 pb-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2 mb-3">
            {viewerRole === "buyer" ? (
              <ShoppingBag className="w-4 h-4 text-accent shrink-0" />
            ) : (
              <Store className="w-4 h-4 text-accent shrink-0" />
            )}
            <h2 className="font-semibold text-base flex-1">{headerTitle}</h2>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              placeholder={`Search ${listLabel.toLowerCase()}...`}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-full rounded-xl border border-border bg-muted/30 pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 placeholder:text-muted-foreground"
            />
          </div>
        </div>

        {/* ─── Conversation list (scrollable) ────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          {/* Loading state */}
          {isLoading && (
            <div className="p-4 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="w-11 h-11 rounded-full shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                  <Skeleton className="h-3 w-8" />
                </div>
              ))}
            </div>
          )}

          {/* Error state */}
          {!isLoading && error && (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
              <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mb-3">
                <AlertCircle className="w-6 h-6 text-destructive" />
              </div>
              <p className="text-sm font-medium mb-1">Couldn&apos;t load {listLabel.toLowerCase()}</p>
              <p className="text-xs text-muted-foreground max-w-[240px] mb-3 break-words">
                {error}
              </p>
              <Button onClick={onRetry} variant="outline" size="sm" className="gap-2">
                <RefreshCw className="w-3.5 h-3.5" />
                Try again
              </Button>
            </div>
          )}

          {/* Empty state */}
          {!isLoading && !error && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
              <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center mb-3">
                <MessageCircle className="w-6 h-6 text-accent" />
              </div>
              <p className="text-sm font-medium mb-1">
                {searchQuery ? `No ${listLabel.toLowerCase()} found` : `No ${listLabel.toLowerCase()} yet`}
              </p>
              <p className="text-xs text-muted-foreground max-w-[220px]">
                {searchQuery
                  ? "Try a different search term."
                  : viewerRole === "buyer"
                    ? "When you message a nursery, they'll appear here."
                    : "When a buyer messages you, they'll appear here."}
              </p>
            </div>
          )}

          {/* Conversation rows */}
          {!isLoading && !error && filtered.length > 0 && (
            <div className="py-1">
              {filtered.map((conv) => {
                const isActive = conv.id === currentConversationId;
                return (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      onNavigate(`/messages/${conv.id}`);
                    }}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors",
                      isActive
                        ? "bg-accent/10"
                        : "hover:bg-muted/40",
                    )}
                  >
                    {/* Avatar (with unread badge) */}
                    <div className="relative shrink-0">
                      <div className="w-11 h-11 rounded-full overflow-hidden border bg-muted/30">
                        {conv.sellerLogoUrl ? (
                          <img src={conv.sellerLogoUrl} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <NoImagePlaceholder compact />
                          </div>
                        )}
                      </div>
                      {conv.unreadCount > 0 && (
                        <div className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 bg-accent text-accent-foreground rounded-full flex items-center justify-center text-[10px] font-bold">
                          {conv.unreadCount > 9 ? "9+" : conv.unreadCount}
                        </div>
                      )}
                    </div>

                    {/* Name + preview + product */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={cn("text-sm truncate", conv.unreadCount > 0 ? "font-semibold" : "font-medium")}>
                          {conv.sellerName}
                        </span>
                        {conv.sellerIsVerified && (
                          <img src={ICON_VERIFIED} alt="Verified" className="w-3.5 h-3.5 shrink-0" />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {conv.lastMessage ?? "No messages yet"}
                      </p>
                      {conv.productName && (
                        <div className="flex items-center gap-1 mt-1">
                          <div className="w-3.5 h-3.5 rounded overflow-hidden bg-muted/30 shrink-0">
                            {conv.productImage ? (
                              <img src={conv.productImage} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <NoImagePlaceholder compact />
                            )}
                          </div>
                          <span className="text-[10px] text-muted-foreground truncate">{conv.productName}</span>
                        </div>
                      )}
                    </div>

                    {/* Time */}
                    <span className="text-[10px] text-muted-foreground shrink-0 self-start mt-1">
                      {formatRelativeTime(conv.lastMessageAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ─── Footer: Settings (sellers only) ────────────────────────
            Per user's request: "Only seller see a setting option bottom of
            side bar but dont add anything in the setting option. We will
            discuss later about setting option." So we render the entry
            (visible + tappable-looking) but it's a no-op for now. */}
        {isSellerUser && (
          <div className="border-t border-border shrink-0">
            <button
              type="button"
              onClick={() => {
                // Intentionally a no-op for now — per user's note, the
                // settings panel contents will be discussed and added later.
                // We keep the button visible & accessible so the layout is
                // finalized; wiring comes in a follow-up commit.
              }}
              className="w-full flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted/50 transition-colors text-left"
            >
              <Settings className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className="flex-1">Settings</span>
            </button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
