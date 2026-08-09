/**
 * Hand-written Zod schemas for routes that the OpenAPI spec doesn't yet cover.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 *
 * `@workspace/api-zod` ships orval-generated schemas for 40+ request bodies,
 * but several routes predate the OpenAPI spec or were never added to it:
 * newsletter, push, preOrders, returns, subscriptions (PATCH), mobileAuth,
 * emailPreferences, etc.
 *
 * Rather than leave these on `req.body as any` (the prior pattern, which
 * loses the `.strict()` mass-assignment defense), we define minimal Zod
 * schemas here. When the OpenAPI spec is later extended to cover these
 * routes, the generated schemas should replace these and this file should
 * shrink.
 *
 * ─── Conventions ────────────────────────────────────────────────────────────
 *
 *  • Every schema is `z.object({...}).strict()` — the `.strict()` is applied
 *    by `validateBody()` at the call site, so just declare the shape.
 *  • Names match the route they validate: `NewsletterSubscribeBody`,
 *    `CreatePreOrderBody`, etc. — so they slot into the existing naming
 *    convention used by `@workspace/api-zod`.
 *  • Use `z.string().email()` for emails, `z.string().min(1)` for required
 *    strings, `z.coerce.number().int().positive()` for IDs.
 */

import { z } from "zod";

// ─── Newsletter ──────────────────────────────────────────────────────────────
export const NewsletterSubscribeBody = z.object({
  email: z.string().email(),
});
export const NewsletterUnsubscribeBody = z.object({
  email: z.string().email(),
});

// ─── Push notifications ──────────────────────────────────────────────────────
export const PushSubscribeBody = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export const PushUnsubscribeBody = z.object({
  endpoint: z.string().min(1),
});

// ─── Pre-orders ──────────────────────────────────────────────────────────────
const PreOrderAddressSchema = z.object({
  fullName: z.string().min(1).max(200),
  phone: z.string().min(6).max(20),
  street: z.string().min(1).max(500),
  city: z.string().min(1).max(100),
  district: z.string().min(1).max(100),
  postalCode: z.string().max(20).optional(),
});
export const CreatePreOrderBody = z.object({
  productId: z.coerce.number().int().positive(),
  sellerListingVariantId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive().default(1),
  shippingAddress: PreOrderAddressSchema,
  paymentMethod: z.enum(["cod", "bkash"]).default("bkash"),
  senderNumber: z.string().max(20).nullable().optional(),
  transactionId: z.string().max(100).nullable().optional(),
  whatsappPhone: z.string().max(20).nullable().optional(),
});
export const UpdatePreOrderStatusBody = z.object({
  status: z.enum(["pending", "confirmed", "arrived_in_bd", "shipped", "delivered", "cancelled"]),
  cancellationReason: z.string().max(500).optional(),
});

// ─── Returns ─────────────────────────────────────────────────────────────────
export const CreateReturnBody = z.object({
  orderId: z.coerce.number().int().positive(),
  reason: z.string().min(10).max(2000),
});
export const UpdateReturnBody = z.object({
  status: z.enum(["requested", "approved", "rejected", "completed"]),
  adminNote: z.string().max(2000).nullish(),
  refundAmount: z.union([z.coerce.number().nonnegative(), z.string()]).nullish(),
});

// ─── Subscriptions ───────────────────────────────────────────────────────────
//
// CRITICAL: `items[].price` is INTENTIONALLY omitted from the request schema.
// The server looks up the real price from `productsTable` and applies the
// subscription discount server-side. Accepting a client-sent price was a
// price-manipulation vulnerability (H-1 in the security audit) — a buyer
// could submit `{"items":[{"productId":1,"price":0.01}]}` and get a
// subscription at a fraction of the real cost.
//
export const SubscriptionAddressSchema = z.object({
  fullName: z.string().min(1).max(200),
  phone: z.string().min(6).max(20),
  street: z.string().min(1).max(500),
  city: z.string().min(1).max(100),
  district: z.string().min(1).max(100),
  postalCode: z.string().max(20).optional(),
});
export const CreateSubscriptionBody = z.object({
  items: z.array(z.object({
    productId: z.coerce.number().int().positive(),
    quantity: z.coerce.number().int().positive().default(1),
    // `price` is deliberately NOT accepted — see comment above.
  })).min(1),
  frequency: z.enum(["weekly", "biweekly", "monthly"]),
  shippingAddress: SubscriptionAddressSchema,
  paymentMethod: z.enum(["cod", "bkash"]).default("cod"),
  notes: z.string().max(2000).optional(),
});
export const UpdateSubscriptionBody = z.object({
  status: z.enum(["active", "paused", "cancelled"]).optional(),
  frequency: z.enum(["weekly", "biweekly", "monthly"]).optional(),
  shippingAddress: SubscriptionAddressSchema.optional(),
  notes: z.string().max(2000).nullable().optional(),
});

// ─── Mobile auth ─────────────────────────────────────────────────────────────
export const MobileSignInBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export const MobileSignUpBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100).optional(),
  phone: z.string().min(6).max(20).optional(),
});
export const MobileRefreshBody = z.object({
  refreshToken: z.string().min(1),
});

// ─── Email preferences ───────────────────────────────────────────────────────
export const UpdateEmailPreferencesBody = z.object({
  orderUpdates: z.boolean().optional(),
  promotions: z.boolean().optional(),
  restockAlerts: z.boolean().optional(),
  newsletter: z.boolean().optional(),
  abandonedCart: z.boolean().optional(),
  loyaltyUpdates: z.boolean().optional(),
});

// ─── Seller verification doc upload (metadata) ───────────────────────────────
export const SellerVerificationMetadataBody = z.object({
  docType: z.enum(["nid", "trade_license", "passport", "drivers_license"]),
  docNumber: z.string().min(1).max(100),
});

// ─── Order cancellation ──────────────────────────────────────────────────────
export const CancelOrderBody = z.object({
  reason: z.string().min(3).max(500),
});

// ─── Generic ID param ─────────────────────────────────────────────────────────
export const IdParam = z.object({
  id: z.coerce.number().int().positive(),
});

// ─── Gift cards ──────────────────────────────────────────────────────────────
export const PurchaseGiftCardBody = z.object({
  amount: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  recipientEmail: z.string().email().nullish(),
  recipientName: z.string().max(200).nullish(),
  message: z.string().max(1000).nullish(),
  expiryDays: z.coerce.number().int().positive().max(3650).optional(),
});
export const RedeemGiftCardBody = z.object({
  code: z.string().min(1).max(50),
  amount: z.union([z.number(), z.string()]).transform((v) => Number(v)),
});
export const IssueGiftCardBody = z.object({
  amount: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  recipientEmail: z.string().email().nullish(),
  recipientName: z.string().max(200).nullish(),
  message: z.string().max(1000).nullish(),
});

// ─── Referrals ───────────────────────────────────────────────────────────────
export const RedeemReferralBody = z.object({
  code: z.string().min(1).max(50),
});

// ─── Blog posts ──────────────────────────────────────────────────────────────
export const CreateBlogPostBody = z.object({
  slug: z.string().min(1).max(300),
  title: z.string().min(1).max(300),
  excerpt: z.string().max(1000).optional(),
  content: z.string(),
  category: z.string().max(100).optional(),
  readTime: z.union([z.coerce.number().int().positive().max(600), z.string()]).optional(),
  image: z.string().url().nullish(),
  featured: z.boolean().optional(),
  publishedAt: z.string().datetime().nullish(),
  linkedProductIds: z.array(z.coerce.number().int().positive()).max(3).optional(),
});
export const UpdateBlogPostBody = z.object({
  slug: z.string().min(1).max(300).optional(),
  title: z.string().min(1).max(300).optional(),
  excerpt: z.string().max(1000).nullish(),
  content: z.string().optional(),
  category: z.string().max(100).nullish(),
  readTime: z.union([z.coerce.number().int().positive().max(600), z.string()]).nullish(),
  image: z.string().url().nullish(),
  featured: z.boolean().optional(),
  publishedAt: z.string().datetime().nullish(),
  linkedProductIds: z.array(z.coerce.number().int().positive()).max(3).nullish(),
});

// ─── Bulk import (CSV upload metadata) ───────────────────────────────────────
export const BulkImportBody = z.object({
  csv: z.string().min(1),
});

// ─── Guest checkout ──────────────────────────────────────────────────────────
//
// This is the body for POST /orders/guest. Unlike the authenticated
// /orders route, this doesn't use the generated CreateOrderBody schema
// (which is typed for authenticated checkout with cart items). Guest
// checkout sends items inline.
//
const GuestOrderAddressSchema = z.object({
  fullName: z.string().min(1).max(200),
  phone: z.string().min(6).max(20),
  street: z.string().min(1).max(500),
  city: z.string().min(1).max(100),
  district: z.string().min(1).max(100),
  postalCode: z.string().max(20).optional(),
});
const GuestOrderItemSchema = z.object({
  productId: z.coerce.number().int().positive(),
  variantId: z.coerce.number().int().positive().nullish(),
  sellerListingVariantId: z.coerce.number().int().positive().nullish(),
  quantity: z.coerce.number().int().positive().default(1),
}).refine(
  (data) => (data.variantId != null) !== (data.sellerListingVariantId != null),
  { message: "Specify either variantId or sellerListingVariantId, not both" },
);
export const CreateGuestOrderBody = z.object({
  paymentMethod: z.enum(["cod", "bkash"]),
  transactionId: z.string().max(100).nullish(),
  senderNumber: z.string().max(20).nullish(),
  shippingAddress: GuestOrderAddressSchema,
  items: z.array(GuestOrderItemSchema).min(1),
  couponCode: z.string().max(50).nullish(),
  giftWrap: z.string().max(500).nullish(),
  giftMessage: z.string().max(500).nullish(),
});
