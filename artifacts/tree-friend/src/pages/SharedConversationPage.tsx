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
 */
import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { Leaf, Loader2, AlertCircle, ArrowLeft } from "lucide-react";
import { MarkdownText } from "@/components/ai/MarkdownText";
import { Link } from "wouter";

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

interface SharedMessage {
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

export function SharedConversationPage() {
  const params = useParams<{ shareToken: string }>();
  const shareToken = params.shareToken ?? "";
  const [data, setData] = useState<SharedConversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-green-600" />
          <p className="text-sm text-gray-600">Loading shared conversation…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <AlertCircle className="h-12 w-12 text-red-500" />
          <h1 className="text-xl font-semibold text-gray-900">{error}</h1>
          <p className="text-sm text-gray-600">
            The share link may be invalid, expired, or the conversation may have been deleted.
          </p>
          <Link
            href="/"
            className="mt-2 inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
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
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-green-500 to-emerald-600">
            <Leaf className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-gray-900">{data.title}</h1>
            <p className="text-xs text-gray-500">
              Shared conversation · {data.messages.length} messages
            </p>
          </div>
          <Link
            href="/"
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-green-600 hover:bg-green-50"
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
            return (
              <div key={i} className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
                <div
                  className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${
                    isUser ? "bg-gray-200" : "bg-gradient-to-br from-green-500 to-emerald-600"
                  }`}
                >
                  {isUser ? (
                    <span className="text-xs font-semibold text-gray-600">You</span>
                  ) : (
                    <Leaf className="h-4 w-4 text-white" />
                  )}
                </div>
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                    isUser ? "bg-green-600 text-white" : "border bg-white text-gray-900"
                  }`}
                >
                  {isUser ? (
                    <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
                  ) : (
                    <div className="prose prose-sm max-w-none">
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
          <p className="text-xs text-gray-400">
            Shared via TreeFriend TreeBot · {new Date(data.createdAt).toLocaleDateString()}
          </p>
        </div>
      </main>
    </div>
  );
}
