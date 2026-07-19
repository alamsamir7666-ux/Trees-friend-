# 🚀 TreeFriend — Free Deployment Guide

Deploy the full website for free using:
- **Vercel** (frontend)
- **Render** (backend API)
- **Neon** (PostgreSQL database)
- **Clerk** (auth — already in the project)

Total cost: **$0/month**

---

## Step 1 — Push to GitHub

1. Go to https://github.com/new and create a **private** repository named `treefriend`
2. On your computer, open a terminal in this project folder and run:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/treefriend.git
git push -u origin main
```

---

## Step 2 — Create the Database (Neon — free)

1. Go to https://neon.tech and sign up (free)
2. Click **New Project** → name it `treefriend` → click **Create Project**
3. On the dashboard, click **Connection string** → copy the full URL
4. **Save this URL** — you'll need it in Step 4

---

## Step 3 — Set Up Clerk (auth — free)

1. Go to https://dashboard.clerk.com and sign up (free)
2. Click **Create Application** → name it `TreeFriend` → choose sign-in options → **Create**
3. Go to **API Keys** and copy both the Publishable key and Secret key
4. **Save both** — you'll need them in Steps 4 and 5

---

## Step 4 — Deploy the Backend (Render — free)

1. Go to https://render.com and sign up (free)
2. Click **New** → **Web Service**
3. Connect your GitHub account and select your `treefriend` repository
4. Fill in the settings:
   - **Name:** `treefriend-api`
   - **Root Directory:** `artifacts/api-server`
   - **Build Command:** `pnpm install && pnpm run build`
   - **Start Command:** `pnpm run start`
   - **Plan:** Free
5. Scroll to **Environment Variables** and add these one by one:

   | Key | Value |
   |-----|-------|
   | `NODE_ENV` | `production` |
   | `PORT` | `10000` |
   | `DATABASE_URL` | *(paste from Step 2)* |
   | `CLERK_SECRET_KEY` | *(paste from Step 3)* |
   | `CLERK_PUBLISHABLE_KEY` | *(paste from Step 3)* |
   | `ALLOWED_ORIGINS` | `https://treefriend.vercel.app` *(update after Step 5)* |

6. Click **Create Web Service**
7. Wait for the build to finish (2–4 minutes)
8. Copy your API URL — it looks like `https://treefriend-api.onrender.com`

> After first deploy, go to Render Shell tab and run:
> ```bash
> cd lib/db && pnpm run push
> ```

---

## Step 5 — Deploy the Frontend (Vercel — free)

1. Go to https://vercel.com and sign up with GitHub (free)
2. Click **New Project** → import your `treefriend` repository
3. Configure:
   - **Root Directory:** `artifacts/tree-friend`
   - **Framework Preset:** Vite
   - **Build Command:** `pnpm run build`
   - **Output Directory:** `dist/public`
4. Add **Environment Variables:**

   | Key | Value |
   |-----|-------|
   | `VITE_API_BASE_URL` | *(your Render URL from Step 4)* |
   | `VITE_CLERK_PUBLISHABLE_KEY` | *(paste from Step 3)* |

5. Click **Deploy**

---

## Step 6 — Update CORS on Render

1. Go to Render → your service → **Environment**
2. Update `ALLOWED_ORIGINS` to your exact Vercel URL
3. Click **Save Changes**

---

## Step 7 — Update Clerk Allowed URLs

1. Go to Clerk Dashboard → your app → **Domains**
2. Add your Vercel URL
3. Click **Save**

---

## Free Tier Limits Summary

| Service | Free Limit | Notes |
|---------|-----------|-------|
| Vercel | Unlimited requests | 100GB bandwidth/month |
| Render | 750 hrs/month | Keep-alive ping prevents sleep |
| Neon | 512MB storage | Enough for thousands of products |
| Clerk | 10,000 users/month | More than enough to start |
| Cloudinary | 25GB storage | For product images (optional) |
| Resend | 3,000 emails/month | For order emails (optional) |

---

## Optional: Add Product Images (Cloudinary — free)

1. Sign up at https://cloudinary.com (free)
2. Copy your Cloud Name, API Key, and API Secret from the Dashboard
3. Add to Render environment variables

## Optional: Add Order Emails (Resend — free)

1. Sign up at https://resend.com (free)
2. Create an API Key and copy it
3. Add as `RESEND_API_KEY` in Render environment variables
