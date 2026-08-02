import { Router } from "express";
import { db } from "@workspace/db";
import {
  conversationsTable,
  messagesTable,
  sellersTable,
  sellerListingsTable,
  productsTable,
  sellerListingVariantsTable,
  usersTable,
} from "@workspace/db";
import { eq, and, desc, sql, lt, gt } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

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
  readByBuyer: boolean;
  readBySeller: boolean;
  createdAt: string;
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
          lastMessage: lastMsg?.content ?? null,
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
          lastMessage: lastMsg?.content ?? null,
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
    console.error("List conversations error:", err);
    res.status(500).json({ error: "Failed to fetch conversations" });
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
    console.error("Create conversation error:", err);
    res.status(500).json({ error: "Failed to create conversation" });
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
    console.error("Get conversation error:", err);
    res.status(500).json({ error: "Failed to fetch conversation" });
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
    console.error("Get messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// ─── POST /conversations/:id/messages ──────────────────────────────────────
// Send a message in a conversation.
router.post("/conversations/:id/messages", requireAuth, async (req: any, res) => {
  try {
    const convId = parseInt(req.params.id);
    if (isNaN(convId)) {
      res.status(400).json({ error: "Invalid conversation id" });
      return;
    }

    const { content, messageType, imageUrl } = req.body;

    if (!content || typeof content !== "string" || content.trim().length === 0) {
      res.status(400).json({ error: "content is required" });
      return;
    }

    if (content.length > 5000) {
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

    // Insert the message
    const [message] = await db
      .insert(messagesTable)
      .values({
        conversationId: convId,
        senderId: req.userId,
        content: content.trim(),
        messageType: messageType || "text",
        imageUrl: imageUrl || null,
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
    console.error("Send message error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

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
    console.error("Mark read error:", err);
    res.status(500).json({ error: "Failed to mark messages as read" });
  }
});

export default router;
