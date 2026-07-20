import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../src/app";
import { db } from "@workspace/db";
import { sellerCourierConfigsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { authHeader } from "./authHelper";
import { cleanupAll, seedSeller, seedUser } from "./testDb";

describe("seller-courier-configs routes (HTTP)", () => {
  let sellerClerkId: string;
  let sellerId: number;
  let buyerClerkId: string;

  beforeAll(async () => {
    await cleanupAll();
    const { user, seller } = await seedSeller({
      clerkIdSuffix: "courierconfig-seller",
      email: "courierconfig-seller@test.example",
      businessName: "Courier Config Nursery",
    });
    sellerClerkId = user.clerkId;
    sellerId = seller.id;

    const buyer = await seedUser({ clerkIdSuffix: "courierconfig-buyer", email: "courierconfig-buyer@test.example" });
    buyerClerkId = buyer.clerkId;
  });

  afterAll(async () => {
    await cleanupAll();
  });

  it("401s POST /api/seller-courier-configs with no auth", async () => {
    const res = await request(app).post("/api/seller-courier-configs").send({ provider: "steadfast" });
    expect(res.status).toBe(401);
  });

  it("403s POST /api/seller-courier-configs for a non-seller buyer", async () => {
    const res = await request(app)
      .post("/api/seller-courier-configs")
      .set(authHeader(buyerClerkId, "courierconfig-buyer@test.example"))
      .send({ provider: "steadfast", apiKey: "k", apiSecret: "s" });
    expect(res.status).toBe(403);
  });

  it("400s creating a Pathao config with an improperly packed apiSecret", async () => {
    const res = await request(app)
      .post("/api/seller-courier-configs")
      .set(authHeader(sellerClerkId, "courierconfig-seller@test.example"))
      .send({ provider: "pathao", apiKey: "clientid", apiSecret: "onlyonepart", storeId: "1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/clientSecret\|username\|password/);
  });

  it("happy path: creates a Steadfast config, masked in the response, isVerified starts false", async () => {
    const res = await request(app)
      .post("/api/seller-courier-configs")
      .set(authHeader(sellerClerkId, "courierconfig-seller@test.example"))
      .send({ provider: "steadfast", apiKey: "real-steadfast-key", apiSecret: "real-steadfast-secret" });

    expect(res.status).toBe(201);
    expect(res.body.provider).toBe("steadfast");
    expect(res.body.isVerified).toBe(false);
    expect(res.body.apiKeyMasked).not.toContain("real-steadfast-key");

    const rows = await db.select().from(sellerCourierConfigsTable).where(eq(sellerCourierConfigsTable.sellerId, sellerId));
    expect(rows).toHaveLength(1);
    expect(rows[0].apiKey).not.toBe("real-steadfast-key");
  });

  it("upsert-by-delete-then-insert: creating a second config for the same seller replaces the first (no accumulation)", async () => {
    const res = await request(app)
      .post("/api/seller-courier-configs")
      .set(authHeader(sellerClerkId, "courierconfig-seller@test.example"))
      .send({ provider: "pathao", apiKey: "clientid", apiSecret: "secret|user|pass", storeId: "999" });

    expect(res.status).toBe(201);
    expect(res.body.provider).toBe("pathao");

    const rows = await db.select().from(sellerCourierConfigsTable).where(eq(sellerCourierConfigsTable.sellerId, sellerId));
    expect(rows).toHaveLength(1); // exactly one row, not two
    expect(rows[0].provider).toBe("pathao");
  });

  it("GET /api/seller-courier-configs/mine returns the current (masked) config", async () => {
    const res = await request(app)
      .get("/api/seller-courier-configs/mine")
      .set(authHeader(sellerClerkId, "courierconfig-seller@test.example"));
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("pathao");
  });

  it("DELETE /api/seller-courier-configs/mine removes the config, then GET/DELETE both 404", async () => {
    const del = await request(app)
      .delete("/api/seller-courier-configs/mine")
      .set(authHeader(sellerClerkId, "courierconfig-seller@test.example"));
    expect(del.status).toBe(200);

    const get = await request(app)
      .get("/api/seller-courier-configs/mine")
      .set(authHeader(sellerClerkId, "courierconfig-seller@test.example"));
    expect(get.status).toBe(404);

    const del2 = await request(app)
      .delete("/api/seller-courier-configs/mine")
      .set(authHeader(sellerClerkId, "courierconfig-seller@test.example"));
    expect(del2.status).toBe(404);
  });
});
