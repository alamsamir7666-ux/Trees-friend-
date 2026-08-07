/**
 * Inline attachment renderer for chat messages: image, video, audio,
 * document. Extracted from ChatPage.tsx.
 */

import type { ChatMessage } from "./types";
import { attachmentUrl } from "./helpers";
import { fileIconFor, formatFileSize } from "@/components/ui/AttachmentMenu";
import {
  Download,
  Film,
  Music,
  ExternalLink,
} from "lucide-react";

interface MessageAttachmentProps {
  msg: ChatMessage;
  kind: "image" | "video" | "audio" | "document";
  isOwn: boolean;
  onImageClick: (src: string) => void;
}

export function MessageAttachment({ msg, kind, onImageClick }: MessageAttachmentProps) {
  const url = attachmentUrl(msg);
  if (!url) return null;

  // ─── Image: inline preview, click to open lightbox ──────────────────
  if (kind === "image") {
    return (
      <div
        className="rounded-xl overflow-hidden cursor-zoom-in bg-muted/30"
        onClick={() => onImageClick(url)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onImageClick(url);
          }
        }}
      >
        <img
          src={url}
          alt={msg.fileName ?? "Image attachment"}
          className="w-full max-w-[280px] max-h-[360px] object-cover"
          loading="lazy"
        />
      </div>
    );
  }

  // ─── Video: native <video> element with controls ────────────────────
  if (kind === "video") {
    return (
      <div className="rounded-xl overflow-hidden bg-black/90 max-w-[280px]">
        <video
          src={url}
          controls
          playsInline
          className="w-full max-h-[360px]"
          preload="metadata"
        />
      </div>
    );
  }

  // ─── Audio: native <audio> element with download fallback ──────────
  if (kind === "audio") {
    return (
      <div className="flex items-center gap-2 min-w-[200px]">
        <audio src={url} controls preload="metadata" className="flex-1 min-w-0" />
      </div>
    );
  }

  // ─── Document: file chip with icon, name, size, download button ────
  const Icon = fileIconFor(msg.fileMimeType ?? null);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      download={msg.fileName ?? undefined}
      className="flex items-center gap-3 px-3 py-2.5 min-w-[220px] max-w-full rounded-lg bg-muted/40 hover:bg-muted/70 transition-colors group"
    >
      <span className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
        <Icon className="w-4 h-4" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium truncate">{msg.fileName ?? "Document"}</span>
        <span className="block text-[11px] text-muted-foreground mt-0.5">
          {msg.fileSize ? formatFileSize(msg.fileSize) : "Download"}
          {msg.fileMimeType && <span className="opacity-70"> · {msg.fileMimeType.split("/")[1]?.toUpperCase()}</span>}
        </span>
      </span>
      <Download className="w-4 h-4 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
    </a>
  );
}
