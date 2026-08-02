import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
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

export const messagesTable = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversationsTable.id, { onDelete: "cascade" }),
  senderId: text("sender_id").notNull(), // Clerk user ID — identifies who sent the message
  content: text("content").notNull(),
  // "text" | "image" | "product_card" — extensible for future media types
  messageType: text("message_type").notNull().default("text"),
  // Optional image URL for image messages
  imageUrl: text("image_url"),
  // Read receipts
  readByBuyer: boolean("read_by_buyer").notNull().default(false),
  readBySeller: boolean("read_by_seller").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
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
