# Cloudflare Pages Deployment Guide

This guide walks you through deploying the TreeFriend frontend to Cloudflare Pages, replacing the current Vercel deployment.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Cloudflare Pages (treefriend.pages.dev)                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Static assets (HTML, JS, CSS, images)                  │   │
│  │  Served from 300+ edge locations worldwide              │   │
│  │  Includes Dhaka POP — fast for BD users                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Pages Functions (functions/) — SEO only                │   │
│  │  • /sitemap.xml → dynamic sitemap generator             │   │
│  │  • /products/:id → bot detection + OG meta injection    │   │
│  │  • /blog/:slug → bot detection + OG meta injection      │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
        │ browser API calls (direct, with CORS)
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  Render (trees-friend-tt53.onrender.com)                       │
│  Express API server — 230 routes, Drizzle ORM, WebSocket chat  │
│  ALLOWED_ORIGINS must include treefriend.pages.dev             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Neon / Supabase (PostgreSQL)                                   │
│  40 tables, pgvector, BM25 full-text search, RLS               │
└─────────────────────────────────────────────────────────────────┘
```

**Why direct API calls (no proxy)?**
The frontend calls the Render API directly from the browser, same as
the original Vercel setup. This is necessary because:
1. WebSocket connections (real-time chat, presence) can't go through
   an HTTP proxy — they need a direct connection to Render.
2. Cloudflare Pages Functions have a 30-second CPU limit, but SSE
   streaming (AI chat) can last minutes.
3. Direct calls are simpler and match the original architecture.

The only server-side functions are for SEO (sitemap + OG meta tags for
social media crawlers). These run on Cloudflare's edge and fetch data
from the Render API server-side.

## What Changed from Vercel

| Aspect | Vercel (old) | Cloudflare Pages (new) |
|--------|-------------|----------------------|
| Static hosting | Vercel CDN | Cloudflare CDN (300+ POPs, Dhaka edge) |
| API calls | Direct to Render (CORS) | Direct to Render (CORS) — same |
| Sitemap | `api/sitemap.ts` (Vercel serverless) | `functions/sitemap.xml.ts` (Pages Function) |
| OG meta for bots | `api/og-product.ts`, `api/og-blog.ts` | `functions/products/[id].ts`, `functions/blog/[slug].ts` |
| SPA fallback | `vercel.json` route `/(.*) → /index.html` | `public/_redirects` with `/* → /index.html 200` |
| Build output | `dist/public/` | `dist/public/` (same) |
| Bandwidth | 100GB/month free tier, then $20/mo | **Unlimited free** |
| Build minutes | 6000 min/month free | 500 builds/month free |

## Step-by-Step Deployment

### Step 1: Commit the Migration Code

The migration code is already committed to `main`. Pull it on your local:
```bash
git pull origin main
```

### Step 2: Create a Cloudflare Account

1. Go to https://dash.cloudflare.com/sign-up
2. Sign up with your email (free tier is fine)
3. Verify your email address

### Step 3: Create a Pages Project

1. In the Cloudflare dashboard, click **Workers & Pages** in the left sidebar
2. Click **Create application** → **Pages** tab → **Connect to Git**
3. Connect your GitHub account and select the `alamsamir7666-ux/Trees-friend-` repo
4. Configure the build:

   | Setting | Value |
   |---------|-------|
   | **Project name** | `treefriend` (this becomes `treefriend.pages.dev`) |
   | **Production branch** | `main` |
   | **Framework preset** | None (leave as "None" — we use a custom build command) |
   | **Root directory** | `/` (repo root — leave blank) |
   | **Build command** | `pnpm --filter tree-friend run build` |
   | **Build output directory** | `artifacts/tree-friend/dist/public` |
   | **Deploy command** | Leave EMPTY (Cloudflare auto-uploads the build output directory) |
   | **Node version** | 22 (set via env var `NODE_VERSION=22`) |

   **Note:** Cloudflare Pages auto-detects pnpm from the `packageManager`
   field in `package.json` and runs `pnpm install --frozen-lockfile`
   automatically before your build command runs. You do NOT need to
   install pnpm or run `pnpm install` in the build command — that would
   cause an `EEXIST` error (pnpm is already installed) and redundant
   work (deps are already installed).

   **IMPORTANT — Deploy command must be EMPTY:** If Cloudflare auto-fills
   a deploy command (e.g. `npx wrangler deploy`), clear it. Pages
   deployments via the Git integration don't need a deploy command —
   Cloudflare automatically uploads everything in the build output
   directory to the edge CDN after the build finishes. Setting a deploy
   command will cause a "workspace root" error if you have a monorepo.

5. Click **Save and Deploy**

### Step 4: Set Environment Variables

**Before the first build succeeds**, you need to set environment variables. In the Pages project:

1. Go to **Settings** → **Environment variables**
2. Add these variables (set them for **both** Production and Preview):

   | Variable name | Value | Required? |
   |---------------|-------|-----------|
   | `VITE_API_BASE_URL` | `https://trees-friend-tt53.onrender.com` | **Yes** — your Render API URL. The frontend calls Render directly (same as Vercel). |
   | `VITE_CLERK_PUBLISHABLE_KEY` | `pk_live_...` or `pk_test_...` | **Yes** — from Clerk dashboard |
   | `API_BASE_URL` | `https://trees-friend-tt53.onrender.com` | **Yes** — used by the SEO Pages Functions (sitemap, OG meta) to fetch data from Render server-side. Note: no `VITE_` prefix — this is the server-side env var. |
   | `NODE_VERSION` | `22` | Yes — Cloudflare Pages defaults to Node 18, your project needs 22 |

   Optional (leave blank for now, set later if needed):
   - `VITE_CLERK_PROXY_URL` — only if using Clerk proxy middleware
   - `VITE_GA_MEASUREMENT_ID` — Google Analytics 4 ID (e.g. `G-XXXXXXXX`)
   - `VITE_META_PIXEL_ID` — Meta/Facebook Pixel ID
   - `VITE_VAPID_PUBLIC_KEY` — Web Push VAPID public key

   **Important:** Both `VITE_API_BASE_URL` and `API_BASE_URL` have the
   same value, but serve different purposes:
   - `VITE_API_BASE_URL` → client-side, inlined into the browser bundle
     by Vite at build time. Used for browser-to-Render API calls.
   - `API_BASE_URL` → server-side, read by the Pages Functions at
     runtime. Used for the sitemap and OG meta functions to fetch data
     from Render.

3. Click **Save**

### Step 5: Trigger the First Build

1. Go to **Deployments** tab
2. Click **Retry deployment** (or push a new commit to `main`)
3. Wait for the build to complete (~2-3 minutes)
4. Once deployed, click the `treefriend.pages.dev` URL to verify

### Step 6: Update Render CORS Settings

**Critical — without this, every API call from the browser will fail.**

1. Go to your Render dashboard → your API service
2. Open the **Environment** tab
3. Find `ALLOWED_ORIGINS` and add the Cloudflare Pages URL:
   ```
   https://treefriend.pages.dev
   ```
   If you had existing origins (e.g. the old Vercel URL), keep them comma-separated:
   ```
   https://treefriend.pages.dev,https://tree-friend-xxxx.vercel.app
   ```
4. Save — Render will auto-redeploy

### Step 7: Update Clerk Dashboard

**Critical — without this, auth callbacks will be rejected.**

1. Go to https://dashboard.clerk.com
2. Select your application
3. Go to **Domains** in the left sidebar
4. Click **Add domain**
5. Enter `treefriend.pages.dev` and save
6. (Optional) Set it as the primary production domain if you're decommissioning Vercel

### Step 8: Verify the Deployment

Open `https://treefriend.pages.dev` and check:

- [ ] Homepage loads with products
- [ ] Sign in / sign up works (Clerk)
- [ ] Cart add/remove works
- [ ] Product detail pages load
- [ ] AI chat works (SSE streaming)
- [ ] Admin dashboard loads (if you're an admin)
- [ ] Deep links work (e.g. `https://treefriend.pages.dev/products/42` — should not 404)
- [ ] Sitemap accessible at `https://treefriend.pages.dev/sitemap.xml`
- [ ] Share a product link on Facebook/WhatsApp — preview should show product image + name

## Local Development

### Regular Vite dev (no Functions)
```bash
pnpm --filter tree-friend run dev
```
This runs Vite dev server on `localhost:5173`. API calls go directly to `VITE_API_BASE_URL` (Render). No Pages Functions run in this mode.

### Full local test with Functions
To test the Pages Functions locally (proxy, sitemap, OG meta):

```bash
# 1. Build the frontend
pnpm --filter tree-friend run build

# 2. Create a .dev.vars file with the API URL
cp artifacts/tree-friend/.dev.vars.example artifacts/tree-friend/.dev.vars
# Edit .dev.vars and set API_BASE_URL

# 3. Run wrangler pages dev
cd artifacts/tree-friend
npx wrangler pages dev dist/public --compatibility-date=2024-09-23
```

This serves the built assets + runs the Pages Functions locally on `localhost:8788`. The `/api/*` proxy will forward to the Render API.

## Custom Domain (Later)

When you buy a domain (e.g. `treefriend.com`):

1. In Cloudflare Pages → **Custom domains** → **Set up a custom domain**
2. Enter `treefriend.com`
3. Cloudflare will guide you through DNS setup (if the domain is on Cloudflare's DNS, it's automatic)
4. Add the custom domain to:
   - Render's `ALLOWED_ORIGINS` env var
   - Clerk dashboard → Domains
5. Update `public/robots.txt` if you want the sitemap URL to be absolute (currently uses relative `/sitemap.xml` which works on any domain)

## Troubleshooting

### Deploy fails with "The Cloudflare application detection logic has been run in the root of a workspace"
Cloudflare auto-detected a `wrangler.toml` and tried to run
`npx wrangler deploy` (Workers deploy) instead of doing a Pages deploy.
Fix: go to **Settings** → **Build & deployments** → clear the
**Deploy command** field (leave it empty). Pages deployments via the
Git integration don't need a deploy command — Cloudflare auto-uploads
the build output directory.

### Build fails with "EEXIST: file already exists" for pnpm
Cloudflare Pages already has pnpm pre-installed (it auto-detects from
your `package.json` `packageManager` field). Remove `npm install -g pnpm@9.15.0`
from your build command — just use `pnpm --filter tree-friend run build`.
Cloudflare also automatically runs `pnpm install --frozen-lockfile` before
your build command, so you don't need that either.

### API calls return 502 Bad Gateway
The `/api/*` proxy function can't reach the Render API server. Check:
1. `API_BASE_URL` env var is set (not `VITE_API_BASE_URL` — that's the client-side one)
2. Render API server is running (free tier sleeps after 15 min of inactivity — first request takes ~30s to wake up)
3. Render's `ALLOWED_ORIGINS` includes `https://treefriend.pages.dev`

### Clerk sign-in shows "Invalid origin"
Add `treefriend.pages.dev` to Clerk dashboard → Domains.

### Deep links (e.g. `/products/42`) return 404
The SPA fallback isn't working. Check that `public/_redirects` exists in the build output. The file should contain:
```
/*    /index.html    200
```

### Social media link previews show default title
The bot-detection Pages Functions aren't running. Check:
1. `functions/products/[id].ts` and `functions/blog/[slug].ts` exist
2. `functions/_routes.json` includes `/products/*` and `/blog/*`
3. The `API_BASE_URL` env var is set (used by the functions to fetch product/blog data)

### Service worker serves stale content
The service worker cache name is `treefriend-v2` in `public/sw.js`. After a deploy, users may see cached HTML until the cache expires. To force a refresh, bump the cache name in `public/sw.js`:
```js
const CACHE_NAME = "treefriend-v3"; // bump on each deploy
```

## Rollback to Vercel

If something goes wrong, you can rollback by reverting the migration commit:
```bash
git revert <migration-commit-hash>
git push origin main
```
Then redeploy on Vercel. The old `vercel.json` and `api/` folder will be restored.

Note: Vercel's free tier may have been deactivated if you haven't deployed in a while. Check your Vercel dashboard.
