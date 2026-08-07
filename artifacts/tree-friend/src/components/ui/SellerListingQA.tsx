import { useState } from "react";
import { MessageCircle, ChevronDown, ChevronUp, Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useUser } from "@clerk/react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSellerListingQA, useCreateSellerListingQuestion, useAnswerSellerListingQuestion, useGetMySeller,
  getListSellerListingQAQueryKey, getGetMySellerQueryKey,
} from "@workspace/api-client-react";

/**
 * Q&A for a specific seller's listing -- fully separate question list from
 * ProductQA.tsx's product-level Q&A (per product decision): this list is
 * keyed by sellerListingId and only shows here. Unlike product Q&A (admin-
 * answered only), a question here can be answered by the listing's OWNING
 * seller as well as an admin -- see productQA.ts's PUT /seller/qa/:id/answer.
 *
 * ownerSellerId identifies whose listing this is (from
 * SellerListingCard.seller.id) so the answer box only renders for that
 * seller -- purely a UI convenience; the actual authorization is enforced
 * server-side by the answer endpoint regardless of what the client shows.
 */
export function SellerListingQA({ sellerListingId, ownerSellerId }: { sellerListingId: number; ownerSellerId: number }) {
  const { user } = useUser();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  const { data: items } = useListSellerListingQA(sellerListingId, {
    query: { enabled: !!sellerListingId, queryKey: getListSellerListingQAQueryKey(sellerListingId) },
  });
  // Only fetched to determine "is the logged-in user the seller who owns
  // this listing" for showing the answer box -- harmless no-op for buyers
  // (query stays disabled unless signed in, and most sellers browsing their
  // own listing will have this warm from the dashboard already).
  const { data: mySeller } = useGetMySeller({ query: { enabled: !!user, queryKey: getGetMySellerQueryKey() } });
  const isOwningSeller = !!mySeller && mySeller.id === ownerSellerId;

  const createQuestion = useCreateSellerListingQuestion();
  const answerQuestion = useAnswerSellerListingQuestion();

  const [showForm, setShowForm] = useState(false);
  const [question, setQuestion] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [answeringId, setAnsweringId] = useState<number | null>(null);
  const [answerText, setAnswerText] = useState("");

  function handleAsk() {
    if (!user) { setLocation("/sign-in"); return; }
    if (question.trim().length < 5) return;
    createQuestion.mutate({ sellerListingId, data: { question: question.trim() } }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSellerListingQAQueryKey(sellerListingId) });
        setQuestion("");
        setShowForm(false);
      },
    });
  }

  function startAnswer(id: number) {
    setAnsweringId(id);
    setAnswerText("");
  }

  function handleAnswer() {
    if (answeringId == null || answerText.trim().length < 2) return;
    answerQuestion.mutate({ id: answeringId, data: { answer: answerText.trim() } }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSellerListingQAQueryKey(sellerListingId) });
        setAnsweringId(null);
        setAnswerText("");
      },
    });
  }

  const list = items ?? [];
  const visible = showAll ? list : list.slice(0, 3);

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-serif text-lg font-medium flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-accent" />
          Questions & Answers
          {list.length > 0 && (
            <Badge variant="secondary" className="text-xs">{list.length}</Badge>
          )}
        </h3>
        <Button
          size="sm"
          variant="outline"
          className="rounded-full text-xs"
          onClick={() => {
            if (!user) { setLocation("/sign-in"); return; }
            setShowForm((v) => !v);
          }}
        >
          Ask a Question
        </Button>
      </div>

      {showForm && (
        <div className="mb-6 p-4 rounded-xl border bg-muted/30">
          <Textarea
            placeholder="Ask this seller anything about this listing?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            maxLength={500}
            className="resize-none mb-3 text-sm"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{question.length}/500</span>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button
                type="button"
                size="sm"
                disabled={createQuestion.isPending || question.trim().length < 5}
                onClick={handleAsk}
              >
                {createQuestion.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Send className="h-4 w-4 mr-1.5" />Submit</>}
              </Button>
            </div>
          </div>
          {createQuestion.isError && (
            <p className="text-sm text-destructive mt-2">Failed to submit. Please try again.</p>
          )}
        </div>
      )}

      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">
          No questions yet. Be the first to ask!
        </p>
      ) : (
        <div className="space-y-4">
          {visible.map((item) => (
            <div key={item.id} className="rounded-xl border p-4 bg-card">
              <div className="flex items-start gap-3">
                <div className="h-7 w-7 rounded-full bg-accent/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-xs font-medium text-accent">
                    {item.userName.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{item.question}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{item.userName} ? {new Date(item.createdAt).toLocaleDateString()}</p>
                  {item.answer && (
                    <div className="mt-3 pl-3 border-l-2 border-accent/40">
                      <p className="text-xs font-semibold text-accent mb-1">Seller's Answer</p>
                      <p className="text-sm text-muted-foreground">{item.answer}</p>
                    </div>
                  )}
                  {!item.answer && isOwningSeller && answeringId !== item.id && (
                    <button
                      onClick={() => startAnswer(item.id)}
                      className="text-xs text-accent hover:text-accent/80 mt-2 font-medium"
                    >
                      Answer this question
                    </button>
                  )}
                  {!item.answer && !isOwningSeller && (
                    <p className="text-xs text-muted-foreground/60 mt-2 italic">Awaiting answer from the seller?</p>
                  )}
                  {answeringId === item.id && (
                    <div className="mt-3 p-3 rounded-lg bg-muted/40">
                      <Textarea
                        placeholder="Write your answer..."
                        value={answerText}
                        onChange={(e) => setAnswerText(e.target.value)}
                        rows={2}
                        maxLength={1000}
                        className="resize-none mb-2 text-sm"
                      />
                      <div className="flex gap-2">
                        <Button size="sm" disabled={answerQuestion.isPending || answerText.trim().length < 2} onClick={handleAnswer}>
                          {answerQuestion.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Post Answer"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setAnsweringId(null)}>Cancel</Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}

          {list.length > 3 && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="w-full text-sm text-accent hover:text-accent/80 transition-colors flex items-center justify-center gap-1 py-2"
            >
              {showAll ? <><ChevronUp className="h-4 w-4" />Show less</> : <><ChevronDown className="h-4 w-4" />Show all {list.length} questions</>}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
