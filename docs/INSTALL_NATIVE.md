# Native install, background service, and auto-update

No more "keep a terminal open." Both the server and the desktop app can run
and update themselves like normal software.

## Server — three ways to run it

### A. Native CachyOS / Arch package (recommended on your box)

```
cd server/packaging
makepkg -si
systemctl --user enable --now hearth-server
```

That's it — the server now starts on login and restarts on failure, no
terminal. For 24/7 (running even when you're logged out):

```
sudo loginctl enable-linger "$USER"
```

Settings are optional; create `~/.config/hearth/hearth.env` for GIF keys or a
public IP, then `systemctl --user restart hearth-server`.

### B. Install script (any systemd Linux — Ubuntu, Fedora, …)

```
cd server
./install-server.sh
```

Same result via a user service. Re-run it any time to update — it wipes the
old program files but **keeps your `data/`** (database, emojis, owner claim,
storage settings) and your `hearth.env`.

Remove it cleanly:

```
./install-server.sh --uninstall   # keep data (backed up to your home dir)
./install-server.sh --purge       # remove everything, data included
```

### C. Plain `npm start`

Still works for quick tests, but you keep the terminal open. The two options
above are strictly better for a server you actually rely on.

### Where your data lives

`~/.local/share/hearth/data` (package) or `<install>/data` (script). The
database is WAL-mode SQLite; copy the whole folder while the server is stopped
for a backup. Upgrades and removals never touch it.

## Desktop app — install & auto-update

The installers come from the private repo's Releases:
`.AppImage` (universal Linux), `.deb` (Debian/Ubuntu), `.exe` (Windows),
`.dmg` (macOS). Install once, then the app **checks for updates on its own**:

- On launch it quietly checks the repo's latest release.
- In **Settings → Audio** (top row) you see the current version and a
  **Check for updates** button; when a newer release exists, **Update now**
  downloads the right file for your OS and installs it (the AppImage updates
  itself in place; deb/exe/dmg hand off to the OS installer, then Hearth
  restarts).

Re-installing over an old version replaces all program files, so nothing
stale is left behind on any OS. Your settings live in the app's profile and
carry over.

### Native CachyOS / Arch client package

electron-builder's pacman target is unreliable in CI, so the AppImage is the
CI Linux artifact and the native Arch package is built locally from it:

```
cd client
npm install && npm run build
npx electron-builder --linux AppImage
cd packaging
makepkg -si
```

That wraps the AppImage into a real pacman package (`hearth` in your menu,
`hearth` on the command line), removable with `sudo pacman -R hearth`. The
in-app auto-updater still works — it updates the AppImage inside `/opt/hearth`
in place.

## Auto-update on a PRIVATE repo — the token

Because the repo is private, update checks need a **read-only** GitHub token
so the app can see releases. Create a fine-grained personal access token
scoped to **only this repo** with **Contents: Read-only**, then:

- **Desktop app:** drop the token in `client/build/update-token.txt` before
  building the installers. electron-builder bundles it into the app's
  resources. A leak exposes nothing but read access to releases you already
  share with your friends. If the file is absent, auto-update simply stays
  off (the app still works).
- **Server:** put the same token in `server/hearth-update-token.txt` (or set
  `HEARTH_UPDATE_TOKEN`). The owner sees a "Check server update" button in
  Settings → Server → Monitor; when a newer release exists, re-run the
  install method above to apply it (data preserved).

The token file is git-ignored, so it never lands in the repo.

## Keeping the repo private

Everything here works with the repo private. The only public surface is the
release assets, which only someone with the token (your friends' installed
apps) can fetch. Nothing about the source is exposed.
