/**
 * User context builder for the TreeBot assistant (v2.0).
 *
 * When the user is signed in (Clerk), we fetch their:
 *   - 5 most recent orders (status, items, tracking, dates)
 *   - 5 most recent wishlist items (product name + category)
 *
 * And inject this as plain text into the system prompt so the AI can
 * answer questions like:
 *   - "Where's my mango tree?" → look up orders with "mango" → return tracking
 *   - "What plants have I bought?" → list past orders
 *   - "Recommend something similar to my last purchase" → look at last
 *     order's product category → suggest similar from catalog context
 *
 * Privacy considerations:
 *   - We do NOT expose addresses, phone numbers, payment info, or emails.
 *   - Only the city/district is included (for shipping ETA context).
 *   - The user context block is only built when req.userId is set (signed
 *     in). Anonymous users get no user context — they're treated as v1.
 *
 * Performance:
 *   - Two parallel queries (orders + wishlist). Each is capped (LIMIT 5)
 *     and indexed. Total added latency: <50ms typical.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";

// ─── Types ───────────────────────────────────────────────────────────────────

interface OrderRow {
  order_number: number | null;
  tracking_id: string;
  order_status: string;
  payment_status: string;
  total_amount: string;
  created_at: Date;
  delivered_at: Date | null;
  items: Array<{
    productName: string;
    quantity: number;
    price: number;
  }>;
  city: string | null;
  district: string | null;
}

interface WishlistRow {
  product_name: string;
  product_slug: string;
  category_name: string | null;
}

// ─── Public functions ────────────────────────────────────────────────────────

/**
 * Fetches the signed-in user's recent orders and wishlist, formatted as
 * a plain-text block ready to inject into the system prompt.
 *
 * Returns an empty string if:
 *   - userId is null/undefined (anonymous user)
 *   - The user has no orders AND no wishlist
 *   - An error occurs (we never fail the chat request over context)
 *
 * @param clerkUserId - The Clerk user ID (req.userId from auth middleware)
 */
export async function buildUserContext(clerkUserId: string | undefined): Promise<string> {
  if (!clerkUserId) return "";

  try {
    const [orders, wishlist] = await Promise.all([
      fetchRecentOrders(clerkUserId),
      fetchWishlist(clerkUserId),
    ]);

    if (orders.length === 0 && wishlist.length === 0) return "";

    const lines: string[] = [];
    lines.push("USER CONTEXT (the user is signed in — use this to answer personal questions):");

    if (orders.length > 0) {
      lines.push("Recent orders (newest first):");
      for (const o of orders) {
        const date = o.created_at instanceof Date
          ? o.created_at.toISOString().slice(0, 10)
          : String(o.created_at).slice(0, 10);
        const items = o.items
          .map((i) => `${i.quantity}× ${i.productName}`)
          .join(", ");
        const location = o.city || o.district
          ? ` (${[o.city, o.district].filter(Boolean).join(", ")})`
          : "";
        const delivery = o.delivered_at
          ? `delivered ${o.delivered_at.toISOString().slice(0, 10)}`
          : `status: ${o.order_status}`;
        lines.push(
          `  - Order #${o.order_number ?? o.tracking_id.slice(0, 8)} (${date}): ` +
            `${items} — ${o.payment_status}, ${delivery}${location}`,
        );
      }
    }

    if (wishlist.length > 0) {
      lines.push("Wishlist:");
      for (const w of wishlist) {
        lines.push(
          `  - ${w.product_name}${w.category_name ? ` (${w.category_name})` : ""}`,
        );
      }
    }

    lines.push(
      "RULES FOR USER CONTEXT:",
      "- Use this to answer 'where is my order' / 'what did I buy' / 'recommend similar' questions.",
      "- Reference orders by their #number when the user asks about a specific one.",
      "- For 'where is my order': if any order is pending/shipped, summarize its status.",
      "- For recommendations: look at the user's past purchases, suggest similar plants from CATALOG CONTEXT.",
      "- NEVER expose phone numbers, full addresses, or payment method details.",
    );

    return lines.join("\n");
  } catch (err) {
    // Don't crash the chat request — just answer without user context.
    logger.error({ err, clerkUserId }, "AI user context builder: query failed");
    return "";
  }
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function fetchRecentOrders(clerkUserId: string): Promise<OrderRow[]> {
  // orders.userId is the Clerk ID. items is a JSONB column with the line items.
  // We pull the 5 most recent orders.
  const result = await pool.query<OrderRow>(
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
    [clerkUserId],
  );
  return result.rows;
}

async function fetchWishlist(clerkUserId: string): Promise<WishlistRow[]> {
  // wishlist joins to products + categories. We pull the 5 most recent.
  const result = await pool.query<WishlistRow>(
    `SELECT
       p.name AS product_name,
       p.slug AS product_slug,
       c.name AS category_name
     FROM wishlist w
     JOIN products p ON p.id = w.product_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE w.user_id = $1
     ORDER BY w.created_at DESC
     LIMIT 5`,
    [clerkUserId],
  );
  return result.rows;
}
