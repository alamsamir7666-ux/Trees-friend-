/**
 * OTP transport — sends OTP codes via WhatsApp (primary) and SMS (fallback).
 *
 * Reuses the existing Twilio integration (same as lib/whatsapp.ts and
 * lib/preOrders.ts). Two separate functions so guestOtp.ts can try
 * WhatsApp first, then SMS, with distinct error handling for each.
 *
 * ─── Why WhatsApp-first in Bangladesh ────────────────────────────────────────
 * WhatsApp is the dominant messaging channel in BD — virtually every
 * smartphone user has it, and OTP delivery is near-instant. SMS is the
 * fallback for the rare buyer without WhatsApp (or whose WhatsApp
 * number differs from their SMS-capable number). Daraz uses the same
 * WhatsApp-first + SMS-fallback pattern for its OTP flow.
 *
 * ─── Environment variables ───────────────────────────────────────────────────
 *   TWILIO_ACCOUNT_SID       — required for any Twilio send
 *   TWILIO_AUTH_TOKEN        — required for any Twilio send
 *   TWILIO_WHATSAPP_FROM     — WhatsApp sender (default: whatsapp:+14155238886,
 *                              Twilio's shared test sender)
 *   TWILIO_SMS_FROM           — SMS sender (optional; if unset, SMS fallback
 *                              is skipped — WhatsApp is the only transport)
 *
 * If Twilio isn't configured at all (missing SID/token), both functions
 * log a warning and resolve successfully (no throw) — this lets the OTP
 * flow work in dev without a Twilio account. The code is still generated
 * and persisted, and dev mode can log it to the console (see the dev
 * fallback in `sendWhatsAppOtp`).
 */

import { logger } from "./logger";
import { describeError } from "./describeError";

interface TwilioClient {
  messages: {
    create: (params: {
      from: string;
      to: string;
      body: string;
    }) => Promise<{ sid: string }>;
  };
}

let _twilioClient: TwilioClient | null | undefined;

/**
 * Lazily load and cache the Twilio client. Returns null if Twilio isn't
 * configured (dev mode) — callers handle that case.
 */
async function getTwilioClient(): Promise<TwilioClient | null> {
  if (_twilioClient !== undefined) return _twilioClient;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    _twilioClient = null;
    return null;
  }

  try {
    const twilio = await import("twilio");
    _twilioClient = twilio.default(accountSid, authToken);
    return _twilioClient;
  } catch (err) {
    logger.error({ err: describeError(err) }, "[otpTransport] Failed to load twilio module");
    _twilioClient = null;
    return null;
  }
}

/**
 * Convert a bare-local-form BD phone (01XXXXXXXXX) to E.164 (+8801XXXXXXXXX).
 * Twilio requires E.164 for both WhatsApp and SMS destinations.
 */
function toE164(bareLocalPhone: string): string {
  // Input is already validated as 01XXXXXXXXX (11 digits, starts with 01[3-9])
  return `+880${bareLocalPhone.slice(1)}`;
}

/**
 * Send an OTP code via WhatsApp.
 *
 * @param bareLocalPhone — normalized to 01XXXXXXXXX by guestOtp.ts
 * @param code — 6-digit plaintext code (NOT the hash)
 *
 * In dev (no Twilio configured), logs the code to the console so the
 * developer can complete the OTP flow without a real Twilio account.
 */
export async function sendWhatsAppOtp(bareLocalPhone: string, code: string): Promise<void> {
  const client = await getTwilioClient();
  const from = process.env.TWILIO_WHATSAPP_FROM ?? "whatsapp:+14155238886";
  const to = `whatsapp:${toE164(bareLocalPhone)}`;

  const message =
    `🌳 *Tree Friend*\n\n` +
    `Your verification code is *${code}*\n\n` +
    `This code expires in 5 minutes. If you didn't request it, please ignore this message.`;

  if (!client) {
    // Dev fallback — log the code so the developer can paste it into the
    // verify form. This is the same pattern Twilio Verify uses in "test"
    // mode. NEVER do this in production.
    if (process.env.NODE_ENV !== "production") {
      logger.info(
        `[otpTransport][DEV] WhatsApp OTP for ${bareLocalPhone}: ${code}`,
      );
    }
    return;
  }

  await client.messages.create({ from, to, body: message });
  logger.info(`[otpTransport] WhatsApp OTP sent to ${bareLocalPhone}`);
}

/**
 * Send an OTP code via SMS (fallback when WhatsApp fails).
 *
 * @param bareLocalPhone — normalized to 01XXXXXXXXX by guestOtp.ts
 * @param code — 6-digit plaintext code (NOT the hash)
 *
 * Skipped silently if TWILIO_SMS_FROM is unset (WhatsApp is the only
 * transport). In dev with no Twilio configured, logs the code.
 */
export async function sendSmsOtp(bareLocalPhone: string, code: string): Promise<void> {
  const client = await getTwilioClient();
  const from = process.env.TWILIO_SMS_FROM;

  if (!from) {
    // No SMS sender configured — skip (WhatsApp was the only transport)
    logger.warn(`[otpTransport] SMS fallback skipped: TWILIO_SMS_FROM not set`);
    return;
  }

  const to = toE164(bareLocalPhone);
  const message = `Tree Friend: Your verification code is ${code}. Expires in 5 minutes.`;

  if (!client) {
    if (process.env.NODE_ENV !== "production") {
      logger.info(
        `[otpTransport][DEV] SMS OTP for ${bareLocalPhone}: ${code}`,
      );
    }
    return;
  }

  await client.messages.create({ from, to, body: message });
  logger.info(`[otpTransport] SMS OTP sent to ${bareLocalPhone}`);
}
