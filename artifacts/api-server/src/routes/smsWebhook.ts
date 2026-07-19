import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable, usersTable, preOrdersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { sendOrderStatusUpdate } from "../lib/email";

const router = Router();

// POST /sms-webhook — receives forwarded SMS from SMS Forwarder app
router.post("/sms-webhook", async (req, res) => {
  try {
    const body = req.body;
    // SMS Forwarder sends: { from: "01XXXXXXXXX", message: "..." } or as text
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const from = body.from || body.number || body.sender || "";
    const message = body.message || body.msg || body.text || raw;

    console.log("[sms-webhook] from:", from, "message:", message);

    // Parse amount from bKash/Nagad SMS
    // bKash: "You have received Tk 500.00 from 01XXXXXXXXX"
    // Nagad: "You have received 500.00 BDT from 01XXXXXXXXX"
    const amountMatch = message.match(/(?:Tk|BDT)?\s*([\d,]+(?:\.\d+)?)/i);
    const senderMatch = message.match(/from\s+(01[\d]{9})/i);

    if (!amountMatch || !senderMatch) {
      console.log("[sms-webhook] Could not parse amount or sender");
      res.json({ ok: false, reason: "parse_failed" });
      return;
    }

    const amount = parseFloat(amountMatch[1].replace(/,/g, ""));
    const senderNumber = senderMatch[1];

    console.log("[sms-webhook] parsed amount:", amount, "sender:", senderNumber);

    // Find matching pending order by sender number and amount
    const orders = await db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.paymentStatus, "pending_verification"),
          eq(ordersTable.senderNumber, senderNumber)
        )
      )
      .orderBy(desc(ordersTable.createdAt))
      .limit(5);

    // Find order where total matches amount (within 1 taka tolerance)
    const match = orders.find(o => Math.abs(Number(o.totalAmount) - amount) <= 1);

    if (!match) {
      // Check pre-orders
    const preOrders = await db
      .select()
      .from(preOrdersTable)
      .where(and(eq(preOrdersTable.paymentStatus, "pending_verification"), eq(preOrdersTable.senderNumber, senderNumber)))
      .orderBy(desc(preOrdersTable.createdAt))
      .limit(5);
    const preMatch = preOrders.find(o => Math.abs(Number(o.deliveryCharge) - amount) <= 1);
    if (preMatch) {
      await db.update(preOrdersTable).set({ paymentStatus: "paid", updatedAt: new Date() }).where(eq(preOrdersTable.id, preMatch.id));
      console.log("[sms-webhook] Auto-paid pre-order:", preMatch.id);
      res.json({ ok: true, preOrderId: preMatch.id });
      return;
    }
    console.log("[sms-webhook] No matching order found");
    res.json({ ok: false, reason: "no_match" });
      return;
    }

    // Mark as paid
    await db.update(ordersTable)
      .set({ paymentStatus: "paid", paidAt: new Date(), updatedAt: new Date() })
      .where(eq(ordersTable.id, match.id));

    console.log("[sms-webhook] Auto-paid order:", match.id);

    // Send payment confirmation email
    try {
      const [userRow] = await db
        .select({ email: usersTable.email, firstName: usersTable.firstName, lastName: usersTable.lastName })
        .from(usersTable)
        .where(eq(usersTable.clerkId, match.userId))
        .limit(1);

      if (userRow?.email && !userRow.email.endsWith("@clerk.user")) {
        const name = [userRow.firstName, userRow.lastName].filter(Boolean).join(" ") || "Customer";
        await sendOrderStatusUpdate({
          to: userRow.email,
          name,
          orderId: match.id,
          trackingId: match.trackingId,
          newStatus: "paid",
        }).catch(() => {});
      }
    } catch { /* Non-blocking */ }

    res.json({ ok: true, orderId: match.id });
  } catch (err) {
    console.error("[sms-webhook] error:", err);
    res.status(500).json({ ok: false });
  }
});

export default router;
