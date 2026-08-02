import { getToken } from "@/lib/getToken";
import type { SentAttachment } from "@/components/ui/AttachmentMenu";

/**
 * Upload a single file attachment to a conversation using multipart/form-data.
 *
 * Extracted from AttachmentMenu so the upload pipeline can be triggered by
 * the parent (ChatPage) at the right time — i.e. when the USER clicks Send,
 * not the moment they pick a file. This matches the industry-standard
 * preview-then-send flow used by WhatsApp, Telegram, Messenger, etc.
 *
 * Uses XHR (not axios) so we can report real upload progress via the
 * optional onProgress callback.
 *
 * The server endpoint POST /api/conversations/:id/upload accepts:
 *   - field "file"    : the attachment (required)
 *   - field "caption" : optional text caption sent alongside the file
 *
 * Returns the created message object on success; throws an Error with a
 * server-provided message (or generic "Upload failed") on failure.
 */
export function uploadAttachment(
  file: File,
  conversationId: number,
  caption?: string,
  onProgress?: (percent: number) => void,
): Promise<SentAttachment> {
  return new Promise<SentAttachment>((resolve, reject) => {
    const formData = new FormData();
    formData.append("file", file);
    if (caption && caption.trim().length > 0) {
      formData.append("caption", caption.trim());
    }

    const xhr = new XMLHttpRequest();
    const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? "") as string;
    xhr.open("POST", `${baseUrl}/api/conversations/${conversationId}/upload`);
    // Send cookies (Clerk may also use cookie-based sessions in dev)
    xhr.withCredentials = true;

    // Pull the Clerk session token via the shared getter so the backend's
    // requireAuth middleware accepts the request — same token apiClient sends.
    getToken()
      .then((token) => {
        if (token) {
          xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        }
        xhr.send(formData);
      })
      .catch((err) => reject(err));

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as SentAttachment);
        } catch (err) {
          reject(err);
        }
      } else {
        let serverError = "Upload failed";
        try {
          const parsed = JSON.parse(xhr.responseText);
          if (parsed?.error) serverError = parsed.error;
          if (parsed?.detail) serverError = `${serverError}: ${parsed.detail}`;
        } catch {
          /* ignore parse errors */
        }
        reject(new Error(serverError));
      }
    };

    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
  });
}
