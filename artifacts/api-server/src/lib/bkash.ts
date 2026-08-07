import { db } from "@workspace/db";
import { platformPaymentConfigTable } from "@workspace/db";
import { decryptCredential } from "./credentialEncryption";

/**
 * bKash Tokenized Checkout API client (Part 2 of 4 -- see PART2_HANDOFF.md).
 * Talks to bKash's real hosted-checkout API on behalf of the PLATFORM's
 * single merchant account (platformPaymentConfigTable, Part 1) -- there is
 * no per-seller bKash integration here; every buyer bKash payment, whether
 * for an admin-direct order or a marketplace order, authenticates and
 * settles against this one merchant account (Part 1's PART1_HANDOFF.md,
 * "Under the new model a seller does not need merchant API access at
 * all"). Sellers are paid out later via a separate B2C/disbursement call
 * against their own sellerPayoutAccountsTable number -- see
 * `disburseToSeller()` further down, added in Part 3 (PART3_HANDOFF.md),
 * which reuses this file's SAME token-cache/`withTokenRetry` machinery
 * (see that function's own doc comment for why, and for the important
 * caveat that B2C may turn out to need a different base URL/credential
 * relationship entirely -- see `BKASH_B2C_BASE_URL` below).
 *
 * Shape verified against bKash's own Tokenized Checkout flow (v1.2.0-beta),
 * cross-checked against multiple independent public integration guides
 * (Packagist/GitHub bKash-tokenized-checkout packages, a bKash Payment
 * Gateway walkthrough, and a sandbox-credentials/test-numbers reference) --
 * NOT fetchable directly from developer.bka.sh itself in this environment
 * (robots.txt disallows automated fetching of that domain), so treat the
 * request/response field names below as "verified via multiple independent
 * secondary sources," not "fetched from bKash's own docs directly." Grant
 * Token / Create Payment / Execute Payment / Query Payment field names and
 * flow order were consistent across every source checked. **Before this
 * touches real money, whoever has sandbox/production merchant credentials
 * should confirm the base URLs and field names directly against
 * developer.bka.sh's live reference** -- flagged here and again in
 * PART2_HANDOFF.md, not silently assumed correct.
 *
 * BASE URL — env-var-with-code-default, same convention as
 * lib/courierAdapters/pathao.ts's PATHAO_API_BASE_URL /
 * lib/courierAdapters/steadfast.ts's equivalent (checked both before
 * writing this): BKASH_API_BASE_URL overrides; falls back to bKash's
 * documented sandbox host, NOT production, since defaulting to a live
 * payment endpoint if an operator forgets to set the env var is a much
 * worse failure mode than defaulting to sandbox (which just fails cleanly
 * with "invalid credentials" against a real merchant account, and can't
 * accidentally move real money). This deliberately inverts pathao.ts's own
 * default (which defaults to PRODUCTION) -- documenting why: Pathao's
 * default-prod choice is precedent for the *pattern* (env-var + code
 * default), not for which environment to default to; a courier booking
 * API accidentally hit against production has a very different (much
 * lower) blast radius than a payment API accidentally hit against
 * production. Set BKASH_API_BASE_URL explicitly in production. No
 * sandbox/production *toggle UI* is added anywhere (prompt's explicit
 * instruction) -- this is purely an env var, matching how Pathao/Steadfast
 * base URLs are handled today (grepped .env.example first: neither
 * PATHAO_API_BASE_URL nor a Steadfast equivalent is documented there
 * either, so bKash not being listed there isn't a deviation from
 * precedent).
 */
const BKASH_BASE_URL =
  process.env.BKASH_API_BASE_URL ?? "https://tokenized.sandbox.bka.sh/v1.2.0-beta";

/**
 * B2C/DISBURSEMENT BASE URL — Part 3 of 4 (see PART3_HANDOFF.md). Verified,
 * not assumed, per Part 3's own explicit instruction not to assume this
 * lives under the Tokenized Checkout path family: cross-checked multiple
 * independent sources and they confirm something the Part 3 prompt only
 * hedged as "commonly" true — bKash's B2C/payout product is NOT the same
 * host as Tokenized Checkout at all:
 *
 * - A Packagist Laravel package's own documented config defaults
 *   (mainul12501/bkash-payment-b2c) show THREE separate base-URL families
 *   for three separate bKash products: BKASH_CHECKOUT_*_URL
 *   (checkout.*.bka.sh), BKASH_TOKENIZED_*_URL (tokenized.*.bka.sh -- what
 *   this file's Checkout functions above already use), and
 *   BKASH_PAYOUTS_*_URL (tokenized.*.bka.sh with no version-path suffix --
 *   i.e. still a distinct base even where the hostname happens to
 *   overlap).
 * - Independently, bKash's own public developer-reference site
 *   (developer.bka.sh, surfaced via search result snippets -- the site
 *   itself is robots.txt-blocked from direct fetching, same sourcing
 *   caveat as Part 2's) exposes B2C/payout endpoints under a SEPARATE
 *   subdomain entirely: "openfin.bka.sh" (paths like
 *   "openfin/loanPayout/b2cPayment", "openfin/token/grant",
 *   "openfin/organizationBalance/queryBalance") -- not under
 *   tokenized.bka.sh or checkout.bka.sh at all. This reads as bKash's
 *   institutional/corporate-disbursement product line ("OpenFin"), a
 *   different product surface from the merchant Tokenized Checkout this
 *   file's other functions call -- WITH ITS OWN "openfin/token/grant"
 *   endpoint, meaning it plausibly authenticates against a distinct
 *   credential/onboarding relationship, not guaranteed to be the identical
 *   app_key/app_secret/username/password issued for Tokenized Checkout.
 *
 * These two independent sources don't fully agree with each other on the
 * exact host (one implies a bare "tokenized.bka.sh" payouts host, the
 * other an entirely separate "openfin.bka.sh" host) -- and THAT
 * disagreement is itself the important finding: there is no single,
 * confidently-verifiable B2C base URL from secondary sourcing alone, unlike
 * Tokenized Checkout's URL, which was consistent across every source Part 2
 * checked. Flagged loudly rather than silently picking one and moving on.
 * **Given this ambiguity, `disburseToSeller()` below defaults to the SAME
 * `BKASH_API_BASE_URL`-derived tokenized host as Checkout (the option that
 * lets this codebase's existing single BKASH_API_BASE_URL env var keep
 * working without a second required var in the common case), but is
 * trivially overridable via a SEPARATE env var, `BKASH_B2C_API_BASE_URL`,
 * specifically so that whoever holds real merchant-onboarding paperwork can
 * point this at the correct host (very possibly openfin.bka.sh, per above)
 * without touching code once bKash confirms which product line this
 * platform was actually onboarded for.** Do not treat the code default
 * below as confirmed correct — it is a reasonable placeholder given
 * conflicting secondary sources, not a verified endpoint. See
 * PART3_HANDOFF.md for the full writeup of this ambiguity, including why it
 * matters more here than it did for Part 2's Checkout URL.
 */
const BKASH_B2C_BASE_URL = process.env.BKASH_B2C_API_BASE_URL ?? BKASH_BASE_URL;

interface BkashTokenResponse {
  id_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  statusCode?: string;
  statusMessage?: string;
}

interface BkashCreatePaymentResponse {
  paymentID?: string;
  bkashURL?: string;
  callbackURL?: string;
  successCallbackURL?: string;
  failureCallbackURL?: string;
  cancelledCallbackURL?: string;
  amount?: string;
  currency?: string;
  intent?: string;
  merchantInvoiceNumber?: string;
  statusCode?: string;
  statusMessage?: string;
}

interface BkashExecutePaymentResponse {
  paymentID?: string;
  trxID?: string;
  transactionStatus?: string;
  amount?: string;
  currency?: string;
  merchantInvoiceNumber?: string;
  paymentExecuteTime?: string;
  statusCode?: string;
  statusMessage?: string;
}

interface BkashQueryPaymentResponse {
  paymentID?: string;
  trxID?: string;
  transactionStatus?: string;
  amount?: string;
  currency?: string;
  merchantInvoiceNumber?: string;
  statusCode?: string;
  statusMessage?: string;
}

/**
 * B2C/disbursement response shape -- Part 3. Field names cross-checked
 * against multiple independent B2C payout guides/packages (see
 * `disburseToSeller()`'s own doc comment for the full sourcing writeup);
 * every source checked used the SAME response shape as Tokenized
 * Checkout's own execute/query responses (trxID + transactionStatus +
 * statusCode/statusMessage), which is one of the few things about B2C this
 * environment could verify with real confidence across sources, even
 * though the request field names and base URL are less certain (see
 * `receiverMSISDN` note on `disburseToSeller`'s input and
 * `BKASH_B2C_BASE_URL` above).
 */
interface BkashB2CPaymentResponse {
  paymentID?: string;
  trxID?: string;
  transactionStatus?: string;
  amount?: string;
  currency?: string;
  merchantInvoiceNumber?: string;
  receiverMSISDN?: string;
  statusCode?: string;
  statusMessage?: string;
}

export class BkashApiError extends Error {
  constructor(
    message: string,
    public readonly step: "grant" | "refresh" | "create" | "execute" | "query" | "disburse" | "config",
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = "BkashApiError";
  }
}

/**
 * TOKEN CACHING STRATEGY — judgment call, documented per the prompt's
 * explicit ask ("decide and document a sensible in-memory caching
 * strategy... document the reasoning for whatever TTL/refresh approach you
 * pick since this isn't specified anywhere in this repo today").
 *
 * bKash's own docs (via the secondary sources checked -- see module doc
 * comment) describe id_token as valid ~1 hour and refresh_token as valid
 * ~28-30 days from grant. This module caches both in a single in-memory
 * module-level variable (there is only ever ONE bKash merchant account --
 * platformPaymentConfigTable is a physical singleton, see its schema doc
 * comment -- so a single unkeyed cache slot is correct here, unlike
 * per-seller courier credentials which would need a Map keyed by
 * sellerId).
 *
 * Refresh-before-expiry with a safety margin: treats id_token as expired
 * 60 seconds before its actual expiry (rather than waiting for a live 401)
 * so a checkout request doesn't race a token that expires mid-flight. If a
 * call still gets a 401 despite that margin (clock drift, bKash revoking
 * early, etc.), getValidToken() retries ONCE via grantToken() from
 * scratch (not just refreshToken()) -- a 401 on a token we believed was
 * valid means we can't trust our own cached refresh_token's validity
 * either, so re-granting from the credentials is the safer fallback than
 * chaining a refresh off a token that just failed.
 *
 * Process-local, not persisted (no Redis/DB row for this) -- deliberate:
 * this environment has no such store wired up for anything else either
 * (grepped for a caching layer used elsewhere in api-server; there isn't
 * one), and a cold-start re-grant on process restart is a one-time cost of
 * a single extra API call, not a correctness problem. A multi-instance
 * deployment would each maintain their own cache and each grant
 * independently on cold start -- acceptable (bKash's grant endpoint has no
 * documented one-token-globally-active constraint in any source checked),
 * but flagged here in case a future multi-instance deploy wants a shared
 * cache instead.
 */
let cachedToken: { idToken: string; refreshToken: string; expiresAt: number } | null = null;

/**
 * BUGFIX follow-up (see PART4_FIX_HANDOFF.md): a credential rotation (POST
 * /platform-payment-config) resets isVerified to false in the DB, but
 * never cleared THIS in-memory cache -- a token granted under the OLD
 * credentials could still be reused (it's just a string; nothing ties it
 * back to which credential set produced it) until it naturally expired.
 * Narrow window, not the circular bug this follow-up primarily fixes, but
 * cheap to close correctly rather than leave as a latent gap. Called by
 * the POST route immediately after a successful credential replacement.
 */
export function clearCachedToken(): void {
  cachedToken = null;
}

/**
 * BUGFIX (Part 4 follow-up — see PART4_FIX_HANDOFF.md): this function used
 * to also throw when `isVerified` was false, which made it impossible for
 * ANY caller — including grantToken() itself — to ever reach bKash while
 * unverified. That made the admin "Test Connection" route (which calls
 * grantToken() specifically IN ORDER TO become verified for the first
 * time) permanently self-defeating: it could only succeed on a config
 * that was already verified, i.e. never on the one case it exists to
 * handle. This function now ONLY checks that a config row exists at all
 * (still required — there is nothing to decrypt otherwise). The
 * `isVerified` check has moved to `assertPlatformVerified()` below, called
 * from `withTokenRetry()`, which is the real chokepoint for every
 * MONEY-MOVING call (createPayment, executePayment, queryPayment,
 * disburseToSeller). grantToken() and refreshToken() — pure auth
 * handshakes that move no money and are the mechanism BY WHICH
 * verification is established — no longer go through that gate.
 */
async function loadPlatformCredentials(): Promise<{
  appKey: string;
  appSecret: string;
  username: string;
  password: string;
}> {
  const [config] = await db.select().from(platformPaymentConfigTable).limit(1);
  if (!config) {
    throw new BkashApiError(
      "Platform bKash merchant account is not configured yet (platform_payment_config has no row).",
      "config",
    );
  }
  // Decrypted at call-time only, held in local variables for the duration
  // of a single request, never logged, never returned from this module --
  // see this file's top-level doc comment and credentialEncryption.ts's
  // own "never log decrypted credentials" convention.
  return {
    appKey: decryptCredential(config.merchantAppKey),
    appSecret: decryptCredential(config.merchantAppSecret),
    username: decryptCredential(config.merchantUsername),
    password: decryptCredential(config.merchantPassword),
  };
}

/**
 * The real "is this platform allowed to move money yet" gate — see the
 * bugfix note on loadPlatformCredentials() above for why this check lives
 * here now instead of there. Called from withTokenRetry() below, so every
 * money-moving call (createPayment/executePayment/queryPayment/
 * disburseToSeller — anything that goes through withTokenRetry) is
 * gated, while grantToken()/refreshToken() (called directly by the admin
 * verify route, and internally by getValidToken()) are not.
 */
async function assertPlatformVerified(): Promise<void> {
  const [config] = await db.select().from(platformPaymentConfigTable).limit(1);
  if (!config) {
    throw new BkashApiError(
      "Platform bKash merchant account is not configured yet (platform_payment_config has no row).",
      "config",
    );
  }
  if (!config.isVerified) {
    throw new BkashApiError(
      'Platform bKash merchant account exists but is not verified (isVerified=false). Refusing to call bKash with unverified credentials. An admin must use "Test Connection" successfully first.',
      "config",
    );
  }
}

/**
 * Grants a fresh id_token/refresh_token pair from bKash using the
 * platform's stored credentials, and updates the module-level cache.
 * Exported (not just used internally) so a route can force a fresh grant
 * explicitly if needed (e.g. an admin "test connection" action in a future
 * part), though nothing in this part's own routes calls it directly --
 * they go through getValidToken() below.
 */
export async function grantToken(): Promise<{ idToken: string; refreshToken: string }> {
  const { appKey, appSecret, username, password } = await loadPlatformCredentials();

  const res = await fetch(`${BKASH_BASE_URL}/tokenized/checkout/token/grant`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      username,
      password,
    },
    body: JSON.stringify({ app_key: appKey, app_secret: appSecret }),
  });

  const data = (await res.json().catch(() => ({}))) as BkashTokenResponse;
  if (!res.ok || !data.id_token || !data.refresh_token) {
    throw new BkashApiError(
      `bKash grant token failed (HTTP ${res.status}): ${data.statusMessage ?? "no id_token/refresh_token in response"}`,
      "grant",
      data,
    );
  }

  const ttlSeconds = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600; // conservative default -- see module doc comment
  cachedToken = {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
  return { idToken: data.id_token, refreshToken: data.refresh_token };
}

/**
 * Refreshes an id_token using a still-valid refresh_token, per bKash's
 * documented refresh flow (avoids a full re-grant -- including a fresh
 * username/password call -- on every expiry). Requires app_key/app_secret
 * again (per every integration guide checked; bKash's refresh endpoint
 * takes the same app credentials as grant, plus the refresh_token itself).
 */
export async function refreshToken(refreshTokenValue: string): Promise<{ idToken: string; refreshToken: string }> {
  const { appKey, appSecret } = await loadPlatformCredentials();

  const res = await fetch(`${BKASH_BASE_URL}/tokenized/checkout/token/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ app_key: appKey, app_secret: appSecret, refresh_token: refreshTokenValue }),
  });

  const data = (await res.json().catch(() => ({}))) as BkashTokenResponse;
  if (!res.ok || !data.id_token) {
    throw new BkashApiError(
      `bKash refresh token failed (HTTP ${res.status}): ${data.statusMessage ?? "no id_token in response"}`,
      "refresh",
      data,
    );
  }

  const ttlSeconds = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
  // bKash's refresh response may or may not include a new refresh_token
  // (sources disagree / are ambiguous on this) -- keep the old one if a
  // new one isn't returned, rather than assuming it must be there.
  const nextRefreshToken = data.refresh_token ?? refreshTokenValue;
  cachedToken = {
    idToken: data.id_token,
    refreshToken: nextRefreshToken,
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
  return { idToken: data.id_token, refreshToken: nextRefreshToken };
}

// 60-second safety margin before real expiry -- see module doc comment.
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * Returns a currently-valid id_token, granting or refreshing as needed.
 * This is what createPayment/executePayment/queryPayment actually call --
 * callers of THIS module never need to think about grant vs. refresh
 * themselves.
 */
async function getValidToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return cachedToken.idToken;
  }
  if (cachedToken?.refreshToken) {
    try {
      const { idToken } = await refreshToken(cachedToken.refreshToken);
      return idToken;
    } catch {
      // Refresh failed (expired refresh_token, revoked, etc.) -- fall
      // through to a full re-grant rather than propagating the refresh
      // failure directly, since a full grant is the correct recovery path
      // here, not a dead end.
    }
  }
  const { idToken } = await grantToken();
  return idToken;
}

/**
 * Wraps a bKash API call with one 401-triggered retry: if the call fails
 * because our cached token turned out to be invalid despite our own TTL
 * bookkeeping (clock drift, bKash-side early revocation, etc.), force a
 * full re-grant (not just a refresh -- see module doc comment on why) and
 * retry exactly once. A second failure propagates as a real error.
 */
async function withTokenRetry<T>(fn: (idToken: string, appKey: string) => Promise<{ res: Response; data: T }>): Promise<{ res: Response; data: T }> {
  // BUGFIX (Part 4 follow-up): the isVerified gate lives here now, not in
  // loadPlatformCredentials() — see that function's doc comment. This is
  // the real chokepoint every money-moving call goes through.
  await assertPlatformVerified();
  const { appKey } = await loadPlatformCredentials();
  let idToken = await getValidToken();
  let result = await fn(idToken, appKey);
  if (result.res.status === 401) {
    await grantToken();
    idToken = await getValidToken();
    result = await fn(idToken, appKey);
  }
  return result;
}

export interface CreatePaymentInput {
  amount: number;
  invoiceNumber: string;
  callbackURL: string;
}

export interface CreatePaymentResult {
  paymentID: string;
  bkashURL: string;
}

/**
 * Create Payment — creates a bKash payment INTENT and returns the hosted
 * URL the buyer must be sent to. Does NOT complete the payment (see this
 * repo's prompt/handoff docs for the full 3-moment flow: create -> buyer
 * authorizes on bKash's own page -> execute). amount is formatted as a
 * fixed 2-decimal string per every integration guide checked (bKash's API
 * expects amount as a STRING, not a JSON number).
 */
export async function createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
  const { res, data } = await withTokenRetry<BkashCreatePaymentResponse>(async (idToken, appKey) => {
    const r = await fetch(`${BKASH_BASE_URL}/tokenized/checkout/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        authorization: idToken,
        "x-app-key": appKey,
      },
      body: JSON.stringify({
        mode: "0011", // Tokenized Checkout mode, per every source checked
        payerReference: input.invoiceNumber,
        callbackURL: input.callbackURL,
        amount: input.amount.toFixed(2),
        currency: "BDT",
        intent: "sale",
        merchantInvoiceNumber: input.invoiceNumber,
      }),
    });
    const d = (await r.json().catch(() => ({}))) as BkashCreatePaymentResponse;
    return { res: r, data: d };
  });

  if (!res.ok || !data.paymentID || !data.bkashURL) {
    throw new BkashApiError(
      `bKash create payment failed (HTTP ${res.status}): ${data.statusMessage ?? "no paymentID/bkashURL in response"}`,
      "create",
      data,
    );
  }
  return { paymentID: data.paymentID, bkashURL: data.bkashURL };
}

export interface ExecutePaymentResult {
  paymentID: string;
  trxID: string;
  transactionStatus: string;
  amount: string;
}

/**
 * Execute Payment — the call that actually finalizes a payment after the
 * buyer completes authorization on bKash's hosted page. Returns the real
 * trxID (transaction id) to store in orders.transactionId, replacing the
 * old buyer-typed value.
 *
 * transactionStatus is returned AS-IS from bKash (not normalized to our
 * own enum here) -- routes/bkashPayment.ts's callback handler is
 * responsible for mapping bKash's "Completed"/other values onto
 * orders.paymentStatus, since that mapping is a routing/business-logic
 * decision, not this client's job (mirrors courierAdapters' separation:
 * the adapter returns a normalized-ISH shape but the actual order-status
 * side-effect decision lives in the route, per courierWebhooks.ts).
 */
export async function executePayment(input: { paymentID: string }): Promise<ExecutePaymentResult> {
  const { res, data } = await withTokenRetry<BkashExecutePaymentResponse>(async (idToken, appKey) => {
    const r = await fetch(`${BKASH_BASE_URL}/tokenized/checkout/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        authorization: idToken,
        "x-app-key": appKey,
      },
      body: JSON.stringify({ paymentID: input.paymentID }),
    });
    const d = (await r.json().catch(() => ({}))) as BkashExecutePaymentResponse;
    return { res: r, data: d };
  });

  if (!res.ok || !data.trxID || !data.transactionStatus) {
    throw new BkashApiError(
      `bKash execute payment failed (HTTP ${res.status}): ${data.statusMessage ?? "no trxID/transactionStatus in response"}`,
      "execute",
      data,
    );
  }
  return {
    paymentID: data.paymentID ?? input.paymentID,
    trxID: data.trxID,
    transactionStatus: data.transactionStatus,
    amount: data.amount ?? "",
  };
}

export interface QueryPaymentResult {
  paymentID: string;
  trxID: string | null;
  transactionStatus: string;
  amount: string;
  // Our own orders.trackingId, round-tripped through bKash as
  // merchantInvoiceNumber at Create Payment time -- routes/bkashPayment.ts's
  // callback handler uses this to find which order a paymentID belongs to
  // when it doesn't already know (see that route's doc comment).
  merchantInvoiceNumber: string | null;
}

/**
 * Query Payment — independent status check, for reconciliation/debugging
 * when the callback never fires (network blip, buyer closed the tab after
 * paying, etc.). Does NOT execute/finalize anything itself -- purely a
 * read. See routes/bkashPayment.ts's GET /bkash/query-payment/:paymentID
 * for the (admin-gated) route that exposes this.
 */
export async function queryPayment(input: { paymentID: string }): Promise<QueryPaymentResult> {
  const { res, data } = await withTokenRetry<BkashQueryPaymentResponse>(async (idToken, appKey) => {
    const r = await fetch(`${BKASH_BASE_URL}/tokenized/checkout/payment/status/${encodeURIComponent(input.paymentID)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        authorization: idToken,
        "x-app-key": appKey,
      },
    });
    const d = (await r.json().catch(() => ({}))) as BkashQueryPaymentResponse;
    return { res: r, data: d };
  });

  if (!res.ok || !data.transactionStatus) {
    throw new BkashApiError(
      `bKash query payment failed (HTTP ${res.status}): ${data.statusMessage ?? "no transactionStatus in response"}`,
      "query",
      data,
    );
  }
  return {
    paymentID: data.paymentID ?? input.paymentID,
    trxID: data.trxID ?? null,
    transactionStatus: data.transactionStatus,
    amount: data.amount ?? "",
    merchantInvoiceNumber: data.merchantInvoiceNumber ?? null,
  };
}

/**
 * PHONE NUMBER NORMALIZATION FOR B2C — Part 3, resolving the open question
 * Part 1's sellerPayoutAccounts.ts doc comment explicitly left unanswered
 * ("no existing convention in this codebase normalizes phone numbers to a
 * single canonical form"). This is the first real consumer that sends a
 * seller's stored bkashNumber to an external API expecting a specific
 * format, so it decides the format HERE, at call-time, rather than
 * rewriting the stored value -- same "decrypt/transform at call-time only"
 * spirit as credentialEncryption.ts's decryptCredential() and this file's
 * own loadPlatformCredentials() (never persist a transformed/decrypted
 * value back to the row it came from).
 *
 * CHOSEN FORMAT: bare 11-digit local form (`01XXXXXXXXX`, no country-code
 * prefix), NOT `+880`/`880`-prefixed. Reasoning, since this wasn't
 * something any single source stated as a hard rule:
 *
 * - Every independent B2C/payout integration source checked while writing
 *   this function (a Packagist Laravel B2C package's example payload, an
 *   independent PHP B2C helper package's parameter documentation) shows
 *   the receiver-number field populated with the bare local form
 *   (`017XXXXXXXX` / `01XXXXXXXXX`), not a `+880`-prefixed one, in every
 *   example available -- consistent with bKash's own Tokenized Checkout
 *   `customerMsisdn` field observed elsewhere (Part 2's sourcing, and this
 *   part's own Search Transaction guide fetch) also always appearing as
 *   bare local-form digits (e.g. "01770618575"), never `+880`-prefixed,
 *   across every bKash-shaped API response sampled.
 * - This is the OPPOSITE of whatsapp.ts's own `+880` prefixing choice --
 *   flagged explicitly rather than silently matching that file's
 *   convention, since whatsapp.ts is normalizing for Twilio's international
 *   E.164 requirement, a different external API with a different documented
 *   format expectation. "Match an existing convention" doesn't mean
 *   anything useful when the two existing precedents in this codebase
 *   (Twilio's E.164 need vs. bKash's own MSISDN examples) point opposite
 *   directions for opposite reasons -- this picks the one that matches
 *   bKash's OWN observed field shape, not whichever existing file was
 *   written first.
 * - `sellerPayoutAccountsTable.bkashNumber` is stored post-`isValidBdPhone`
 *   check (Part 1), which accepts an optional `+880`/`880`/`0` leading form
 *   -- so a stored value may legitimately start with any of those three.
 *   This function strips a leading `+880` or `880` down to a bare `0`
 *   prefix (mirrors whatsapp.ts's own "strip anything non-digit, then
 *   inspect the prefix" instinct, just normalizing to the opposite target
 *   shape) rather than assuming the stored value is already bare-local.
 *
 * Documented here AND in sellerPayoutAccounts.ts's own doc comment (see
 * that file's Part 3 addendum) per the prompt's explicit instruction, since
 * this was left open specifically for whoever built this part.
 */
export function normalizeMsisdnForB2C(rawStored: string): string {
  const digitsOnly = rawStored.replace(/[^\d]/g, "");
  if (digitsOnly.startsWith("880") && digitsOnly.length === 13) {
    return `0${digitsOnly.slice(3)}`;
  }
  if (digitsOnly.startsWith("0") && digitsOnly.length === 11) {
    return digitsOnly;
  }
  // Anything else (unexpected length/shape) is passed through as
  // digits-only rather than thrown on here -- this function's job is
  // format normalization, not (re-)validation; isValidBdPhone() already
  // gated what could be stored in the first place at write-time (Part 1).
  // A malformed number reaching bKash will surface as a real bKash-side
  // rejection, which disburseToSeller()'s caller (courierWebhooks.ts, Part
  // 3) already handles as a normal "failed" payout outcome, not a crash.
  return digitsOnly;
}

export interface DisburseToSellerInput {
  amount: number;
  receiverNumber: string;
  reference: string;
}

export interface DisburseToSellerResult {
  trxID: string;
  transactionStatus: string;
  amount: string;
}

/**
 * B2C/Disbursement — Part 3 of 4 (see PART3_HANDOFF.md). Sends money OUT of
 * the platform's merchant account to a seller's bKash number after courier
 * delivery is confirmed (see routes/courierWebhooks.ts's delivered-
 * transition branch, this function's only caller). Distinct bKash PRODUCT
 * from everything else in this file (Create/Execute/Query Payment are all
 * Tokenized Checkout, the buyer-facing collection side) -- but the SAME
 * platform merchant account making the call, per the Part 3 prompt's own
 * framing, which is why this reuses `withTokenRetry`/`getValidToken`/
 * `loadPlatformCredentials` rather than duplicating a second token-cache
 * module. **Important, flagged rather than glossed over**: reusing the
 * token machinery is a call reused, not a certainty that it's correct --
 * see `BKASH_B2C_BASE_URL`'s own doc comment above for why this platform's
 * B2C product may turn out to need an entirely separate onboarding/
 * credential relationship (bKash's "OpenFin" product line, per sourcing)
 * with its own grant endpoint. If that's true, this function's reuse of
 * `withTokenRetry` will fail cleanly (401/403 from bKash, surfaced as a
 * BkashApiError with step "disburse") rather than silently sending money
 * with a wrong/expired token -- whoever verifies against real credentials
 * should treat a persistent auth failure here as a signal to check that,
 * not just retry harder.
 *
 * Request field names (`amount`, `merchantInvoiceNumber`, `receiverMSISDN`)
 * cross-checked against multiple independent B2C-specific sources (a
 * Packagist Laravel B2C package's example payload, an independent PHP B2C
 * helper package's parameter list) -- both agreed on this exact field set
 * for the B2C request body, which is more directly relevant here than
 * Part 2's Tokenized Checkout sourcing was (that covered Create/Execute/
 * Query Payment, not B2C at all). `amount` sent as a fixed 2-decimal
 * STRING, matching every bKash-shaped request body observed across both
 * Checkout and B2C sources (never a JSON number). No `currency` field
 * needed in the request body per those same B2C-specific sources (unlike
 * Checkout's create-payment body, which does take one) -- BDT is implied;
 * flagged as one more thing to verify against real onboarding docs, not
 * silently assumed.
 *
 * `reference` is passed as `merchantInvoiceNumber`, matching every B2C
 * source's field name for it. This part's caller (courierWebhooks.ts)
 * passes the ORDER's trackingId here, NOT the seller's -- one order, one
 * payout attempt, one invoice number, mirroring how Part 2's Checkout
 * already uses trackingId as ITS merchantInvoiceNumber for the buyer-side
 * leg of the same order.
 */
export async function disburseToSeller(input: DisburseToSellerInput): Promise<DisburseToSellerResult> {
  const receiverMSISDN = normalizeMsisdnForB2C(input.receiverNumber);

  const { res, data } = await withTokenRetry<BkashB2CPaymentResponse>(async (idToken, appKey) => {
    const r = await fetch(`${BKASH_B2C_BASE_URL}/tokenized/checkout/b2c/payment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        authorization: idToken,
        "x-app-key": appKey,
      },
      body: JSON.stringify({
        amount: input.amount.toFixed(2),
        merchantInvoiceNumber: input.reference,
        receiverMSISDN,
      }),
    });
    const d = (await r.json().catch(() => ({}))) as BkashB2CPaymentResponse;
    return { res: r, data: d };
  });

  if (!res.ok || !data.trxID || !data.transactionStatus) {
    throw new BkashApiError(
      `bKash B2C disbursement failed (HTTP ${res.status}): ${data.statusMessage ?? "no trxID/transactionStatus in response"}`,
      "disburse",
      data,
    );
  }

  return {
    trxID: data.trxID,
    transactionStatus: data.transactionStatus,
    amount: data.amount ?? input.amount.toFixed(2),
  };
}
