import { memo } from "react";
import type { ChatMessage } from "./types";
import {
  isWithinEditWindow,
  formatDate,
  formatTime,
  shouldShowDateSeparator,
  classifyMessage,
} from "./helpers";
/**
 * Per-message bubble sub-component for the chat page.
 *
 * Extracted from ChatPage.tsx so each bubble can use the useLongPress
 * hook independently (React hooks can't be called inside .map()
 * callbacks).
 *
 * Responsibilities:
 *   - Date separator above the bubble (if needed)
 *   - Avatar (for the other party, last-in-sequence only)
 *   - Bubble itself (text / image / video / audio / document)
 *   - Soft-delete tombstone for deleted messages
 *   - Long-press (mobile) + right-click (desktop) handlers that open
 *     the Edit/Delete action menu (WhatsApp/Telegram standard)
 *   - Action menu as a bottom sheet on mobile, popover on desktop
 *   - Inline delete-confirmation dialog
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "wouter";
import { useUser } from "@clerk/react";
import { apiClient } from "@/lib/apiClient";
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
import { MessageAttachment } from "./MessageAttachment";

const ICON_VERIFIED =
  "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1785076114/0731e6a0-0e45-481d-bfab-5d82aac4e9d7_1_jas2kb.svg";

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
  /** Display name of the OTHER party (used in reply-context header).
      For buyer-side: the seller's nursery name. For seller-side: the
      buyer's name. */
  otherPartyName: string;
  /** The message this message is replying to (looked up from the parent
      ChatPage's messages array via msg.replyToId). Null when the message
      is not a reply, or when the parent isn't in the loaded window. */
  parentMessage: ChatMessage | null;
  /** Display name of the sender of `parentMessage` ("You" if the current
      user sent the parent, otherwise `otherPartyName`). */
  parentSenderName: string;
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
  /** Called when the user completes a swipe-to-reply gesture on this
      bubble OR taps "Reply" in the action menu. ChatPage uses this to
      set `replyingTo` state and show the reply preview above the composer. */
  onReply: (msg: ChatMessage) => void;
}

export const MessageBubble = memo(function MessageBubble({
  msg,
  prevMsg,
  nextMsg,
  sellerLogoUrl,
  otherPartyName,
  parentMessage,
  parentSenderName,
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
  onReply,
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
  // Reply is available on any non-deleted message (you can't reply to a
  // tombstone — there's nothing to quote). WhatsApp allows replying to
  // attachment-only messages too, so we don't require hasCaption.
  const canReply = !isDeleted;
  // Whether the action menu should show ANY actions at all. Reply is always
  // available on non-deleted messages, so the menu essentially always has
  // something to show except for tombstones.
  const hasAnyAction = canEditDelete || canCopy || canReply;
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

  // ─── Swipe-to-reply ──────────────────────────────────────────────────────
  // Industry-standard gesture: incoming messages swipe right, outgoing
  // swipe left. The hook exposes `dragX` (current translation) and
  // `progress` (0..1) for visual feedback, and fires `onReply` when the
  // user releases past threshold.
  //
  // We pass a stable `onReply` wrapper that calls the parent's onReply
  // with the current message. The hook handles haptics, threshold, and
  // snap-back animation.
  //
  // Disabled when the message is a deleted tombstone (nothing to reply
  // to) — passing a no-op onReply effectively disables the gesture
  // because the hook still tracks movement but never fires.
  const swipe = useSwipeToReply(
    () => {
      if (canReply) onReply(msg);
    },
    {
      direction: isOwn ? "left" : "right",
      threshold: 50,
      maxDistance: 80,
    },
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

        {/* Bubble wrapper — long-press + context-menu target + swipe-to-reply.
            max-w is anchored HERE (on the flex item) so it references the
            flex row's width (= 100% of container), NOT the bubble's own
            content width. Putting max-w on the inner bubble instead creates
            a circular sizing dependency: the wrapper sizes to the bubble,
            the bubble's max-width is 75% of the wrapper, which makes the
            browser collapse both to ~75% of the bubble's natural width —
            that was the "bubbles look vertical / Hello splits into Hel/lo"
            bug.

            Swipe handlers are merged with long-press handlers — they
            coexist because useLongPress auto-cancels on >10px movement,
            so a swipe naturally suppresses the long-press menu. */}
        <div
          className="relative group max-w-[75%] sm:max-w-[65%] min-w-0 select-none"
          onClick={handleBubbleClick}
          onTouchStart={(e) => {
            longPressHandlers.onTouchStart?.(e);
            swipe.handlers.onTouchStart(e);
          }}
          onTouchMove={(e) => {
            longPressHandlers.onTouchMove?.(e);
            swipe.handlers.onTouchMove(e);
          }}
          onTouchEnd={(e) => {
            longPressHandlers.onTouchEnd?.(e);
            swipe.handlers.onTouchEnd(e);
          }}
          onTouchCancel={swipe.handlers.onTouchCancel}
          onContextMenu={longPressHandlers.onContextMenu}
        >
          {/* ─── Swipe-to-reply icon background ──────────────────────────
              Renders BEHIND the bubble (z-0) on the side being revealed
              by the swipe. Fades + scales in with swipe.progress. When
              the user crosses the threshold (isReplyActive), the icon
              gets the accent color to signal "release to reply".
              Only rendered when reply is available (i.e. not a tombstone). */}
          {canReply && swipe.progress > 0 && (
            <div
              className={cn(
                "absolute inset-y-0 z-0 flex items-center pointer-events-none transition-colors",
                isOwn ? "right-0 pr-1" : "left-0 pl-1",
              )}
              style={{
                opacity: swipe.progress,
                transform: `scale(${0.6 + 0.4 * swipe.progress})`,
              }}
            >
              <div
                className={cn(
                  "rounded-full p-1.5 transition-colors",
                  swipe.isReplyActive
                    ? "bg-accent text-accent-foreground"
                    : "bg-muted text-muted-foreground",
                )}
              >
                <CornerUpLeft className="w-4 h-4" />
              </div>
            </div>
          )}

          {/* ─── Bubble content (gets the swipe transform) ──────────────
              The transform translates the bubble horizontally following
              the finger. When not swiping, a CSS transition handles the
              snap-back animation. The z-10 ensures the bubble renders
              above the reply-icon background. */}
          <div
            className="relative z-10"
            style={{
              transform: `translateX(${swipe.dragX}px)`,
              transition: swipe.isSwiping ? "none" : "transform 200ms cubic-bezier(0.2, 0, 0, 1)",
            }}
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
              {/* ─── Reply context bar ──────────────────────────────────
                  Shown when this message is a reply to another. Renders
                  a small quote-style bar with:
                  - A colored vertical accent bar (accent color for the
                    OTHER party, primary for own messages — standard
                    WhatsApp/iMessage convention)
                  - The sender name of the replied-to message (bold,
                    colored to match the accent bar)
                  - A truncated snippet of the replied-to message content
                    (or "This message was deleted" if the parent is a
                    tombstone, or "Attachment" if it's a media message
                    with no caption)
                  Tap-to-scroll-to-parent is a nice-to-have; skipping for
                  now to keep the first cut focused. */}
              {parentMessage && (
                <div className="flex items-stretch gap-2 mb-1.5 -mx-1 px-1 max-w-[260px]">
                  <div
                    className={cn(
                      "w-0.5 rounded-full shrink-0",
                      parentMessage.senderId === currentUserId
                        ? "bg-accent"
                        : "bg-primary",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "text-[11px] font-semibold truncate",
                        parentMessage.senderId === currentUserId
                          ? "text-accent"
                          : "text-primary",
                      )}
                    >
                      {parentSenderName}
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {parentMessage.isDeleted
                        ? "This message was deleted"
                        : parentMessage.content?.trim()
                          ? parentMessage.content
                          : classifyMessage(parentMessage) !== "text"
                            ? `${classifyMessage(parentMessage)[0].toUpperCase()}${classifyMessage(parentMessage).slice(1)}`
                            : "No content"}
                    </p>
                  </div>
                </div>
              )}
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
          </div>
          {/* ─── End of swipe-transform wrapper ───────────────────────── */}

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
              {canReply && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleMenu(null);
                    onReply(msg);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/60 transition-colors text-left"
                >
                  <Reply className="w-3.5 h-3.5" />
                  Reply
                </button>
              )}
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
              {canReply && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleMenu(null);
                    onReply(msg);
                  }}
                  className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl hover:bg-muted/60 active:bg-muted transition-colors text-left"
                >
                  <Reply className="w-5 h-5 shrink-0" />
                  <span className="text-base">Reply</span>
                </button>
              )}
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
});
