# Self-hosting Invidious for YouTube transcript fetching

This guide walks you through setting up a free Invidious instance on
Oracle Cloud's "Always Free" tier, then pointing the TreeFriend
api-server at it for bulk YouTube transcript ingestion.

## Why self-host Invidious?

The TreeFriend YouTube fetcher has a 3-tier strategy (Invidious →
InnerTube → oEmbed). On Render / Vercel / AWS (datacenter IPs), Tier 2
(InnerTube) and Tier 3 (oEmbed) are the only ones that respond — but
Tier 3 returns metadata only (no transcript), and Tier 2 fails with
HTTP 403 (bot challenge).

Self-hosting Invidious on a residential-ish IP (Oracle Cloud's free
tier is a VM in a residential IP range — not flagged as aggressively
as AWS/GCP/Render) makes Tier 1 work reliably. This is the only
practical free solution for bulk ingestion of 1,000+ videos.

## Cost

- **€0/month** — Oracle Cloud Always Free tier (1 VM, 1GB RAM, 50GB disk)
- No credit card charge — only required for identity verification
- The free tier is "always free" (not a 12-month trial)

## Time required

- 30-45 minutes one-time setup
- 5 minutes per video for ingestion (via the admin API)

## Prerequisites

- An Oracle Cloud account (https://www.oracle.com/cloud/free/)
  - Sign up with a credit card for identity verification (no charge)
  - Choose a region close to your Render deployment for low latency
- An SSH key pair for VM access
  - Generate: `ssh-keygen -t ed25519 -C "invidious" -f ~/.ssh/invidious-key`

## Step 1: Create the Oracle Cloud VM

1. Log in to https://cloud.oracle.com
2. Click "Create a VM instance"
3. Configure:
   - **Name**: `invidious`
   - **Image**: Canonical Ubuntu 22.04 (default)
   - **Shape**: `VM.Standard.E2.1.Micro` (Always Free eligible)
     - 1 vCPU, 1 GB RAM
   - **SSH keys**: Paste your public key (`~/.ssh/invidious-key.pub`)
   - **Boot volume**: leave defaults (46 GB free tier)
4. Click "Create"
5. Wait ~2 min for the VM to provision
6. Note the **Public IP** from the instance details page

## Step 2: Open port 3000 in the security list

1. Oracle Cloud Console → Networking → Virtual Cloud Networks
2. Click your VCN (default: `Default VCN`)
3. Click "Security List" → `Default Security List for <vcn>`
4. Click "Add Ingress Rules":
   - **Source CIDR**: `0.0.0.0/0`
   - **IP Protocol**: TCP
   - **Destination Port Range**: `3000`
   - **Description**: `Invidious API`
5. Click "Add Ingress Rules"

⚠️ **Security note**: Port 3000 is now publicly accessible. This is
required for Render to reach your Invidious instance. If you want to
restrict access, set `INVIDIOUS_INSTANCES=http://<ip>:3000` on Render
and add basic-auth via nginx reverse proxy (advanced — see "Hardening"
section below).

## Step 3: SSH into the VM and install Docker

```bash
# Replace <public-ip> with your VM's public IP
ssh -i ~/.ssh/invidious-key ubuntu@<public-ip>

# Once logged in:
# Install Docker
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg lsb-release
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Add yourself to the docker group (so you don't need sudo)
sudo usermod -aG docker $USER
# Log out and back in for the group change to take effect
exit
```

Reconnect:

```bash
ssh -i ~/.ssh/invidious-key ubuntu@<public-ip>
docker --version  # Should print "Docker version 24+..."
```

## Step 4: Run Invidious via Docker

Create a `docker-compose.yml`:

```bash
cat > ~/invidious-compose.yml << 'EOF'
version: "3"
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: kemal
      POSTGRES_PASSWORD: kemal
      POSTGRES_DB: invidious
    volumes:
      - postgresdata:/var/lib/postgresql/data
  invidious:
    image: quay.io/invidious/invidious:latest
    restart: unless-stopped
    depends_on:
      - postgres
    ports:
      - "3000:3000"
    environment:
      INVIDIOUS_DATABASE_URL: postgres://kemal:kemal@postgres:5432/invidious
      INVIDIOUS_CHECK_TABLES: "true"
      # Disable signups (admin-only ingestion)
      INVIDIOUS_REGISTRATION_ENABLED: "false"
      # Disable the web UI (API-only mode, saves RAM)
      INVIDIOUS_USE_QUIC: "false"
      # Reduce log verbosity
      INVIDIOUS_LOG_LEVEL: "Warn"
volumes:
  postgresdata:
EOF

# Start it
docker compose -f ~/invidious-compose.yml up -d

# Wait ~30s for first boot (Postgres + Invidious startup)
sleep 30

# Test it (should return JSON with title, author, captions fields)
curl -s "http://localhost:3000/api/v1/videos/QCvyyyb-XCQ?fields=videoId,title,author,captions" | head -c 500
```

You should see something like:

```json
{
  "videoId": "QCvyyyb-XCQ",
  "title": "Video title",
  "author": "Channel name",
  "captions": [
    {
      "label": "English",
      "language_code": "en",
      "url": "/api/v1/captions/QCvyyyb-XCQ?label=English&format=vtt"
    }
  ]
}
```

If you see `{"error":"Video unavailable"}` or empty response, the VM's
IP might still be flagged. Wait 5 min and retry — Invidious needs to
warm up its YouTube session on first boot.

## Step 5: Verify from outside the VM

From your local machine:

```bash
curl -s "http://<public-ip>:3000/api/v1/videos/QCvyyyb-XCQ?fields=videoId,title" | head -c 200
```

If this works, your Invidious instance is publicly reachable. If not:

1. Re-check the security list rule from Step 2
2. Check the VM's iptables: `sudo iptables -L -n` (Oracle's Ubuntu
   images sometimes have a firewall that blocks port 3000)
3. To clear iptables: `sudo iptables -F` (then `sudo netfilter-persistent save`)

## Step 6: Configure Render to use your Invidious instance

1. Go to your Render dashboard → your api-server service → Environment
2. Add (or update) the env var:
   - **Key**: `INVIDIOUS_INSTANCES`
   - **Value**: `http://<public-ip>:3000`
3. Save → Render will auto-redeploy
4. After redeploy, test:

```bash
curl -H "Authorization: Bearer <your-admin-jwt>" \
  https://your-api.onrender.com/api/ai/admin/youtube/health
```

You should see:

```json
{
  "invidious": [
    {"url": "http://<public-ip>:3000", "circuitState": "closed", ...}
  ]
}
```

## Step 7: Bulk-fetch a video transcript

```bash
curl -X POST \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=QCvyyyb-XCQ","language":"en"}' \
  https://your-api.onrender.com/api/ai/admin/kb/sources/youtube
```

Success response (HTTP 201):

```json
{
  "source": {...},
  "transcript": {
    "fetchedVia": "invidious",
    "segmentCount": 247,
    "detectedLanguage": "en"
  }
}
```

If you see `fetchedVia: "invidious"`, you're done. Bulk ingestion now
works at ~100 videos/hour (rate-limited by the `youtubeFetchLimiter`).

## Bulk ingestion script (for 10k+ videos)

Create a script like this on your laptop:

```python
#!/usr/bin/env python3
# scripts/bulk-youtube-ingest.py
import csv, requests, time, sys

API_URL = "https://your-api.onrender.com/api/ai/admin/kb/sources/youtube"
ADMIN_JWT = "<your-admin-jwt>"

with open("video_urls.csv") as f:
    reader = csv.DictReader(f)  # CSV with column "url" + "language"
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
                via = data.get("transcript", {}).get("fetchedVia") or data.get("manualFallback", {}).get("reason", "manual")
                print(f"OK: {row['url']} -> {via}")
            elif r.status_code == 429:
                print(f"RATE LIMITED: sleeping 1 hour...")
                time.sleep(3600)
            else:
                print(f"FAIL: {row['url']} -> HTTP {r.status_code}: {r.text[:200]}")
        except Exception as e:
            print(f"ERR: {row['url']} -> {e}")
        # Pace: 1 video per 40 seconds = ~90/hour (under the 100/hour cap)
        time.sleep(40)
```

Run: `python3 bulk-youtube-ingest.py > ingest.log 2>&1 &`

For 10,000 videos at 40s/video = 111 hours = ~5 days of continuous
ingestion. The script handles rate limits, network errors, and
manual-fallback cases gracefully.

## Hardening (optional, recommended for production)

The above setup exposes Invidious on port 3000 without authentication.
For production:

1. **Add nginx reverse proxy with HTTP basic auth**:

   ```bash
   sudo apt install -y nginx apache2-utils
   sudo htpasswd -c /etc/nginx/.htpasswd yourusername
   ```

2. **Create nginx site config** at `/etc/nginx/sites-available/invidious`:

   ```nginx
   server {
     listen 80;
     server_name _;

     auth_basic "Restricted";
     auth_basic_user_file /etc/nginx/.htpasswd;

     location / {
       proxy_pass http://localhost:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
     }
   }
   ```

3. Enable + reload:

   ```bash
   sudo ln -s /etc/nginx/sites-available/invidious /etc/nginx/sites-enabled/
   sudo rm /etc/nginx/sites-enabled/default
   sudo nginx -t && sudo systemctl reload nginx
   ```

4. Change Docker compose to bind Invidious to localhost only:

   ```yaml
   ports:
     - "127.0.0.1:3000:3000" # nginx proxies externally
   ```

5. Update `INVIDIOUS_INSTANCES` on Render:

   ```
   INVIDIOUS_INSTANCES=http://yourusername:yourpassword@<public-ip>
   ```

6. Optionally add HTTPS via Caddy or certbot (recommended if you're
   putting credentials in the URL).

## Troubleshooting

### "Video unavailable" or empty captions

- Invidious needs ~5 min after first boot to warm up its YouTube session.
- The video might genuinely have no captions (lecture recordings, music
  videos, etc.) — check `https://www.youtube.com/watch?v=<id>` and look
  for the "Show transcript" button. If it's missing, the video has no
  captions and no backend can fetch it.
- Some videos are region-locked. Set the Invidious `INVIDIOUS_REGION`
  env var to match the video's country.

### "Connection refused" from Render

- Oracle's iptables might be blocking port 3000.
- Fix: `sudo iptables -F && sudo netfilter-persistent save`
- Re-check the security list rule in the Oracle console.

### Circuit breaker keeps opening

- Check `/api/ai/admin/youtube/health` on Render.
- If state is `open` with 3+ failures, the Invidious instance is
  rejecting requests. SSH in and check `docker logs invidious`.
- Manually reset: `POST /api/ai/admin/youtube/health/reset`.

### "VM.Standard.E2.1.Micro" not available in your region

- Try a different region (us-phoenix-1, us-ashburn-1, uk-london-1).
- Or use the Ampere A1 shape (`VM.Standard.A1.Flex`) — also Always Free
  eligible, more powerful (4 ARM cores, 24GB RAM).

### Out of memory (OOM)

- The 1GB free tier is tight. If Docker kills Invidious with OOM:
  - Add swap: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`
  - Or upgrade to the Ampere A1 shape (free, more RAM).

## Maintenance

### Update Invidious

```bash
ssh -i ~/.ssh/invidious-key ubuntu@<public-ip>
docker compose -f ~/invidious-compose.yml pull
docker compose -f ~/invidious-compose.yml up -d
```

### Check disk usage

```bash
docker system df
docker compose -f ~/invidious-compose.yml exec postgres du -sh /var/lib/postgresql/data
```

### View logs

```bash
docker compose -f ~/invidious-compose.yml logs -f invidious
```

### Restart

```bash
docker compose -f ~/invidious-compose.yml restart
```

## What this gives you

After completing this guide:

- ✅ Tier 1 (Invidious) works reliably for 100 videos/hour
- ✅ 10,000 videos fetchable in ~5 days of continuous ingestion
- ✅ €0/month cost (Oracle Cloud Always Free tier)
- ✅ Full control over the instance (version, rate limits, regions)
- ✅ No reliance on flaky public Invidious instances
