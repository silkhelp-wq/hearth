#!/usr/bin/env bash
# Reclaim Hearth server ownership from the host — always works, even when a
# device-token change has stranded the old owner. Prints a fresh claim code;
# enter it in the client's Settings → Server.
#
#   ./reclaim-owner.sh
#
# Finds the installed server + its data dir automatically.
set -euo pipefail

# Stop the service so the DB isn't locked, run reclaim, restart.
SERVICE="hearth-server.service"
WAS_RUNNING=0
if systemctl --user is-active --quiet "$SERVICE" 2>/dev/null; then
  WAS_RUNNING=1
  systemctl --user stop "$SERVICE"
fi

# Locate the server entry (native package first, then repo).
ENTRY=""
for p in /opt/hearth-server/src/index.js \
         "$(dirname "$(readlink -f "$0")")/src/index.js"; do
  [ -f "$p" ] && ENTRY="$p" && break
done
[ -z "$ENTRY" ] && { echo "Could not find the Hearth server install."; exit 1; }

HEARTH_DATA_DIR="${HEARTH_DATA_DIR:-$HOME/.local/share/hearth/data}" \
  node "$ENTRY" --reclaim-owner

[ "$WAS_RUNNING" -eq 1 ] && systemctl --user start "$SERVICE"
echo "  Server restarted. Claim the code now in the app."
