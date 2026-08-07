/**
 * Left-drawer conversation list. Extracted from ChatPage.tsx.
 *
 * Renders a Radix Sheet sliding in from the LEFT, containing:
 *   1. A header with a context-aware title ("Sellers" / "Users")
 *   2. A search input (filters by name / last message / product name)
 *   3. Two tabs: buyer-side conversations and seller-side conversations
 *   4. A list of conversation rows, each linking to that conversation
 */

import { useState, memo } from "react";
import { Link } from "wouter";
import type { ConversationListResponse } from "./types";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Search,
  Settings,
  MessageCircle,
  RefreshCw,
  AlertCircle,
  ShoppingBag,
  Store,
} from "lucide-react";
import { cn } from "@/lib/utils";

const ICON_VERIFIED =
  "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1785076114/0731e6a0-0e45-481d-bfab-5d82aac4e9d7_1_jas2kb.svg";

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

export const ConversationsSidebar = memo(function ConversationsSidebar({
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
      {/* side="left" produces a panel pinned to inset-y-0 left-0 h-full by
          default (see sheet.tsx sheetVariants). We override:
          - top-16: start BELOW the 64px (h-16) sticky navbar instead of
            covering it. Combined with the bottom:0 from inset-y-0, the
            panel runs from top:4rem to bottom:0.
          - h-auto: override the variant's h-full so the browser computes
            height from top+bottom (calc(100dvh - 4rem)) instead of forcing
            100% (which would push the panel 4rem past the bottom edge).
          - w-72 sm:max-w-xs: narrower than the previous w-80 sm:max-w-sm
            (288px / 320px max vs 320px / 384px max) for a more compact,
            standard-looking drawer.
          - rounded-r-xl: subtle rounding on the right edge for a polished look.
          The overlay (scrim) stays full-screen so tapping the navbar area
          still dismisses the sidebar. */}
      <SheetContent
        side="left"
        className="w-72 sm:max-w-xs p-0 flex flex-col top-16 h-auto rounded-r-xl"
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
});
