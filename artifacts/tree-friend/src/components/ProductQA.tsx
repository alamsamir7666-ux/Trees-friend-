import { useState } from "react";
import { MessageCircle, ChevronDown, ChevronUp, Send } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/apiClient";
import { useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

type QA = {
  id: number;
  userName: string;
  question: string;
  answer: string | null;
  answeredAt: string | null;
  createdAt: string;
};

export function ProductQA({ productId }: { productId: number }) {
  const { user } = useUser();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [question, setQuestion] = useState("");
  const [showAll, setShowAll] = useState(false);

  const { data: qaList = [], isLoading } = useQuery<QA[]>({
    queryKey: ["qa", productId],
    queryFn: () =>
      apiClient.get<QA[]>(`/api/products/${productId}/qa`).then((r) => r.data),
  });

  const submitQuestion = useMutation({
    mutationFn: (q: string) =>
      apiClient.post(`/api/products/${productId}/qa`, { question: q }),
    onSuccess: () => {
      toast({ title: "Question submitted!", description: "We'll answer it as soon as possible." });
      setQuestion("");
      qc.invalidateQueries({ queryKey: ["qa", productId] });
    },
    onError: (err: any) => {
      toast({
        title: "Failed to submit",
        description: err?.response?.data?.error ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  const visible = showAll ? qaList : qaList.slice(0, 3);

  return (
    <div className="mt-10">
      <div className="flex items-center gap-2 mb-5">
        <MessageCircle className="h-5 w-5 text-accent" />
        <h2 className="font-serif text-xl">Questions & Answers</h2>
        <span className="text-sm text-muted-foreground">({qaList.length})</span>
      </div>

      {/* Q&A list */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-20 bg-muted animate-pulse rounded-xl" />
          ))}
        </div>
      ) : qaList.length === 0 ? (
        <p className="text-muted-foreground text-sm mb-6">
          No questions yet. Be the first to ask!
        </p>
      ) : (
        <div className="space-y-4 mb-6">
          {visible.map((qa) => (
            <div key={qa.id} className="bg-muted/30 rounded-2xl p-4">
              <div className="flex items-start gap-2 mb-2">
                <span className="text-accent font-bold text-sm mt-0.5">Q</span>
                <div>
                  <p className="text-sm font-medium">{qa.question}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {qa.userName} ·{" "}
                    {new Date(qa.createdAt).toLocaleDateString("en-BD", {
                      month: "short",
                      day: "numeric",
                    })}
                  </p>
                </div>
              </div>
              {qa.answer ? (
                <div className="flex items-start gap-2 mt-3 pl-4 border-l-2 border-accent/30">
                  <span className="text-green-600 font-bold text-sm mt-0.5">A</span>
                  <div>
                    <p className="text-sm text-muted-foreground">{qa.answer}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Tree Friend Team ·{" "}
                      {qa.answeredAt
                        ? new Date(qa.answeredAt).toLocaleDateString("en-BD", {
                            month: "short",
                            day: "numeric",
                          })
                        : ""}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground mt-2 pl-6 italic">
                  Awaiting answer from our team...
                </p>
              )}
            </div>
          ))}

          {qaList.length > 3 && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="text-sm text-accent flex items-center gap-1 hover:underline"
            >
              {showAll ? (
                <><ChevronUp className="h-3.5 w-3.5" /> Show less</>
              ) : (
                <><ChevronDown className="h-3.5 w-3.5" /> Show all {qaList.length} questions</>
              )}
            </button>
          )}
        </div>
      )}

      {/* Ask a question */}
      {user ? (
        <div className="border border-border rounded-2xl p-4">
          <p className="text-sm font-medium mb-3">Ask a question</p>
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What would you like to know about this product?"
            className="resize-none mb-3 text-sm rounded-xl"
            rows={3}
            maxLength={500}
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{question.length}/500</span>
            <Button
              size="sm"
              className="rounded-full"
              disabled={question.trim().length < 10 || submitQuestion.isPending}
              onClick={() => submitQuestion.mutate(question)}
            >
              <Send className="h-3.5 w-3.5 mr-1.5" />
              Submit Question
            </Button>
          </div>
        </div>
      ) : (
        <div className="bg-muted/30 rounded-2xl p-4 text-center">
          <p className="text-sm text-muted-foreground">
            <a href="/sign-in" className="text-accent underline underline-offset-4">Sign in</a> to ask a question
          </p>
        </div>
      )}
    </div>
  );
}
