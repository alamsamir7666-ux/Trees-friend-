# Running TreeFriend api-server on an Android phone

This guide walks you through running the TreeFriend api-server on an
Android phone using Termux + Cloudflare Tunnel. The phone's residential
IP makes Tier 2 (InnerTube) work without any extra configuration — no
Invidious instance, no Oracle Cloud, no payment card required.

## Why this works

The TreeFriend YouTube fetcher has a 3-tier strategy:

- Tier 1: Invidious (multi-instance failover)
- Tier 2: youtubei.js InnerTube API — **works on residential IPs**
- Tier 3: oEmbed metadata-only + manual .vtt upload

On Render / Vercel / AWS (datacenter IPs), Tier 2 fails with HTTP 403
(bot challenge). Your phone's cellular or WiFi connection uses a
residential IP that YouTube doesn't flag — so Tier 2 just works.

## Requirements

- **Android phone** (Android 7.0+ — basically any phone from 2016 onward)
  - iPhone is NOT supported — would require jailbreak, much harder
- **Stable internet** (WiFi preferred for sustained ingestion;
  cellular works but check your data cap — 10k videos ~2GB)
- **Charger** — keep plugged in during bulk ingestion (phone stays warm)
- **Cloudflare account** (free, no card — just email signup)
- A **domain name** is recommended but not required — Cloudflare Tunnel
  gives you a free `*.trycloudflare.com` URL for testing

## Cost

- **€0/month** — Termux is free, Cloudflare Tunnel is free, your phone
  already has a data plan
- Optional: €10/year for a custom domain (cheaper than a VPS)

## Time required

- Initial setup: ~30 minutes
- Per-video ingestion: ~5 seconds (Tier 2 is fast on residential IP)

## Step 1: Install Termux on your phone

⚠️ **Do NOT install Termux from the Play Store** — the Play Store version
is abandoned and broken. Install from F-Droid or the official GitHub
release.

### Option A: F-Droid (recommended)

1. Open https://f-droid.org on your phone's browser
2. Download and install the F-Droid app
3. Open F-Droid → search "Termux" → install

### Option B: GitHub release

1. Go to https://github.com/termux/termux-app/releases
2. Download the latest `termux-v0.118.x+github-debug-arm64-v8a.apk`
3. Allow "Install from unknown sources" in Android settings
4. Tap the downloaded APK to install

## Step 2: Set up Termux environment

Open Termux and run:

```bash
# Update packages
pkg update && pkg upgrade -y

# Install required tools
pkg install -y nodejs-lts git python openssh cloudflared

# Verify versions
node --version    # should print v20+
npm --version
git --version
cloudflared --version
```

⚠️ **Important: Disable battery optimization for Termux**

- Android Settings → Apps → Termux → Battery → "Unrestricted"
- This prevents Android from killing Termux when the screen is off
- Without this, bulk ingestion will silently stop after ~15 min

Also enable "Acquire wakelock" in Termux:

```bash
# In Termux, run:
termux-wake-lock
```

This keeps the CPU running even when the screen is off. To release:
`termux-wake-release` (or just close Termux)

## Step 3: Clone the TreeFriend repo

```bash
# In Termux:
cd ~
git clone https://github.com/alamsamir7666-ux/Trees-friend-.git
cd Trees-friend-

# Install pnpm
npm install -g pnpm@9.15

# Install dependencies (takes ~5 min on phone)
pnpm install --frozen-lockfile
```

## Step 4: Set up environment variables

You'll need the same env vars your Render deployment uses. Create a
`.env` file in `artifacts/api-server/`:

```bash
cd artifacts/api-server
cp .env.example .env

# Edit the .env file with your values:
nano .env
```

Required env vars (copy from your Render dashboard):

```
DATABASE_URL=postgresql://...           # your Neon/Supabase URL
CLERK_SECRET_KEY=sk_test_...
CLERK_PUBLISHABLE_KEY=pk_test_...
MOBILE_JWT_SECRET=...                   # generate with: openssl rand -base64 32
CREDENTIAL_ENCRYPTION_KEY=...           # generate with: openssl rand -base64 48
COURIER_WEBHOOK_SECRET=...
ADMIN_EMAILS=your@email.com
ALLOWED_ORIGINS=https://your-frontend.vercel.app

# Optional: raise the rate limit for bulk ingestion
YOUTUBE_FETCH_RATE_LIMIT_MAX=200
```

To generate random secrets in Termux:

```bash
openssl rand -base64 32   # for MOBILE_JWT_SECRET
openssl rand -base64 48   # for CREDENTIAL_ENCRYPTION_KEY
```

## Step 5: Push the database schema (one-time)

If you haven't already pushed the schema to your Neon/Supabase DB:

```bash
cd ~/Trees-friend-/lib/db
DATABASE_URL="postgresql://..." pnpm run push
```

## Step 6: Build the api-server

```bash
cd ~/Trees-friend-/artifacts/api-server
pnpm run build    # esbuild bundles to dist/
```

This takes ~30 seconds on a modern phone. The output is in `dist/`.

## Step 7: Start the api-server

```bash
# Production mode (uses the built dist/)
pnpm run start

# You should see:
# "Server listening on port 3000"
```

Test it locally:

```bash
# In another Termux session (swipe from the left edge → "New session")
curl http://localhost:3000/api/health
# Should return {"status":"ok",...}
```

## Step 8: Expose the api-server publicly via Cloudflare Tunnel

### Option A: Quick test URL (no account, no domain needed)

```bash
# In another Termux session:
cloudflared tunnel --url http://localhost:3000
```

Cloudflare prints a URL like:

```
https://random-words-1234.trycloudflare.com
```

This URL is publicly accessible and routes to your phone's api-server.
Update your frontend's API base URL to point at it and you're live.

⚠️ **Limitation:** The URL changes every time you restart `cloudflared`.
For production, use Option B.

### Option B: Named tunnel (persistent URL, requires free Cloudflare account)

1. Sign up at https://dash.cloudflare.com (free, no card)
2. In Termux:

   ```bash
   # Authenticate (opens browser)
   cloudflared tunnel login

   # Create a named tunnel
   cloudflared tunnel create treefriend-api

   # Configure DNS (if you have a domain on Cloudflare)
   cloudflared tunnel route dns treefriend-api api.yourdomain.com

   # Run the tunnel
   cloudflared tunnel run treefriend-api
   ```

3. Create a config file at `~/.cloudflared/config.yml`:

   ```yaml
   tunnel: <tunnel-id-from-create-output>
   credentials-file: /data/data/com.termux/files/home/.cloudflared/<tunnel-id>.json

   ingress:
     - hostname: api.yourdomain.com
       service: http://localhost:3000
     - service: http_status:404
   ```

4. Start everything in one command:
   ```bash
   cloudflared tunnel run treefriend-api
   ```

Now `https://api.yourdomain.com` permanently routes to your phone.
Even if your phone's IP changes (carrier reassignment), the URL stays
the same.

## Step 9: Test the YouTube fetcher

From your laptop or any device:

```bash
curl -X POST \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=QCvyyyb-XCQ","language":"en"}' \
  https://api.yourdomain.com/api/ai/admin/kb/sources/youtube
```

You should see:

```json
{
  "source": {...},
  "transcript": {
    "fetchedVia": "innertube-noauth",   ← Tier 2 working!
    "segmentCount": 247,
    "detectedLanguage": "en"
  }
}
```

If `fetchedVia` is `innertube-noauth`, you're done. Bulk ingestion now
works at 100-200 videos/hour (depending on your `YOUTUBE_FETCH_RATE_LIMIT_MAX`).

## Step 10: Bulk ingestion script

Create a script on your laptop (not the phone):

```python
#!/usr/bin/env python3
# bulk-youtube-ingest.py — runs on your laptop, hits the phone's api-server
import csv, requests, time

API_URL = "https://api.yourdomain.com/api/ai/admin/kb/sources/youtube"
ADMIN_JWT = "<your-admin-jwt>"

with open("video_urls.csv") as f:
    reader = csv.DictReader(f)  # CSV with columns "url" + "language"
    for row in reader:
        try:
            r = requests.post(
                API_URL,
                headers={"Authorization": f"Bearer {ADMIN_JWT}",
                         "Content-Type": "application/json"},
                json={"url": row["url"], "language": row.get("language", "en")},
                timeout=120,
            )
            if r.status_code == 201:
                data = r.json()
                via = data.get("transcript", {}).get("fetchedVia") or "manual"
                print(f"OK: {row['url']} -> {via}")
            elif r.status_code == 429:
                print(f"RATE LIMITED: sleeping 1 hour...")
                time.sleep(3600)
            else:
                print(f"FAIL: {row['url']} -> HTTP {r.status_code}: {r.text[:200]}")
        except Exception as e:
            print(f"ERR: {row['url']} -> {e}")
        time.sleep(20)  # 180/hour — under the 200/hour cap
```

Run: `python3 bulk-youtube-ingest.py > ingest.log 2>&1 &`

For 10,000 videos at 20s/video = 56 hours = ~2.5 days.

## Auto-restart on crash (production hardening)

Phones occasionally kill background processes. Add a restart script:

```bash
# In Termux, create ~/start-api.sh:
cat > ~/start-api.sh << 'EOF'
#!/bin/bash
# Auto-restart wrapper — if api-server crashes, restart it after 5s
while true; do
  cd ~/Trees-friend-/artifacts/api-server
  node dist/index.js
  echo "[$(date)] api-server crashed, restarting in 5s..."
  sleep 5
done
EOF
chmod +x ~/start-api.sh

# Start it with nohup so it survives Termux being closed
nohup ~/start-api.sh > ~/api-server.log 2>&1 &

# You can safely close Termux — the server keeps running
# To check logs: tail -f ~/api-server.log
```

For Cloudflare Tunnel, similar wrapper:

```bash
cat > ~/start-tunnel.sh << 'EOF'
#!/bin/bash
while true; do
  cloudflared tunnel run treefriend-api
  echo "[$(date)] tunnel crashed, restarting in 5s..."
  sleep 5
done
EOF
chmod +x ~/start-tunnel.sh
nohup ~/start-tunnel.sh > ~/tunnel.log 2>&1 &
```

## Battery and heat management

Phones can overheat during sustained CPU load. Tips:

1. **Keep it plugged in** — sustained CPU drains battery fast
2. **Remove the case** during ingestion — improves cooling
3. **Place on a cool surface** (metal/glass, not fabric)
4. **Don't run screen-on** — screen off uses less power, set screen
   timeout to 30s
5. **Use a fan** if doing 10k+ videos over multiple days — small USB
   fan pointed at the back of the phone works wonders
6. **Disable 5G** if on cellular — 5G modem runs hot; LTE is fine
7. **Limit to ~150 videos/hour** (`YOUTUBE_FETCH_RATE_LIMIT_MAX=150`)
   — leaves headroom and prevents thermal throttling

If the phone gets hot (>40°C), pause ingestion:

```bash
# Check temperature (root required on most phones):
# Or install "CPU-Z" from Play Store (free) to monitor temp
```

## Troubleshooting

### "port 3000 already in use"

```bash
# Find and kill the process using port 3000
netstat -tlnp 2>/dev/null | grep :3000
# Or just restart Termux entirely
```

### "Cannot find module 'youtubei.js'" after pulling latest code

```bash
cd ~/Trees-friend-
pnpm install --frozen-lockfile
cd artifacts/api-server
pnpm run build
```

### Cloudflare Tunnel shows "offline"

- Check your phone's internet connection
- Cloudflared might have crashed — check `~/tunnel.log`
- Restart: `pkill cloudflared && nohup ~/start-tunnel.sh &`

### api-server returns 403 (bot challenge) on YouTube

- This means your phone's IP got temporarily flagged — unlikely on
  residential IP but possible after thousands of requests
- Wait 1 hour and retry — YouTube's per-IP flags auto-expire
- Or switch networks (turn off WiFi to use cellular, or vice versa)
  to get a new IP

### Termux was killed by Android

- Disable battery optimization (see Step 2)
- Enable `termux-wake-lock`
- Use `nohup` so the process survives Termux being killed
- On some phones (Xiaomi, Huawei, Samsung), you need to explicitly
  allow "Background activity" for Termux in App settings

### "openssl: command not found"

```bash
pkg install openssl
```

### Git clone fails with "SSL certificate problem"

```bash
pkg install ca-certificates
git config --global http.sslVerify true
```

## What this gives you

After completing this guide:

- ✅ api-server runs 24/7 on your Android phone (€0/month)
- ✅ Residential IP → Tier 2 (InnerTube) works without configuration
- ✅ Public HTTPS URL via Cloudflare Tunnel (free, no card, no domain)
- ✅ 10,000 videos fetchable in ~2.5 days of continuous ingestion
- ✅ Auto-restart on crash — survives phone reboots and Android kills
- ✅ No payment card, no VPS, no Oracle Cloud, no Invidious setup

## When NOT to use this approach

- Your phone is your daily driver and you can't spare it
- You need guaranteed uptime (phones can drop off unexpectedly)
- You're in a region with poor cellular reliability
- You want to ingest 50k+ videos (battery degradation concern)

For those cases, the Oracle Cloud guide (docs/INVIDIOUS_DEPLOYMENT.md)
is a better fit — get a free virtual card from Revolut or Wise for the
identity verification.
