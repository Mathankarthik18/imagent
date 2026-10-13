#!/usr/bin/env bash
# One-shot setup of an always-on imagent server on a Mac (e.g. the backup Mac mini).
#
#   curl -fsSL https://raw.githubusercontent.com/Mathankarthik18/imagent/main/deploy/server/setup.sh | bash
#   (or: bash deploy/server/setup.sh from a checkout)
#
# What it does (safe to re-run):
#   1. installs Colima + Docker CLI + Compose (headless Docker — no Docker Desktop / no login needed)
#   2. starts Colima now, and at every boot via a LaunchDaemon (a LaunchAgent wouldn't run without a login)
#   3. clones / updates imagent in ~/imagent-monitor
#   4. writes ~/imagent-monitor/.env once: LAN binding, a random ClickHouse password and UI read key
#   5. builds and starts imagent; the containers restart by themselves after a reboot
set -euo pipefail

REPO="${IMAGENT_REPO:-https://github.com/Mathankarthik18/imagent.git}"
DIR="${IMAGENT_DIR:-$HOME/imagent-monitor}"
COLIMA_CPU="${COLIMA_CPU:-2}"
COLIMA_MEMORY="${COLIMA_MEMORY:-4}"   # GB — ClickHouse + imagent fit comfortably
COLIMA_DISK="${COLIMA_DISK:-60}"      # GB — traces are compressed; 30-day retention by default

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

command -v brew >/dev/null || { echo "Homebrew is required: https://brew.sh"; exit 1; }
BREW="$(brew --prefix)"

say "1/5 Installing Colima, Docker CLI, Compose"
brew list colima >/dev/null 2>&1 || brew install colima
brew list docker >/dev/null 2>&1 || brew install docker
brew list docker-compose >/dev/null 2>&1 || brew install docker-compose
mkdir -p "$HOME/.docker/cli-plugins"
ln -sfn "$BREW/opt/docker-compose/bin/docker-compose" "$HOME/.docker/cli-plugins/docker-compose"

say "2/5 Starting Colima (and at every boot)"
if ! colima status >/dev/null 2>&1; then
  colima start --cpu "$COLIMA_CPU" --memory "$COLIMA_MEMORY" --disk "$COLIMA_DISK"
fi
PLIST=/Library/LaunchDaemons/com.imagent.colima.plist
sudo tee "$PLIST" >/dev/null <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.imagent.colima</string>
  <key>UserName</key><string>$(whoami)</string>
  <key>ProgramArguments</key><array>
    <string>$BREW/bin/colima</string><string>start</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$BREW/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/imagent-colima.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/imagent-colima.log</string>
</dict></plist>
PLIST_EOF
sudo chown root:wheel "$PLIST" && sudo chmod 644 "$PLIST"
sudo launchctl bootout system "$PLIST" 2>/dev/null || true
sudo launchctl bootstrap system "$PLIST"

say "3/5 Getting imagent into $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
fi
cd "$DIR"

say "4/5 Configuration ($DIR/.env)"
if [ ! -f .env ]; then
  READ_KEY="imr_$(openssl rand -hex 16)"
  cat > .env <<ENV_EOF
# imagent server — written by deploy/server/setup.sh. Keep this file private.
IMAGENT_BIND=0.0.0.0
CLICKHOUSE_PASSWORD=$(openssl rand -hex 16)
IMAGENT_READ_KEY=$READ_KEY
# Only project API keys (imk_…) may send data; this one is a locked fallback nobody uses.
IMAGENT_INGEST_KEY=$(openssl rand -hex 24)
IMAGENT_RETENTION_DAYS=30
ENV_EOF
  chmod 600 .env
  echo "Created .env (new UI read key)."
else
  echo "Keeping the existing .env."
fi

say "5/5 Building and starting imagent"
docker compose up -d --build
for i in $(seq 1 60); do
  curl -fsS http://127.0.0.1:8300/api/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://127.0.0.1:8300/api/health >/dev/null || { echo "imagent didn't come up — docker compose logs imagent"; exit 1; }

HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s).local"
READ_KEY="$(grep '^IMAGENT_READ_KEY=' .env | cut -d= -f2-)"
cat <<DONE

imagent is running.
  UI (office network):  http://$HOST:8300
  UI read key:          $READ_KEY     (the UI asks for it once — Sidebar → Access key)

Next:
  1. Open the UI, create a project (e.g. "Bosun") and copy its API key.
  2. On the Bosun Mac, add to bosun/.env:
       IMAGENT_ENDPOINT=http://$HOST:8300
       IMAGENT_API_KEY=imk_...
  3. For access from outside the office: deploy/server/README.md → "Cloudflare Tunnel".
DONE
