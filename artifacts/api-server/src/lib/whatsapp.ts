import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const from = process.env.TWILIO_WHATSAPP_FROM ?? "whatsapp:+14155238886";
const siteUrl = process.env.VITE_SITE_URL ?? "https://fixed5.vercel.app";

function getClient() {
  if (!accountSid || !authToken) return null;
  return twilio(accountSid, authToken);
}

export async function sendWhatsAppStockAlert({
  phone,
  productName,
  productId,
}: {
  phone: string;
  productName: string;
  productId: number;
}) {
  const client = getClient();
  if (!client) {
    console.warn("[whatsapp] Twilio not configured");
    return;
  }

  // Clean phone number - remove spaces, dashes
  const cleaned = phone.replace(/[^+\d]/g, "");
  // Add Bangladesh country code if not present
  const to = cleaned.startsWith("+") ? cleaned : `+88${cleaned}`;

  const message = `🌳 *Tree Friend*\n\nGreat news! *${productName}* is back in stock!\n\nShop now 👉 ${siteUrl}/products/${productId}\n\n_Reply STOP to unsubscribe_`;

  try {
    await client.messages.create({
      from,
      to: `whatsapp:${to}`,
      body: message,
    });
    console.log(`[whatsapp] Sent stock alert to ${to}`);
  } catch (err: any) {
    console.error("[whatsapp] Failed to send:", err?.message ?? err);
  }
}
