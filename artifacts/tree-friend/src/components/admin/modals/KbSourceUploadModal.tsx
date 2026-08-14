import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { AlertCircle } from "lucide-react";
import { useApiFetch } from "@/lib/useApiFetch";
import {
  createKbSource,
  createKbCreator,
  autoSlug,
  type KbCreator,
  type KbSource,
} from "@/lib/kbApi";

const RAW_TEXT_MAX = 100_000;

/**
 * Source upload modal — Step 1 of the ingestion pipeline.
 *
 * The admin fills in source metadata + pastes the raw text (YouTube
 * transcript, blog post, manual content). On submit, POST /api/ai/admin/kb/sources
 * creates the source with `processing_status = 'pending'`.
 *
 * After creation, the parent (KbSourcesView) opens either:
 *   - KbChunkReviewModal (if English — AI chunking)
 *   - KbEntryEditorModal (if Bengali/Banglish — manual chunking)
 *
 * The "Create new creator" inline form lets the admin register a new
 * creator without leaving the modal (common flow when uploading a new
 * YouTube channel for the first time).
 */
export function KbSourceUploadModal({
  open,
  onOpenChange,
  creators,
  onCreated,
  onSourceCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creators: KbCreator[];
  onCreated: () => void; // refresh creators list (after inline creator create)
  onSourceCreated: (source: KbSource) => void;
}) {
  const apiFetch = useApiFetch();
  const [sourceType, setSourceType] = useState<string>("manual");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState<string>("en");
  const [creatorId, setCreatorId] = useState<string>("__none__");
  const [sourcePublishedAt, setSourcePublishedAt] = useState("");
  const [rawText, setRawText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Inline "create new creator" form.
  const [showNewCreator, setShowNewCreator] = useState(false);
  const [newCreatorName, setNewCreatorName] = useState("");
  const [newCreatorSlug, setNewCreatorSlug] = useState("");
  const [newCreatorSlugEdited, setNewCreatorSlugEdited] = useState(false);
  const [creatingCreator, setCreatingCreator] = useState(false);

  // Reset on open.
  useEffect(() => {
    if (!open) return;
    setError("");
    setSourceType("manual");
    setSourceUrl("");
    setSourceTitle("");
    setSourceLanguage("en");
    setCreatorId("__none__");
    setSourcePublishedAt("");
    setRawText("");
    setShowNewCreator(false);
    setNewCreatorName("");
    setNewCreatorSlug("");
    setNewCreatorSlugEdited(false);
  }, [open]);

  function handleNewCreatorNameChange(next: string) {
    setNewCreatorName(next);
    if (!newCreatorSlugEdited) setNewCreatorSlug(autoSlug(next));
  }

  async function handleCreateCreator() {
    const name = newCreatorName.trim();
    const slug = newCreatorSlug.trim();
    if (!name || !slug) {
      setError("Creator name + slug are required.");
      return;
    }
    setCreatingCreator(true);
    setError("");
    try {
      const created = await createKbCreator(apiFetch, {
        name,
        slug,
        sourceType,
      });
      onCreated(); // refresh the creators list
      setCreatorId(String(created.id));
      setShowNewCreator(false);
      setNewCreatorName("");
      setNewCreatorSlug("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create creator.");
    } finally {
      setCreatingCreator(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!sourceTitle.trim()) {
      setError("Source title is required.");
      return;
    }
    if (!rawText.trim()) {
      setError("Raw text is required.");
      return;
    }
    if (rawText.length > RAW_TEXT_MAX) {
      setError(`Raw text is too long (max ${RAW_TEXT_MAX.toLocaleString()} characters).`);
      return;
    }
    if (sourceUrl && sourceUrl.trim()) {
      try {
        new URL(sourceUrl.trim());
      } catch {
        setError("Source URL must be a valid URL.");
        return;
      }
    }

    setSaving(true);
    try {
      const created = await createKbSource(apiFetch, {
        sourceType,
        sourceUrl: sourceUrl.trim() || null,
        sourceTitle: sourceTitle.trim(),
        sourceLanguage,
        creatorId: creatorId === "__none__" ? null : Number(creatorId),
        sourcePublishedAt: sourcePublishedAt || null,
        rawText,
      });
      onSourceCreated(created);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create source.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload KB Source</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Source type + language */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Source Type *
              </Label>
              <Select value={sourceType} onValueChange={setSourceType}>
                <SelectTrigger className="mt-1.5 rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="youtube">YouTube</SelectItem>
                  <SelectItem value="blog">Blog</SelectItem>
                  <SelectItem value="facebook">Facebook</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Language *
              </Label>
              <Select value={sourceLanguage} onValueChange={setSourceLanguage}>
                <SelectTrigger className="mt-1.5 rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="bn">Bengali (Unicode)</SelectItem>
                  <SelectItem value="banglish">Banglish</SelectItem>
                </SelectContent>
              </Select>
              {sourceLanguage !== "en" && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                  AI chunking is English-only — you'll create entries manually for this language.
                </p>
              )}
            </div>
          </div>

          {/* Source title */}
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Source Title *
            </Label>
            <Input
              value={sourceTitle}
              onChange={(e) => setSourceTitle(e.target.value)}
              required
              maxLength={200}
              className="mt-1.5 rounded-xl"
              placeholder="e.g. Mango Tree Care Full Guide"
            />
          </div>

          {/* Source URL */}
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Source URL (optional)
            </Label>
            <Input
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              maxLength={500}
              className="mt-1.5 rounded-xl"
              placeholder="https://youtube.com/watch?v=... (used for dedup)"
            />
            <p className="text-[11px] text-muted-foreground/70 mt-1">
              Leave empty for manual content. If set, duplicate uploads are rejected.
            </p>
          </div>

          {/* Creator */}
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Creator
            </Label>
            <div className="mt-1.5 flex gap-2">
              <Select value={creatorId} onValueChange={setCreatorId}>
                <SelectTrigger className="rounded-xl flex-1">
                  <SelectValue placeholder="Select a creator (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— None —</SelectItem>
                  {creators.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name} ({c.sourceType})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowNewCreator((s) => !s)}
                className="rounded-xl shrink-0"
              >
                {showNewCreator ? "Cancel" : "New Creator"}
              </Button>
            </div>

            {/* Inline new-creator form */}
            {showNewCreator && (
              <div className="mt-2 p-3 rounded-xl border space-y-2 bg-muted/30">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">Name</Label>
                    <Input
                      value={newCreatorName}
                      onChange={(e) => handleNewCreatorNameChange(e.target.value)}
                      className="mt-1 rounded-xl"
                      placeholder="e.g. Garden with Arif"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Slug</Label>
                    <Input
                      value={newCreatorSlug}
                      onChange={(e) => {
                        setNewCreatorSlugEdited(true);
                        setNewCreatorSlug(
                          e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                        );
                      }}
                      className="mt-1 rounded-xl font-mono text-sm"
                      placeholder="garden-with-arif"
                    />
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleCreateCreator}
                  disabled={creatingCreator}
                  className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  {creatingCreator ? "Creating…" : "Create Creator"}
                </Button>
              </div>
            )}
          </div>

          {/* Source published date */}
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Published Date (optional)
            </Label>
            <Input
              type="date"
              value={sourcePublishedAt}
              onChange={(e) => setSourcePublishedAt(e.target.value)}
              className="mt-1.5 rounded-xl"
            />
          </div>

          {/* Raw text */}
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Raw Text *
            </Label>
            <Textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              required
              maxLength={RAW_TEXT_MAX}
              rows={12}
              className="mt-1.5 rounded-xl font-mono text-sm"
              placeholder="Paste the YouTube transcript, blog post text, or manual content here…"
            />
            <p className="text-[11px] text-muted-foreground/70 mt-1">
              {rawText.length.toLocaleString()} / {RAW_TEXT_MAX.toLocaleString()} chars
            </p>
          </div>

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
              {saving ? "Creating…" : "Create Source"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
