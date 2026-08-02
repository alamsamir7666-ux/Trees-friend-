import { Router } from "express";
import multerPkg from "multer";
import { v2 as cloudinaryV2 } from "cloudinary";
import { db } from "@workspace/db";
import {
  conversationsTable,
  messagesTable,
  sellersTable,
  sellerListingsTable,
  productsTable,
  sellerListingVariantsTable,
  usersTable,
  ALLOWED_CHAT_ATTACHMENT_MIME_TYPES,
  MAX_CHAT_ATTACHMENT_BYTES,
} from "@workspace/db";
import { eq, and, desc, sql, lt, gt } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { logger } from "../lib/logger";

/**
 * Normalize any thrown value (Error, string, object, unknown) into a string
 * suitable for both structured logging and (in non-production) the JSON
 * response body. Without this, thrown non-Error values serialize to `{}`,
 * which is exactly what was producing the empty `Error {}` in the browser
 * console for the /conversations 500.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

cloudinaryV2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Memory storage so we can pipe straight to Cloudinary without touching disk.
// 10MB hard cap matches MAX_CHAT_ATTACHMENT_BYTES; multer enforces it before
// the request body is fully buffered, preventing memory-exhaustion attacks.
const uploadStorage = multerPkg.memoryStorage();
const uploadMiddleware = multerPkg({
  storage: uploadStorage,
  limits: { fileSize: MAX_CHAT_ATTACHMENT_BYTES },
});

const router = Router();

// ─── Types ─────────────────────────────────────────────────────────────────

interface ConversationResponse {
  id: number;
  sellerId: number;
  sellerName: string;
  sellerLogoUrl: string | null;
  sellerIsVerified: boolean;
  sellerListingId: number | null;
  productName: string | null;
  productImage: string | null;
  productPrice: number | null;
  lastMessage: string | null;
  lastMessageAt: string;
  unreadCount: number;
  createdAt: string;
}

interface MessageResponse {
  id: number;
  conversationId: number;
  senderId: string;
  content: string;
  messageType: string;
  imageUrl: string | null;
  fileUrl: string | null;
  fileName: string | null;
  fileSize: number | null;
  fileMimeType: string | null;
  attachmentType: string | null;
  readByBuyer: boolean;
  readBySeller: boolean;
  createdAt: string;
}

// ─── Attachment helpers ────────────────────────────────────────────────────

/**
 * Normalize an arbitrary MIME type into one of the UI-branchable buckets:
 *   "image" | "video" | "audio" | "document"
 *
 * The UI uses this to decide between an inline preview (image/video), a
 * inline audio player, or a generic file chip with a download button.
 * Anything we don't recognize is treated as a document download — never
 * inline-rendered, so we never accidentally execute or stream unknown
 * content.
 */
function classifyAttachment(mimeType: string | null): "image" | "video" | "audio" | "document" {
  if (!mimeType) return "document";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * Map a MIME type to a Cloudinary resource_type so the upload pipeline
 * picks the correct storage/optimization path. Cloudinary treats "image",
 * "video" (covers video + audio), and "raw" (everything else: PDFs, docs).
 */
function cloudinaryResourceType(mimeType: string | null): "image" | "video" | "raw" {
  const kind = classifyAttachment(mimeType);
  if (kind === "image") return "image";
  if (kind === "video" || kind === "audio") return "video";
  return "raw";
}

function isAllowedAttachment(mimeType: string | null): boolean {
  if (!mimeType) return false;
  return (ALLOWED_CHAT_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * Produce a human-friendly preview string for the conversation list.
 * Attachment-only messages ("📷 Photo", "📎 invoice.pdf") are far more
 * useful in the list than an empty string or the raw URL.
 */
function previewMessageText(m: typeof messagesTable.$inferSelect | undefined): string | null {
  if (!m) return null;
  if (m.content && m.content.trim().length > 0) return m.content.trim();
  switch (m.attachmentType) {
    case "image":
      return "📷 Photo";
    case "video":
      return "📹 Video";
    case "audio":
      return "🔊 Audio";
    case "document":
      return m.fileName ? `📎 ${m.fileName}` : "📎 File";
    default:
      // Legacy image messages without attachment_type backfill
      if (m.messageType === "image" && m.imageUrl) return "📷 Photo";
      return null;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatMessage(m: typeof messagesTable.$inferSelect): MessageResponse {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    content: m.content,
    messageType: m.messageType,
    imageUrl: m.imageUrl,
    fileUrl: m.fileUrl,
    fileName: m.fileName,
    fileSize: m.fileSize ?? null,
    fileMimeType: m.fileMimeType,
    attachmentType: m.attachmentType,
    readByBuyer: m.readByBuyer,
    readBySeller: m.readBySeller,
    createdAt: m.createdAt.toISOString(),
  };
}

// ─── GET /conversations ────────────────────────────────────────────────────
// List all conversations for the authenticated user (as buyer or seller).
// Sorted by lastMessageAt descending (most recent first).
router.get("/conversations", requireAuth, async (req: any, res) => {
  try {
    const userId = req.userId;

    // Check if the user is a seller
    const [seller] = await db
      .select({ id: sellersTable.id })
      .from(sellersTable)
      .where(eq(sellersTable.userId, req.dbUser.id))
      .limit(1);

    const isSeller = !!seller;
    const sellerId = seller?.id;

    // Fetch conversations as buyer
    const buyerConversations = await db
      .select({
        conv: conversationsTable,
        seller: sellersTable,
      })
      .from(conversationsTable)
      .innerJoin(sellersTable, eq(conversationsTable.sellerId, sellersTable.id))
      .where(
        and(
          eq(conversationsTable.buyerId, userId),
          eq(conversationsTable.buyerArchived, false),
        )
      )
      .orderBy(desc(conversationsTable.lastMessageAt));

    // Fetch conversations as seller (if applicable)
    const sellerConversations = isSeller
      ? await db
          .select({
            conv: conversationsTable,
            buyer: usersTable,
          })
          .from(conversationsTable)
          .innerJoin(usersTable, eq(conversationsTable.buyerId, usersTable.clerkId))
          .where(
            and(
              eq(conversationsTable.sellerId, sellerId!),
              eq(conversationsTable.sellerArchived, false),
            )
          )
          .orderBy(desc(conversationsTable.lastMessageAt))
      : [];

    // Build response for buyer conversations
    const buyerResults: ConversationResponse[] = await Promise.all(
      buyerConversations.map(async ({ conv, seller: s }) => {
        // Get last message
        const [lastMsg] = await db
          .select()
          .from(messagesTable)
          .where(eq(messagesTable.conversationId, conv.id))
          .orderBy(desc(messagesTable.createdAt))
          .limit(1);

        // Get unread count
        const [unreadRow] = await db
          .select({ count: sql<string>`COUNT(*)` })
          .from(messagesTable)
          .where(
            and(
              eq(messagesTable.conversationId, conv.id),
              eq(messagesTable.readByBuyer, false),
              sql`${messagesTable.senderId} != ${userId}`,
            )
          );

        // Get product info if linked
        let productName: string | null = null;
        let productImage: string | null = null;
        let productPrice: number | null = null;

        if (conv.sellerListingId) {
          const [listing] = await db
            .select({
              product: productsTable,
              variant: sellerListingVariantsTable,
            })
            .from(sellerListingsTable)
            .innerJoin(productsTable, eq(sellerListingsTable.productId, productsTable.id))
            .leftJoin(
              sellerListingVariantsTable,
              eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id),
            )
            .where(eq(sellerListingsTable.id, conv.sellerListingId))
            .limit(1);

          if (listing) {
            productName = listing.product.name;
            productImage = listing.product.images?.[0] ?? null;
            productPrice = listing.variant
              ? Number(listing.variant.discountPrice ?? listing.variant.price)
              : null;
          }
        }

        return {
          id: conv.id,
          sellerId: s.id,
          sellerName: s.nurseryName,
          sellerLogoUrl: s.logoUrl,
          sellerIsVerified: s.isVerified,
          sellerListingId: conv.sellerListingId,
          productName,
          productImage,
          productPrice,
          lastMessage: previewMessageText(lastMsg),
          lastMessageAt: conv.lastMessageAt.toISOString(),
          unreadCount: Number(unreadRow?.count ?? 0),
          createdAt: conv.createdAt.toISOString(),
        };
      }),
    );

    // Build response for seller conversations
    const sellerResults: ConversationResponse[] = await Promise.all(
      sellerConversations.map(async ({ conv, buyer: b }) => {
        const [lastMsg] = await db
          .select()
          .from(messagesTable)
          .where(eq(messagesTable.conversationId, conv.id))
          .orderBy(desc(messagesTable.createdAt))
          .limit(1);

        const [unreadRow] = await db
          .select({ count: sql<string>`COUNT(*)` })
          .from(messagesTable)
          .where(
            and(
              eq(messagesTable.conversationId, conv.id),
              eq(messagesTable.readBySeller, false),
              sql`${messagesTable.senderId} != ${userId}`,
            )
          );

        let productName: string | null = null;
        let productImage: string | null = null;
        let productPrice: number | null = null;

        if (conv.sellerListingId) {
          const [listing] = await db
            .select({
              product: productsTable,
              variant: sellerListingVariantsTable,
            })
            .from(sellerListingsTable)
            .innerJoin(productsTable, eq(sellerListingsTable.productId, productsTable.id))
            .leftJoin(
              sellerListingVariantsTable,
              eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id),
            )
            .where(eq(sellerListingsTable.id, conv.sellerListingId))
            .limit(1);

          if (listing) {
            productName = listing.product.name;
            productImage = listing.product.images?.[0] ?? null;
            productPrice = listing.variant
              ? Number(listing.variant.discountPrice ?? listing.variant.price)
              : null;
          }
        }

        return {
          id: conv.id,
          sellerId: conv.sellerId,
          sellerName: b.firstName
            ? `${b.firstName} ${b.lastName ?? ""}`.trim()
            : b.email,
          sellerLogoUrl: null,
          sellerIsVerified: false,
          sellerListingId: conv.sellerListingId,
          productName,
          productImage,
          productPrice,
          lastMessage: previewMessageText(lastMsg),
          lastMessageAt: conv.lastMessageAt.toISOString(),
          unreadCount: Number(unreadRow?.count ?? 0),
          createdAt: conv.createdAt.toISOString(),
        };
      }),
    );

    res.json({
      buyerConversations: buyerResults,
      sellerConversations: sellerResults,
    });
  } catch (err) {
    const detail = describeError(err);
    logger.error({ err, detail }, "List conversations error");
    res.status(500).json({
      error: "Failed to fetch conversations",
      // Include detail in non-production so the client can surface it for
      // debugging. In production we hide internals to avoid leaking schema.
      detail: process.env.NODE_ENV === "production" ? undefined : detail,
    });
  }
});

// ─── POST /conversations ───────────────────────────────────────────────────
// Create or retrieve a conversation with a seller. Idempotent — if a
// conversation already exists for this buyer-seller pair, returns it
// instead of creating a duplicate. This is the standard pattern used by
// marketplaces (eBay, Etsy, Daraz) to avoid duplicate threads.
router.post("/conversations", requireAuth, async (req: any, res) => {
  try {
    const { sellerId, sellerListingId } = req.body;
    const buyerId = req.userId;

    if (!sellerId || isNaN(parseInt(sellerId))) {
      res.status(400).json({ error: "sellerId is required" });
      return;
    }

    const parsedSellerId = parseInt(sellerId);

    // Verify seller exists and is active
    const [seller] = await db
      .select({ id: sellersTable.id })
      .from(sellersTable)
      .where(and(eq(sellersTable.id, parsedSellerId), eq(sellersTable.status, "active")))
      .limit(1);

    if (!seller) {
      res.status(404).json({ error: "Seller not found" });
      return;
    }

    // Prevent seller from messaging themselves
    const [sellerUser] = await db
      .select({ userId: sellersTable.userId })
      .from(sellersTable)
      .where(eq(sellersTable.id, parsedSellerId))
      .limit(1);

    if (sellerUser && sellerUser.userId === req.dbUser.id) {
      res.status(400).json({ error: "Cannot message yourself" });
      return;
    }

    // Check if conversation already exists
    const [existing] = await db
      .select()
      .from(conversationsTable)
      .where(
        and(
          eq(conversationsTable.buyerId, buyerId),
          eq(conversationsTable.sellerId, parsedSellerId),
        ),
      )
      .limit(1);

    let conversation;

    if (existing) {
      // Update sellerListingId if provided and different
      if (sellerListingId && existing.sellerListingId !== sellerListingId) {
        const [updated] = await db
          .update(conversationsTable)
          .set({
            sellerListingId: sellerListingId ?? existing.sellerListingId,
            updatedAt: new Date(),
          })
          .where(eq(conversationsTable.id, existing.id))
          .returning();
        conversation = updated;
      } else {
        conversation = existing;
      }
    } else {
      // Create new conversation
      const [created] = await db
        .insert(conversationsTable)
        .values({
          buyerId,
          sellerId: parsedSellerId,
          sellerListingId: sellerListingId ?? null,
        })
        .returning();
      conversation = created;
    }

    // Get seller info for the response
    const [sellerInfo] = await db
      .select()
      .from(sellersTable)
      .where(eq(sellersTable.id, parsedSellerId))
      .limit(1);

    // Get product info if linked
    let productName: string | null = null;
    let productImage: string | null = null;
    let productPrice: number | null = null;

    if (conversation.sellerListingId) {
      const [listing] = await db
        .select({
          product: productsTable,
          variant: sellerListingVariantsTable,
        })
        .from(sellerListingsTable)
        .innerJoin(productsTable, eq(sellerListingsTable.productId, productsTable.id))
        .leftJoin(
          sellerListingVariantsTable,
          eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id),
        )
        .where(eq(sellerListingsTable.id, conversation.sellerListingId))
        .limit(1);

      if (listing) {
        productName = listing.product.name;
        productImage = listing.product.images?.[0] ?? null;
        productPrice = listing.variant
          ? Number(listing.variant.discountPrice ?? listing.variant.price)
          : null;
      }
    }

    res.json({
      id: conversation.id,
      sellerId: parsedSellerId,
      sellerName: sellerInfo?.nurseryName ?? "",
      sellerLogoUrl: sellerInfo?.logoUrl ?? null,
      sellerIsVerified: sellerInfo?.isVerified ?? false,
      sellerListingId: conversation.sellerListingId,
      productName,
      productImage,
      productPrice,
      lastMessageAt: conversation.lastMessageAt.toISOString(),
      createdAt: conversation.createdAt.toISOString(),
    });
  } catch (err) {
    const detail = describeError(err);
    logger.error({ err, detail }, "Create conversation error");
    res.status(500).json({
      error: "Failed to create conversation",
      detail: process.env.NODE_ENV === "production" ? undefined : detail,
    });
  }
});

// ─── GET /conversations/:id ────────────────────────────────────────────────
// Get a single conversation with full metadata.
router.get("/conversations/:id", requireAuth, async (req: any, res) => {
  try {
    const convId = parseInt(req.params.id);
    if (isNaN(convId)) {
      res.status(400).json({ error: "Invalid conversation id" });
      return;
    }

    const [conv] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.id, convId))
      .limit(1);

    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    // Verify the user is a participant (buyer or seller)
    const [seller] = await db
      .select({ id: sellersTable.id })
      .from(sellersTable)
      .where(eq(sellersTable.userId, req.dbUser.id))
      .limit(1);

    const isBuyer = conv.buyerId === req.userId;
    const isSellerParticipant = seller?.id === conv.sellerId;

    if (!isBuyer && !isSellerParticipant) {
      res.status(403).json({ error: "Not a participant in this conversation" });
      return;
    }

    // Get seller info
    const [sellerInfo] = await db
      .select()
      .from(sellersTable)
      .where(eq(sellersTable.id, conv.sellerId))
      .limit(1);

    // The "other party" in this conversation depends on who's viewing it:
    // a buyer sees the seller's store name; a seller sees the buyer's name.
    // (See GET /conversations above, where buyerResults/sellerResults already
    // split this correctly for the list view — this mirrors that here.)
    let displayName: string;
    let displayAvatarUrl: string | null;
    let displayIsVerified: boolean;

    if (isSellerParticipant) {
      const [buyerInfo] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.clerkId, conv.buyerId))
        .limit(1);
      displayName = buyerInfo?.firstName
        ? `${buyerInfo.firstName} ${buyerInfo.lastName ?? ""}`.trim()
        : buyerInfo?.email ?? "Buyer";
      displayAvatarUrl = null;
      displayIsVerified = false;
    } else {
      displayName = sellerInfo?.nurseryName ?? "";
      displayAvatarUrl = sellerInfo?.logoUrl ?? null;
      displayIsVerified = sellerInfo?.isVerified ?? false;
    }

    // Get product info if linked
    let productName: string | null = null;
    let productImage: string | null = null;
    let productPrice: number | null = null;
    let productSlug: string | null = null;

    if (conv.sellerListingId) {
      const [listing] = await db
        .select({
          product: productsTable,
          variant: sellerListingVariantsTable,
        })
        .from(sellerListingsTable)
        .innerJoin(productsTable, eq(sellerListingsTable.productId, productsTable.id))
        .leftJoin(
          sellerListingVariantsTable,
          eq(sellerListingVariantsTable.sellerListingId, sellerListingsTable.id),
        )
        .where(eq(sellerListingsTable.id, conv.sellerListingId))
        .limit(1);

      if (listing) {
        productName = listing.product.name;
        productImage = listing.product.images?.[0] ?? null;
        productPrice = listing.variant
          ? Number(listing.variant.discountPrice ?? listing.variant.price)
          : null;
        productSlug = listing.product.slug ?? null;
      }
    }

    res.json({
      id: conv.id,
      buyerId: conv.buyerId,
      sellerId: conv.sellerId,
      viewerRole: isSellerParticipant ? "seller" : "buyer",
      displayName,
      displayAvatarUrl,
      displayIsVerified,
      sellerName: sellerInfo?.nurseryName ?? "",
      sellerLogoUrl: sellerInfo?.logoUrl ?? null,
      sellerIsVerified: sellerInfo?.isVerified ?? false,
      sellerListingId: conv.sellerListingId,
      productName,
      productImage,
      productPrice,
      productSlug,
      lastMessageAt: conv.lastMessageAt.toISOString(),
      createdAt: conv.createdAt.toISOString(),
    });
  } catch (err) {
    const detail = describeError(err);
    logger.error({ err, detail }, "Get conversation error");
    res.status(500).json({
      error: "Failed to fetch conversation",
      detail: process.env.NODE_ENV === "production" ? undefined : detail,
    });
  }
});

// ─── GET /conversations/:id/messages ───────────────────────────────────────
// Get messages for a conversation with cursor-based pagination.
// Query params: ?cursor=<messageId>&limit=<number>&direction=before|after
router.get("/conversations/:id/messages", requireAuth, async (req: any, res) => {
  try {
    const convId = parseInt(req.params.id);
    if (isNaN(convId)) {
      res.status(400).json({ error: "Invalid conversation id" });
      return;
    }

    const [conv] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.id, convId))
      .limit(1);

    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    // Verify the user is a participant
    const [seller] = await db
      .select({ id: sellersTable.id })
      .from(sellersTable)
      .where(eq(sellersTable.userId, req.dbUser.id))
      .limit(1);

    const isBuyer = conv.buyerId === req.userId;
    const isSellerParticipant = seller?.id === conv.sellerId;

    if (!isBuyer && !isSellerParticipant) {
      res.status(403).json({ error: "Not a participant in this conversation" });
      return;
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const cursor = req.query.cursor ? parseInt(req.query.cursor as string) : null;
    const direction = (req.query.direction as string) || "before";

    // Build query with cursor
    let query = db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, convId))
      .orderBy(desc(messagesTable.createdAt))
      .limit(limit + 1); // +1 to detect hasMore

    if (cursor) {
      const [cursorMsg] = await db
        .select({ createdAt: messagesTable.createdAt })
        .from(messagesTable)
        .where(eq(messagesTable.id, cursor))
        .limit(1);

      if (cursorMsg) {
        if (direction === "before") {
          query = db
            .select()
            .from(messagesTable)
            .where(
              and(
                eq(messagesTable.conversationId, convId),
                lt(messagesTable.createdAt, cursorMsg.createdAt),
              )
            )
            .orderBy(desc(messagesTable.createdAt))
            .limit(limit + 1);
        } else {
          query = db
            .select()
            .from(messagesTable)
            .where(
              and(
                eq(messagesTable.conversationId, convId),
                gt(messagesTable.createdAt, cursorMsg.createdAt),
              )
            )
            .orderBy(messagesTable.createdAt)
            .limit(limit + 1);
        }
      }
    }

    const messages = await query;
    const hasMore = messages.length > limit;
    const resultMessages = hasMore ? messages.slice(0, limit) : messages;

    // Mark messages as read by the current user
    if (isBuyer) {
      await db
        .update(messagesTable)
        .set({ readByBuyer: true })
        .where(
          and(
            eq(messagesTable.conversationId, convId),
            eq(messagesTable.readByBuyer, false),
          )
        );
    } else if (isSellerParticipant) {
      await db
        .update(messagesTable)
        .set({ readBySeller: true })
        .where(
          and(
            eq(messagesTable.conversationId, convId),
            eq(messagesTable.readBySeller, false),
          )
        );
    }

    // Return messages in chronological order (oldest first)
    const sorted = resultMessages.reverse();

    res.json({
      messages: sorted.map(formatMessage),
      hasMore,
      nextCursor: hasMore ? sorted[sorted.length - 1]?.id ?? null : null,
    });
  } catch (err) {
    const detail = describeError(err);
    logger.error({ err, detail }, "Get messages error");
    res.status(500).json({
      error: "Failed to fetch messages",
      detail: process.env.NODE_ENV === "production" ? undefined : detail,
    });
  }
});

// ─── POST /conversations/:id/messages ──────────────────────────────────────
// Send a text message (or an attachment-bearing message with an optional
// caption) in a conversation. For raw file uploads, use the dedicated
// `/conversations/:id/upload` endpoint below — it accepts multipart/form-data,
// uploads the file to Cloudinary, and creates the message in one transaction.
//
// This JSON endpoint is used by the emoji/text input path and by clients
// that already have a file URL (e.g. re-using an existing upload).
router.post("/conversations/:id/messages", requireAuth, async (req: any, res) => {
  try {
    const convId = parseInt(req.params.id);
    if (isNaN(convId)) {
      res.status(400).json({ error: "Invalid conversation id" });
      return;
    }

    const {
      content,
      messageType,
      imageUrl,
      fileUrl,
      fileName,
      fileSize,
      fileMimeType,
    } = req.body ?? {};

    const hasContent = typeof content === "string" && content.trim().length > 0;
    const hasAttachment = typeof fileUrl === "string" && fileUrl.length > 0 || typeof imageUrl === "string" && imageUrl.length > 0;

    // Either text content OR an attachment must be present. This allows
    // sending attachment-only messages (no caption) without failing the
    // "content required" check.
    if (!hasContent && !hasAttachment) {
      res.status(400).json({ error: "content or an attachment is required" });
      return;
    }

    if (hasContent && content.length > 5000) {
      res.status(400).json({ error: "Message content too long (max 5000 characters)" });
      return;
    }

    const [conv] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.id, convId))
      .limit(1);

    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    // Verify the user is a participant
    const [seller] = await db
      .select({ id: sellersTable.id })
      .from(sellersTable)
      .where(eq(sellersTable.userId, req.dbUser.id))
      .limit(1);

    const isBuyer = conv.buyerId === req.userId;
    const isSellerParticipant = seller?.id === conv.sellerId;

    if (!isBuyer && !isSellerParticipant) {
      res.status(403).json({ error: "Not a participant in this conversation" });
      return;
    }

    // Derive attachment_type from the supplied MIME so the UI can branch
    // without re-classifying on the client.
    const resolvedMimeType = typeof fileMimeType === "string" ? fileMimeType : (typeof imageUrl === "string" ? "image/jpeg" : null);
    const attachmentType = hasAttachment ? classifyAttachment(resolvedMimeType) : null;
    const resolvedMessageType = messageType || (hasAttachment ? (attachmentType === "image" ? "image" : "file") : "text");

    // Insert the message
    const [message] = await db
      .insert(messagesTable)
      .values({
        conversationId: convId,
        senderId: req.userId,
        content: hasContent ? content.trim() : "",
        messageType: resolvedMessageType,
        imageUrl: imageUrl || null,
        fileUrl: fileUrl || imageUrl || null,
        fileName: typeof fileName === "string" ? fileName : null,
        fileSize: typeof fileSize === "number" && Number.isFinite(fileSize) ? fileSize : null,
        fileMimeType: resolvedMimeType,
        attachmentType,
        // Mark as read by the sender
        readByBuyer: isBuyer,
        readBySeller: isSellerParticipant,
      })
      .returning();

    // Update conversation's lastMessageAt
    await db
      .update(conversationsTable)
      .set({
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(conversationsTable.id, convId));

    res.status(201).json(formatMessage(message));
  } catch (err) {
    const detail = describeError(err);
    logger.error({ err, detail }, "Send message error");
    res.status(500).json({
      error: "Failed to send message",
      detail: process.env.NODE_ENV === "production" ? undefined : detail,
    });
  }
});

// ─── POST /conversations/:id/upload ────────────────────────────────────────
// Upload a file attachment to a conversation.
//
// Multipart/form-data:
//   - field "file"        : the attachment (required)
//   - field "caption"     : optional text caption sent alongside the file
//
// Pipeline:
//   1. requireAuth + participant check (same as POST /messages)
//   2. multer memory-storage with 10MB hard cap
//   3. MIME allow-list check (reject before Cloudinary call to save bandwidth)
//   4. Upload to Cloudinary with the correct resource_type ("image" | "video" | "raw")
//      → images get quality:75 + webp for size; documents stay raw
//   5. Insert message row with fileUrl / fileName / fileSize / fileMimeType / attachmentType
//   6. Bump conversations.lastMessageAt
//
// Returns: the created message (same shape as POST /messages).
router.post(
  "/conversations/:id/upload",
  requireAuth,
  uploadMiddleware.single("file"),
  async (req: any, res) => {
    try {
      const convId = parseInt(req.params.id);
      if (isNaN(convId)) {
        res.status(400).json({ error: "Invalid conversation id" });
        return;
      }

      const file = req.file as Express.Multer.File | undefined;
      if (!file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }

      // 1) MIME allow-list — reject anything not in the safe set.
      if (!isAllowedAttachment(file.mimetype)) {
        res.status(415).json({
          error: `File type ${file.mimetype || "unknown"} is not supported`,
          allowedTypes: ALLOWED_CHAT_ATTACHMENT_MIME_TYPES,
        });
        return;
      }

      // 2) Look up conversation + verify participation.
      const [conv] = await db
        .select()
        .from(conversationsTable)
        .where(eq(conversationsTable.id, convId))
        .limit(1);

      if (!conv) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }

      const [seller] = await db
        .select({ id: sellersTable.id })
        .from(sellersTable)
        .where(eq(sellersTable.userId, req.dbUser.id))
        .limit(1);

      const isBuyer = conv.buyerId === req.userId;
      const isSellerParticipant = seller?.id === conv.sellerId;

      if (!isBuyer && !isSellerParticipant) {
        res.status(403).json({ error: "Not a participant in this conversation" });
        return;
      }

      // 3) Upload to Cloudinary with the right resource_type.
      const resourceType = cloudinaryResourceType(file.mimetype);
      const isImage = resourceType === "image";
      const folder = `treefriend/chat/${convId}`;
      const publicId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      const uploadOptions: Record<string, unknown> = {
        folder,
        public_id: publicId,
        resource_type: resourceType,
      };
      // Images: apply quality/format transform to keep payload small.
      // Documents (PDFs, DOCX, etc.): upload raw — no transform, or
      // Cloudinary would try to re-encode them and corrupt the file.
      if (isImage) {
        uploadOptions.quality = 75;
        uploadOptions.format = "webp";
      }

      const uploadResult = await new Promise<{ secure_url: string }>((resolve, reject) => {
        const stream = cloudinaryV2.uploader.upload_stream(
          uploadOptions,
          (err, result) => {
            if (err || !result) {
              logger.error({ err }, "Cloudinary chat upload error");
              return reject(err ?? new Error("Upload failed"));
            }
            resolve(result as { secure_url: string });
          }
        );
        stream.end(file.buffer);
      });

      // 4) Insert the message row.
      const caption = typeof req.body?.caption === "string" ? req.body.caption.trim() : "";
      const attachmentType = classifyAttachment(file.mimetype);
      const resolvedMessageType = attachmentType === "image" ? "image" : "file";

      const [message] = await db
        .insert(messagesTable)
        .values({
          conversationId: convId,
          senderId: req.userId,
          content: caption,
          messageType: resolvedMessageType,
          imageUrl: isImage ? uploadResult.secure_url : null,
          fileUrl: uploadResult.secure_url,
          fileName: file.originalname || null,
          fileSize: file.size || null,
          fileMimeType: file.mimetype || null,
          attachmentType,
          readByBuyer: isBuyer,
          readBySeller: isSellerParticipant,
        })
        .returning();

      // 5) Bump conversation's lastMessageAt.
      await db
        .update(conversationsTable)
        .set({
          lastMessageAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(conversationsTable.id, convId));

      res.status(201).json(formatMessage(message));
    } catch (err) {
      const detail = describeError(err);
      logger.error({ err, detail }, "Chat file upload error");
      res.status(500).json({
        error: "Failed to upload file",
        detail: process.env.NODE_ENV === "production" ? undefined : detail,
      });
    }
  }
);

// ─── PUT /conversations/:id/read ───────────────────────────────────────────
// Mark all messages in a conversation as read by the current user.
router.put("/conversations/:id/read", requireAuth, async (req: any, res) => {
  try {
    const convId = parseInt(req.params.id);
    if (isNaN(convId)) {
      res.status(400).json({ error: "Invalid conversation id" });
      return;
    }

    const [conv] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.id, convId))
      .limit(1);

    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const [seller] = await db
      .select({ id: sellersTable.id })
      .from(sellersTable)
      .where(eq(sellersTable.userId, req.dbUser.id))
      .limit(1);

    const isBuyer = conv.buyerId === req.userId;
    const isSellerParticipant = seller?.id === conv.sellerId;

    if (!isBuyer && !isSellerParticipant) {
      res.status(403).json({ error: "Not a participant in this conversation" });
      return;
    }

    if (isBuyer) {
      await db
        .update(messagesTable)
        .set({ readByBuyer: true })
        .where(
          and(
            eq(messagesTable.conversationId, convId),
            eq(messagesTable.readByBuyer, false),
          )
        );
    } else {
      await db
        .update(messagesTable)
        .set({ readBySeller: true })
        .where(
          and(
            eq(messagesTable.conversationId, convId),
            eq(messagesTable.readBySeller, false),
          )
        );
    }

    res.json({ success: true });
  } catch (err) {
    const detail = describeError(err);
    logger.error({ err, detail }, "Mark read error");
    res.status(500).json({
      error: "Failed to mark messages as read",
      detail: process.env.NODE_ENV === "production" ? undefined : detail,
    });
  }
});

export default router;
