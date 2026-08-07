/**
 * Composer thumbnail for a pending attachment (staged but not yet
 * uploaded). Shows progress bar during upload, error state on failure.
 * Includes the PreviewRemoveButton helper.
 */

import type { PendingAttachment } from "./types";
import { X, Loader2, Film, Music } from "lucide-react";
import { fileIconFor, formatFileSize } from "@/components/ui/AttachmentMenu";
import { cn } from "@/lib/utils";

interface PendingAttachmentPreviewProps {
  attachment: PendingAttachment;
  onRemove: () => void;
}

/**
 * Renders a single pending attachment as a thumbnail (for images/videos) or
 * a file chip (for audio/documents) in the composer's preview strip, before
 * the user clicks Send. Each preview has an X button to remove it.
 *
 * For images, we show the actual decoded image via a blob URL so the user
 * sees exactly what they're about to send. For videos, we show the first
 * frame via a <video> element with `preload="metadata"`. For audio and
 * documents, we show a compact file chip with icon + name + size.
 */
export function PendingAttachmentPreview({
  attachment,
  onRemove,
}: PendingAttachmentPreviewProps) {
  const { file, previewUrl, kind } = attachment;

  // ─── Image thumbnail ─────────────────────────────────────────────────
  if (kind === "image" && previewUrl) {
    return (
      <div className="relative shrink-0 w-20 h-20 rounded-lg overflow-hidden border border-border bg-muted/30 group">
        <img
          src={previewUrl}
          alt={file.name}
          className="w-full h-full object-cover"
        />
        <PreviewRemoveButton onClick={onRemove} />
      </div>
    );
  }

  // ─── Video thumbnail (first frame) ───────────────────────────────────
  if (kind === "video" && previewUrl) {
    return (
      <div className="relative shrink-0 w-20 h-20 rounded-lg overflow-hidden border border-border bg-black/90 group">
        <video
          src={previewUrl}
          className="w-full h-full object-cover"
          preload="metadata"
          muted
        />
        {/* Play icon overlay to signal it's a video */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-7 h-7 rounded-full bg-black/60 flex items-center justify-center">
            <Film className="w-3.5 h-3.5 text-white" />
          </div>
        </div>
        <PreviewRemoveButton onClick={onRemove} />
      </div>
    );
  }

  // ─── Audio / document file chip ─────────────────────────────────────
  const Icon = fileIconFor(file.type || null);
  return (
    <div className="relative shrink-0 flex items-center gap-2 pl-2.5 pr-7 py-2 rounded-lg border border-border bg-muted/30 max-w-[200px]">
      <span className="shrink-0 w-8 h-8 rounded-md bg-primary/10 text-primary flex items-center justify-center">
        {kind === "audio" ? (
          <Music className="w-4 h-4" />
        ) : (
          <Icon className="w-4 h-4" />
        )}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-xs font-medium truncate">{file.name}</span>
        <span className="block text-[10px] text-muted-foreground mt-0.5">
          {formatFileSize(file.size)}
        </span>
      </span>
      <PreviewRemoveButton onClick={onRemove} compact />
    </div>
  );
}

/**
 * The X button overlaid on a pending attachment preview. Styled to be
 * visible against any background (semi-transparent dark circle with a
 * white X). `compact` variant is for the file chip (smaller, positioned
 * at the top-right of the chip rather than overlaid).
 */
function PreviewRemoveButton({
  onClick,
  compact = false,
}: {
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label="Remove attachment"
      className={cn(
        "rounded-full bg-black/70 hover:bg-black/90 text-white flex items-center justify-center transition-colors",
        compact
          ? "absolute top-1 right-1 w-4 h-4"
          : "absolute top-1 right-1 w-5 h-5",
      )}
    >
      <X className={compact ? "w-2.5 h-2.5" : "w-3 h-3"} />
    </button>
  );
}
