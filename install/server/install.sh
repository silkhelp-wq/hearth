#!/usr/bin/env bash
# Hearth server — one-command installer for Linux (home machine or VPS).
#
#   bash install.sh
#
# Installs Node deps, sets up a background service, and prints your owner
# claim code. Safe to re-run to update. Your data is never touched.
set -euo pipefail

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

printf '\033[1mHearth — server installer\033[0m\n'
echo "This will:"
echo "  1. Install the server's dependencies (compiles a few native pieces)"
echo "  2. Set up a background service so it runs on its own (where systemd exists)"
echo "  3. Print your OWNER CLAIM CODE — you'll paste it into the Hearth app"
echo ""
echo "Before continuing you need: Node.js 22+ installed."
echo "Home hosting? Also have Tailscale installed and connected."
echo "Cloud/VPS?   Set your public IP first, e.g.:"
echo "  echo \"HEARTH_ANNOUNCED_IP=YOUR.PUBLIC.IP\" >> ~/.config/hearth/hearth.env"
if [ -t 0 ]; then read -r -p "Press Enter to continue (Ctrl-C to cancel)… " _; fi

command -v node >/dev/null || die "Node.js is not installed. Install Node 22+ first: https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20+ required (you have $(node -v))."

cd "$(dirname "$(readlink -f "$0")")"

say "Installing server dependencies (this compiles a few native pieces; give it a minute)…"
npm install --omit=dev

DATA="${HEARTH_DATA_DIR:-$HOME/.local/share/hearth/data}"
mkdir -p "$DATA"

# Optional: set a public IP for cloud/VPS hosting (skip for Tailscale/home).
ENVFILE="$HOME/.config/hearth/hearth.env"
mkdir -p "$(dirname "$ENVFILE")"
touch "$ENVFILE"

if command -v systemctl >/dev/null && systemctl --user >/dev/null 2>&1; then
  say "Setting up a background service so the server runs on its own…"
  SVC_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SVC_DIR"
  cat > "$SVC_DIR/hearth-server.service" <<UNIT
[Unit]
Description=Hearth server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$(pwd)
EnvironmentFile=$ENVFILE
Environment=HEARTH_DATA_DIR=$DATA
ExecStart=$(command -v node) src/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now hearth-server
  sleep 2
  say "Server is running in the background. It will start automatically on boot."
  echo "    Logs:    journalctl --user -u hearth-server -f"
  echo "    Restart: systemctl --user restart hearth-server"
  echo ""
  say "Your OWNER CLAIM CODE (enter it in the app: Settings -> Server):"
  journalctl --user -u hearth-server --since "1 minute ago" | grep -i 'claim code' || \
    echo "    (already claimed, or run: node src/index.js --reclaim-owner)"
else
  say "No systemd here — starting the server in this window."
  echo "    Keep this window open. Your claim code prints below."
  HEARTH_DATA_DIR="$DATA" exec node src/index.js
fi
