# Phase 8 Handoff — Real-Database Verification Pass

## What this covers
Nothing in this project had ever been tested against a live Postgres
database before this session — every prior phase's "verified" claim was
structural only (typecheck, build, boot-to-DATABASE_URL-failure). This
session provisioned a real Postgres instance, ran the actual schema push
against it, and wrote + ran a real script-level integration test exercising
core business logic with no HTTP/auth layer. No feature work was done.

## Verified, not assumed (re-run at the start of this session, before any code)
- `pnpm install --frozen-lockfile` — clean.
- Checked for stale `.tsbuildinfo` files per the task brief's warning —
  **none existed in the zip.** (Three `tsconfig.tsbuildinfo` files appeared
  under `lib/*` immediately afterward, but only as output of this session's
  own first `pnpm run typecheck` run — confirmed by timing, not assumed.)
- `pnpm run typecheck` (full workspace, all 4 packages) — clean from a cold
  start.
- Real `vite build` in `artifacts/tree-friend` — succeeds.
  `SellerDashboardPage` = **44.18 kB** (gzip 9.96 kB) — matches Phase 7's
  reported post-session number exactly, confirming no drift between the
  zip's actual contents and Phase 7's own report.
- Real `node build.mjs` in `artifacts/api-server` — succeeds. `dist/index.mjs`
  = **11.8 MB**, matching Phase 7's reported size exactly.
- Boot test with no env vars — fails **only** on missing `DATABASE_URL`, as
  every prior phase reported.
- Re-ran full workspace typecheck a second time at the end of this session
  (after adding the one new script file) — still clean, confirming the new
  file didn't break anything elsewhere in the workspace.
- Confirmed by direct `find`/manual diff (no git repo in this zip, so
  compared file-by-file) that the **only** two files touched this session
  are `scripts/src/verify-seller-marketplace.ts` (new) and
  `scripts/package.json` (one new script entry). `cart.ts`,
  `CheckoutPage.tsx`, `sellerPaymentConfigs.ts`, and `adminSellers.ts` are
  byte-for-byte untouched, per the brief's explicit scope boundary.

## What was built

### 1. Real Postgres, actually provisioned
No Postgres, Docker, or any DB tooling pre-existed in this sandbox. It was
achievable, so it was provisioned rather than skipped:
- Installed `postgresql-16` + `postgresql-contrib` from the standard Ubuntu
  archive (`archive.ubuntu.com` — already in this environment's network
  allowlist; the separate `deb.nodesource.com` repo is **not** allowlisted
  and 403'd, but wasn't needed).
- Started the cluster via `pg_ctlcluster 16 main start` (the raw
  `pg_ctl`/data-directory approach fails in this environment because Debian's
  packaging splits config into `/etc/postgresql/16/main/`, separate from the
  data directory — `pg_ctlcluster` is the tool that knows about that split).
- Created a `treefriend` database, set a password on the `postgres` role,
  and confirmed TCP+password auth works end-to-end
  (`host ... 127.0.0.1/32 scram-sha-256` in `pg_hba.conf` — already the
  default, no config edits needed).
- `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/treefriend`
  is the connection string used for every step below. The cluster is not
  necessarily still running in a future session's fresh container — if this
  environment resets, a future session needs to redo the install +
  `pg_ctlcluster ... start` steps (a few minutes of work, all commands
  above are copy-pasteable).

### 2. Schema push — ran for real, succeeded
`pnpm run push` (in `lib/db`, via `drizzle-kit push --config
./drizzle.config.ts`) against the live database:
```
[✓] Pulling schema from database...
[✓] Changes applied
```
No errors, no interactive conflict prompts. Confirmed via `\dt` that **all
36 tables** exist, including every one the task brief named explicitly:
`seller_listings`, `seller_payment_configs`, `seller_courier_configs`,
`order_shipments`, `listing_attribute_options`, and `reviews` (with its
`seller_listing_id` column). Read `\d` output directly (not just row counts)
for `reviews`, `seller_listings`, `seller_payment_configs`,
`seller_courier_configs`, and `order_shipments` — every column, FK, and
constraint matches the Drizzle schema source exactly. This closes the
category of bug the brief specifically named ("a schema that typechecks in
Drizzle can still fail to push") — it did not fail, but this is now an
actually-confirmed fact rather than an assumption.

### 3. Real script-level integration test
New file: **`scripts/src/verify-seller-marketplace.ts`**, registered as
`pnpm --filter @workspace/scripts run verify-seller-marketplace` (added the
one-line entry to `scripts/package.json`, following the exact convention of
`hello`/`seed`). Follows `seed.ts`'s established pattern exactly — direct
`@workspace/db` imports, no HTTP layer, no auth, self-cleans on every run
(re-runnable — confirmed by literally running it twice in a row, both
clean).

**Run twice against the real database, final result both times: 17 passed,
0 failed.** Full transcript of the final run:
```
--- 1. seller/category/product/listing creation ---
  PASS: seller row created with status=active
  PASS: second seller row created
  PASS: category created
  PASS: product created
  PASS: seller_listing created against seller 1
  PASS: seller_listing created against seller 2 (same product)

--- 2. hasVerifiedPaymentConfig() real-query behavior ---
  PASS: hasVerifiedPaymentConfig() returns false when isVerified=false
  PASS: hasVerifiedPaymentConfig() returns true after flipping isVerified=true

--- 3. cart_items across two sellers -> groupBySellerAndAllocateDiscount ---
  PASS: real cart query returns 2 rows
  PASS: groupBySellerAndAllocateDiscount produces 2 separate order groups
  PASS: seller1 group subtotal = 1000
  PASS: seller2 group subtotal = 300
  PASS: full discount (100) allocated to the larger group (seller1), not split

--- 4. DB-level uniqueness assumptions behind delete-then-insert routes ---
  PASS: seller_payment_configs: DB rejects a 2nd row for the same seller (unique constraint enforced)
  PASS: seller_courier_configs: DB allows a 2nd row for the same seller (NO unique constraint -- confirms the gap, does not fix it)
  PASS: seller_courier_configs now has 2 row(s) for seller1 (expected 2, confirming no DB-level guard)

--- 5. reviews unique constraint (one review per buyer per listing) ---
  PASS: reviews table has a unique constraint on (seller_listing_id, user_id)

=== Results: 17 passed, 0 failed ===
```

What each section actually exercises, against real data:
- **§1**: real INSERTs for two sellers, a shared category/product, and one
  `seller_listings` row per seller against that same product — proves the
  "many sellers, one variety" structural claim from the plan doc actually
  works at the DB level, not just in the schema definition.
- **§2**: `hasVerifiedPaymentConfig()` from `sellerListings.ts` is not
  exported (module-local), so its exact query shape was reimplemented
  verbatim in the script and run against a real row — `false` before
  `isVerified` is flipped, `true` after, via a real `UPDATE` in between.
- **§3**: real `cart_items` rows across two different sellers, joined
  against `seller_listings` with a real query, then run through a verbatim
  reimplementation of `groupBySellerAndAllocateDiscount` (also module-local
  to `orders.ts`, not exported — see "Flagged" section below for the risk
  this creates). Confirms two separate order groups, correct per-seller
  subtotals, and that a shared discount goes entirely to the larger group
  rather than being split — matching the doc comment's stated design.
- **§4**: the actual finding of this session (see below) — attempted a
  real duplicate INSERT against both config tables to test whether the
  "at most one row per seller, delete-then-insert" assumption every route
  makes is backed by an actual DB constraint or just application code.
- **§5**: confirmed via `pg_constraint` (not just the `\d` output already
  eyeballed) that `reviews_seller_listing_user_unique` exists, matching the
  plan doc §3b's "a buyer can only review a listing they purchased" intent
  at the mechanism level (one review row per buyer per listing).

### 4. A real finding: `seller_courier_configs` has no unique constraint on `seller_id`
Confirmed at the DB level, not guessed from reading code:
- `seller_payment_configs` schema (`sellerPaymentConfigs.ts`) declares
  `.unique()` on `sellerId`. The live DB has
  `seller_payment_configs_seller_id_unique` as a real `UNIQUE CONSTRAINT`
  (confirmed via `\d` and via a real duplicate-insert attempt in the script,
  which correctly failed with Postgres error `23505`,
  `duplicate key value violates unique constraint`).
- `seller_courier_configs` schema (`sellerCourierConfigs.ts`) has **no**
  `.unique()` call on `sellerId` anywhere in the file — read directly, not
  inferred. The live DB confirms this: a second `INSERT` for the same
  `sellerId` with a different provider **succeeded**, leaving 2 rows for
  one seller.
- `routes/sellerCourierConfigs.ts` still does delete-then-insert (same
  "at most one config" assumption `sellerPaymentConfigs.ts` makes, per that
  file's own comment: *"Delete-then-insert here for symmetry with
  sellerCourierConfigs.ts"*). That assumption is enforced by the payment
  table's DB constraint but **not** by the courier table's — nothing stops
  two courier-config rows existing for one seller if that route is ever
  raced (two concurrent requests) or bypassed (a future direct-DB script,
  an admin tool, a bug). `orderShipments.ts`'s courier-booking query
  (`.where(eq(sellerCourierConfigsTable.sellerId, ...))` with no `.limit(1)`
  visible at the call site — worth a future session double-checking
  whether it takes the first row nondeterministically if 2 ever exist)
  would silently pick whichever row Postgres returns first in that case.
- This is a real schema-level gap, not a checkout-side gap, so it's
  reported here rather than deferred — but **no fix was applied**, per this
  session's explicit read-only/verification-only scope. A future session
  should add `.unique()` to `sellerCourierConfigs.ts`'s `sellerId` column
  and push a migration, mirroring the payment table exactly.

### 5. A bug in this session's own verification script, caught and fixed (disclosed, not smoothed over)
The first run of the duplicate-insert check for `seller_payment_configs`
reported a **false FAIL** — 16 passed, 1 failed. Investigated directly
rather than assumed either "the code is broken" or "the test is probably
fine":
- Wrote a standalone repro script, ran it against the same live DB, and
  inspected the raw thrown error's shape.
- Root cause: Drizzle wraps the real driver error in `DrizzleQueryError`,
  whose own `.message` is the **query text** (`"Failed query: insert
  into..."`), not the Postgres error. The actual error — including
  `.code === "23505"` (`unique_violation`) and the real message
  (`"duplicate key value violates unique constraint ..."`) — lives on
  `err.cause`, not `err.message`.
- The script's original catch block checked `err.message` for
  `/unique|duplicate/i`, which never matched, so it silently misread a
  real, correctly-enforced constraint as "missing."
- Fixed to check `err.cause?.code === "23505"` first (with the regex on
  `.cause` as a fallback). Re-ran: 17/17 pass, confirmed by directly
  inspecting `err.cause` in the standalone repro before trusting the fix,
  not just re-running and accepting a green result.
- Flagging this because it's exactly the failure mode "structural
  verification only" produces at one level higher: even a real-DB test can
  give a false result if the error-handling around it is wrong, and the
  only way to catch that here was to actually look at what Postgres sent
  back, not just trust the test's own pass/fail label.

## What remains structurally-verified-only (explicitly, per the brief's request)
- **No HTTP-level testing occurred.** Every route handler's actual request
  parsing, `requireSeller`/`requireAuth` middleware behavior, Zod/OpenAPI
  validation, and response shape are still only typecheck/build-verified,
  not exercised. This was explicitly out of reach per the brief (no Clerk
  credentials in this sandbox, no test-auth bypass in `auth.ts`/`mobileJwt.ts`
  — read directly, confirmed neither file has one).
- `groupBySellerAndAllocateDiscount` and `hasVerifiedPaymentConfig` are
  **not exported** from `orders.ts`/`sellerListings.ts`. This script
  reimplements their logic verbatim rather than importing them, because (a)
  they aren't exported and (b) exporting them would mean editing
  `orders.ts`, which sits adjacent to the checkout files this session was
  told not to touch. **Risk to flag explicitly:** if a future session
  changes either function's real implementation without updating this
  script's copy, the two will silently drift and this test will keep
  passing against stale logic. The safer long-term fix — exporting both
  functions and importing them here — is exactly the kind of change that
  should happen as part of the future checkout-focused session, not this
  one.
- Cloudinary upload round-trips, live bKash/Pathao/Steadfast credential
  checks, and the courier/payment webhook adapters are untested here (no
  credentials exist in this sandbox) — unchanged from every prior phase's
  caveat.
- Order-completion → review-eligibility flow (a buyer can only review a
  listing they've actually purchased, per plan §3b) was **not** exercised
  end-to-end — this session confirmed the `reviews` table's unique
  constraint exists at the DB level, but did not create a real completed
  order + review row to test the "only after purchase" business rule,
  since that logic likely lives in a route handler this session didn't
  need to touch to answer the brief's specific ask.

## Explicitly out of scope (per this session's brief)
- `cart.ts`, `CheckoutPage.tsx`, `sellerPaymentConfigs.ts`'s delete route,
  `adminSellers.ts`'s unverify route — untouched, confirmed by file-diff
  above.
- No feature work, no bug fixes to application code — this was a
  verification-only session. The `seller_courier_configs` unique-constraint
  gap found in §4 above is reported, not fixed.

## Flagged for a future session
1. **`seller_courier_configs.seller_id` needs a `.unique()` constraint**,
   mirroring `seller_payment_configs.seller_id`. This is a real, confirmed
   gap (§4 above), not a hypothetical. Low-risk, mechanical fix — add the
   constraint in the schema file, `pnpm run push` (or a proper migration if
   this project moves off `push`-based schema management before then).
2. **`orderShipments.ts`'s courier-booking query has no `.limit(1)`** at the
   call site that reads `seller_courier_configs` (confirmed by reading the
   surrounding code, not just guessing from the missing constraint) — worth
   checking whether it silently takes an arbitrary row if the #1 gap above
   is ever hit before the constraint fix lands.
3. **Export `groupBySellerAndAllocateDiscount` and `hasVerifiedPaymentConfig`**
   from `orders.ts`/`sellerListings.ts` so future integration scripts (and
   this one, on a re-run) test the real function, not a hand-maintained
   copy. Natural to bundle with the deferred checkout-side session, since it
   touches `orders.ts`.
4. **No HTTP-level integration testing exists yet.** If Clerk test
   credentials or a test-auth bypass ever become available in this
   environment, that's the next real gap to close — this session closed the
   "does the schema work against a real DB" and "does the core business
   logic work against real rows" gaps, but the full request→middleware→
   route→response path is still unexercised.
5. Confirmed (not new, just re-verified while in the code) that Phase 7's
   own flag about `SellerDashboardPage`'s vacation-mode tab-disabling being
   UI-layer-only (backend independently enforces via `requireSeller`) is
   still accurate — no change here, just noting it wasn't contradicted by
   anything found this session.

## Reproducing this session's results
```bash
# From a fresh container with the same network allowlist:
apt-get update && apt-get install -y postgresql postgresql-contrib
pg_ctlcluster 16 main start
su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\""
su postgres -c "psql -c \"CREATE DATABASE treefriend;\""

cd lib/db
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/treefriend" pnpm run push

cd ../../scripts
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/treefriend" pnpm run verify-seller-marketplace
```
