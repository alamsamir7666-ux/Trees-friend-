import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useUser } from "@clerk/react";
import { apiClient } from "@/lib/apiClient";
import { useCurrency } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import {
  MessageCircle,
  Search,
  Store,
  ShoppingBag,
  AlertCircle,
  RefreshCw,
} from "lucide-react";

const ICON_VERIFIED =
  "https://res.cloudinary.com/dcfbtdp6r/image/upload/v1785076114/0731e6a0-0e45-481d-bfab-5d82aac4e9d7_1_jas2kb.svg";

// ─── Types ─────────────────────────────────────────────────────────────────

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

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

// ─── Component ─────────────────────────────────────────────────────────────

export function MessagesPage() {
  const { user } = useUser();
  const [, setLocation] = useLocation();
  const { format } = useCurrency();

  const [conversations, setConversations] = useState<ConversationListResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"buyer" | "seller">("buyer");
  const [searchQuery, setSearchQuery] = useState("");

  const loadConversations = () => {
    if (!user) return;

    setIsLoading(true);
    setFetchError(null);
    apiClient
      .get("/api/conversations")
      .then((res) => {
        const data = res.data as ConversationListResponse;
        setConversations(data);
        // If user has seller conversations but no buyer conversations, default to seller tab
        if (
          data.sellerConversations.length > 0 &&
          data.buyerConversations.length === 0
        ) {
          setActiveTab("seller");
        }
      })
      .catch((err: unknown) => {
        // Surface a meaningful error to the user instead of logging silently.
        // Axios wraps server errors in err.response.data; we prefer the
        // server-provided `detail` (only present in non-production) then fall
        // back to a stable generic message.
        const serverDetail =
          (err as { response?: { data?: { detail?: string; error?: string } } })
            ?.response?.data?.detail ??
          (err as { response?: { data?: { error?: string } } })
            ?.response?.data?.error;
        const fallback =
          (err as { message?: string })?.message ?? "Unknown error";
        setFetchError(serverDetail ?? fallback);
        // Still log the full error so it shows up in browser devtools with
        // the request URL, status, and stack trace if available.
        // eslint-disable-next-line no-console
        console.error("Failed to fetch conversations:", err);
      })
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const currentConversations =
    activeTab === "buyer"
      ? conversations?.buyerConversations ?? []
      : conversations?.sellerConversations ?? [];

  const filteredConversations = searchQuery
    ? currentConversations.filter(
        (c) =>
          c.sellerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.lastMessage?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.productName?.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : currentConversations;

  return (
    <div className="max-w-5xl lg:max-w-6xl mx-auto px-4 md:px-6 lg:px-8 pt-4 pb-16">
      <PageBreadcrumb
        crumbs={[{ label: "Messages" }]}
        className="mb-4"
      />

      <div className="flex items-center justify-between mb-4">
        <h1 className="font-serif text-2xl font-medium">Messages</h1>
      </div>

      {/* Search bar */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search conversations..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full rounded-xl border border-border bg-muted/30 pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 placeholder:text-muted-foreground"
        />
      </div>

      {/* Tabs: Buyer / Seller */}
      {conversations && conversations.sellerConversations.length > 0 && (
        <div className="flex border-b border-border mb-4">
          <button
            onClick={() => setActiveTab("buyer")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "buyer"
                ? "border-accent text-accent"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <ShoppingBag className="w-4 h-4" />
            As Buyer
            {conversations.buyerConversations.length > 0 && (
              <span className="bg-accent/10 text-accent text-xs font-semibold px-1.5 py-0.5 rounded-full">
                {conversations.buyerConversations.reduce((sum, c) => sum + c.unreadCount, 0) || conversations.buyerConversations.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab("seller")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "seller"
                ? "border-accent text-accent"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Store className="w-4 h-4" />
            As Seller
            {conversations.sellerConversations.length > 0 && (
              <span className="bg-accent/10 text-accent text-xs font-semibold px-1.5 py-0.5 rounded-full">
                {conversations.sellerConversations.reduce((sum, c) => sum + c.unreadCount, 0) || conversations.sellerConversations.length}
              </span>
            )}
          </button>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-3 rounded-xl">
              <Skeleton className="w-12 h-12 rounded-full shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-3 w-12" />
            </div>
          ))}
        </div>
      )}

      {/* Error state */}
      {!isLoading && fetchError && (
        <div className="flex flex-col items-center justify-center py-16 text-center px-4">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
            <AlertCircle className="w-8 h-8 text-destructive" />
          </div>
          <h2 className="font-serif text-lg font-medium mb-1">
            Couldn’t load messages
          </h2>
          <p className="text-sm text-muted-foreground max-w-[320px] mb-4 break-words">
            {fetchError}
          </p>
          <Button onClick={loadConversations} variant="outline" className="gap-2">
            <RefreshCw className="w-4 h-4" />
            Try again
          </Button>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !fetchError && filteredConversations.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mb-4">
            <MessageCircle className="w-8 h-8 text-accent" />
          </div>
          <h2 className="font-serif text-lg font-medium mb-1">
            {searchQuery ? "No conversations found" : "No messages yet"}
          </h2>
          <p className="text-sm text-muted-foreground max-w-[280px]">
            {searchQuery
              ? "Try a different search term."
              : "When you message a seller or a buyer messages you, conversations will appear here."}
          </p>
          {!searchQuery && (
            <Link href="/products" className="mt-4">
              <Button>Browse Products</Button>
            </Link>
          )}
        </div>
      )}

      {/* Conversation list */}
      {!isLoading && !fetchError && filteredConversations.length > 0 && (
        <div className="space-y-1">
          {filteredConversations.map((conv) => (
            <button
              key={conv.id}
              onClick={() => setLocation(`/messages/${conv.id}`)}
              className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-muted/30 transition-colors text-left"
            >
              {/* Avatar */}
              <div className="relative shrink-0">
                <div className="w-12 h-12 rounded-full overflow-hidden border bg-muted/30">
                  {conv.sellerLogoUrl ? (
                    <img src={conv.sellerLogoUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <NoImagePlaceholder compact />
                    </div>
                  )}
                </div>
                {/* Unread indicator */}
                {conv.unreadCount > 0 && (
                  <div className="absolute -top-0.5 -right-0.5 w-5 h-5 bg-accent text-accent-foreground rounded-full flex items-center justify-center text-[10px] font-bold">
                    {conv.unreadCount > 9 ? "9+" : conv.unreadCount}
                  </div>
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-sm truncate">{conv.sellerName}</span>
                  {conv.sellerIsVerified && (
                    <img src={ICON_VERIFIED} alt="Verified" className="w-3.5 h-3.5 shrink-0" />
                  )}
                </div>
                <p className="text-sm text-muted-foreground truncate mt-0.5">
                  {conv.lastMessage ?? "No messages yet"}
                </p>
                {/* Product context */}
                {conv.productName && (
                  <div className="flex items-center gap-1.5 mt-1">
                    <div className="w-4 h-4 rounded overflow-hidden bg-muted/30 shrink-0">
                      {conv.productImage ? (
                        <img src={conv.productImage} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <NoImagePlaceholder compact />
                      )}
                    </div>
                    <span className="text-[11px] text-muted-foreground truncate">{conv.productName}</span>
                    {conv.productPrice != null && (
                      <span className="text-[11px] font-semibold text-accent shrink-0">{format(conv.productPrice)}</span>
                    )}
                  </div>
                )}
              </div>

              {/* Time & unread */}
              <div className="flex flex-col items-end shrink-0">
                <span className="text-[11px] text-muted-foreground">
                  {formatRelativeTime(conv.lastMessageAt)}
                </span>
                {conv.unreadCount > 0 && (
                  <div className="w-5 h-5 bg-accent text-accent-foreground rounded-full flex items-center justify-center text-[10px] font-bold mt-1">
                    {conv.unreadCount > 9 ? "9+" : conv.unreadCount}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
