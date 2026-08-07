import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    clerkId: text("clerk_id").notNull().unique(),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    phone: text("phone"),
    role: text("role").notNull().default("user"),
    isBlocked: boolean("is_blocked").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    /**
     * Presence tracking — the timestamp of the user's most recent heartbeat.
     *
     * The frontend sends a heartbeat to POST /api/presence/heartbeat every
     * 30 seconds while the user is actively using the app (and on
     * visibilitychange/focus events). The backend treats the user as
     * "online" if last_seen_at is within the last 60 seconds; otherwise
     * "offline" with last_seen_at shown as "last seen at <time>".
     *
     * This matches the WhatsApp/Telegram/Messenger presence model: the
     * server doesn't track WebSocket connections, just the latest
     * heartbeat timestamp. Simpler to scale, simpler to reason about,
     * and degrades gracefully (a missed heartbeat just means the user
     * shows as "last seen at <time>").
     *
     * Nullable so existing rows don't need a default backfill — users
     * who have never sent a heartbeat just show as "offline" with no
     * "last seen" text.
     */
    lastSeenAt: timestamp("last_seen_at"),
  },
  (table) => [
    // FIX: index on last_seen_at — the presence route queries "who is
    // online" by filtering WHERE last_seen_at > NOW() - INTERVAL '60
    // seconds'. Without this index, that query is a sequential scan on
    // the entire users table. Previously only in migration.sql.
    index("users_last_seen_at_idx").on(table.lastSeenAt),
  ],
);

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
