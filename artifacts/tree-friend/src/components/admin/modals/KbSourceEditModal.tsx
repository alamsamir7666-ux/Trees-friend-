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
import { AlertCircle, Lock } from "lucide-react";
import { useApiFetch } from "@/lib/useApiFetch";
import {
  updateKbSource,
  createKbCreator,
  autoSlug,
  parseYoutubeMetadata,
  type KbCreator,
  type KbSource,
} from "@/lib/kbApi";

const RAW_TEXT_MAX = 100_000;

/**
 * Edit Source modal — lets the admin edit an existing KB source's metadata
 * and (conditionally) its raw text.
 *
 * This modal exists primarily to close Gap #3 from the YouTube auto-fetch
 * feature: when the YouTube auto-fetch falls back to manual mode (bot
 * protection), the source is created with a placeholder rawText. The admin
 * needs to edit the source to paste the real transcript — but the previous
 * PUT route didn't accept rawText updates, and there was no edit UI at all.
 *
 * rawText editing is DISABLED when the source has entries (entryCount > 0).
 * Changing rawText after chunks have been derived would invalidate them —
 * the backend enforces this too (returns 409), but we disable the field
 * client-side so the admin never hits the error in normal use.
 *
 * The modal also supports editing: sourceTitle, sourceUrl, creatorId,
 * sourcePublishedAt. These are always editable regardless of entry count.
 *
 * When rawText IS updated, the backend resets chunking metadata
 * (processing_status → 'pending', chunking fields → NULL) so the admin
 * can re-chunk from the new text.
 *
 * Props:
 *   - source: the KbSource to edit (null = modal closed)
 *   - creators: list of creators for the dropdown
 *   - onCreated: refresh creators list (after inline creator create)
 *   - onSaved: called after a successful save with the updated source
 *   - onOpenChange: control modal open state
 */
export function KbSourceEditModal({
  source,
  creators,
  onCreated,
  onSaved,
  onOpenChange,
}: {
  source: KbSource | null;
  creators: KbCreator[];
  onCreated: () => void;
  onSaved: (source: KbSource) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const apiFetch = useApiFetch();
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [creatorId, setCreatorId] = useState<string>("__none__");
  const [sourcePublishedAt, setSourcePublishedAt] = useState("");
  const [rawText, setRawText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Inline "create new creator" form (same pattern as KbSourceUploadModal).
  const [showNewCreator, setShowNewCreator] = useState(false);
  const [newCreatorName, setNewCreatorName] = useState("");
  const [newCreatorSlug, setNewCreatorSlug] = useState("");
  const [newCreatorSlugEdited, setNewCreatorSlugEdited] = useState(false);
  const [creatingCreator, setCreatingCreator] = useState(false);

  // Reset state when the source changes (modal opens or switches sources).
  useEffect(() => {
    if (!source) return;
    setError("");
    setSourceTitle(source.sourceTitle);
    setSourceUrl(source.sourceUrl ?? "");
    setCreatorId(source.creatorId ? String(source.creatorId) : "__none__");
    setSourcePublishedAt(source.sourcePublishedAt ? source.sourcePublishedAt.slice(0, 10) : "");
    setRawText(source.rawText);
    setShowNewCreator(false);
    setNewCreatorName("");
    setNewCreatorSlug("");
    setNewCreatorSlugEdited(false);
  }, [source]);

  // YouTube metadata (for showing thumbnail + channel link in the modal
  // header — helps the admin confirm they're editing the right video).
  const ytMetadata = source ? parseYoutubeMetadata(source.rawMetadata) : null;

  // The source has entries → rawText is locked. We show the field as
  // read-only with a lock icon + tooltip explaining why.
  const rawTextLocked = source ? source.entryCount > 0 : false;

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
        sourceType: source?.sourceType ?? "manual",
      });
      onCreated();
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
    if (!source) return;
    setError("");

    if (!sourceTitle.trim()) {
      setError("Source title is required.");
      return;
    }

    // Build the updates object — only include fields that changed. This
    // minimizes the diff + avoids sending rawText when it wasn't touched
    // (which would trigger the entries-exist guard unnecessarily).
    const updates: {
      sourceTitle?: string;
      sourceUrl?: string | null;
      creatorId?: number | null;
      sourcePublishedAt?: string | null;
      rawText?: string;
    } = {};

    if (sourceTitle.trim() !== source.sourceTitle) {
      updates.sourceTitle = sourceTitle.trim();
    }
    const newUrl = sourceUrl.trim() || null;
    if (newUrl !== source.sourceUrl) {
      updates.sourceUrl = newUrl;
    }
    const newCreatorId = creatorId === "__none__" ? null : Number(creatorId);
    if (newCreatorId !== source.creatorId) {
      updates.creatorId = newCreatorId;
    }
    const newPublishedAt = sourcePublishedAt || null;
    const oldPublishedAt = source.sourcePublishedAt ? source.sourcePublishedAt.slice(0, 10) : null;
    if (newPublishedAt !== oldPublishedAt) {
      updates.sourcePublishedAt = newPublishedAt;
    }
    // Only send rawText if it changed AND the field isn't locked.
    // (If locked, the field is disabled so it can't change — but this
    // guard is defensive in case the state gets out of sync.)
    if (!rawTextLocked && rawText !== source.rawText) {
      if (!rawText.trim()) {
        setError("Raw text cannot be empty.");
        return;
      }
      if (rawText.length > RAW_TEXT_MAX) {
        setError(`Raw text is too long (max ${RAW_TEXT_MAX.toLocaleString()} characters).`);
        return;
      }
      updates.rawText = rawText;
    }

    if (Object.keys(updates).length === 0) {
      setError("No changes to save.");
      return;
    }

    setSaving(true);
    try {
      const updated = await updateKbSource(apiFetch, source.id, updates);
      onSaved(updated);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update source.");
    } finally {
      setSaving(false);
    }
  }

  // Modal is controlled by whether `source` is non-null.
  const open = source !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit KB Source</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* YouTube thumbnail + channel (if this is a YouTube source) */}
          {ytMetadata && (
            <div className="flex gap-3 p-3 rounded-xl border bg-muted/30">
              {ytMetadata.thumbnailUrl && (
                <img
                  src={ytMetadata.thumbnailUrl}
                  alt={source?.sourceTitle ?? "YouTube thumbnail"}
                  className="w-32 h-20 object-cover rounded-lg shrink-0"
                />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">YouTube</p>
                <p className="text-sm font-medium truncate">{ytMetadata.author}</p>
                {ytMetadata.authorUrl && (
                  <a
                    href={ytMetadata.authorUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    View channel →
                  </a>
                )}
                <p className="text-[11px] text-muted-foreground/70 mt-1">
                  Fetched via <code className="font-mono">{ytMetadata.fetchedVia}</code>
                  {ytMetadata.detectedLanguage && (
                    <>
                      {" "}
                      · language: <code className="font-mono">{ytMetadata.detectedLanguage}</code>
                    </>
                  )}
                </p>
              </div>
            </div>
          )}

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
            />
          </div>

          {/* Source URL */}
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Source URL
            </Label>
            <Input
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              maxLength={500}
              className="mt-1.5 rounded-xl"
              placeholder="https://youtube.com/watch?v=... (optional, used for dedup)"
            />
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

            {/* inline new-creator form */}
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
                        setNewCreatorSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
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
              Published Date
            </Label>
            <Input
              type="date"
              value={sourcePublishedAt}
              onChange={(e) => setSourcePublishedAt(e.target.value)}
              className="mt-1.5 rounded-xl"
            />
          </div>

          {/* Raw text — locked when entries exist */}
          <div>
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Raw Text
              </Label>
              {rawTextLocked && (
                <span className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                  <Lock className="h-3 w-3" />
                  Locked — {source?.entryCount} entr{source?.entryCount === 1 ? "y" : "ies"} exist
                </span>
              )}
            </div>
            <Textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              maxLength={RAW_TEXT_MAX}
              rows={12}
              disabled={rawTextLocked}
              className={`mt-1.5 rounded-xl font-mono text-sm ${
                rawTextLocked ? "bg-muted/50 cursor-not-allowed" : ""
              }`}
              placeholder="Paste the YouTube transcript, blog post text, or manual content here…"
            />
            <p className="text-[11px] text-muted-foreground/70 mt-1">
              {rawText.length.toLocaleString()} / {RAW_TEXT_MAX.toLocaleString()} chars
              {rawTextLocked && (
                <span className="ml-2 text-amber-600 dark:text-amber-400">
                  · Delete all entries to unlock raw text editing (then re-chunk from the new text).
                </span>
              )}
            </p>
            {!rawTextLocked && source && source.rawText !== rawText && (
              <p className="text-[11px] text-blue-600 dark:text-blue-400 mt-1">
                Saving will reset chunking metadata so you can re-chunk from the new text.
              </p>
            )}
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
              {saving ? "Saving…" : "Save Changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
