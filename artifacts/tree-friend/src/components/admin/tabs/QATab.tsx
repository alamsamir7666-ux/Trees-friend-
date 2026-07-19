import { useState, useEffect } from "react";
import { useAuth } from "@clerk/react";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Trash2 } from "lucide-react";

const API = import.meta.env.VITE_API_BASE_URL ?? "";

export function QATab() {
  const [questions, setQuestions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [answeringId, setAnsweringId] = useState<number | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [saving, setSaving] = useState(false);

  const { getToken: getQAToken } = useAuth();

  useEffect(() => {
    (async () => {
      try {
        const token = await getQAToken();
        const r = await fetch(`${API}/api/admin/qa/unanswered`, { headers: { Authorization: "Bearer " + token } });
        setQuestions(await r.json());
      } catch {} finally { setLoading(false); }
    })();
  }, []);

  async function submitAnswer(id: number) {
    if (!answerText.trim() || answerText.trim().length < 2) return;
    setSaving(true);
    try {
      const token = await getQAToken();
      const r = await fetch(`${API}/api/admin/qa/${id}/answer`, {
        method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ answer: answerText.trim() }),
      });
      if (r.ok) {
        setQuestions(prev => prev.filter(q => q.id !== id));
        setAnsweringId(null); setAnswerText("");
      }
    } finally { setSaving(false); }
  }

  async function deleteQuestion(id: number) {
    if (!window.confirm("Delete this question?")) return;
    const token = await getQAToken();
    await fetch(`${API}/api/admin/qa/${id}`, { method: "DELETE", headers: { Authorization: "Bearer " + token } });
    setQuestions(prev => prev.filter(q => q.id !== id));
  }

  if (loading) return <div className="h-40 bg-muted animate-pulse rounded-xl" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Unanswered Questions</h2>
        <Badge variant="secondary">{questions.length} pending</Badge>
      </div>
      {questions.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          <p className="text-2xl mb-2">❓</p>
          <p className="font-medium">All questions answered!</p>
          <p className="text-sm">No pending product questions.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {questions.map(q => (
            <div key={q.id} className="bg-card border rounded-xl p-5 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">{q.userName} ? Product #{q.productId} ? {new Date(q.createdAt).toLocaleDateString()}</p>
                  <p className="font-medium text-sm">{q.question}</p>
                </div>
                <button onClick={() => deleteQuestion(q.id)} className="text-muted-foreground hover:text-destructive transition-colors shrink-0">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {answeringId === q.id ? (
                <div className="space-y-2">
                  <Textarea
                    placeholder="Write your answer?"
                    value={answerText}
                    onChange={e => setAnswerText(e.target.value)}
                    rows={3} maxLength={1000}
                    className="text-sm resize-none"
                  />
                  <div className="flex gap-2">
                    <button onClick={() => submitAnswer(q.id)} disabled={saving || answerText.trim().length < 2}
                      className="text-xs bg-accent text-white px-4 py-1.5 rounded-full hover:bg-accent/90 transition-colors disabled:opacity-50">
                      {saving ? "Posting?" : "Post Answer"}
                    </button>
                    <button onClick={() => { setAnsweringId(null); setAnswerText(""); }}
                      className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => { setAnsweringId(q.id); setAnswerText(""); }}
                  className="text-xs bg-accent/10 text-accent px-4 py-1.5 rounded-full hover:bg-accent/20 transition-colors font-medium">
                  Answer Question
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ??? Bulk Import Tab ??????????????????????????????????????????????????????????
