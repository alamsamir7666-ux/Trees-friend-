import { useState } from "react";
import { MessageCircle, ChevronDown, ChevronUp, Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useUser } from "@clerk/react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListProductQA, useCreateProductQuestion,
  getListProductQAQueryKey,
} from "@workspace/api-client-react";

export function ProductQA({ productId }: { productId: number }) {
  const { user } = useUser();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  const { data: items, isLoading } = useListProductQA(productId, {
    query: { enabled: !!productId, queryKey: getListProductQAQueryKey(productId) },
  });
  const createQuestion = useCreateProductQuestion();

  const [showForm, setShowForm] = useState(false);
  const [question, setQuestion] = useState("");
  const [showAll, setShowAll] = useState(false);

  function handleAsk() {
    if (!user) { setLocation("/sign-in"); return; }
    if (question.trim().length < 5) return;
    createQuestion.mutate({ productId, data: { question: question.trim() } }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListProductQAQueryKey(productId) });
        setQuestion("");
        setShowForm(false);
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
            placeholder="Ask anything about this product?"
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

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-16 rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : list.length === 0 ? (
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
                      <p className="text-xs font-semibold text-accent mb-1">Official Answer</p>
                      <p className="text-sm text-muted-foreground">{item.answer}</p>
                    </div>
                  )}
                  {!item.answer && (
                    <p className="text-xs text-muted-foreground/60 mt-2 italic">Awaiting answer?</p>
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
