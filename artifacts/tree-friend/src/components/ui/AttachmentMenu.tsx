import { useState, useRef } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Paperclip,
  ImageIcon,
  FileText,
  Film,
  Music,
  Camera,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Constants (mirror server-side allow-list) ─────────────────────────────
// These MUST stay in sync with ALLOWED_CHAT_ATTACHMENT_MIME_TYPES in
// lib/db/src/schema/conversations.ts. The client uses them to give the
// user early feedback (e.g. reject toast) before wasting bandwidth on a
// doomed upload.

export const ACCEPTED_MIME_TYPES = [
  // Images
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  // Video
  "video/mp4",
  "video/webm",
  "video/quicktime",
  // Audio
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/json",
] as const;

export const ACCEPT_ATTRIBUTE = ACCEPTED_MIME_TYPES.join(",");
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB — must match server

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Shape of a successfully-uploaded attachment message returned by the
 * server's POST /api/conversations/:id/upload endpoint. Re-exported here
 * so ChatPage and other consumers can import it from a single place.
 */
export interface SentAttachment {
  id: number;
  messageType: string;
  fileUrl: string;
  fileName: string | null;
  fileSize: number | null;
  fileMimeType: string | null;
  attachmentType: string | null;
  content: string;
  createdAt: string;
}

interface AttachmentMenuProps {
  /**
   * Called with every selected file. The parent (ChatPage) is responsible
   * for staging them as pending attachments and uploading on Send — this
   * component does NOT upload anything itself. This matches the
   * industry-standard preview-then-send flow.
   */
  onFilesSelected: (files: File[]) => void;
  /** Optional trigger; defaults to a paperclip button. */
  children?: React.ReactNode;
  align?: "start" | "center" | "end";
}

// ─── Helpers ───────────────────────────────────────────────────────────────

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function isAllowedFile(file: File): { ok: boolean; reason?: string } {
  if (file.size > MAX_FILE_SIZE) {
    return {
      ok: false,
      reason: `"${file.name}" is ${formatFileSize(file.size)}. Max allowed is ${formatFileSize(MAX_FILE_SIZE)}.`,
    };
  }
  // Some browsers report empty MIME for files they don't recognize.
  // Fall back to extension sniffing for the common document types.
  let mime = file.type;
  if (!mime) {
    const ext = file.name.split(".").pop()?.toLowerCase();
    mime = ext ? EXTENSION_TO_MIME[ext] ?? "" : "";
  }
  if (!mime || !(ACCEPTED_MIME_TYPES as readonly string[]).includes(mime)) {
    return {
      ok: false,
      reason: `"${file.name}" has an unsupported file type${mime ? ` (${mime})` : ""}.`,
    };
  }
  return { ok: true };
}

const EXTENSION_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
};

/**
 * Pick an icon for a file based on its MIME type. Used by both the
 * attachment preview strip and the message bubble (file chip).
 */
export function fileIconFor(mimeType: string | null) {
  if (!mimeType) return FileText;
  if (mimeType.startsWith("image/")) return ImageIcon;
  if (mimeType.startsWith("video/")) return Film;
  if (mimeType.startsWith("audio/")) return Music;
  return FileText;
}

/**
 * Classify a file into a UI bucket for preview rendering. Mirrors the
 * server-side `classifyAttachment` in conversations.ts.
 */
export function classifyFile(mimeType: string | null): "image" | "video" | "audio" | "document" {
  if (!mimeType) return "document";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

// ─── Component ─────────────────────────────────────────────────────────────

export function AttachmentMenu({
  onFilesSelected,
  children,
  align = "center",
}: AttachmentMenuProps) {
  const [open, setOpen] = useState(false);

  const photoInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // ─── Input handlers ─────────────────────────────────────────────────────
  // Each handler reads the selected files, passes them to the parent for
  // staging as pending attachments, then resets the input so the same file
  // can be picked again later. NO upload happens here — the parent decides
  // when to upload (on Send click).
  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onFilesSelected(files);
    e.target.value = "";
    setOpen(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onFilesSelected(files);
    e.target.value = "";
    setOpen(false);
  };

  const handleCameraCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onFilesSelected(files);
    e.target.value = "";
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {children ?? (
          <button
            type="button"
            aria-label="Attach a file"
            className="p-2 rounded-full hover:bg-muted/50 transition-colors shrink-0 text-muted-foreground hover:text-foreground"
          >
            <Paperclip className="w-5 h-5" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side="top"
        sideOffset={8}
        className="w-56 p-1.5 rounded-2xl border border-border bg-popover shadow-xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-0.5">
          <AttachmentMenuItem
            icon={<ImageIcon className="w-4 h-4 text-blue-500" />}
            label="Photo & Video"
            hint="JPG, PNG, WEBP, MP4"
            onClick={() => photoInputRef.current?.click()}
          />
          <AttachmentMenuItem
            icon={<Camera className="w-4 h-4 text-purple-500" />}
            label="Take Photo"
            hint="Use your camera"
            onClick={() => cameraInputRef.current?.click()}
          />
          <AttachmentMenuItem
            icon={<FileText className="w-4 h-4 text-orange-500" />}
            label="Document"
            hint="PDF, DOC, XLS, TXT — up to 10MB"
            onClick={() => fileInputRef.current?.click()}
          />
        </div>

        {/* Hidden inputs. The `capture` attribute on the camera input
            asks mobile browsers to open the camera directly. */}
        <input
          ref={photoInputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          className="hidden"
          onChange={handlePhotoSelect}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={handleCameraCapture}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />
      </PopoverContent>
    </Popover>
  );
}

function AttachmentMenuItem({
  icon,
  label,
  hint,
  onClick,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 px-2.5 py-2 rounded-lg hover:bg-muted/60 transition-colors text-left",
        className,
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium leading-tight">{label}</span>
        {hint && (
          <span className="block text-[11px] text-muted-foreground leading-tight mt-0.5">
            {hint}
          </span>
        )}
      </span>
    </button>
  );
}
