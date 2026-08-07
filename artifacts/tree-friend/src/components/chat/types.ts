/**
 * Shared types for the chat module.
 *
 * Extracted from ChatPage.tsx to make the chat feature easier to
 * navigate — the original file was 2,833 lines, mixing the main
 * component, six sub-components, all the types, and all the helpers.
 * Each sub-component now lives in its own file under this directory
 * and imports the types it needs from here.
 */

export interface ConversationInfo {
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
export interface ConversationListItem {
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

export interface ConversationListResponse {
  buyerConversations: ConversationListItem[];
  sellerConversations: ConversationListItem[];
}

export interface ChatMessage {
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
  // ─── Reply tracking (swipe-to-reply) ──────────────────────────────────
  // When non-null, this message is a reply to the message with this id.
  // The UI looks up the parent message in the messages array to render
  // a reply-context bar above the bubble (sender name + content snippet).
  replyToId?: number | null;
}

// ─── Pending attachment (staged in the composer, not yet uploaded) ──────────
// When the user picks a file via the AttachmentMenu, we stage it here
// instead of uploading immediately. The upload only happens when the user
// clicks Send. This matches the industry-standard preview-then-send flow
// used by WhatsApp, Telegram, Messenger, etc.

export interface PendingAttachment {
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

/**
 * 15-minute edit/delete window, matching WhatsApp's "Delete for everyone"
 * and Telegram's edit window. The server enforces this independently
 * (defense in depth), but the UI also checks so we can hide the Edit /
 * Delete actions entirely on older messages — no point offering an action
 * the user can't actually complete.
 */
export const EDIT_DELETE_WINDOW_MS = 15 * 60 * 1000;
