#!/usr/bin/env bash
# Hearth server — installer / updater for Linux (CachyOS, Arch, Ubuntu, …).
#
# Installs the server under ~/.local/share/hearth-server, runs it as a
# systemd *user* service (starts on login, no terminal window), and PRESERVES
# your data/ (database, emojis, owner claim, storage settings) across updates.
#
# Usage:
#   ./install-server.sh            install or update in place (keeps data)
#   ./install-server.sh --purge    remove everything INCLUDING data
#   ./install-server.sh --uninstall remove the app but KEEP data
#
# Re-running always wipes the old program files first, so nothing stale is
# left behind — only data/ survives (unless --purge).

set -euo pipefail

APP_DIR="$HOME/.local/share/hearth-server"
DATA_DIR="$APP_DIR/data"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE="hearth-server.service"
ENV_FILE="$APP_DIR/hearth.env"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\033[1;32m»\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$1"; }

stop_service() {
  if systemctl --user list-unit-files 2>/dev/null | grep -q "$SERVICE"; then
    systemctl --user stop "$SERVICE" 2>/dev/null || true
  fi
}

do_uninstall() {
  local keep_data="$1"
  stop_service
  systemctl --user disable "$SERVICE" 2>/dev/null || true
  rm -f "$SERVICE_DIR/$SERVICE"
  systemctl --user daemon-reload 2>/dev/null || true

  if [[ "$keep_data" == "keep" && -d "$DATA_DIR" ]]; then
    local backup="$HOME/hearth-data-backup-$(date +%Y%m%d%H%M%S)"
    say "Preserving your data at $backup"
    cp -a "$DATA_DIR" "$backup"
    rm -rf "$APP_DIR"
    say "Server removed. Your data is safe at $backup"
  else
    rm -rf "$APP_DIR"
    say "Server and all data removed."
  fi
  exit 0
}

case "${1:-}" in
  --uninstall) do_uninstall keep ;;
  --purge)     do_uninstall purge ;;
esac

# ── preflight ───────────────────────────────────────────────────────────
command -v node >/dev/null || { warn "Node.js not found. Install Node 22+ first."; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then warn "Node $NODE_MAJOR found; Hearth needs 22+."; exit 1; fi
command -v systemctl >/dev/null || { warn "systemd not found; this script targets systemd systems."; exit 1; }

for opt in yt-dlp ffmpeg; do
  command -v "$opt" >/dev/null || warn "optional: $opt not found — the jukebox will stay disabled until it is installed"
done

# ── preserve data across the wipe ───────────────────────────────────────
TMP_DATA=""
if [[ -d "$DATA_DIR" ]]; then
  say "Existing install found — preserving data/ across the update"
  TMP_DATA="$(mktemp -d)"
  cp -a "$DATA_DIR/." "$TMP_DATA/"
fi

TMP_ENV=""
if [[ -f "$ENV_FILE" ]]; then
  TMP_ENV="$(mktemp)"
  cp "$ENV_FILE" "$TMP_ENV"
fi

# ── clean install (no stale files) ──────────────────────────────────────
stop_service
say "Installing fresh program files"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR" "$DATA_DIR" "$SERVICE_DIR"

# Copy server sources (everything except any bundled data/ and node_modules).
cp -a "$SRC_DIR/." "$APP_DIR/" 2>/dev/null || true
rm -rf "$APP_DIR/node_modules" "$APP_DIR/data"
mkdir -p "$DATA_DIR"

# restore data + env
if [[ -n "$TMP_DATA" ]]; then cp -a "$TMP_DATA/." "$DATA_DIR/"; rm -rf "$TMP_DATA"; fi
if [[ -n "$TMP_ENV" ]]; then cp "$TMP_ENV" "$ENV_FILE"; rm -f "$TMP_ENV"; fi

# first-run env template (edit to add GIF keys, public IP, etc.)
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<'ENVEOF'
# Hearth server settings — uncomment and edit as needed, then:
#   systemctl --user restart hearth-server
# HEARTH_NAME=Hearth
# HEARTH_PORT=4443
# HEARTH_MEDIA_PORT=44444
# HEARTH_ANNOUNCED_IP=       # set to your PUBLIC IP for VPS hosting (no Tailscale)
# HEARTH_TENOR_KEY=
# HEARTH_GIPHY_KEY=
# HEARTH_IMGUR_CLIENT_ID=
ENVEOF
  say "Wrote settings template: $ENV_FILE"
fi

# ── dependencies ────────────────────────────────────────────────────────
say "Installing dependencies (this can take a minute)"
( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund )
# native build scripts (mediasoup worker, better-sqlite3) — approve + rebuild
( cd "$APP_DIR" && npm install-scripts approve mediasoup better-sqlite3 2>/dev/null || true )
( cd "$APP_DIR" && npm rebuild mediasoup better-sqlite3 2>/dev/null || true )

# ── systemd user service ────────────────────────────────────────────────
cat > "$SERVICE_DIR/$SERVICE" <<EOF
[Unit]
Description=Hearth voice/chat server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=-$ENV_FILE
Environment=HEARTH_DATA_DIR=$DATA_DIR
ExecStart=$(command -v node) $APP_DIR/src/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$SERVICE"
systemctl --user restart "$SERVICE"

# Let the service survive logout / run at boot without an active session.
loginctl enable-linger "$USER" 2>/dev/null || \
  warn "Could not enable linger — the server runs while you're logged in; run 'sudo loginctl enable-linger $USER' for 24/7."

sleep 2
say "Hearth server is running as a user service."
echo
echo "  Status:   systemctl --user status hearth-server"
echo "  Logs:     journalctl --user -u hearth-server -f"
echo "  Settings: $ENV_FILE  (restart after editing)"
echo "  Stop:     systemctl --user stop hearth-server"
echo
echo "  The owner claim code is in the logs on first run:"
echo "    journalctl --user -u hearth-server | grep -i 'claim code'"
