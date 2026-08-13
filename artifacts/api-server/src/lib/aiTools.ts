/**
 * Function-calling tools for the TreeBot assistant (v2.5).
 *
 * Gemini's function-calling API lets the AI decide WHEN to query the
 * database based on the user's intent — much more accurate than Naive RAG
 * (which dumps context into the prompt regardless of whether it's needed).
 *
 * How it works:
 *   1. We declare a list of available functions (with parameter schemas).
 *   2. Gemini receives the user's message + the tool declarations.
 *   3. If Gemini needs DB info, it responds with a `functionCall` instead
 *      of text — asking us to execute e.g. `search_catalog({ query: "mango" })`.
 *   4. We execute the function locally and send the result back to Gemini.
 *   5. Gemini generates the final text response using the function result.
 *
 * This multi-round loop runs inside streamGeminiChat (see gemini.ts).
 *
 * Tools exposed:
 *   - search_catalog(query, max_price?, sunlight?)
 *     Fuzzy product search with optional price/sunlight filters.
 *   - get_product_care(product_slug)
 *     Returns detailed care info (watering, sunlight, soil, etc.) for a
 *     specific product identified by its slug.
 *   - get_user_orders()
 *     Returns the signed-in user's 5 most recent orders. Anonymous users
 *     get a "not available" response that the AI can phrase politely.
 *   - get_order_details(order_number)
 *     Returns detailed status for a specific order. Only works for the
 *     signed-in user's own orders (privacy: can't query other users).
 *
 * Security:
 *   - get_user_orders and get_order_details check the userId — they only
 *     return data belonging to that user. An anonymous user cannot query
 *     orders at all.
 *   - search_catalog and get_product_care are public (same data as the
 *     public product pages).
 */
import { Type } from "@google/genai";
import type { FunctionDeclaration } from "@google/genai";
import { pool } from "@workspace/db";
import { logger } from "./logger";

// ─── Tool declarations (sent to Gemini) ──────────────────────────────────────

export const AI_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "search_catalog",
    description:
      "Search the TreeFriend product catalog for trees/plants matching a query. " +
      "Returns up to 8 results with name, slug, price range, sunlight needs, and a short description. " +
      "Use this when the user is looking for specific plants, asking what's available, or wants recommendations. " +
      "Optional filters: max_price (in BDT), sunlight requirement.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description:
            "Search keywords — plant name, scientific name, or description keywords. " +
            'e.g. "mango", "indoor", "shade loving", "Mangifera indica"',
        },
        max_price: {
          type: Type.NUMBER,
          description: "Optional maximum price in BDT (Bangladeshi Taka). e.g. 500",
        },
        sunlight: {
          type: Type.STRING,
          description: "Optional sunlight requirement filter.",
          enum: ["full_sun", "partial_shade", "full_shade"],
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_product_care",
    description:
      "Get detailed care information for a specific product, identified by its slug. " +
      "Returns sunlight, watering, soil type, mature height, climate zone, growth rate, " +
      "bloom season, key benefits, best for (indoor/balcony/garden), and care tips. " +
      "Use this AFTER search_catalog when the user asks about a specific product's care.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        product_slug: {
          type: Type.STRING,
          description: 'The product\'s slug (URL identifier). e.g. "alphonso-mango"',
        },
      },
      required: ["product_slug"],
    },
  },
  {
    name: "get_user_orders",
    description:
      "Get the signed-in user's 5 most recent orders with status, items, and dates. " +
      "Use this when the user asks 'where is my order', 'what did I buy', 'my orders', etc. " +
      "Only works for signed-in users — anonymous users get a 'not signed in' response.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "get_order_details",
    description:
      "Get detailed status for a specific order, identified by its order number. " +
      "Returns tracking ID, current status, payment status, items, delivery address (city/district only), " +
      "and per-status timestamps (confirmed, shipped, delivered). " +
      "Only works for the signed-in user's OWN orders.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        order_number: {
          type: Type.NUMBER,
          description: "The order number shown to the user (e.g. 1001, 1002). NOT the tracking ID.",
        },
      },
      required: ["order_number"],
    },
  },
];

// ─── Tool executor ───────────────────────────────────────────────────────────

/**
 * Executes a tool call by name. Returns a JSON-serializable result object
 * that gets sent back to Gemini.
 *
 * @param name - The function name (matches AI_TOOL_DECLARATIONS[].name)
 * @param args - The arguments object Gemini provided
 * @param userId - The signed-in user's Clerk ID (null for anonymous).
 *                Used by get_user_orders + get_order_details for privacy.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  userId: string | null,
): Promise<unknown> {
  try {
    switch (name) {
      case "search_catalog":
        return await searchCatalog(args);
      case "get_product_care":
        return await getProductCare(args);
      case "get_user_orders":
        return await getUserOrders(userId);
      case "get_order_details":
        return await getOrderDetails(args, userId);
      default:
        logger.warn({ name }, "AI tool: unknown function called");
        return { error: `Unknown function: ${name}` };
    }
  } catch (err) {
    logger.error({ err, name, args }, "AI tool: execution failed");
    return { error: "Tool execution failed. Try answering without this data." };
  }
}

// ─── Tool implementations ────────────────────────────────────────────────────

interface CatalogResult {
  slug: string;
  name: string;
  scientific_name: string | null;
  description: string | null;
  sunlight: string | null;
  watering: string | null;
  mature_height: string | null;
  product_status: string | null;
  min_price: number | null;
  image: string | null;
}

async function searchCatalog(args: Record<string, unknown>): Promise<{
  results: CatalogResult[];
  count: number;
}> {
  const query = String(args.query ?? "").trim();
  if (!query) return { results: [], count: 0 };

  const maxPrice = typeof args.max_price === "number" ? args.max_price : null;
  const sunlight = typeof args.sunlight === "string" ? args.sunlight : null;

  // Build ILIKE conditions from query tokens (same approach as buildCatalogContext
  // but with optional price/sunlight filters).
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 5);

  if (tokens.length === 0) return { results: [], count: 0 };

  const conditions: string[] = [];
  const params: unknown[] = [];
  for (const t of tokens) {
    params.push(`%${t}%`);
    conditions.push(
      `(p.name ILIKE $${params.length} OR p.scientific_name ILIKE $${params.length} OR p.description ILIKE $${params.length})`,
    );
  }
  let where = conditions.join(" OR ");

  if (sunlight) {
    params.push(sunlight);
    where += ` AND p.sunlight = $${params.length}`;
  }

  // Always join to prices so we can return min_price in the result (useful
  // for the AI to mention a price range even when the user didn't filter on it).
  // We only filter on it when maxPrice is provided.
  const priceJoin =
    "LEFT JOIN (SELECT product_id, MIN(price) AS min_price FROM seller_listings sl JOIN seller_listing_variants slv ON slv.seller_listing_id = sl.id WHERE sl.is_active = true AND sl.deleted_at IS NULL GROUP BY product_id) AS prices ON prices.product_id = p.id";

  let priceWhere = "";
  if (maxPrice != null) {
    params.push(maxPrice);
    priceWhere = ` AND (prices.min_price IS NULL OR prices.min_price <= $${params.length})`;
  }

  const result = await pool.query<CatalogResult>(
    `SELECT
       p.slug,
       p.name,
       p.scientific_name,
       p.description,
       p.sunlight,
       p.watering,
       p.mature_height,
       p.product_status,
       prices.min_price,
       (p.images::jsonb->0->>'url') AS image
     FROM products p
     ${priceJoin}
     WHERE p.deleted_at IS NULL AND (${where})${priceWhere}
     ORDER BY
       CASE WHEN p.name ILIKE $${params.length + 1} THEN 0 ELSE 1 END,
       p.created_at DESC
     LIMIT 8`,
    [...params, `%${tokens[0]}%`],
  );

  return {
    results: result.rows.map((r) => ({
      ...r,
      description: r.description ? r.description.slice(0, 150) : null,
    })),
    count: result.rows.length,
  };
}

async function getProductCare(args: Record<string, unknown>): Promise<{
  product: unknown | null;
  error?: string;
}> {
  const slug = String(args.product_slug ?? "").trim();
  if (!slug) return { product: null };

  const result = await pool.query(
    `SELECT
       name, slug, scientific_name, description,
       sunlight, watering, soil_type, mature_height, climate_zone,
       growth_rate, bloom_season,
       key_benefits, best_for, care_tips,
       images, product_status
     FROM products
     WHERE slug = $1 AND deleted_at IS NULL`,
    [slug],
  );

  if (result.rows.length === 0) {
    return { product: null, error: "Product not found." };
  }
  return { product: result.rows[0] };
}

async function getUserOrders(userId: string | null): Promise<{
  signed_in: boolean;
  orders: unknown[];
  message?: string;
}> {
  if (!userId) {
    return {
      signed_in: false,
      orders: [],
      message: "User is not signed in. Ask them to sign in to view their orders.",
    };
  }

  const result = await pool.query(
    `SELECT
       order_number,
       tracking_id,
       order_status,
       payment_status,
       total_amount::text,
       created_at,
       delivered_at,
       items,
       (shipping_address->>'city')::text AS city,
       (shipping_address->>'district')::text AS district
     FROM orders
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 5`,
    [userId],
  );

  return {
    signed_in: true,
    orders: result.rows.map((r) => ({
      order_number: r.order_number,
      tracking_id: r.tracking_id,
      status: r.order_status,
      payment_status: r.payment_status,
      total: r.total_amount,
      date:
        r.created_at instanceof Date
          ? r.created_at.toISOString().slice(0, 10)
          : String(r.created_at).slice(0, 10),
      delivered: r.delivered_at instanceof Date ? r.delivered_at.toISOString().slice(0, 10) : null,
      items: (r.items as { productName: string; quantity: number }[])?.map(
        (i) => `${i.quantity}× ${i.productName}`,
      ),
      location: [r.city, r.district].filter(Boolean).join(", ") || null,
    })),
  };
}

async function getOrderDetails(
  args: Record<string, unknown>,
  userId: string | null,
): Promise<{ order: unknown | null; error?: string; signed_in?: boolean; message?: string }> {
  const orderNumber = Number(args.order_number);
  if (!Number.isFinite(orderNumber)) {
    return { order: null, error: "Invalid order number." };
  }
  if (!userId) {
    return {
      order: null,
      signed_in: false,
      message: "User is not signed in. Ask them to sign in to view order details.",
    };
  }

  const result = await pool.query(
    `SELECT
       order_number,
       tracking_id,
       order_status,
       payment_status,
       total_amount::text,
       payment_method,
       created_at,
       confirmed_at,
       shipped_at,
       delivered_at,
       cancelled_at,
       items,
       (shipping_address->>'city')::text AS city,
       (shipping_address->>'district')::text AS district
     FROM orders
     WHERE user_id = $1 AND order_number = $2`,
    [userId, orderNumber],
  );

  if (result.rows.length === 0) {
    return {
      order: null,
      error: `Order #${orderNumber} not found in your account. Check the order number and try again.`,
    };
  }

  const r = result.rows[0];
  return {
    order: {
      order_number: r.order_number,
      tracking_id: r.tracking_id,
      status: r.order_status,
      payment_status: r.payment_status,
      payment_method: r.payment_method,
      total: r.total_amount,
      placed_at:
        r.created_at instanceof Date
          ? r.created_at.toISOString().slice(0, 10)
          : String(r.created_at).slice(0, 10),
      confirmed_at:
        r.confirmed_at instanceof Date ? r.confirmed_at.toISOString().slice(0, 10) : null,
      shipped_at: r.shipped_at instanceof Date ? r.shipped_at.toISOString().slice(0, 10) : null,
      delivered_at:
        r.delivered_at instanceof Date ? r.delivered_at.toISOString().slice(0, 10) : null,
      cancelled_at:
        r.cancelled_at instanceof Date ? r.cancelled_at.toISOString().slice(0, 10) : null,
      items: (r.items as { productName: string; quantity: number; price: number }[])?.map((i) => ({
        name: i.productName,
        qty: i.quantity,
        price: i.price,
      })),
      location: [r.city, r.district].filter(Boolean).join(", ") || null,
    },
  };
}
