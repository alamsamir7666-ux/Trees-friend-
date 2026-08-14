import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
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
import { AlertCircle, X } from "lucide-react";
import { useApiFetch } from "@/lib/useApiFetch";
import {
  createKbEntry,
  updateKbEntry,
  type KbEntry,
  type KbCategoryNode,
} from "@/lib/kbApi";

/**
 * Entry editor modal — for manual entry creation + editing existing entries.
 *
 * Used in two flows:
 *   1. Manual chunking: admin clicks "Add Manual Entry" on a source →
 *      this modal opens empty (create mode). The sourceId is pre-set.
 *   2. Edit existing: admin clicks "Edit" on an entry in the Entries tab →
 *      this modal opens pre-filled (edit mode).
 *
 * Fields:
 *   - Title (required, max 200)
 *   - Content (required, max 50K, plain textarea — no RichTextEditor per Phase 2 scope)
 *   - Keywords (tag input — type + Enter to add, click X to remove, max 10)
 *   - Category (tree dropdown, optional)
 *   - Priority (0-10, higher = surfaces first in search)
 *   - Active toggle (only shown in edit mode — new manual entries default to active)
 *
 * On save:
 *   - Create mode: POST /api/ai/admin/kb/entries
 *   - Edit mode: PUT /api/ai/admin/kb/entries/:id
 *     (if content changes, the backend clears the embedding — it'll be regenerated)
 */
export function KbEntryEditorModal({
  open,
  onOpenChange,
  entry, // null = create mode; object = edit mode
  sourceId, // required in create mode; ignored in edit mode (uses entry.sourceId)
  categoryTree,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: KbEntry | null;
  sourceId: number | null;
  categoryTree: KbCategoryNode[];
  onSaved: () => void;
}) {
  const apiFetch = useApiFetch();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [keywordInput, setKeywordInput] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [priority, setPriority] = useState(0);
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Reset form on open / entry change.
  useEffect(() => {
    if (!open) return;
    setError("");
    if (entry) {
      setTitle(entry.title);
      setContent(entry.content);
      setKeywords(entry.keywords ?? []);
      setCategoryId(entry.categoryId);
      setPriority(entry.priority);
      setIsActive(entry.isActive);
    } else {
      setTitle("");
      setContent("");
      setKeywords([]);
      setCategoryId(null);
      setPriority(0);
      setIsActive(true); // manual entries default to active
    }
    setKeywordInput("");
  }, [open, entry]);

  // Flatten category tree for the dropdown.
  const categoryOptions: { id: number; label: string; depth: number }[] = [];
  const walk = (nodes: KbCategoryNode[], depth: number) => {
    for (const n of nodes) {
      categoryOptions.push({ id: n.id, label: n.name, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(categoryTree, 0);

  function addKeyword() {
    const k = keywordInput.trim();
    if (!k) return;
    if (k.length > 50) {
      setError("Each keyword must be at most 50 characters.");
      return;
    }
    if (keywords.length >= 10) {
      setError("Maximum 10 keywords.");
      return;
    }
    if (keywords.includes(k)) {
      setKeywordInput("");
      return;
    }
    setKeywords((prev) => [...prev, k]);
    setKeywordInput("");
    setError("");
  }

  function removeKeyword(k: string) {
    setKeywords((prev) => prev.filter((x) => x !== k));
  }

  function handleKeywordKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addKeyword();
    }
    if (e.key === "Backspace" && !keywordInput && keywords.length > 0) {
      setKeywords((prev) => prev.slice(0, -1));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    if (title.trim().length > 200) {
      setError("Title is too long (max 200 characters).");
      return;
    }
    if (!content.trim()) {
      setError("Content is required.");
      return;
    }
    if (content.length > 50_000) {
      setError("Content is too long (max 50,000 characters).");
      return;
    }
    if (!Number.isInteger(priority) || priority < 0 || priority > 10) {
      setError("Priority must be an integer between 0 and 10.");
      return;
    }

    const effectiveSourceId = entry?.sourceId ?? sourceId;
    if (!effectiveSourceId) {
      setError("Missing sourceId (required for new entries).");
      return;
    }

    setSaving(true);
    try {
      if (entry) {
        // Edit mode — PUT. Note: isActive is NOT changed here (use the
        // activate/deactivate buttons in the Entries tab). We only update
        // content fields. (The PUT endpoint doesn't accept isActive.)
        await updateKbEntry(apiFetch, entry.id, {
          title: title.trim(),
          content,
          keywords,
          categoryId,
          priority,
        });
      } else {
        // Create mode — POST.
        await createKbEntry(apiFetch, {
          sourceId: effectiveSourceId,
          title: title.trim(),
          content,
          keywords,
          categoryId,
          priority,
          isActive,
        });
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save entry.");
    } finally {
      setSaving(false);
    }
  }

  const isEdit = entry !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit KB Entry" : "Add Manual KB Entry"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Title */}
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Title *
            </Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={200}
              className="mt-1.5 rounded-xl"
              placeholder="e.g. Watering mango trees in summer"
              autoFocus
            />
          </div>

          {/* Content */}
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Content *
            </Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              required
              maxLength={50_000}
              rows={12}
              className="mt-1.5 rounded-xl font-mono text-sm"
              placeholder="The entry content (markdown supported by the AI). 200-500 words ideal."
            />
            <p className="text-[11px] text-muted-foreground/70 mt-1">
              {content.length.toLocaleString()} / 50,000 chars
              {isEdit && entry && content !== entry.content && (
                <span className="text-amber-600 dark:text-amber-400 ml-2">
                  · content changed — embedding will be regenerated
                </span>
              )}
            </p>
          </div>

          {/* Keywords (tag input) */}
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Keywords (max 10)
            </Label>
            <div className="mt-1.5 flex flex-wrap gap-1.5 rounded-xl border p-2 min-h-[44px]">
              {keywords.map((k) => (
                <Badge
                  key={k}
                  variant="secondary"
                  className="flex items-center gap-1 text-xs"
                >
                  {k}
                  <button
                    type="button"
                    onClick={() => removeKeyword(k)}
                    className="hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              <input
                value={keywordInput}
                onChange={(e) => setKeywordInput(e.target.value)}
                onKeyDown={handleKeywordKeyDown}
                onBlur={addKeyword}
                className="flex-1 min-w-[120px] bg-transparent text-sm outline-none"
                placeholder={keywords.length === 0 ? "Type a keyword + Enter" : ""}
                maxLength={50}
              />
            </div>
          </div>

          {/* Category + Priority */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Category
              </Label>
              <Select
                value={categoryId === null ? "__none__" : String(categoryId)}
                onValueChange={(v) => setCategoryId(v === "__none__" ? null : Number(v))}
              >
                <SelectTrigger className="mt-1.5 rounded-xl">
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
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Priority (0-10)
              </Label>
              <Input
                type="number"
                min={0}
                max={10}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value) || 0)}
                className="mt-1.5 rounded-xl"
              />
              <p className="text-[11px] text-muted-foreground/70 mt-1">
                Higher priority entries surface first in AI search results.
              </p>
            </div>
          </div>

          {/* Active toggle (create mode only — edit mode uses activate/deactivate buttons) */}
          {!isEdit && (
            <div className="flex items-center justify-between rounded-xl border p-3">
              <div>
                <Label className="text-sm font-medium">Active</Label>
                <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                  Active entries are returned by the AI search tool. Inactive entries are
                  hidden until activated.
                </p>
              </div>
              <Switch checked={isActive} onCheckedChange={setIsActive} />
            </div>
          )}

          {/* Embedding status (edit mode only — informational) */}
          {isEdit && entry && (
            <div className="rounded-xl border p-3 text-xs text-muted-foreground space-y-1">
              <div className="flex justify-between">
                <span>Embedding status</span>
                <Badge
                  variant={
                    entry.embeddingStatus === "generated"
                      ? "default"
                      : entry.embeddingStatus === "pending"
                        ? "secondary"
                        : "destructive"
                  }
                >
                  {entry.embeddingStatus}
                </Badge>
              </div>
              {entry.embeddingGeneratedAt && (
                <div className="flex justify-between">
                  <span>Last embedded</span>
                  <span>{new Date(entry.embeddingGeneratedAt).toLocaleString()}</span>
                </div>
              )}
              {entry.embeddingError && (
                <div className="text-destructive">Error: {entry.embeddingError}</div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

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
              type="submit"
              disabled={saving}
              className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving ? "Saving…" : isEdit ? "Save Changes" : "Add Entry"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
