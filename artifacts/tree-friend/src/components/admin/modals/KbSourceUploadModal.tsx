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
import { AlertCircle, Youtube, Loader2, ExternalLink, CheckCircle2 } from "lucide-react";
import { useApiFetch } from "@/lib/useApiFetch";
import {
  createKbSource,
  createKbCreator,
  createKbSourceFromYoutube,
  autoSlug,
  type KbCreator,
  type KbSource,
} from "@/lib/kbApi";

const RAW_TEXT_MAX = 100_000;

/**
 * Upload mode — drives the form layout.
 *
 *   - "manual"     → the original flow: admin pastes raw text + fills metadata by hand
 *   - "youtube"    → the new auto-fetch flow: admin pastes a YouTube URL, the server
 *                    fetches title/channel/thumbnail (via oEmbed) + transcript (via
 *                    youtubei.js — InnerTube API). On bot-protection failure, the
 *                    server still creates a source row with metadata only and the
 *                    modal shows a "paste transcript manually" prompt.
 *
 * The YouTube mode is a strict superset of the manual mode (it just pre-fills
 * more fields), so the rest of the KB pipeline (chunk → entries → embeddings)
 * is unchanged.
 */
type UploadMode = "manual" | "youtube";

/**
 * Source upload modal — Step 1 of the ingestion pipeline.
 *
 * The admin fills in source metadata + pastes the raw text (YouTube
 * transcript, blog post, manual content). On submit, POST /api/ai/admin/kb/sources
 * creates the source with `processing_status = 'pending'`.
 *
 * YouTube mode: POST /api/ai/admin/kb/sources/youtube auto-fetches the
 * transcript server-side. The admin only pastes the URL.
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
  const [mode, setMode] = useState<UploadMode>("manual");
  const [sourceType, setSourceType] = useState<string>("manual");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState<string>("en");
  const [creatorId, setCreatorId] = useState<string>("__none__");
  const [sourcePublishedAt, setSourcePublishedAt] = useState("");
  const [rawText, setRawText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // YouTube mode state.
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [youtubeResult, setYoutubeResult] = useState<{
    fetchedVia: string;
    segmentCount: number;
    detectedLanguage: string | null;
  } | null>(null);
  const [manualFallback, setManualFallback] = useState<{
    reason: string;
    transcriptUrl: string;
    videoId: string;
    thumbnailUrl: string | null;
  } | null>(null);

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
    setMode("manual");
    setSourceType("manual");
    setSourceUrl("");
    setSourceTitle("");
    setSourceLanguage("en");
    setCreatorId("__none__");
    setSourcePublishedAt("");
    setRawText("");
    setYoutubeUrl("");
    setYoutubeResult(null);
    setManualFallback(null);
    setShowNewCreator(false);
    setNewCreatorName("");
    setNewCreatorSlug("");
    setNewCreatorSlugEdited(false);
  }, [open]);

  // When the admin switches to YouTube mode, auto-set sourceType to "youtube"
  // so the creator dropdown + dedup logic use the right context. When they
  // switch back, restore "manual" (don't override if they had "blog" or
  // "facebook" selected — only flip if it was "youtube").
  //
  // We intentionally exclude `sourceType` from the deps array here: this
  // effect is a one-way sync FROM mode TO sourceType (when mode changes),
  // NOT the reverse. Adding sourceType would create an infinite loop
  // because we setSourceType() inside. The behavior is well-defined and
  // reviewed.
  useEffect(() => {
    if (mode === "youtube") {
      setSourceType("youtube");
    } else if (sourceType === "youtube") {
      setSourceType("manual");
    }
    // Clear YouTube-specific state when switching modes.
    setYoutubeResult(null);
    setManualFallback(null);
    setError("");
  }, [mode]);

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

  // ─── YouTube mode: submit handler ──────────────────────────────────────
  async function handleYoutubeSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setYoutubeResult(null);
    setManualFallback(null);

    const url = youtubeUrl.trim();
    if (!url) {
      setError("YouTube URL is required.");
      return;
    }

    setSaving(true);
    try {
      const result = await createKbSourceFromYoutube(apiFetch, {
        url,
        creatorId: creatorId === "__none__" ? null : Number(creatorId),
        sourceLanguage: sourceLanguage as "en" | "bn" | "banglish",
      });
      // Auto-fetched successfully — close the modal and let the parent
      // open the chunk-review modal.
      if (result.transcript) {
        setYoutubeResult({
          fetchedVia: result.transcript.fetchedVia,
          segmentCount: result.transcript.segmentCount,
          detectedLanguage: result.transcript.detectedLanguage,
        });
        // Brief success state (800ms) so the admin sees what happened,
        // then close + hand off to parent.
        setTimeout(() => {
          onSourceCreated(result.source);
          onOpenChange(false);
        }, 800);
        return;
      }
      // Manual fallback — the source was created with metadata only,
      // rawText is a placeholder. Show the fallback prompt so the admin
      // knows they need to paste the transcript manually (via the Edit
      // Source flow on the source detail page).
      if (result.manualFallback) {
        setManualFallback(result.manualFallback);
        // Don't auto-close — the admin should read the fallback reason
        // and decide whether to copy the transcript now or close.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch YouTube transcript.");
    } finally {
      setSaving(false);
    }
  }

  // ─── Manual mode: submit handler ───────────────────────────────────────
  async function handleManualSubmit(e: React.FormEvent) {
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

  // ─── Shared creator sub-form (used in both modes) ──────────────────────
  function renderCreatorPicker() {
    return (
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
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload KB Source</DialogTitle>
        </DialogHeader>

        {/* Mode switcher (top of form, shared between modes) */}
        <div className="flex gap-2 p-1 rounded-xl bg-muted/40">
          <button
            type="button"
            onClick={() => setMode("manual")}
            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition ${
              mode === "manual"
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Manual paste
          </button>
          <button
            type="button"
            onClick={() => setMode("youtube")}
            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition flex items-center justify-center gap-2 ${
              mode === "youtube"
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Youtube className="h-4 w-4" />
            YouTube URL
          </button>
        </div>

        {mode === "youtube" ? (
          // ─── YouTube mode ───
          <form onSubmit={handleYoutubeSubmit} className="space-y-4">
            {/* YouTube URL */}
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                YouTube URL *
              </Label>
              <Input
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
                required
                className="mt-1.5 rounded-xl"
                placeholder="https://youtube.com/watch?v=... or https://youtu.be/..."
                disabled={saving || !!youtubeResult}
              />
              <p className="text-[11px] text-muted-foreground/70 mt-1">
                The server auto-fetches the video's title, channel, thumbnail, and transcript. Works
                for any YouTube video with captions enabled.
              </p>
            </div>

            {/* Language override (optional) */}
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Language (auto-detected, override if wrong)
              </Label>
              <Select value={sourceLanguage} onValueChange={setSourceLanguage} disabled={saving}>
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

            {/* Creator picker (shared) */}
            {renderCreatorPicker()}

            {/* Success banner */}
            {youtubeResult && (
              <div className="rounded-xl bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 px-3 py-2.5 text-sm text-green-800 dark:text-green-300 flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium">Transcript fetched successfully</div>
                  <div className="text-[11px] mt-0.5 opacity-90">
                    {youtubeResult.segmentCount.toLocaleString()} segments via{" "}
                    <code className="font-mono">{youtubeResult.fetchedVia}</code>
                    {youtubeResult.detectedLanguage && (
                      <>
                        {" "}
                        · detected language:{" "}
                        <code className="font-mono">{youtubeResult.detectedLanguage}</code>
                      </>
                    )}
                    . Opening chunk review…
                  </div>
                </div>
              </div>
            )}

            {/* Manual fallback banner */}
            {manualFallback && (
              <div className="rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-200 space-y-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium">Could not auto-fetch the transcript</div>
                    <div className="text-[11px] mt-0.5 opacity-90">{manualFallback.reason}</div>
                  </div>
                </div>
                <div className="text-[12px] pl-6">
                  <span className="opacity-80">
                    The source was still created with the video's metadata saved.
                  </span>
                  <br />
                  <span className="opacity-80">To complete it:</span>
                  <ol className="list-decimal ml-4 mt-1 space-y-0.5">
                    <li>
                      Open the video and copy the transcript:{" "}
                      <a
                        href={manualFallback.transcriptUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-0.5"
                      >
                        open on YouTube <ExternalLink className="h-3 w-3" />
                      </a>
                    </li>
                    <li>Click "Create Source" below — the metadata will be saved.</li>
                    <li>
                      On the source detail page, click "Edit" and paste the transcript into the Raw
                      Text field.
                    </li>
                  </ol>
                </div>
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
                disabled={saving || !!youtubeResult}
                className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Fetching transcript…
                  </>
                ) : manualFallback ? (
                  "Create Source (metadata only)"
                ) : (
                  <>
                    <Youtube className="h-4 w-4 mr-2" />
                    Auto-fetch transcript
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          // ─── Manual mode (original flow) ───
          <form onSubmit={handleManualSubmit} className="space-y-4">
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
                <span className="ml-1 text-blue-600 dark:text-blue-400">
                  Tip: switch to "YouTube URL" mode above to auto-fetch the transcript.
                </span>
              </p>
            </div>

            {/* Creator picker (shared) */}
            {renderCreatorPicker()}

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
        )}
      </DialogContent>
    </Dialog>
  );
}
