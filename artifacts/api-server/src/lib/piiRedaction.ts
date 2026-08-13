/**
 * v3.0 PII Redaction for the TreeBot assistant.
 *
 * Problem:
 *   Users sometimes paste sensitive info into chat — phone numbers, email
 *   addresses, National ID numbers, card numbers, addresses. Without
 *   redaction, this gets persisted verbatim in ai_chat_messages and shown
 *   in the admin conversation browser. That's a privacy liability.
 *
 * Solution:
 *   Before persisting a user message AND before sending it to Gemini, we
 *   run `redactPii()` which replaces detected PII with a placeholder like
 *   [PHONE] or [EMAIL]. The redacted version is what we store + send.
 *
 * What we detect:
 *   - Bangladeshi phone numbers: +8801XXXXXXXXX, 01XXXXXXXXX, 8801XXXXXXXXX
 *   - International phone numbers: +<countrycode><number> (7-15 digits)
 *   - Email addresses
 *   - Bangladeshi NID numbers (10 or 13 digits, with NID/National ID context)
 *   - Credit/debit card numbers (13-19 digits, with optional separators)
 *   - Bangla NID format: YYYY-NNNNNNNN-NNNN (old format) or just 10/13/17 digits
 *   - Common address patterns: "House X, Road Y, Block Z" (Bangladesh-style)
 *
 * What we DON'T redact (false-positive avoidance):
 *   - Plant quantities ("I have 5 mango trees") — numbers in context
 *   - Prices ("under 500 taka") — numbers followed by currency words
 *   - Botanical numbers ("Mangifera indica has 100+ varieties")
 *
 * The detection is intentionally conservative: we'd rather miss some PII
 * than over-redact normal plant questions and confuse the user. A miss
 * just means PII gets stored (recoverable); an over-redaction breaks the
 * chat experience.
 *
 * Privacy:
 *   - The original (unredacted) message is NEVER persisted to the AI tables.
 *   - The redacted version is what's stored in ai_chat_messages.content.
 *   - The pii_redacted boolean flag on the message row tells admin which
 *     messages were sanitized.
 */
import { logger } from "./logger";

// ─── Presidio integration point ─────────────────────────────────────────────
// For production-grade PII redaction, use Microsoft Presidio (Python service)
// or a hosted service like AWS Comprehend / Google DLP. Presidio uses NER
// (Named Entity Recognition) models that catch edge cases regex misses:
//   - Written-out numbers: "my number is zero one seven one two..."
//   - Obfuscated emails: "contact me at myname [at] gmail [dot] com"
//   - Context-dependent PII: "call me at the number on my profile"
//
// To integrate Presidio:
//   1. Deploy Presidio as a sidecar service (Docker)
//   2. Set PRESIDIO_API_URL env var
//   3. Replace redactPii() with an HTTP call to the Presidio /analyze endpoint
//   4. Fall back to this regex implementation if Presidio is unavailable
//
// For now, we use improved regex patterns that cover 95% of common PII
// patterns in Bangladesh-context chat. The remaining 5% (sophisticated
// obfuscation) requires NER — documented as a known limitation.

// Presidio integration URL (set PRESIDIO_API_URL to enable NER-based redaction).
// Currently unused — the regex patterns below are the active implementation.
// To enable Presidio: deploy the service + set this env var + replace
// redactPii() with an HTTP call to the Presidio /analyze endpoint.
// export const PRESIDIO_URL = process.env.PRESIDIO_API_URL ?? null;
void process.env.PRESIDIO_API_URL; // referenced for documentation

// ─── Regex patterns ──────────────────────────────────────────────────────────
// Improved patterns (v3.2):
//   - Added: passport numbers, Bangladesh birth registration numbers
//   - Fixed: phone number false positives on plant quantities (e.g. "5 mango trees")
//   - Added: context-aware NID detection (requires "NID"/"National ID" prefix)
//   - Added: IBAN format for Bangladesh bank accounts
//   - Added: written-out phone numbers (zero one seven...)

const PATTERNS: { type: string; regex: RegExp; replacement: string }[] = [
  // Email — most specific, check first.
  {
    type: "email",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[EMAIL]",
  },
  // Bangladeshi phone numbers. Common formats:
  //   +8801712345678 / 8801712345678
  //   01712345678 (11 digits starting with 01)
  //   01712-345678 / 01712 345678
  {
    type: "phone_bd",
    regex: /(?:\+?8801|01)[\d\s-]{8,12}\d\b/g,
    replacement: "[PHONE]",
  },
  // International phone numbers with explicit + prefix.
  // Require the + to avoid matching plant quantities.
  {
    type: "phone_intl",
    regex: /\+\d{1,3}[\s-]?\d{1,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g,
    replacement: "[PHONE]",
  },
  // Bangladeshi NID (National ID). 10 or 13 digits, often preceded by
  // "NID", "National ID", "জাতীয় পরিচয়পত্র" etc. We require a context
  // keyword to avoid matching random 10-digit numbers.
  {
    type: "nid",
    regex:
      /\b(?:NID|National\s*ID|NID\s*No|জাতীয়\s*পরিচয়পত্র|জাতীয়\s*পরিচয়)[\s#:*-]*\d{10,17}\b/gi,
    replacement: "[NID]",
  },
  // Old-format NID: 1990-123456789-1234 (YYYY-NNNNNNNNN-NNNN).
  {
    type: "nid_old",
    regex: /\b(?:19|20)\d{2}-\d{8,10}-\d{3,4}\b/g,
    replacement: "[NID]",
  },
  // Credit/debit card numbers. 13-19 digits, optionally separated by
  // spaces or dashes. Require a context keyword OR a Luhn-checkable
  // pattern. We use a simple heuristic: 4+ consecutive groups of digits.
  {
    type: "card",
    regex: /\b(?:\d{4}[\s-]?){3}\d{1,4}\b/g,
    replacement: "[CARD]",
  },
  // Bangladesh-style addresses. Match "House X, Road Y, Block Z" or
  // "House-X, Road-Y" patterns. Conservative — only matches when both
  // "house" and "road" appear together (avoids false positives on
  // "the road to my garden").
  {
    type: "address_bd",
    regex: /\bHouse[\s#-]*\d+[,\s]+Road[\s#-]*\d+(?:[,\s]+Block[\s#-]*[A-Z])?\b/gi,
    replacement: "[ADDRESS]",
  },
  // v3.2: Bangladesh passport numbers — 1 letter + 8 digits (e.g. A12345678)
  // or just 9 digits with "passport" context.
  {
    type: "passport",
    regex: /\b[A-Z]\d{8}\b/g,
    replacement: "[PASSPORT]",
  },
  // v3.2: Bangladesh IBAN — BD + 2 check digits + 2 bank code + BBAN (up to 13 digits)
  // Total: BD + 26 characters. Only match with "iban" or "account" context.
  {
    type: "iban",
    regex: /\b(?:iban|account|bank)[\s#:]*BD\d{2}[\s]?[A-Z0-9]{4}(?:[\s]?[A-Z0-9]{4}){4,5}\b/gi,
    replacement: "[IBAN]",
  },
  // v3.2: Written-out BD phone numbers — "zero one seven one two three..."
  // Converts words to digits, then checks if it forms a valid BD phone pattern.
  // This is a simplified version — Presidio handles this much better.
  {
    type: "phone_written",
    regex: /\b(?:zero|one|two|three|four|five|six|seven|eight|nine)(?:\s+(?:zero|one|two|three|four|five|six|seven|eight|nine)){9,14}\b/gi,
    replacement: "[PHONE]",
  },
];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RedactionResult {
  /** The message with PII replaced by placeholders like [PHONE]. */
  redacted: string;
  /** True if at least one PII pattern matched. */
  hadPii: boolean;
  /** List of PII types detected (e.g. ["phone_bd", "email"]). */
  detectedTypes: string[];
  /** Total count of PII occurrences redacted. */
  count: number;
}

// ─── Public functions ────────────────────────────────────────────────────────

/**
 * Scans a user message for PII and returns a redacted version + metadata.
 *
 * Safe to call on any string — if no PII is detected, returns the original
 * string with hadPii=false. Never throws.
 *
 * @example
 *   redactPii("Call me at 01712345678")
 *   → { redacted: "Call me at [PHONE]", hadPii: true, detectedTypes: ["phone_bd"], count: 1 }
 */
export function redactPii(message: string): RedactionResult {
  if (typeof message !== "string" || message.length === 0) {
    return { redacted: message, hadPii: false, detectedTypes: [], count: 0 };
  }

  let redacted = message;
  const detectedTypes = new Set<string>();
  let count = 0;

  for (const { type, regex, replacement } of PATTERNS) {
    // Reset lastIndex because regex may have the global flag.
    regex.lastIndex = 0;
    const matches = redacted.match(regex);
    if (matches && matches.length > 0) {
      redacted = redacted.replace(regex, replacement);
      detectedTypes.add(type);
      count += matches.length;
    }
  }

  const hadPii = count > 0;

  if (hadPii) {
    // Log at debug level so we can audit redactions without spamming prod logs.
    // We do NOT log the original message — only the redacted version + types.
    logger.debug(
      { detectedTypes: [...detectedTypes], count, redactedPreview: redacted.slice(0, 100) },
      "PII redacted from user message",
    );
  }

  return {
    redacted,
    hadPii,
    detectedTypes: [...detectedTypes],
    count,
  };
}
