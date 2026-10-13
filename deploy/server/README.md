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

## Operating it

| | |
|---|---|
| Update | `cd ~/imagent-monitor && git pull && docker compose up -d --build imagent` |
| Logs | `docker compose logs -f imagent` |
| Status | `docker compose ps` · `curl localhost:8300/api/health` |
| After a reboot | nothing to do: Colima starts at boot and the containers restart themselves |
| Disk | traces are kept `IMAGENT_RETENTION_DAYS` (30) days; `docker system df` |
