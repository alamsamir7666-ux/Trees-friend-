import {
  type CourierAdapter,
  type BookShipmentInput,
  type BookShipmentResult,
  type NormalizedShipmentStatus,
  CourierBookingError,
} from "./types";

/**
 * Real integration against Steadfast Courier's Merchant API (publicly
 * documented as portal.packzy.com/api/v1), built from documented
 * request/response shapes -- same "not tested against live credentials"
 * caveat as pathao.ts. Steadfast's auth is simpler than Pathao's: static
 * Api-Key / Secret-Key headers on every request, no OAuth token exchange.
 *
 * Maps cleanly onto seller_courier_configs as-is: apiKey -> Api-Key header,
 * apiSecret -> Secret-Key header, storeId unused (Steadfast has no
 * multi-store concept per merchant account the way Pathao does).
 */

const STEADFAST_BASE_URL = process.env.STEADFAST_API_BASE_URL ?? "https://portal.packzy.com/api/v1";

// Steadfast's documented status_type values from webhook payloads, mapped
// to our normalized enum. Unrecognized values return null.
const STEADFAST_STATUS_MAP: Record<string, NormalizedShipmentStatus> = {
  pending: "pending",
  delivered_approval_pending: "in_transit",
  partial_delivered_approval_pending: "in_transit",
  cancelled_approval_pending: "in_transit",
  unknown_approval_pending: "in_transit",
  delivered: "delivered",
  partial_delivered: "delivered",
  cancelled: "failed",
  hold: "pending",
  in_review: "pending",
  unknown: "failed",
};

export const steadfastAdapter: CourierAdapter = {
  provider: "steadfast",

  async bookShipment(input: BookShipmentInput): Promise<BookShipmentResult> {
    const { credentials, merchantOrderId, recipientName, recipientPhone, recipientAddress, codAmount, itemDescription } = input;

    const res = await fetch(`${STEADFAST_BASE_URL}/create_order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": credentials.apiKey,
        "Secret-Key": credentials.apiSecret,
      },
      body: JSON.stringify({
        invoice: merchantOrderId,
        recipient_name: recipientName,
        recipient_phone: recipientPhone,
        recipient_address: recipientAddress,
        cod_amount: codAmount,
        note: itemDescription,
      }),
    });

    const body = (await res.json().catch(() => null)) as
      | { consignment?: { consignment_id?: string | number; tracking_code?: string } }
      | null;
    if (!res.ok) {
      throw new CourierBookingError(`Steadfast create-order failed (${res.status})`, "steadfast", body);
    }

    const consignment = body?.consignment;
    const consignmentId = consignment?.consignment_id ?? consignment?.tracking_code;
    if (!consignmentId) {
      throw new CourierBookingError("Steadfast create-order response missing consignment id", "steadfast", body);
    }

    return {
      courierTrackingId: String(consignmentId),
      status: "pending",
      raw: body,
    };
  },

  normalizeWebhookStatus(payload: unknown): NormalizedShipmentStatus | null {
    if (typeof payload !== "object" || payload === null) return null;
    const p = payload as Record<string, unknown>;
    const rawStatus = (p.status ?? p.status_type ?? p.delivery_status) as string | undefined;
    if (!rawStatus) return null;
    return STEADFAST_STATUS_MAP[rawStatus.toLowerCase()] ?? null;
  },

  extractTrackingId(payload: unknown): string | null {
    if (typeof payload !== "object" || payload === null) return null;
    const p = payload as Record<string, unknown>;
    const id = p.consignment_id ?? p.tracking_code ?? p.cid;
    return id != null ? String(id) : null;
  },
};
