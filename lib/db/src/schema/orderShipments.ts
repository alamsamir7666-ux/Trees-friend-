import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ordersTable } from "./orders";

/**
 * Normalized shipment/tracking status for an order, sourced from the
 * seller's own Pathao/Steadfast account (or manual updates). Buyer-facing
 * tracking UI reads only from this table -- never calls Pathao/Steadfast
 * directly.
 *
 * courierProvider = "manual" means the seller has no verified courier
 * config: no courierTrackingId, no webhook, status is updated by hand via
 * dropdown in the seller's Manage Orders.
 *
 * rawWebhookPayload is kept for debugging when a courier's webhook payload
 * shape changes -- an adapter layer translates each courier's status
 * vocabulary into the common `status` enum below.
 *
 * orderId has .unique(): at most one shipment row per order. This mirrors
 * the seller_courier_configs.sellerId / seller_payment_configs.sellerId
 * precedent -- routes/orderShipments.ts's book-courier and
 * shipment-status handlers both do a check-then-act
 * "SELECT by orderId, then UPDATE if found else INSERT" against this
 * table (not an atomic upsert), and book-courier's check-then-act window
 * spans a real network round-trip to Pathao/Steadfast, not just a few
 * synchronous lines. Without a DB-level constraint, two concurrent
 * requests for the same order (a double-click on "Book Courier", or a
 * manual status update racing a booking) could both pass the "no existing
 * row" check before either INSERT commits, leaving two shipment rows for
 * one order. Every reader in this codebase (this file's own GET routes,
 * courierWebhooks.ts's trackingId lookup, sellerOrders.ts's
 * orderId -> shipment map) assumes at most one row per order and would
 * silently pick/keep an arbitrary one if that were ever violated. Added
 * in Part 2 of the Phase-9-successor backlog, found while re-verifying a
 * separate (and, on inspection, incorrect) claim about a missing
 * .limit(1) on a different query in this file -- see PART2_HANDOFF.md.
 */
export const orderShipmentsTable = pgTable("order_shipments", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .notNull()
    .unique()
    .references(() => ordersTable.id, { onDelete: "cascade" }),
  courierProvider: text("courier_provider").notNull(), // "pathao" | "steadfast" | "manual"
  courierTrackingId: text("courier_tracking_id"), // null if manual

  // "pending" | "picked_up" | "in_transit" | "delivered" | "returned" | "failed"
  status: text("status").notNull().default("pending"),

  lastSyncedAt: timestamp("last_synced_at"),
  rawWebhookPayload: jsonb("raw_webhook_payload"),
});

export const insertOrderShipmentSchema = createInsertSchema(orderShipmentsTable).omit({
  id: true,
});
export type InsertOrderShipment = z.infer<typeof insertOrderShipmentSchema>;
export type OrderShipment = typeof orderShipmentsTable.$inferSelect;
