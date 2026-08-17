/**
 * SharedConversationPage — read-only view of a shared AI conversation.
 *
 * v5.1: Renders a conversation someone shared via POST /api/ai/sessions/:token/share.
 * The share token in the URL is the only auth (128 bits of entropy, unguessable).
 *
 * No cookies/auth required — this is a public endpoint. The page fetches
 * GET /api/ai/shared/:shareToken and renders the messages read-only.
 *
 * Industry standard: ChatGPT shared links, Claude artifacts.
 *
 * v6.2 Part 8 (Gap A+B+C+D fix):
 *   - Gap A+C: handle the #msg-<id> URL fragment (per-message share links,
 *     P3-16). The backend now includes `id` on each message; we render
 *     id="msg-<id>" anchors + scrollIntoView + highlight animation on mount.
 *   - Gap B+D: replaced hardcoded Tailwind colors (bg-gray-50, text-green-600,
 *     bg-green-500, text-red-500, etc.) with design-system tokens
 *     (bg-background, text-primary, text-destructive, etc.). Dark mode
 *     now works — previously the page was light-mode-only.
 *   - Added a highlight animation (ring-2 ring-primary/40 + bg-primary/5)
 *     on the message scrolled to via the fragment, matching ChatGPT's
 *     shared-link behavior. The highlight fades after 3s.
 */
import { useEffect, useState, useRef } from "react";
import { useParams } from "wouter";
import { Leaf, Loader2, AlertCircle, ArrowLeft } from "lucide-react";
import { MarkdownText } from "@/components/ai/MarkdownText";
import { Link } from "wouter";

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

interface SharedMessage {
  /**
   * v6.2 Part 8 (Gap A+C fix): the message's DB id. Used to anchor the
   * #msg-<id> URL fragment so per-message share links (P3-16) can scroll
   * to + highlight the specific message.
   *
   * Optional for backward compat — if an older backend deployment doesn't
   * include `id` in the response, the page still renders (just without
   * fragment anchoring).
   */
  id?: number;
  role: string;
  content: string;
  createdAt: string;
}

interface SharedConversation {
  title: string;
  createdAt: string;
  sessionCreatedAt: string;
  messages: SharedMessage[];
}

/**
 * Duration of the highlight animation on the message scrolled to via
 * #msg-<id> fragment. 3s matches ChatGPT's shared-link behavior — long
 * enough for the user to register the highlight, short enough to not be
 * distracting.
 */
const HIGHLIGHT_DURATION_MS = 3000;

export function SharedConversationPage() {
  const params = useParams<{ shareToken: string }>();
  const shareToken = params.shareToken ?? "";
  const [data, setData] = useState<SharedConversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * v6.2 Part 8 (Gap A+C fix): the id of the message to highlight (from
   * the #msg-<id> URL fragment). When non-null + the matching message
   * renders, we scrollIntoView + apply the highlight animation, then
   * clear this state after HIGHLIGHT_DURATION_MS.
   */
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  const highlightedRef = useRef(false); // tracks whether we've already scrolled (prevents re-scroll on re-render)

  useEffect(() => {
    if (!shareToken) {
      setError("Invalid share link.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${BASE_URL}/api/ai/shared/${shareToken}`);
        if (!res.ok) {
          if (res.status === 404) throw new Error("Shared conversation not found.");
          if (res.status === 410) throw new Error("This share link has expired.");
          throw new Error(`Failed to load (${res.status}).`);
        }
        const json = (await res.json()) as SharedConversation;
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load.");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shareToken]);

  // v6.2 Part 8 (Gap A+C fix): read the #msg-<id> URL fragment on mount.
  //
  // We use window.location.hash (not useParams) because wouter doesn't
  // parse the hash — it's a browser-side concept, not a route param.
  //
  // The fragment format is `#msg-<id>` where <id> is the message's DB id
  // (numeric). We parse it once on mount + store the target id in state.
  // The actual scrollIntoView happens in a separate effect that runs after
  // `data` loads (we can't scroll to a message that hasn't rendered yet).
  useEffect(() => {
    const hash = window.location.hash;
    const match = hash.match(/^#msg-(\d+)$/);
    if (match) {
      const id = Number(match[1]);
      if (Number.isFinite(id) && id > 0) {
        setHighlightedId(id);
      }
    }
  }, []);

  // v6.2 Part 8 (Gap A+C fix): once data has loaded + we have a target id,
  // scroll the matching message into view + apply the highlight animation.
  //
  // Runs after every render where `data` is non-null + `highlightedId` is
  // set + we haven't already scrolled (highlightedRef guard). The guard
  // prevents re-scrolling on every re-render (e.g., when the highlight
  // state clears after 3s).
  useEffect(() => {
    if (!data || highlightedId === null || highlightedRef.current) return;
    // Use a microtask to ensure the DOM has committed before we query.
    // requestAnimationFrame is the industry-standard pattern for
    // "scroll after paint" — it avoids a flash of the unscrolled state.
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`msg-${highlightedId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        highlightedRef.current = true;
        // Clear the highlight after HIGHLIGHT_DURATION_MS. The highlight
        // CSS class will be removed (re-render) + the message returns
        // to normal styling.
        window.setTimeout(() => setHighlightedId(null), HIGHLIGHT_DURATION_MS);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [data, highlightedId]);

  // v6.2 Part 8 (Gap B+D fix): loading state — design-system tokens.
  // Previously used bg-gray-50 + text-green-600 (hardcoded, broke dark mode).
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading shared conversation…</p>
        </div>
      </div>
    );
  }

  // v6.2 Part 8 (Gap B+D fix): error state — design-system tokens.
  // Previously used text-red-500 + bg-gray-50 (hardcoded, broke dark mode).
  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <AlertCircle className="h-12 w-12 text-destructive" />
          <h1 className="text-xl font-semibold text-foreground">{error}</h1>
          <p className="text-sm text-muted-foreground">
            The share link may be invalid, expired, or the conversation may have been deleted.
          </p>
          <Link
            href="/"
            className="mt-2 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Go to TreeFriend
          </Link>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/70">
            <Leaf className="h-5 w-5 text-primary-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-foreground">{data.title}</h1>
            <p className="text-xs text-muted-foreground">
              Shared conversation · {data.messages.length} messages
            </p>
          </div>
          <Link
            href="/"
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/5 transition-colors"
          >
            Try TreeBot
          </Link>
        </div>
      </header>

      {/* Messages */}
      <main className="mx-auto max-w-3xl px-4 py-6">
        <div className="space-y-6">
          {data.messages.map((msg, i) => {
            const isUser = msg.role === "user";
            // v6.2 Part 8 (Gap A+C fix): render id="msg-<id>" on each
            // message wrapper so the #msg-<id> fragment can scroll to it.
            // Falls back to index-based key when msg.id is missing (older
            // backend deployment without the Part 8 fix).
            const anchorId = msg.id != null ? `msg-${msg.id}` : undefined;
            const isHighlighted = highlightedId === msg.id;
            return (
              <div
                key={msg.id ?? i}
                id={anchorId}
                className={`flex gap-3 transition-all duration-500 ${
                  isUser ? "flex-row-reverse" : ""
                } ${isHighlighted ? "rounded-2xl ring-2 ring-primary/40 bg-primary/5 p-3 -m-3" : ""}`}
              >
                <div
                  className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${
                    isUser ? "bg-muted" : "bg-gradient-to-br from-primary to-primary/70"
                  }`}
                >
                  {isUser ? (
                    <span className="text-xs font-semibold text-muted-foreground">You</span>
                  ) : (
                    <Leaf className="h-4 w-4 text-primary-foreground" />
                  )}
                </div>
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                    isUser
                      ? "bg-primary text-primary-foreground"
                      : "border bg-card text-card-foreground"
                  }`}
                >
                  {isUser ? (
                    <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
                  ) : (
                    <div className="prose prose-sm max-w-none dark:prose-invert">
                      <MarkdownText content={msg.content} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="mt-12 border-t pt-6 text-center">
          <p className="text-xs text-muted-foreground">
            Shared via TreeFriend TreeBot · {new Date(data.createdAt).toLocaleDateString()}
          </p>
        </div>
      </main>
    </div>
  );
}
