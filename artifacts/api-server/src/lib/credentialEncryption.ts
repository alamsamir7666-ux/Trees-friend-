import crypto from "crypto";

/**
 * Encrypt-at-rest for seller_payment_configs / seller_courier_configs.
 *
 * Neither table's schema comments ("SECURITY: ... Encrypt at rest, same
 * standard as password storage") were ever backed by an actual utility in
 * Parts 1-3 -- confirmed by grep, not assumed. This fills that gap, built
 * as part of Part 4 because booking a courier requires decrypting real
 * credentials to call Pathao/Steadfast, which is the first place plaintext
 * storage becomes an active risk rather than a documented future TODO.
 *
 * Algorithm: AES-256-GCM (authenticated encryption -- tampering with
 * ciphertext is detected, not just silently decrypted to garbage).
 *
 * Same "fail loudly at import time" convention as MOBILE_JWT_SECRET in
 * middlewares/mobileJwt.ts: a missing key must break startup, not silently
 * fall back to storing plaintext.
 *
 * IMPORTANT: set CREDENTIAL_ENCRYPTION_KEY in your Render environment
 * variables before deploying -- a 32-byte key, base64-encoded. Generate one
 * with: openssl rand -base64 32
 * Losing/rotating this key makes every previously-encrypted row
 * undecryptable -- back it up the same way you'd back up a database
 * password, and treat rotation as a re-encrypt-all-rows migration, not a
 * drop-in env var swap.
 */

const KEY_ENV_VAR = "CREDENTIAL_ENCRYPTION_KEY";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV, standard for GCM
const AUTH_TAG_LENGTH = 16;

function loadKey(): Buffer {
  const raw = process.env[KEY_ENV_VAR];
  if (!raw) {
    throw new Error(
      `${KEY_ENV_VAR} environment variable is not set. Generate one with ` +
        "`openssl rand -base64 32` and add it to your Render environment " +
        "variables. Required to store/read seller payment and courier " +
        "credentials (seller_payment_configs, seller_courier_configs).",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `${KEY_ENV_VAR} must decode to exactly 32 bytes (got ${key.length}). ` +
        "Generate a valid key with: openssl rand -base64 32",
    );
  }
  return key;
}

// Lazy: only throws when a route actually tries to encrypt/decrypt, not at
// module import time for every process that happens to import this file
// transitively. Matches how sellerPaymentConfigs/sellerCourierConfigs
// routes are only hit when those features are used.
let _key: Buffer | null = null;
function getKey(): Buffer {
  if (!_key) _key = loadKey();
  return _key;
}

/**
 * Encrypts a plaintext credential string. Output format is a single string
 * safe to store directly in a `text` column: base64(iv):base64(authTag):base64(ciphertext)
 */
export function encryptCredential(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/**
 * Decrypts a string produced by encryptCredential. Throws if the value is
 * malformed or the auth tag doesn't verify (tampered/corrupted/wrong key) --
 * callers should not swallow this silently, since a decrypt failure on a
 * credential means we cannot safely call the courier/payment API with it.
 */
export function decryptCredential(stored: string): string {
  const key = getKey();
  const parts = stored.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted credential (expected iv:authTag:ciphertext)");
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Masked display value for API responses -- never return decrypted
 * credentials to the client beyond a last-4 indicator, per both configs
 * tables' schema comments. Returns e.g. "••••••••WXYZ". If the stored value
 * can't be decrypted (or is shorter than 4 chars), falls back to a generic
 * mask with no trailing chars rather than throwing -- a masked-response
 * endpoint should never 500 because of a decrypt problem.
 */
export function maskCredential(stored: string): string {
  try {
    const plaintext = decryptCredential(stored);
    if (plaintext.length <= 4) return "••••••••";
    return `••••••••${plaintext.slice(-4)}`;
  } catch {
    return "••••••••";
  }
}
