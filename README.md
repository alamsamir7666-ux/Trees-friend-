# TreeFriend

A Bangladesh-targeted plant marketplace where buyers can purchase trees, saplings, and gardening supplies from multiple sellers. Features a full e-commerce flow (cart, checkout, orders, returns), a seller marketplace (listings, variants, payouts), real-time chat between buyers and sellers, loyalty/referral programs, an admin dashboard, and integrations with bKash (payments), Pathao/Steadfast (couriers), Cloudinary (images), and Resend (email).

## Tech Stack

| Layer             | Technology                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Frontend**      | React 19, Vite, TypeScript, TanStack Query, wouter, Tailwind CSS, shadcn/ui, Radix UI, Clerk, framer-motion, Recharts, TipTap |
| **Backend**       | Node.js 24, Express 5, TypeScript, Drizzle ORM, PostgreSQL                                                                    |
| **Database**      | PostgreSQL (Supabase / Neon)                                                                                                  |
| **Auth**          | Clerk (web) + custom HS256 JWT (mobile)                                                                                       |
| **Payments**      | bKash Tokenized Checkout                                                                                                      |
| **Couriers**      | Pathao, Steadfast                                                                                                             |
| **Images**        | Cloudinary                                                                                                                    |
| **Email**         | Resend                                                                                                                        |
| **Rate Limiting** | Upstash Redis (sliding window)                                                                                                |
| **Mobile**        | Flutter (Expo) — shares the API server                                                                                        |
| **Monorepo**      | pnpm 9.15 workspaces                                                                                                          |

## Project Structure

```
.
├── artifacts/
│   ├── api-server/          # Express API server (230 routes, 54 files)
│   │   ├── src/
│   │   │   ├── routes/      # Route handlers (one file per domain)
│   │   │   ├── middlewares/  # auth, rateLimiter, clerkProxy, mobileJwt
│   │   │   ├── lib/         # bkash, cloudinary, email, payouts, etc.
│   │   │   ├── jobs/        # Background jobs (lowStock, sellerSubscription)
│   │   │   └── types/       # Typed ApiRequest generic
│   │   ├── test/            # Integration tests (supertest + real Postgres)
│   │   └── build.mjs        # esbuild production bundler
│   ├── tree-friend/         # React frontend (35 pages, ~150 components)
│   │   ├── src/
│   │   │   ├── pages/       # Route-level page components
│   │   │   ├── components/  # ui/, admin/, seller/, chat/, layout/
│   │   │   ├── contexts/    # Cart, Wishlist, Admin, Page contexts
│   │   │   ├── hooks/       # usePresence, useInfiniteScroll, etc.
│   │   │   └── lib/         # apiClient, queryClient, i18n, etc.
│   │   └── vite.config.ts
│   └── mockup-sandbox/      # Vite sandbox for design previews
├── lib/
│   ├── db/                  # Drizzle ORM schema + migrations (41 tables)
│   │   ├── src/
│   │   │   ├── schema/      # One file per table
│   │   │   ├── logic/       # Shared DB logic (orders, sellerListings)
│   │   │   └── index.ts
│   │   ├── migrations/      # drizzle-kit generated SQL migrations
│   │   └── drizzle.config.ts
│   ├── api-zod/             # orval-generated Zod schemas (from OpenAPI)
│   ├── api-client-react/    # orval-generated TanStack Query client
│   └── api-spec/            # OpenAPI spec + orval config
├── scripts/                 # Admin/seed/verify TypeScript scripts
├── eslint.config.mjs        # ESLint 9 flat config (workspace-wide)
├── .prettierrc              # Prettier config
├── pnpm-workspace.yaml      # Workspace config + dependency catalog
└── tsconfig.base.json       # Shared TypeScript config (8/10 strict flags)
```

## Prerequisites

- **Node.js** 24.x
- **pnpm** 9.15+ (`npm install -g pnpm`)
- **PostgreSQL** 14+ (local dev, or use Supabase/Neon for cloud)
- **Clerk** account (auth) — [dashboard.clerk.com](https://dashboard.clerk.com)
- **Cloudinary** account (images) — optional, has fallback
- **Resend** account (email) — optional, has fallback
- **Upstash Redis** (rate limiting) — optional in dev (in-memory fallback)
- **bKash** merchant account (payments) — sandbox for dev

## Quick Start

```bash
# 1. Clone + install
git clone https://github.com/alamsamir7666-ux/Trees-friend-.git
cd Trees-friend-
pnpm install

# 2. Set up environment variables
cp artifacts/api-server/.env.example artifacts/api-server/.env
# Edit .env with your DATABASE_URL, CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, etc.

# 3. Push DB schema (creates all 41 tables)
cd lib/db
DATABASE_URL="postgresql://..." pnpm run push
cd ../..

# 4. Start the API server (dev mode)
pnpm --filter api-server run dev

# 5. In another terminal, start the frontend
pnpm --filter tree-friend run dev
```

## Available Scripts

### Root (workspace-wide)

```bash
pnpm build              # Typecheck + build all packages
pnpm typecheck          # TypeScript check across all packages
pnpm lint               # ESLint check across all files
pnpm lint:fix           # ESLint auto-fix
pnpm format             # Prettier format all files
pnpm format:check       # Prettier check (CI mode)
```

### API Server (`artifacts/api-server/`)

```bash
pnpm --filter api-server run dev          # Dev mode (build + start with NODE_ENV=development)
pnpm --filter api-server run build        # Production build (esbuild → dist/)
pnpm --filter api-server run start        # Start production server
pnpm --filter api-server run typecheck    # TypeScript check
pnpm --filter api-server run test         # Run integration tests (needs DATABASE_URL)
```

### Frontend (`artifacts/tree-friend/`)

```bash
pnpm --filter tree-friend run dev         # Vite dev server
pnpm --filter tree-friend run build       # Production build → dist/
pnpm --filter tree-friend run serve       # Preview production build
pnpm --filter tree-friend run typecheck   # TypeScript check
```

### Database (`lib/db/`)

```bash
pnpm --filter db run generate             # Generate migration SQL from schema changes
pnpm --filter db run migrate              # Apply migrations (transactional)
pnpm --filter db run push                 # Push schema directly (dev only — no migration history)
pnpm --filter db run studio               # Drizzle Studio (DB browser)
```

## Environment Variables

See `artifacts/api-server/.env.example` for the full list (22 vars, all documented with generation commands and default behavior). Key ones:

| Variable                    | Required   | Description                                                                     |
| --------------------------- | ---------- | ------------------------------------------------------------------------------- |
| `DATABASE_URL`              | Yes        | PostgreSQL connection string                                                    |
| `CLERK_SECRET_KEY`          | Yes        | Clerk secret key                                                                |
| `CLERK_PUBLISHABLE_KEY`     | Yes        | Clerk publishable key                                                           |
| `MOBILE_JWT_SECRET`         | Yes        | HS256 secret for mobile JWT (generate: `openssl rand -base64 32`)               |
| `CREDENTIAL_ENCRYPTION_KEY` | Yes        | AES-256-GCM key for credential encryption (generate: `openssl rand -base64 48`) |
| `COURIER_WEBHOOK_SECRET`    | Yes        | Shared secret for courier webhooks                                              |
| `ADMIN_EMAILS`              | Yes        | Comma-separated admin email addresses                                           |
| `ALLOWED_ORIGINS`           | Yes (prod) | Comma-separated allowed CORS origins                                            |
| `UPSTASH_REDIS_REST_URL`    | No         | Upstash Redis URL (rate limiting; in-memory fallback in dev)                    |
| `UPSTASH_REDIS_REST_TOKEN`  | No         | Upstash Redis token                                                             |
| `CLOUDINARY_*`              | No         | Cloudinary credentials (image uploads)                                          |
| `RESEND_API_KEY`            | No         | Resend API key (transactional email)                                            |
| `BKASH_API_BASE_URL`        | No         | bKash API base URL (defaults to sandbox)                                        |

### v5.0 BM25 + Reranker (optional, recommended)

| Variable                         | Required | Description                                                                                                                        |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `COHERE_API_KEY`                 | No       | Cohere API key for Rerank v3 (multilingual, supports Bangla). Free tier: 1000 calls/month. Get one at https://dashboard.cohere.com |
| `JINA_API_KEY`                   | No       | Jina API key for Reranker v2 (open-source alternative). Free tier: 1M tokens/month. Get one at https://jina.ai/reranker            |
| `JINA_RERANKER_URL`              | No       | Self-hosted Jina-compatible reranker endpoint (skips JINA_API_KEY)                                                                 |
| `RERANKER_PROVIDER`              | No       | `"auto"` (default, tries Cohere→Jina→local) \| `"cohere"` \| `"jina"` \| `"local"`                                                 |
| `RERANKER_TOP_K`                 | No       | Candidates to retrieve before reranking (default 20)                                                                               |
| `RERANKER_TOP_N`                 | No       | Results to return after reranking (default 5)                                                                                      |
| `RERANKER_TIMEOUT_MS`            | No       | API call timeout, max 10000 (default 3000)                                                                                         |
| `RERANKER_MIN_SCORE`             | No       | Minimum rerank score to include (default 0.0)                                                                                      |
| `RERANKER_CACHE_TTL_SECONDS`     | No       | Cache TTL for rerank results (default 3600 = 1h)                                                                                   |
| `RERANKER_ENABLED`               | No       | Master switch, `"true"` (default) or `"false"`                                                                                     |
| `BM25_STATS_REFRESH_INTERVAL_MS` | No       | BM25 IDF refresh interval (default 21600000 = 6h)                                                                                  |

If no reranker API keys are set, the system gracefully degrades to local fallback (returns first-pass order). BM25 always works (no external dependencies).

## Database Schema

41 tables across 9 domains:

- **Users/auth** (3): `users`, `addresses`, `email_preferences`
- **Products/catalog** (6): `products`, `product_variants`, `categories`, `homepage_sections`, `listing_attribute_options`, `blog_posts`
- **Orders/checkout** (8): `orders`, `cart_items`, `wishlist`, `returns`, `pre_orders`, `subscriptions`, `gift_cards`, `gift_card_transactions`
- **Sellers/marketplace** (5): `sellers`, `seller_listings`, `seller_listing_variants`, `seller_subscriptions`, `follows`
- **Payments** (4): `seller_payment_configs`, `platform_payment_config`, `seller_payout_accounts`, `payouts`
- **Shipping** (2): `order_shipments`, `seller_courier_configs`
- **Conversations** (2): `conversations`, `messages`
- **Marketing** (7): `coupons`, `referrals`, `loyalty_points`, `loyalty_transactions`, `stock_alerts`, `abandoned_carts`, `newsletter_subscribers`
- **Admin/audit** (2): `audit_logs`, `monthly_records`

Schema files live in `lib/db/src/schema/`. Each table has detailed doc comments explaining intent, cascade rules, and trade-offs.

## API Validation

Request bodies, params, and queries are validated using Zod schemas generated from the OpenAPI spec (`lib/api-spec/openapi.yaml` → `lib/api-zod/`). Routes use the `validateBody` / `validateParams` / `validateQuery` middleware from `artifacts/api-server/src/lib/validateRequest.ts`.

To add validation to a new route:

```typescript
import { CreateOrderBody } from "@workspace/api-zod";
import { validateBody } from "../lib/validateRequest";
import type { ApiRequest } from "../types/apiRequest";
import type { z } from "zod";

router.post(
  "/orders",
  requireAuth,
  checkoutLimiter,
  validateBody(CreateOrderBody, "CreateOrderBody"),
  async (req: ApiRequest<z.infer<typeof CreateOrderBody>>, res) => {
    // req.body is now fully typed as z.infer<typeof CreateOrderBody>
    // req.userId is set by requireAuth
  },
);
```

## Testing

Integration tests use `supertest` against the real Express app + a real PostgreSQL database (no mocking). Tests mint real mobile JWTs via the production `signMobileJwt` function. Cleanup uses a marker-prefix pattern (`httptest_`) so test data never conflicts with real data.

```bash
# Run tests (needs DATABASE_URL pointing to a test database)
cd artifacts/api-server
DATABASE_URL="postgresql://..." pnpm run test
```

Test coverage: 140 test cases across 11 route files (~21% route file coverage). See the engineering audit for coverage gaps.

## Deployment

See [`DEPLOY.md`](./DEPLOY.md) for a step-by-step free-tier deployment guide using Vercel (frontend) + Render (backend) + Neon/Supabase (database) + Clerk (auth). Total cost: $0/month to start.

## Engineering Standards

- **TypeScript**: 8 of 10 strict sub-flags enabled (`noImplicitAny`, `strictNullChecks`, `strictBindCallApply`, `strictPropertyInitialization`, `useUnknownInCatchVariables`, `alwaysStrict`, `noImplicitReturns`, `noFallthroughCasesInSwitch`). `strictFunctionTypes` and `noUnusedLocals` are disabled (pragmatic choices).
- **Linting**: ESLint 9 flat config (`eslint.config.mjs`) with `typescript-eslint/recommended` + Prettier integration. Run `pnpm lint`.
- **Formatting**: Prettier (`.prettierrc`). Run `pnpm format`.
- **Pre-commit hooks**: husky + lint-staged run ESLint `--fix` + Prettier `--write` + `pnpm typecheck` on staged files. Install with `pnpm prepare` (runs automatically on `pnpm install`).
- **Post-merge hook**: husky runs `pnpm install --frozen-lockfile` + `pnpm --filter db push` after every `git pull` (keeps deps + DB schema in sync).
- **Code style**: consistent naming — camelCase for routes/libs, PascalCase for React components, kebab-case for shadcn UI primitives, `use*` for hooks, `*Table` for Drizzle schemas, `require*` for auth middlewares.

## Key Documentation

- [`DEPLOY.md`](./DEPLOY.md) — Free-tier deployment guide
- [`CHANGES.md`](./CHANGES.md) — Changelog
- [`artifacts/api-server/.env.example`](./artifacts/api-server/.env.example) — Environment variable reference (22 vars, all documented)
- [`lib/api-spec/openapi.yaml`](./lib/api-spec/openapi.yaml) — OpenAPI spec (source of truth for API client + Zod schemas)

## License

MIT
