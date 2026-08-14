import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Trash2, AlertCircle, Sparkles } from "lucide-react";
import { useApiFetch } from "@/lib/useApiFetch";
import {
  createKbEntriesBatch,
  autoSlug,
  type KbChunkSuggestion,
  type KbCategoryNode,
  type KbSource,
} from "@/lib/kbApi";

/**
 * Review modal for AI-suggested chunks.
 *
 * After the admin clicks "AI Chunk" on an English source, the backend
 * returns a list of suggested chunks (title + content + keywords). This
 * modal shows them in an editable list — the admin can:
 *   - Edit title / content / keywords per chunk.
 *   - Set a category + product + priority per chunk (optional).
 *   - Delete a chunk.
 *   - Add a manual chunk (empty placeholder at the end).
 *
 * On "Create N Entries", POST /api/ai/admin/kb/sources/:id/entries/batch
 * creates all entries with `is_active = false` (admin activates them
 * later in the Entries tab). The background job then generates embeddings.
 *
 * Note: "Split" and "Merge with next" from the plan are deferred (Phase 5
 * enhancement) — they add complexity without much value for v1.
 */
interface ReviewableChunk extends KbChunkSuggestion {
  categoryId: number | null;
  productId: number | null;
  priority: number;
}

function chunkFromSuggestion(s: KbChunkSuggestion): ReviewableChunk {
  return {
    title: s.title,
    content: s.content,
    keywords: s.keywords,
    categoryId: null,
    productId: null,
    priority: 0,
  };
}

export function KbChunkReviewModal({
  open,
  onOpenChange,
  source,
  chunks,
  model,
  categoryTree,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: KbSource | null;
  chunks: KbChunkSuggestion[];
  model: string;
  categoryTree: KbCategoryNode[];
  onCreated: () => void; // refetch the source (so entries appear)
}) {
  const apiFetch = useApiFetch();
  const [reviewable, setReviewable] = useState<ReviewableChunk[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    setReviewable(chunks.map(chunkFromSuggestion));
  }, [open, chunks]);

  // Flatten the category tree for the dropdown (indented by depth).
  const categoryOptions: { id: number; label: string; depth: number }[] = [];
  const walk = (nodes: KbCategoryNode[], depth: number) => {
    for (const n of nodes) {
      categoryOptions.push({ id: n.id, label: n.name, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(categoryTree, 0);

  function updateChunk(idx: number, updates: Partial<ReviewableChunk>) {
    setReviewable((prev) => prev.map((c, i) => (i === idx ? { ...c, ...updates } : c)));
  }

  function deleteChunk(idx: number) {
    setReviewable((prev) => prev.filter((_, i) => i !== idx));
  }

  function addManualChunk() {
    setReviewable((prev) => [
      ...prev,
      {
        title: "",
        content: "",
        keywords: [],
        categoryId: null,
        productId: null,
        priority: 0,
      },
    ]);
  }

  async function handleSubmit() {
    if (!source) return;
    if (reviewable.length === 0) {
      setError("No chunks to create. Add at least one chunk.");
      return;
    }
    // Validate all chunks have title + content.
    for (let i = 0; i < reviewable.length; i++) {
      if (!reviewable[i].title.trim() || !reviewable[i].content.trim()) {
        setError(`Chunk ${i + 1} is missing a title or content.`);
        return;
      }
    }
    setSaving(true);
    setError("");
    try {
      await createKbEntriesBatch(
        apiFetch,
        source.id,
        reviewable.map((c, i) => ({
          title: c.title.trim(),
          content: c.content,
          keywords: c.keywords,
          categoryId: c.categoryId,
          productId: c.productId,
          priority: c.priority,
          chunkIndex: i,
        })),
        "ai",
      );
      onCreated();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create entries.");
    } finally {
      setSaving(false);
    }
  }

  if (!source) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            Review AI-Generated Chunks
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>
              Source: <span className="font-medium text-foreground">{source.sourceTitle}</span>
            </span>
            <Badge variant="secondary">{reviewable.length} chunks</Badge>
            <Badge variant="outline">model: {model}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Review each chunk below. Edit the title, content, or keywords as needed. Set a
            category + priority per chunk (optional). All entries are created inactive —
            activate them from the Entries tab after review.
          </p>

          {reviewable.length === 0 && (
            <div className="rounded-xl border p-6 text-center text-sm text-muted-foreground">
              No chunks. Click "Add Manual Chunk" to create one, or close + use manual entry.
            </div>
          )}

          {reviewable.map((chunk, idx) => (
            <div key={idx} className="rounded-xl border p-3 space-y-2 bg-muted/20">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  Chunk {idx + 1}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => deleteChunk(idx)}
                  className="h-7 px-2 text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              <div>
                <Label className="text-[11px] text-muted-foreground">Title</Label>
                <Input
                  value={chunk.title}
                  onChange={(e) => updateChunk(idx, { title: e.target.value })}
                  maxLength={200}
                  className="mt-0.5 rounded-lg text-sm"
                  placeholder="Chunk title"
                />
              </div>

              <div>
                <Label className="text-[11px] text-muted-foreground">Content</Label>
                <Textarea
                  value={chunk.content}
                  onChange={(e) => updateChunk(idx, { content: e.target.value })}
                  rows={5}
                  maxLength={50_000}
                  className="mt-0.5 rounded-lg text-sm font-mono"
                />
                <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                  {chunk.content.length.toLocaleString()} chars
                </p>
              </div>

              <div>
                <Label className="text-[11px] text-muted-foreground">
                  Keywords (comma-separated)
                </Label>
                <Input
                  value={chunk.keywords.join(", ")}
                  onChange={(e) =>
                    updateChunk(idx, {
                      keywords: e.target.value
                        .split(",")
                        .map((k) => k.trim())
                        .filter(Boolean)
                        .slice(0, 10),
                    })
                  }
                  className="mt-0.5 rounded-lg text-sm"
                  placeholder="mango, watering, summer"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label className="text-[11px] text-muted-foreground">Category</Label>
                  <Select
                    value={chunk.categoryId === null ? "__none__" : String(chunk.categoryId)}
                    onValueChange={(v) =>
                      updateChunk(idx, { categoryId: v === "__none__" ? null : Number(v) })
                    }
                  >
                    <SelectTrigger className="mt-0.5 rounded-lg text-sm h-8">
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— None —</SelectItem>
                      {categoryOptions.map((opt) => (
                        <SelectItem key={opt.id} value={String(opt.id)}>
                          {"\u00A0".repeat(opt.depth * 2)}
                          {opt.depth > 0 ? "↳ " : ""}
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-[11px] text-muted-foreground">Priority (0-10)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={10}
                    value={chunk.priority}
                    onChange={(e) =>
                      updateChunk(idx, { priority: Number(e.target.value) || 0 })
                    }
                    className="mt-0.5 rounded-lg text-sm h-8"
                  />
                </div>
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addManualChunk}
                    className="rounded-lg h-8 w-full"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Chunk
                  </Button>
                </div>
              </div>
            </div>
          ))}

          {error && (
            <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            className="rounded-xl"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={saving || reviewable.length === 0}
            className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving
              ? "Creating…"
              : `Create ${reviewable.length} ${reviewable.length === 1 ? "Entry" : "Entries"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
