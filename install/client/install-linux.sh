#!/usr/bin/env bash
# Hearth — Linux client installer / repair.
#
#   bash install-linux.sh              # download the latest and install
#   bash install-linux.sh ./Some.AppImage   # install a file you already have
#
# What it does, and why:
#   * Installs to ONE stable path (~/Applications/Hearth.AppImage) with no
#     version in the filename. A versioned name is what breaks self-updating
#     menu entries: the launcher pins to "Hearth-0.6.5.AppImage" forever while
#     updates land elsewhere, so every launch runs the old build and offers the
#     same update again.
#   * Points the application-menu entry at that stable path.
#   * Removes stale Hearth AppImages and old menu entries so nothing can
#     launch an outdated copy by accident.
#   * Leaves your settings and identity (~/.config/Hearth) completely alone.
set -euo pipefail

PUBLIC_REPO="silkhelp-wq/hearth-releases"
TARGET_DIR="$HOME/Applications"
TARGET="$TARGET_DIR/Hearth.AppImage"
DESKTOP="$HOME/.local/share/applications/hearth.desktop"

say()  { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m  ! \033[0m%s\n' "$1"; }
die()  { printf '\n\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

mkdir -p "$TARGET_DIR" "$(dirname "$DESKTOP")"

# ── 1. Get the AppImage ───────────────────────────────────────────────────
SRC="${1:-}"
if [ -n "$SRC" ]; then
  [ -f "$SRC" ] || die "No such file: $SRC"
  say "Installing from $SRC"
  cp -f "$SRC" "$TARGET.new"
else
  command -v curl >/dev/null || die "curl is required to download."
  say "Finding the latest Hearth release…"
  URL="$(curl -fsSL "https://api.github.com/repos/$PUBLIC_REPO/releases/latest" \
        | grep -o 'https://[^"]*\.AppImage' | head -1)"
  [ -n "$URL" ] || die "Couldn't find an AppImage in the latest release of $PUBLIC_REPO."
  say "Downloading: $(basename "$URL")"
  curl -fL --progress-bar -o "$TARGET.new" "$URL"
fi

SIZE=$(stat -c%s "$TARGET.new" 2>/dev/null || stat -f%z "$TARGET.new")
[ "$SIZE" -gt 10000000 ] || die "Download looks wrong (only $SIZE bytes)."
chmod +x "$TARGET.new"
mv -f "$TARGET.new" "$TARGET"          # atomic; safe even if Hearth is running
say "Installed to: $TARGET"

# ── 2. Menu entry pointing at the STABLE path ─────────────────────────────
{
  echo '[Desktop Entry]'
  echo 'Name=Hearth'
  echo 'Comment=Your private voice, video and chat hangout'
  echo "Exec=$TARGET"
  echo 'Icon=applications-internet'
  echo 'Terminal=false'
  echo 'Type=Application'
  echo 'Categories=Network;AudioVideo;'
  echo 'StartupWMClass=Hearth'
} > "$DESKTOP"
chmod +x "$DESKTOP" 2>/dev/null || true
say "Menu entry written: $DESKTOP"

# ── 3. Purge stale copies so nothing launches an old build ────────────────
say "Cleaning up old Hearth copies…"
FOUND=0
while IFS= read -r old; do
  [ "$old" = "$TARGET" ] && continue
  rm -f "$old" && warn "removed old AppImage: $old"
  FOUND=1
done < <(find "$HOME" -maxdepth 4 -iname 'Hearth*.AppImage' 2>/dev/null || true)
[ "$FOUND" -eq 0 ] && echo "    (none found — clean)"

# Old menu entries that point somewhere other than the stable path.
while IFS= read -r d; do
  [ "$d" = "$DESKTOP" ] && continue
  if grep -qi 'hearth' "$d" 2>/dev/null; then
    rm -f "$d" && warn "removed stale menu entry: $d"
  fi
done < <(find "$HOME/.local/share/applications" -maxdepth 1 -iname '*hearth*.desktop' 2>/dev/null || true)

# ── 4. Refresh the menu ───────────────────────────────────────────────────
command -v update-desktop-database >/dev/null && \
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 2>/dev/null || true
command -v kbuildsycoca5 >/dev/null && kbuildsycoca5 2>/dev/null || true

say "Done. Search your application menu for 'Hearth' and launch it."
echo "    From now on Hearth updates itself in place at this same path,"
echo "    so the menu always runs the current version."
echo ""
echo "    Your settings and identity in ~/.config/Hearth were not touched."
