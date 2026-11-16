# Running imagent on a server Mac

For an always-on Mac (e.g. a Mac mini that already does backups) that other machines send
traces to. Your apps keep running where they are — they only need the server's address.

```
 app Mac (Bosun) ──LAN──► imagent Mac :8300 ──► ClickHouse (Docker, same Mac)
                                   ▲
 you, anywhere ──► https://imagent.<your-domain> (Cloudflare Tunnel + Access login)
```

## 1. Install (on the server Mac)

```bash
git clone https://github.com/Mathankarthik18/imagent.git ~/imagent-monitor
bash ~/imagent-monitor/deploy/server/setup.sh
```

It installs **Colima** (headless Docker — Docker Desktop only runs while someone is logged
in), starts it at every boot with a **LaunchDaemon**, writes `~/imagent-monitor/.env`
(LAN binding, random ClickHouse password, UI read key, a locked ingest key) and starts
imagent. It prints the UI address and read key at the end. Safe to re-run.

Keep the Mac awake: `sudo pmset -a sleep 0 disablesleep 1`.

## 2. Connect an app

In the UI: **New project** → copy the key. On the app's machine, in its `.env`:

```
IMAGENT_ENDPOINT=http://<server>.local:8300
IMAGENT_API_KEY=imk_...
```

Apps send over the office network directly — never through the tunnel below (Cloudflare
Access would block a non-browser client).

## 3. Open the UI from outside the office (Cloudflare Tunnel + Access)

Needs a domain on Cloudflare. On the server Mac:

```bash
brew install cloudflared
cloudflared tunnel login                      # pick the domain in the browser
cloudflared tunnel create imagent
cloudflared tunnel route dns imagent imagent.<your-domain>
cat > ~/.cloudflared/config.yml <<CFG
tunnel: imagent
credentials-file: $HOME/.cloudflared/$(cloudflared tunnel list -o json | python3 -c 'import sys,json;print([t["id"] for t in json.load(sys.stdin) if t["name"]=="imagent"][0])').json
ingress:
  - hostname: imagent.<your-domain>
    service: http://localhost:8300
  - service: http_status:404
CFG
sudo cloudflared --config ~/.cloudflared/config.yml service install   # starts at boot
```

Then put a login in front of it — **Cloudflare dashboard → Zero Trust → Access →
Applications → Add → Self-hosted**: domain `imagent.<your-domain>`, policy *Allow* →
*Emails* (your team's addresses; one-time code by email). Without this step the UI is only
protected by the read key.

## Connect GitHub (for diagnosing issues)

Issues › Diagnose reads the app's code to find the root cause. To let people connect a repo
with one click (**Settings › Source code › Connect GitHub**), create a GitHub App once:

1. **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
   (or under your organisation's settings, to use it on the org's repos).
2. Name it (e.g. `imagent-yourteam`), Homepage URL: your imagent URL. Leave Callback URL empty.
3. Tick **Enable Device Flow**. Untick **Expire user authorization tokens** (or keep it and
   also set the client secret below). Untick **Webhook → Active**.
4. **Permissions → Repository → Contents: Read & write** and **Pull requests: Read & write**
   (Metadata: read-only is added for you). Nothing else. Write is only used by **Create fix branch
   & draft PR** — it commits to a new `imagent/fix-…` branch and never touches existing ones. For
   read-only diagnosis, Contents: Read-only is enough.
5. Create it, then **Install App** on the repos imagent may read.
6. In `~/imagent-monitor/.env`:

   ```bash
   IMAGENT_GITHUB_CLIENT_ID=Iv23li…          # "Client ID" on the app's page
   IMAGENT_GITHUB_APP_SLUG=imagent-yourteam  # from the app's URL; adds a "give access to more repos" link
   # IMAGENT_GITHUB_CLIENT_SECRET=…          # only if tokens expire (step 3)
   ```

7. `docker compose up -d imagent`.

Connecting shows a short code to enter on github.com — no callback URL, so it works the same
behind Cloudflare Access and on localhost. The token stays on the server; imagent writes only
when someone clicks Create fix branch, and only to a new branch. Without the app, Settings takes a pasted read-only token instead.

## Operating it

| | |
|---|---|
| Update | `cd ~/imagent-monitor && git pull && docker compose up -d --build imagent` |
| Logs | `docker compose logs -f imagent` |
| Status | `docker compose ps` · `curl localhost:8300/api/health` |
| After a reboot | nothing to do: Colima starts at boot and the containers restart themselves |
| Disk | traces are kept `IMAGENT_RETENTION_DAYS` (30) days; `docker system df` |
