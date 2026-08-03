import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  bigint,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sellersTable } from "./sellers";

/**
 * A conversation between a buyer and a seller. Each buyer-seller pair has
 * exactly one conversation (enforced by the unique index on
 * buyer_id + seller_id). This is the industry-standard pattern for
 * marketplace messaging (eBay, Etsy, Daraz) — one thread per
 * buyer-seller pair, not per product or per order.
 *
 * A conversation can optionally be linked to a specific seller listing
 * (seller_listing_id) when the buyer initiates chat from a product page.
 * This allows the product context card to appear in the chat header.
 * If the buyer messages from the seller's store page (no specific product),
 * this field is null.
 *
 * lastMessageAt is denormalized for efficient conversation-list sorting
 * without joining into messages. Updated on every new message insert.
 */
export const conversationsTable = pgTable("conversations", {
  id: serial("id").primaryKey(),
  buyerId: text("buyer_id").notNull(), // Clerk user ID (text), same convention as follows/wishlist/cart
  sellerId: integer("seller_id")
    .notNull()
    .references(() => sellersTable.id, { onDelete: "cascade" }),
  // Optional: link to a specific listing when chat started from a product page
  sellerListingId: integer("seller_listing_id"),
  // Denormalized: updated on every new message for efficient sorting
  lastMessageAt: timestamp("last_message_at").defaultNow().notNull(),
  // Buyer can archive a conversation (hide from their list)
  buyerArchived: boolean("buyer_archived").notNull().default(false),
  // Seller can archive a conversation (hide from their list)
  sellerArchived: boolean("seller_archived").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Messages in a conversation.
 *
 * messageType controls how the payload is interpreted:
 *   - "text"      : `content` is the message body. No attachments.
 *   - "image"     : `imageUrl` (legacy) / `fileUrl` points to the image. `content` may hold a caption.
 *   - "file"      : `fileUrl` + `fileName` + `fileSize` + `fileMimeType` describe a downloadable file.
 *   - "product_card" : Reserved for future inline product cards (no schema changes needed).
 *
 * `imageUrl` is preserved for backward compatibility with existing image
 * messages; new image uploads populate `fileUrl` and `imageUrl` in tandem
 * (fileUrl is canonical, imageUrl is mirrored for older clients).
 *
 * `attachmentType` is a normalized view of the attachment for quick UI
 * branching: "image" | "video" | "audio" | "document" | null.
 */
export const messagesTable = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversationsTable.id, { onDelete: "cascade" }),
  senderId: text("sender_id").notNull(), // Clerk user ID — identifies who sent the message
  content: text("content").notNull(),
  // "text" | "image" | "file" | "product_card" — extensible for future media types
  messageType: text("message_type").notNull().default("text"),

  // ─── Attachment fields (Phase: emoji + file attachments) ───────────────
  // Legacy image URL — preserved for backward compat. New image uploads
  // populate BOTH imageUrl and fileUrl so old clients keep working.
  imageUrl: text("image_url"),
  // Canonical attachment URL for any message type (image, file, video, audio).
  fileUrl: text("file_url"),
  // Original file name as uploaded by the sender (e.g. "invoice-2026.pdf").
  fileName: text("file_name"),
  // File size in bytes (number). bigint because media files can exceed 2GB.
  fileSize: bigint("file_size", { mode: "number" }),
  // MIME type (e.g. "application/pdf", "image/jpeg"). Used for icon + preview logic.
  fileMimeType: text("file_mime_type"),
  // Normalized attachment type for UI branching: "image" | "video" | "audio" | "document" | null.
  attachmentType: text("attachment_type"),

  // Read receipts
  readByBuyer: boolean("read_by_buyer").notNull().default(false),
  readBySeller: boolean("read_by_seller").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),

  // ─── Edit tracking ──────────────────────────────────────────────────────
  // Set to the timestamp of the most recent edit (null = never edited).
  // The UI shows a small "edited" label next to the timestamp when this is
  // non-null. WhatsApp/Telegram/Signal all do this — the existence of an
  // edit is visible (transparency), but the previous content is not kept.
  editedAt: timestamp("edited_at"),

  // ─── Soft-delete tracking ───────────────────────────────────────────────
  // We never hard-delete chat messages — instead, we mark them deleted so
  // the other participant still sees "This message was deleted" in place.
  // This matches WhatsApp/Telegram semantics: a deleted message stays in
  // the conversation thread as a tombstone, preserving context (timestamps,
  // read-receipt sequence, replies) instead of leaving a gap.
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at"),

  // ─── Reply tracking (swipe-to-reply) ────────────────────────────────────
  // When non-null, this message is a reply to the message with this id.
  // The referenced message must be in the same conversation (enforced at
  // the API layer, not via DB FK, so that soft-deleting the parent doesn't
  // cascade-block replies). The frontend looks up the parent message from
  // its already-loaded messages array — no N+1 query needed on GET.
  // Nullable so existing rows and non-reply messages default to null.
  replyToId: integer("reply_to_id"),
});

export const insertConversationSchema = createInsertSchema(conversationsTable).omit({
  id: true,
  lastMessageAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Conversation = typeof conversationsTable.$inferSelect;

export const insertMessageSchema = createInsertSchema(messagesTable).omit({
  id: true,
  readByBuyer: true,
  readBySeller: true,
  createdAt: true,
});
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messagesTable.$inferSelect;

/**
 * Allowed MIME types for chat attachments. Kept here so both the API
 * route and any future admin/test script can share the same allow-list.
 *
 * Images and videos are rendered inline; everything else is rendered as
 * a file chip with a download button. Executables, scripts, and archives
 * (zip/rar) are intentionally excluded to reduce malware risk — the
 * marketplace does not need to ship binaries through chat.
 */
export const ALLOWED_CHAT_ATTACHMENT_MIME_TYPES = [
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

export const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
