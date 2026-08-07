/**
 * Shared shape for both courier adapters (plan doc §8: "An adapter layer
 * translates each courier's status vocabulary into the common
 * order_shipments.status enum."). Buyer-facing tracking UI reads only from
 * order_shipments -- never calls Pathao/Steadfast directly -- so every
 * adapter output funnels through this normalized shape before it's stored.
 */

/** Mirrors order_shipments.status. Keep in sync with orderShipments.ts. */
export type NormalizedShipmentStatus =
  | "pending"
  | "picked_up"
  | "in_transit"
  | "delivered"
  | "returned"
  | "failed";

export interface CourierCredentials {
  apiKey: string; // decrypted, never logged
  apiSecret: string; // decrypted, never logged
  storeId: string | null;
}

export interface BookShipmentInput {
  credentials: CourierCredentials;
  /** Our own order id / tracking id, sent as the courier's merchant-order reference. */
  merchantOrderId: string;
  /** The SELLER's own name/phone -- couriers need a real pickup contact,
   * distinct from the buyer/recipient below. Sourced from sellersTable
   * (ownerName/businessName, contactPhone), not left as a placeholder. */
  senderName: string;
  senderPhone: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  /** Free-text city/district -- Pathao technically wants city/zone/area IDs
   * resolved via their location-lookup endpoints, which is a separate,
   * larger integration (address-to-ID resolution UI) not built here. See
   * PathaoAdapter doc comment for how this is handled instead. */
  recipientCity: string;
  codAmount: number; // 0 for advance-paid orders, order total for COD
  itemDescription: string;
  itemQuantity: number;
  /** Approximate weight in kg -- schema has no per-order weight field yet,
   * so callers pass a fixed estimate. See routes/orderShipments.ts. */
  itemWeightKg: number;
}

export interface BookShipmentResult {
  courierTrackingId: string;
  status: NormalizedShipmentStatus;
  raw: unknown;
}

export interface CourierAdapter {
  provider: "pathao" | "steadfast";
  bookShipment(input: BookShipmentInput): Promise<BookShipmentResult>;
  /** Normalizes a provider's webhook payload into our common status enum.
   * Returns null if the payload doesn't identify a recognizable status
   * (caller should store the raw payload for debugging but not update
   * status on a null return). */
  normalizeWebhookStatus(payload: unknown): NormalizedShipmentStatus | null;
  /** Extracts the courier's own tracking/consignment id from a webhook
   * payload, so the webhook route can look up the matching order_shipments
   * row without assuming a specific field name per provider. */
  extractTrackingId(payload: unknown): string | null;
}

export class CourierBookingError extends Error {
  constructor(
    message: string,
    public readonly provider: "pathao" | "steadfast",
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = "CourierBookingError";
  }
}
