import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../src/app";
import { db } from "@workspace/db";
import { returnsTable, ordersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { authHeader } from "./authHelper";
import { cleanupAll, seedSeller, seedUser, seedCategory, seedProduct, seedListing, seedOrder } from "./testDb";

describe("seller-returns routes (HTTP)", () => {
  let sellerClerkId: string;
  let sellerId: number;
  let otherSellerClerkId: string;
  let otherSellerId: number;
  let buyerClerkId: string;
  let orderId: number;
  let otherOrderId: number;

  beforeAll(async () => {
    await cleanupAll();

    const { user: sellerUser, seller } = await seedSeller({
      clerkIdSuffix: "returns-seller",
      email: "returns-seller@test.example",
      businessName: "Returns Test Nursery",
    });
    sellerClerkId = sellerUser.clerkId;
    sellerId = seller.id;

    const { user: otherSellerUser, seller: otherSeller } = await seedSeller({
      clerkIdSuffix: "returns-other-seller",
      email: "returns-other-seller@test.example",
      businessName: "Other Test Nursery",
    });
    otherSellerClerkId = otherSellerUser.clerkId;
    otherSellerId = otherSeller.id;

    const buyer = await seedUser({ clerkIdSuffix: "returns-buyer", email: "returns-buyer@test.example" });
    buyerClerkId = buyer.clerkId;

    const category = await seedCategory();
    const product = await seedProduct(category.id);
    const listing = await seedListing({ productId: product.id, sellerId, price: "750" });
    const order = await seedOrder({ userIdClerk: buyerClerkId, sellerId, listingId: listing.id, productId: product.id, price: 750 });
    orderId = order.id;

    const otherListing = await seedListing({ productId: product.id, sellerId: otherSellerId, price: "500" });
    const otherOrder = await seedOrder({ userIdClerk: buyerClerkId, sellerId: otherSellerId, listingId: otherListing.id, productId: product.id, price: 500 });
    otherOrderId = otherOrder.id;
  });

  afterAll(async () => {
    await cleanupAll();
  });

  async function insertReturn(orderIdToUse: number, overrides: Partial<typeof returnsTable.$inferInsert> = {}) {
    const [row] = await db
      .insert(returnsTable)
      .values({
        orderId: orderIdToUse,
        userId: buyerClerkId,
        reason: "Plant arrived damaged in transit",
        ...overrides,
      })
      .returning();
    return row;
  }

  it("401s GET /api/seller/returns with no auth", async () => {
    const res = await request(app).get("/api/seller/returns");
    expect(res.status).toBe(401);
  });

  it("403s GET /api/seller/returns for a user with no seller account", async () => {
    const res = await request(app)
      .get("/api/seller/returns")
      .set(authHeader(buyerClerkId, "returns-buyer@test.example"));
    expect(res.status).toBe(403);
  });

  it("lists only this seller's own returns, paginated, with buyer + order context", async () => {
    const mine = await insertReturn(orderId);
    await insertReturn(otherOrderId); // belongs to the other seller -- must not appear

    const res = await request(app)
      .get("/api/seller/returns")
      .set(authHeader(sellerClerkId, "returns-seller@test.example"));

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
    expect(res.body.returns).toHaveLength(1);
    expect(res.body.returns[0].id).toBe(mine.id);
    expect(res.body.returns[0].orderId).toBe(orderId);
    expect(res.body.returns[0].customerName).toBe("Test Buyer");
    expect(res.body.returns[0].orderTotal).toBe(750);

    await db.delete(returnsTable).where(eq(returnsTable.orderId, otherOrderId));
    await db.delete(returnsTable).where(eq(returnsTable.id, mine.id));
  });

  it("400s GET /api/seller/returns with an invalid status filter", async () => {
    const res = await request(app)
      .get("/api/seller/returns?status=bogus")
      .set(authHeader(sellerClerkId, "returns-seller@test.example"));
    expect(res.status).toBe(400);
  });

  it("filters by ?status=", async () => {
    const requested = await insertReturn(orderId, { status: "requested" });
    const approved = await insertReturn(orderId, { status: "approved" });

    const res = await request(app)
      .get("/api/seller/returns?status=approved")
      .set(authHeader(sellerClerkId, "returns-seller@test.example"));

    expect(res.status).toBe(200);
    expect(res.body.returns.map((r: any) => r.id)).toEqual([approved.id]);

    await db.delete(returnsTable).where(eq(returnsTable.id, requested.id));
    await db.delete(returnsTable).where(eq(returnsTable.id, approved.id));
  });

  it("403s GET /api/seller/returns/:id for a return belonging to a different seller's order", async () => {
    const theirs = await insertReturn(otherOrderId);
    const res = await request(app)
      .get(`/api/seller/returns/${theirs.id}`)
      .set(authHeader(sellerClerkId, "returns-seller@test.example"));
    expect(res.status).toBe(403);
    await db.delete(returnsTable).where(eq(returnsTable.id, theirs.id));
  });

  it("404s GET/PUT /api/seller/returns/:id for a nonexistent id", async () => {
    const get = await request(app)
      .get("/api/seller/returns/999999999")
      .set(authHeader(sellerClerkId, "returns-seller@test.example"));
    expect(get.status).toBe(404);

    const put = await request(app)
      .put("/api/seller/returns/999999999")
      .set(authHeader(sellerClerkId, "returns-seller@test.example"))
      .send({ status: "approved" });
    expect(put.status).toBe(404);
  });

  it("400s PUT with an invalid status value", async () => {
    const ret = await insertReturn(orderId);
    const res = await request(app)
      .put(`/api/seller/returns/${ret.id}`)
      .set(authHeader(sellerClerkId, "returns-seller@test.example"))
      .send({ status: "requested" }); // not a valid target status for a seller PUT
    expect(res.status).toBe(400);
    await db.delete(returnsTable).where(eq(returnsTable.id, ret.id));
  });

  it("400s rejecting without a reason (adminNote) of at least 3 characters", async () => {
    const ret = await insertReturn(orderId);
    const res = await request(app)
      .put(`/api/seller/returns/${ret.id}`)
      .set(authHeader(sellerClerkId, "returns-seller@test.example"))
      .send({ status: "rejected" });
    expect(res.status).toBe(400);
    await db.delete(returnsTable).where(eq(returnsTable.id, ret.id));
  });

  it("400s completing without a refundAmount", async () => {
    const ret = await insertReturn(orderId, { status: "approved" });
    const res = await request(app)
      .put(`/api/seller/returns/${ret.id}`)
      .set(authHeader(sellerClerkId, "returns-seller@test.example"))
      .send({ status: "completed" });
    expect(res.status).toBe(400);
    await db.delete(returnsTable).where(eq(returnsTable.id, ret.id));
  });

  it("409s trying to complete a return that is still in \"requested\" status (must be approved first)", async () => {
    const ret = await insertReturn(orderId, { status: "requested" });
    const res = await request(app)
      .put(`/api/seller/returns/${ret.id}`)
      .set(authHeader(sellerClerkId, "returns-seller@test.example"))
      .send({ status: "completed", refundAmount: "100" });
    expect(res.status).toBe(409);
    await db.delete(returnsTable).where(eq(returnsTable.id, ret.id));
  });

  it("403s a seller trying to update a return on another seller's order", async () => {
    const theirs = await insertReturn(otherOrderId);
    const res = await request(app)
      .put(`/api/seller/returns/${theirs.id}`)
      .set(authHeader(sellerClerkId, "returns-seller@test.example"))
      .send({ status: "approved" });
    expect(res.status).toBe(403);
    await db.delete(returnsTable).where(eq(returnsTable.id, theirs.id));
  });

  it("happy path: approve then complete with a refund amount, order flips to return_completed", async () => {
    const ret = await insertReturn(orderId, { status: "requested" });

    const approveRes = await request(app)
      .put(`/api/seller/returns/${ret.id}`)
      .set(authHeader(sellerClerkId, "returns-seller@test.example"))
      .send({ status: "approved" });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe("approved");

    const completeRes = await request(app)
      .put(`/api/seller/returns/${ret.id}`)
      .set(authHeader(sellerClerkId, "returns-seller@test.example"))
      .send({ status: "completed", refundAmount: "750" });
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.status).toBe("completed");
    expect(completeRes.body.refundAmount).toBe(750);

    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    expect(order.orderStatus).toBe("return_completed");

    await db.delete(returnsTable).where(eq(returnsTable.id, ret.id));
  });
});
