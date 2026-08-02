import { useState, useRef, useCallback, useEffect } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { getToken } from "@/lib/getToken";
import {
  Paperclip,
  ImageIcon,
  FileText,
  Film,
  Music,
  Camera,
  X,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Constants (mirror server-side allow-list) ─────────────────────────────
// These MUST stay in sync with ALLOWED_CHAT_ATTACHMENT_MIME_TYPES in
// lib/db/src/schema/conversations.ts. The client uses them to give the
// user early feedback (e.g. greyed-out file-type icon, instant reject
// toast) before wasting bandwidth on a doomed upload.

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
  conversationId: number;
  onSent: (message: SentAttachment) => void;
  /** Optional trigger; defaults to a paperclip button. */
  children?: React.ReactNode;
  align?: "start" | "center" | "end";
}

interface UploadState {
  fileName: string;
  fileSize: number;
  progress: number; // 0-100
  status: "uploading" | "done" | "error";
  error?: string;
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
 * attachment menu (upload progress) and the message bubble (file chip).
 */
export function fileIconFor(mimeType: string | null) {
  if (!mimeType) return FileText;
  if (mimeType.startsWith("image/")) return ImageIcon;
  if (mimeType.startsWith("video/")) return Film;
  if (mimeType.startsWith("audio/")) return Music;
  // documents — pick by specific extension for nicer UX
  if (mimeType === "application/pdf") return FileText;
  if (mimeType.includes("word")) return FileText;
  if (mimeType.includes("sheet") || mimeType.includes("excel")) return FileText;
  if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) return FileText;
  return FileText;
}

// ─── Component ─────────────────────────────────────────────────────────────

export function AttachmentMenu({
  conversationId,
  onSent,
  children,
  align = "center",
}: AttachmentMenuProps) {
  const [open, setOpen] = useState(false);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const { toast } = useToast();

  const photoInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // ─── Upload pipeline ────────────────────────────────────────────────────
  /**
   * Upload a list of files to the conversation. Each file is uploaded
   * independently so one failure doesn't block the others. We use XHR
   * instead of axios so we can show real upload progress — axios's
   * `onUploadProgress` works too but XHR is the underlying primitive
   * and keeps this code independent of the apiClient config.
   */
  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      // Pre-validate ALL files before starting any upload so the user
      // gets a single combined error message instead of one-per-failure.
      const valid: File[] = [];
      const errors: string[] = [];
      for (const file of files) {
        const result = isAllowedFile(file);
        if (result.ok) {
          valid.push(file);
        } else {
          errors.push(result.reason ?? `"${file.name}" is not allowed.`);
        }
      }

      if (errors.length > 0) {
        toast({
          title: errors.length === 1 ? "File not added" : `${errors.length} files not added`,
          description: errors.join(" "),
          variant: "destructive",
        });
      }
      if (valid.length === 0) return;

      // Snapshot the uploads we're about to start so we can update their
      // progress entries by index. We use the file name + start time as
      // a stable key — duplicates in the same batch get a suffix.
      const startIndex = uploads.length;
      const newEntries: UploadState[] = valid.map((f) => ({
        fileName: f.name,
        fileSize: f.size,
        progress: 0,
        status: "uploading",
      }));
      setUploads((prev) => [...prev, ...newEntries]);

      await Promise.all(
        valid.map(async (file, i) => {
          const idx = startIndex + i;
          try {
            const formData = new FormData();
            formData.append("file", file);

            await new Promise<void>((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              // Build the URL the same way apiClient does: BASE_URL + /api/conversations/:id/upload
              const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? "") as string;
              xhr.open("POST", `${baseUrl}/api/conversations/${conversationId}/upload`);
              // Send cookies (Clerk may also use cookie-based sessions in dev)
              xhr.withCredentials = true;

              // Pull the Clerk session token via the shared getter that
              // App.tsx wires up. This is the SAME token apiClient sends
              // on JSON requests, so the backend's requireAuth middleware
              // accepts it without any extra config.
              getToken()
                .then((token) => {
                  if (token) {
                    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
                  }
                  xhr.send(formData);
                })
                .catch((err) => reject(err));

              xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                  const pct = Math.round((e.loaded / e.total) * 100);
                  setUploads((prev) => {
                    const next = [...prev];
                    if (next[idx]) {
                      next[idx] = { ...next[idx], progress: pct };
                    }
                    return next;
                  });
                }
              };

              xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                  try {
                    const message = JSON.parse(xhr.responseText) as SentAttachment;
                    setUploads((prev) => {
                      const next = [...prev];
                      if (next[idx]) {
                        next[idx] = { ...next[idx], status: "done", progress: 100 };
                      }
                      return next;
                    });
                    onSent(message);
                    resolve();
                  } catch (err) {
                    reject(err);
                  }
                } else {
                  let serverError = "Upload failed";
                  try {
                    const parsed = JSON.parse(xhr.responseText);
                    if (parsed?.error) serverError = parsed.error;
                  } catch {
                    /* ignore parse errors */
                  }
                  reject(new Error(serverError));
                }
              };

              xhr.onerror = () => reject(new Error("Network error during upload"));
              xhr.onabort = () => reject(new Error("Upload aborted"));
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : "Upload failed";
            setUploads((prev) => {
              const next = [...prev];
              if (next[idx]) {
                next[idx] = { ...next[idx], status: "error", error: message };
              }
              return next;
            });
            toast({
              title: `Failed to upload ${file.name}`,
              description: message,
              variant: "destructive",
            });
          }
        }),
      );

      // Auto-clear completed uploads after 3s so the UI doesn't pile up.
      // Errors stay visible until the user dismisses them.
      setTimeout(() => {
        setUploads((prev) => prev.filter((u) => u.status === "uploading" || u.status === "error"));
      }, 3000);
    },
    [conversationId, onSent, toast, uploads.length],
  );

  // ─── Input handlers ─────────────────────────────────────────────────────
  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    void uploadFiles(files);
    // Reset input so the same file can be selected again later
    e.target.value = "";
    setOpen(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    void uploadFiles(files);
    e.target.value = "";
    setOpen(false);
  };

  const handleCameraCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    void uploadFiles(files);
    e.target.value = "";
    setOpen(false);
  };

  // ─── Drag-and-drop support ──────────────────────────────────────────────
  // Drop files anywhere on the picker trigger area to upload them.
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (e.dataTransfer?.files?.length) {
      setIsDragging(true);
    }
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  };
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    void uploadFiles(files);
    setOpen(false);
  };

  // Cleanup timeouts/preview URLs on unmount
  useEffect(() => {
    return () => {
      dragCounter.current = 0;
    };
  }, []);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {children ?? (
            <button
              type="button"
              aria-label="Attach a file"
              className={cn(
                "p-2 rounded-full hover:bg-muted/50 transition-colors shrink-0 text-muted-foreground hover:text-foreground",
                isDragging && "bg-accent/20 text-accent",
              )}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
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

      {/* Upload progress tray — rendered inline so it can be placed
          anywhere the parent wants (we put it above the input bar). */}
      {uploads.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {uploads.map((u, i) => {
            const Icon = fileIconFor(null);
            return (
              <div
                key={`${u.fileName}-${i}`}
                className={cn(
                  "flex items-center gap-2 px-2.5 py-1.5 rounded-full text-xs border max-w-[260px]",
                  u.status === "error"
                    ? "bg-destructive/10 border-destructive/30 text-destructive"
                    : u.status === "done"
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                      : "bg-muted border-border",
                )}
              >
                {u.status === "uploading" && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                )}
                {u.status === "done" && (
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                )}
                {u.status === "error" && (
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                )}
                <span className="truncate max-w-[140px]">{u.fileName}</span>
                {u.status === "uploading" && (
                  <span className="text-muted-foreground tabular-nums">{u.progress}%</span>
                )}
                {u.status === "error" && u.error && (
                  <span className="text-destructive truncate max-w-[100px]" title={u.error}>
                    {u.error}
                  </span>
                )}
                <button
                  type="button"
                  className="p-0.5 rounded-full hover:bg-background/50 shrink-0"
                  onClick={() => setUploads((prev) => prev.filter((_, j) => j !== i))}
                  aria-label="Dismiss"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function AttachmentMenuItem({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 px-2.5 py-2 rounded-lg hover:bg-muted/60 transition-colors text-left"
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

// (Clerk token is pulled via the shared `getToken()` helper from
// @/lib/getToken — see the upload pipeline above.)
