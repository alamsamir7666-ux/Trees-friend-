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
 */
export const orderShipmentsTable = pgTable("order_shipments", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .notNull()
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
