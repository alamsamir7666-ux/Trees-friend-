import {
  pgTable,
  serial,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * AI assistant chat sessions.
 *
 * Each row represents one anonymous conversation thread between a website
 * visitor and the Gemini-powered TreeBot assistant. Sessions are keyed by a
 * client-generated `sessionToken` (stored in localStorage on the browser)
 * so the same anonymous visitor can resume their conversation across page
 * refreshes and even across devices if they share the token.
 *
 * Design notes:
 *   - `userId` is nullable because v1 of the assistant is anonymous — even
 *     if the visitor happens to be signed in via Clerk, we don't currently
 *     tie AI chats to user accounts. This column is reserved for a future
 *     v2 that adds logged-in context (orders, wishlist, etc.).
 *   - `title` is auto-derived from the first user message (truncated) so
 *     the conversation list (if we ever build one in the UI) has a
 *     readable label instead of just an ID.
 *   - We deliberately do NOT cascade-delete sessions when a user is deleted,
 *     because v1 sessions are anonymous — `userId` will be NULL for all rows.
 */
export const aiChatSessionsTable = pgTable(
  "ai_chat_sessions",
  {
    id: serial("id").primaryKey(),
    // Client-generated opaque token (e.g. crypto.randomUUID()). Uniqueness
    // enforced so concurrent inserts with the same token collapse to one row.
    sessionToken: text("session_token").notNull().unique(),
    // Nullable for v1 (anonymous). Reserved for future logged-in context.
    userId: text("user_id"),
    // Auto-derived from the first user message; updated once on first message.
    title: text("title"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Lookups by client token are the hot path (every chat request).
    index("ai_chat_sessions_token_idx").on(table.sessionToken),
    // Future-proof: when v1 ships logged-in context, list a user's sessions.
    index("ai_chat_sessions_user_idx").on(table.userId),
  ],
);

/**
 * AI assistant chat messages.
 *
 * Stores both sides of the conversation — user messages (`role = 'user'`)
 * and assistant responses (`role = 'assistant'`). Ordered by `created_at`
 * ascending within a session for chronological display.
 *
 * The assistant content is stored exactly as Gemini returned it (post-stream
 * reassembly on the backend), so the frontend can rehydrate a conversation
 * on page load without re-calling the model.
 */
export const aiChatMessagesTable = pgTable(
  "ai_chat_messages",
  {
    id: serial("id").primaryKey(),
    sessionId: serial("session_id")
      .notNull()
      .references(() => aiChatSessionsTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'user' | 'assistant'
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // The hot path is "fetch the last N messages for a session, oldest first"
    // — both for display and for building the conversation history sent to
    // Gemini. This composite index covers that with a single index scan.
    index("ai_chat_messages_session_created_idx").on(
      table.sessionId,
      table.createdAt,
    ),
  ],
);

// Useful type exports for the API server to consume via @workspace/db.
export type AiChatSession = typeof aiChatSessionsTable.$inferSelect;
export type AiChatMessage = typeof aiChatMessagesTable.$inferSelect;

// Mark the module as side-effectful for the schema barrel — drizzle needs
// the table objects to be imported so they're included in the schema bag.
export const __aiChatSchemaMarker = sql`-- ai_chat schema loaded`;
