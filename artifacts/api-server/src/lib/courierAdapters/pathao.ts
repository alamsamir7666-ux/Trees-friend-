import {
  type CourierAdapter,
  type BookShipmentInput,
  type BookShipmentResult,
  type NormalizedShipmentStatus,
  CourierBookingError,
} from "./types";

/**
 * Real integration against Pathao's Courier Merchant API, built from
 * publicly documented request/response shapes (Pathao's own SDKs and
 * merchant API docs) -- NOT tested against live credentials, since this
 * environment has none. Flagging explicitly, same discipline as Phase 3's
 * "not verified — no database was available" note: the OAuth token flow
 * and create-order shape below match documented behavior, but the first
 * real booking attempt against a live seller's credentials is the actual
 * test. If Pathao has changed a field name or endpoint since, that surfaces
 * there, not here.
 *
 * Base URL: sellers configure their own store, but the API host itself is
 * fixed per environment (sandbox vs production), not per-seller -- there is
 * no per-seller field for this in seller_courier_configs, and the plan doc
 * doesn't ask for one. Defaults to production; set PATHAO_API_BASE_URL to
 * override for testing against Pathao's sandbox
 * (https://courier-api-sandbox.pathao.com).
 *
 * KNOWN GAP, not fixed here: Pathao's create-order endpoint wants
 * recipient_city / recipient_zone / recipient_area as numeric IDs resolved
 * via their own /api/v1/city-list, /zone-list, /area-list lookups -- not
 * free-text city names. order_shipments/orders has no such ID-resolution
 * step or UI. This adapter sends recipient_city as-is into a `city_name`
 * style fallback field where the shape allows it, but a real integration
 * needs a location-picker in the seller's "Book Courier" UI backed by those
 * lookup endpoints. Flagging rather than guessing Dhaka's zone/area IDs.
 *
 * sender_name/sender_phone are the seller's own pickup contact (threaded
 * through from sellersTable.ownerName/businessName + contactPhone by the
 * caller in routes/orderShipments.ts), not the buyer's -- Pathao needs a
 * real pickup contact distinct from the delivery recipient.
 */

const PATHAO_BASE_URL = process.env.PATHAO_API_BASE_URL ?? "https://api-hermes.pathao.com";

interface PathaoTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

async function getAccessToken(clientId: string, clientSecret: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${PATHAO_BASE_URL}/aladdin/api/v1/issue-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      username,
      password,
      grant_type: "password",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CourierBookingError(`Pathao token request failed (${res.status})`, "pathao", body);
  }
  const data = (await res.json()) as PathaoTokenResponse;
  if (!data.access_token) {
    throw new CourierBookingError("Pathao token response missing access_token", "pathao", data);
  }
  return data.access_token;
}

// Pathao delivery_type: 48 = Normal Delivery (documented default).
const DELIVERY_TYPE_NORMAL = 48;
// Pathao item_type: 2 = Parcel (documented default; 1 = Document).
const ITEM_TYPE_PARCEL = 2;

// Pathao's own order_status vocabulary (as seen in webhook payloads /
// order-details responses) mapped to our normalized enum. Unrecognized
// values return null from normalizeWebhookStatus rather than guessing.
const PATHAO_STATUS_MAP: Record<string, NormalizedShipmentStatus> = {
  Pending: "pending",
  Pickup_Requested: "pending",
  Assigned_for_Pickup: "pending",
  Picked: "picked_up",
  "Pickup Complete": "picked_up",
  In_Transit: "in_transit",
  Received_at_Sub_Hub: "in_transit",
  Delivered: "delivered",
  Partial_Delivery: "delivered",
  Return: "returned",
  Returned: "returned",
  Cancelled: "failed",
  Delivery_Failed: "failed",
};

export const pathaoAdapter: CourierAdapter = {
  provider: "pathao",

  /**
   * NOTE on credential shape: seller_courier_configs has apiKey/apiSecret/
   * storeId (3 fields), but Pathao's OAuth needs 4 (client_id, client_secret,
   * username, password) plus a store_id for the order itself. This adapter
   * maps apiKey -> client_id, apiSecret -> client_secret, and expects the
   * seller's Pathao username/password to have been packed into apiSecret as
   * "password|username" by the courier-config route (see
   * routes/sellerCourierConfigs.ts) since the schema wasn't extended with
   * dedicated columns for this -- flagged there, not silently worked around
   * here without a trace.
   */
  async bookShipment(input: BookShipmentInput): Promise<BookShipmentResult> {
    const { credentials, merchantOrderId, senderName, senderPhone, recipientName, recipientPhone, recipientAddress, recipientCity, codAmount, itemDescription, itemQuantity, itemWeightKg } = input;

    const [clientSecret, username, password] = credentials.apiSecret.split("|");
    if (!username || !password) {
      throw new CourierBookingError(
        "Pathao credentials incomplete: seller_courier_configs.apiSecret must be packed as \"clientSecret|username|password\" for Pathao provider",
        "pathao",
      );
    }
    if (!credentials.storeId) {
      throw new CourierBookingError("Pathao booking requires storeId (seller_courier_configs.storeId)", "pathao");
    }

    const accessToken = await getAccessToken(credentials.apiKey, clientSecret, username, password);

    const res = await fetch(`${PATHAO_BASE_URL}/aladdin/api/v1/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        store_id: Number(credentials.storeId),
        merchant_order_id: merchantOrderId,
        sender_name: senderName,
        sender_phone: senderPhone,
        recipient_name: recipientName,
        recipient_phone: recipientPhone,
        recipient_address: recipientAddress,
        recipient_city: recipientCity,
        delivery_type: DELIVERY_TYPE_NORMAL,
        item_type: ITEM_TYPE_PARCEL,
        special_instruction: "",
        item_quantity: itemQuantity,
        item_weight: itemWeightKg,
        amount_to_collect: codAmount,
        item_description: itemDescription,
      }),
    });

    const body = (await res.json().catch(() => null)) as
      | { data?: { consignment_id?: string | number }; consignment_id?: string | number }
      | null;
    if (!res.ok) {
      throw new CourierBookingError(`Pathao create-order failed (${res.status})`, "pathao", body);
    }

    const consignmentId = body?.data?.consignment_id ?? body?.consignment_id;
    if (!consignmentId) {
      throw new CourierBookingError("Pathao create-order response missing consignment_id", "pathao", body);
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
    const rawStatus = (p.order_status ?? p.status ?? p.event) as string | undefined;
    if (!rawStatus) return null;
    return PATHAO_STATUS_MAP[rawStatus] ?? null;
  },

  extractTrackingId(payload: unknown): string | null {
    if (typeof payload !== "object" || payload === null) return null;
    const p = payload as Record<string, unknown>;
    const id = p.consignment_id ?? p.consignment_id_str;
    return id != null ? String(id) : null;
  },
};
