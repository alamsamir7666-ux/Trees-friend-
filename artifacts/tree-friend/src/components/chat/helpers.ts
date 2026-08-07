/**
 * Pure helpers for the chat module: time formatting, date separators,
 * attachment URL resolution, message classification, edit-window check.
 *
 * Extracted from ChatPage.tsx. All functions are pure (no React, no
 * hooks) so they can be unit-tested in isolation if needed.
 */

import type { ChatMessage } from "./types";
import { EDIT_DELETE_WINDOW_MS } from "./types";

// Re-export so ChatPage.tsx can import EDIT_DELETE_WINDOW_MS from a single
// location (helpers) without having to know it actually lives in types.ts.
// The constant is defined in types.ts because isWithinEditWindow (below)
// uses it, and helpers must not introduce a circular dep on ChatPage.
export { EDIT_DELETE_WINDOW_MS };

export function isWithinEditWindow(msg: ChatMessage): boolean {
  const ageMs = Date.now() - new Date(msg.createdAt).getTime();
  return ageMs <= EDIT_DELETE_WINDOW_MS;
}

export function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatDate(isoString: string): string {
  const date = new Date(isoString);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
}

export function shouldShowDateSeparator(prev: ChatMessage | undefined, curr: ChatMessage): boolean {
  if (!prev) return true;
  return new Date(prev.createdAt).toDateString() !== new Date(curr.createdAt).toDateString();
}

/**
 * Resolve which URL to use for an attachment message. fileUrl is the
 * canonical field; imageUrl is the legacy one. We prefer fileUrl, then
 * fall back to imageUrl for older messages that only set the legacy field.
 */
export function attachmentUrl(msg: ChatMessage): string | null {
  return msg.fileUrl ?? msg.imageUrl ?? null;
}

/**
 * Classify a message for rendering. The server populates
 * `attachmentType` on new messages, but old messages (and messages
 * created via the legacy JSON endpoint without fileMimeType) may not
 * have it. We fall back to inferring from `messageType` + `imageUrl`.
 */
export function classifyMessage(msg: ChatMessage): "text" | "image" | "video" | "audio" | "document" {
  const a = msg.attachmentType;
  if (a === "image" || a === "video" || a === "audio" || a === "document") return a;
  // Legacy message: type=image with imageUrl, no attachmentType
  if (msg.messageType === "image" && attachmentUrl(msg)) return "image";
  // Otherwise: text (even if it's an unknown attachment type, treat as text
  // and let the message body show the content string)
  return "text";
}
