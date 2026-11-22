#!/bin/bash
# Install or update the Opportunity Nav server on a Mac (e.g. the Studio):
# pull, install, build the UI, write the env file once, run it as a LaunchAgent,
# and publish it on the tailnet over HTTPS with `tailscale serve`.
#   deploy/install-server-macos.sh [--https-port 8443] [--db opportunity_nav]
set -euo pipefail
# Everything runs inside main() so bash has read the whole file before `git pull` can replace it.
main() {
HTTPS_PORT=8443
DB=opportunity_nav
while [ $# -gt 0 ]; do case "$1" in --https-port) HTTPS_PORT=$2; shift 2;; --db) DB=$2; shift 2;; *) echo "Unknown option $1"; exit 2;; esac; done

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@18/bin:$HOME/.local/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
command -v tailscale >/dev/null && TS=tailscale

echo "• Updating code"
git pull --ff-only
npm ci --no-audit --no-fund
npm run build -w @opnav/web

echo "• Database"
pg_isready -h 127.0.0.1 -q || { echo "Postgres isn't running on 127.0.0.1:5432 (brew services start postgresql@18)."; exit 1; }
psql -h 127.0.0.1 -d postgres -Atc "select 1 from pg_database where datname = '$DB'" | grep -q 1 || createdb -h 127.0.0.1 "$DB"

DNS=$($TS status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
PUBLIC_URL="https://$DNS:$HTTPS_PORT"
CONF="$HOME/.config/opportunity-nav"
mkdir -p "$CONF" && chmod 700 "$CONF"
if [ ! -f "$CONF/server.env" ]; then
  echo "• Writing $CONF/server.env"
  umask 077
  cat > "$CONF/server.env" <<ENV
DATABASE_URL=postgres://$(whoami)@127.0.0.1:5432/$DB
HOST=127.0.0.1
PORT=4317
PUBLIC_URL=$PUBLIC_URL
OPNAV_ASSISTANT_CMD=$(command -v claude || echo claude)
PATH=$PATH
ENV
fi
chmod 600 "$CONF/server.env"

echo "• LaunchAgent"
PLIST="$HOME/Library/LaunchAgents/dev.opportunitynav.server.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/opportunity-nav"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.opportunitynav.server</string>
  <key>ProgramArguments</key><array><string>$ROOT/deploy/run-server.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/opportunity-nav/server.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/opportunity-nav/server.log</string>
</dict></plist>
PL
chmod +x "$ROOT/deploy/run-server.sh"
SVC="gui/$(id -u)/dev.opportunitynav.server"
if launchctl print "$SVC" >/dev/null 2>&1; then
  launchctl bootout "$SVC" 2>/dev/null || true
  # bootout returns before launchd lets go; bootstrapping too soon fails with "Input/output error".
  for i in $(seq 1 20); do launchctl print "$SVC" >/dev/null 2>&1 || break; sleep 0.5; done
fi
launchctl bootstrap "gui/$(id -u)" "$PLIST"
for i in $(seq 1 30); do curl -sf http://127.0.0.1:4317/healthz >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:4317/healthz >/dev/null || { echo "Server didn't come up; see ~/Library/Logs/opportunity-nav/server.log"; exit 1; }

echo "• Tailnet HTTPS"
$TS serve --bg --https="$HTTPS_PORT" http://127.0.0.1:4317 >/dev/null
echo "Up at $PUBLIC_URL"
}
main "$@"
