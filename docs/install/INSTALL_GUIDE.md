# Hearth — Complete Installation Guide

This is the one-stop guide to getting Hearth running, whichever side of it
you're on. Hearth has two halves:

- **The client** — the desktop app each person runs. Windows, macOS, and
  Linux. This is what 90% of readers want.
- **The server** — one machine that hosts the hangout. Exactly one person in
  the group runs this. See the [server host guide](#part-2--the-server-host-one-person)
  or, for the production-grade path, the DevOps deployment docs.

If someone already runs the server and handed you an address, skip to
[installing the client](#part-1--the-client-everyone). You only need the
address and the app.

---

## Part 1 — The client (everyone)

The client is a normal desktop application. Download the installer for your OS
from the [Releases page](https://github.com/silkhelp-wq/hearth/releases/latest),
run it, paste in the server address, pick a name, and you're in. Details and
gotchas per platform below.

### Which file do I download?

| OS | File | Notes |
|----|------|-------|
| Windows 10/11 | `Hearth.Setup.<version>.exe` | Standard installer |
| macOS (Apple Silicon) | `Hearth-<version>-arm64.dmg` | M1/M2/M3/M4 Macs |
| macOS (Intel) | `Hearth-<version>.dmg` | Older Intel Macs, if published |
| Linux (universal) | `Hearth-<version>.AppImage` | Runs on any distro |
| Linux (Debian/Ubuntu) | `hearth_<version>_amd64.deb` | apt-based systems |
| Arch/CachyOS | build from `client/packaging/` | Native pacman package |

All builds are **unsigned** — this is a hobby app for a private group, not a
notarized commercial product. That means every OS will show a "this is from an
unidentified developer" warning the first time. That's expected; the steps
below tell you how to get past it on each platform.

---

### Windows

1. Download `Hearth.Setup.<version>.exe`.
2. Double-click it. **Windows SmartScreen will very likely block it** with a
   blue "Windows protected your PC" box. This is because the app isn't signed
   with a paid code-signing certificate — not because anything is wrong.
3. Click **More info**, then **Run anyway**.
4. The app installs and launches. On the connect screen, paste the server
   address your host gave you and enter a display name.

**Windows pitfalls to watch for:**

- **Do NOT run the app from an Administrator terminal or "Run as
  administrator."** Windows screen-capture permissions behave differently for
  elevated processes, and you can end up unable to share your screen (or
  accidentally sharing the wrong window). Just launch it normally.
- **Screen share shows no previews / capture is blocked (Windows 11 24H2+):**
  newer Windows builds gate screen capture behind a privacy permission. Go to
  **Settings → Privacy & security → screen-capture permissions** and allow it,
  then update your GPU driver. Restart Hearth afterward.
- **Antivirus quarantine:** some aggressive AV suites flag unsigned Electron
  apps. If Hearth vanishes after install, check your AV quarantine and add an
  exception.
- **Desktop audio in screen share works out of the box on Windows** — tick the
  "share audio" box in the share dialog and it captures what Windows is
  playing. (This is the one platform where that Just Works; see the Linux notes
  for why Linux is harder.)

---

### macOS

1. Download the `.dmg` that matches your chip (arm64 for Apple Silicon).
2. Open the `.dmg` and drag **Hearth** to your Applications folder.
3. The first launch will be blocked: **"Hearth can't be opened because Apple
   cannot check it for malicious software."** Again — unsigned app, expected.
4. Right-click (or Control-click) the Hearth app in Applications → **Open** →
   **Open** in the dialog. You only have to do this once; after that it opens
   normally.
   - Alternatively: **System Settings → Privacy & Security**, scroll to the
     "Hearth was blocked" message, and click **Open Anyway**.

**macOS pitfalls to watch for:**

- **Screen recording permission is mandatory.** The first time you try to
  share your screen, macOS pops a permission request. If you miss it or deny
  it, screen share silently fails. Fix: **System Settings → Privacy &
  Security → Screen Recording**, enable **Hearth**, then fully quit and reopen
  the app (the permission only takes effect on restart).
- **Microphone and camera permissions** are prompted on first use — allow
  them, or you'll be listen-only / camera-less.
- **Desktop audio in screen share needs a loopback driver.** macOS has no
  built-in way to capture system audio. If you want the crew to hear your
  game/video, install a virtual audio device like
  [BlackHole](https://github.com/ExistentialAudio/BlackHole) (free), route your
  system output through it, and select it as your output. Without this, your
  screen share is video-only.

---

### Linux — AppImage (works on every distro)

The AppImage is the universal option: one self-contained file, no install, no
package manager.

1. Download `Hearth-<version>.AppImage`.
2. Make it executable:
   ```
   chmod +x Hearth-<version>.AppImage
   ```
3. Run it:
   ```
   ./Hearth-<version>.AppImage
   ```

**Getting it into your application menu** (so you're not launching from a
terminal every time) — create a desktop entry:

```
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/hearth.desktop <<'EOF'
[Desktop Entry]
Name=Hearth
Exec=/full/path/to/Hearth-<version>.AppImage
Icon=applications-internet
Type=Application
Categories=Network;AudioVideo;
EOF
update-desktop-database ~/.local/share/applications
```

(On KDE, follow with `kbuildsycoca6` to refresh the menu immediately.) Replace
`/full/path/to/` with the real path — and note that if you move or delete the
AppImage later, the launcher breaks. Since the app auto-updates the AppImage in
place, leaving it where it is keeps everything working.

> **fish shell users:** the `cat > file <<'EOF'` heredoc above is bash syntax
> and will not work in fish. Either run it in a `bash` subshell, or write the
> file with a series of `echo '...' >> ~/.local/share/applications/hearth.desktop`
> lines instead.

**Linux AppImage pitfalls:**

- **"dlopen(): error loading libfuse.so.2" or the AppImage won't start:**
  AppImages need FUSE. On Arch/CachyOS: `sudo pacman -S fuse2`. On
  Debian/Ubuntu: `sudo apt install libfuse2`.
- **Wayland screen share opens a system picker, not an in-app one** — this is
  correct and intentional (see the Wayland section below).

---

### Linux — Debian / Ubuntu (.deb)

```
sudo apt install ./hearth_<version>_amd64.deb
```

apt resolves dependencies automatically. Hearth then appears in your
application menu. To update later, download the newer `.deb` and run the same
command, or let the in-app updater handle it.

---

### Linux — Arch / CachyOS (native package)

The AppImage works fine, but a native pacman package integrates cleanly with
your system menu and updates through pacman. Build it from the repo:

```
git clone https://github.com/silkhelp-wq/hearth.git
cd hearth
# put a downloaded AppImage where the PKGBUILD expects it:
mkdir -p client/release
cp ~/Downloads/Hearth-<version>.AppImage client/release/
cd client/packaging
makepkg -si
```

Hearth is now in your menu and available as the `hearth` command.
`sudo pacman -R hearth` removes it.

**Arch packaging pitfalls:**

- **`makepkg` fails with "cannot stat '.../squashfs-root/hearth.png'":** this
  is a stale build cache. Clear it and rebuild:
  ```
  rm -rf pkg src
  makepkg -si --force
  ```
- **If the native package keeps fighting you, just use the AppImage** with a
  hand-written `.desktop` launcher (see the AppImage section). It's the same
  app; the package only adds menu/pacman integration.

---

### Linux — Wayland vs X11 (important for screen sharing)

Hearth detects Wayland automatically and adapts its screen-share flow:

- **On Wayland** (modern KDE/GNOME default), your desktop's own screen picker
  (the xdg-desktop-portal dialog) is the *only* picker. When you click "Go
  live," that system dialog opens once — choose your screen or window there.
  Hearth does **not** show its own thumbnail grid on Wayland, by design: doing
  so would open the portal twice and abort the share.
  - You need `xdg-desktop-portal` **and** your compositor's backend installed.
    On KDE: `xdg-desktop-portal-kde`. On GNOME: `xdg-desktop-portal-gnome`. If
    the picker never appears, this is almost always the missing piece.
- **On X11**, Hearth shows its own in-app source picker with thumbnails.

**Desktop audio in screen share on Linux is the hard case.** Chromium on
Wayland cannot capture desktop audio directly. If you want the crew to hear
your game/video, route your audio through a **PipeWire virtual sink** and
select that virtual device as your *microphone* in Hearth. This is a
distro-specific setup (search "PipeWire virtual sink loopback"); it's the one
rough edge of Linux streaming.

**NVIDIA + Wayland lag note:** if your screen share is choppy at high
resolution, see the [engineering docs on hardware
encoding](../engineering/STREAMING_INTERNALS.md). Short version: Chromium's
WebRTC on Linux can't use NVIDIA's NVENC encoder (it's a driver limitation, not
a Hearth bug), so 4K screen share is software-encoded and CPU-bound. Dropping
to VP8 at 1080p/30 is the practical fix.

---

### Connecting for the first time (all platforms)

1. Launch Hearth.
2. On the connect screen, paste the **server address** your host gave you.
   It looks like `http://100.x.y.z:4443` (a Tailscale address) or
   `https://hearth.example.com` (a public host).
3. Enter a **display name**.
4. Click connect. You'll land in the lobby with the list of voice and text
   channels on the left.

If you're the **first person ever** to connect and the host tells you to claim
ownership, they'll give you a **claim code** — paste it into **Settings →
Server** to become the owner (admin). See the [ownership
section](#claiming-and-recovering-ownership) below.

---

## Part 2 — The server host (one person)

One person in the group runs the server. There are three ways to do it, from
simplest to most robust:

1. **Quick / from source** — clone, `npm install`, `npm start`. Good for
   trying it out. See [`INSTALL_HOST.md`](../INSTALL_HOST.md).
2. **Native service (Linux)** — install as a `systemd` user service so it runs
   in the background and survives reboots. This is the recommended home-host
   setup. See [`INSTALL_NATIVE.md`](../INSTALL_NATIVE.md).
3. **Production / cloud** — run it on a VPS or in any cloud with TLS. See the
   [DevOps deployment guide](../deployment/DEPLOYMENT_GUIDE.md).

### Server requirements

- **Node.js 20+** (22 recommended).
- A machine that stays on while people hang out — a spare desktop, a home
  server, a Raspberry Pi 4/5, or a small cloud VM.
- **Tailscale** on the host and every client (the zero-config networking
  path), OR a public IP + domain + TLS for the public path.
- Enough **upload bandwidth** — this is the real constraint. The host relays
  everyone's streams, so host upload is the shared ceiling. See
  [`STREAM_SETTINGS.md`](../STREAM_SETTINGS.md) for the math.

### The fastest possible server

```
git clone https://github.com/silkhelp-wq/hearth.git
cd hearth/server
npm install
npm start
```

On boot the server prints its address and, on first run with a fresh database,
an **owner claim code**. Give the address to your friends; use the claim code
yourself in Settings → Server.

### Networking: Tailscale (recommended)

Hearth is built to avoid port forwarding. Install
[Tailscale](https://tailscale.com) on the host and every client — they join the
same private WireGuard mesh, and the server auto-detects its Tailscale address
(the `100.x.y.z` one). Everyone connects to that. No router config, no exposed
ports, end-to-end encrypted. See [`CONNECTION_GUIDE.md`](../CONNECTION_GUIDE.md).

### Networking: public host

If you'd rather run it on a public VPS, set `HEARTH_ANNOUNCED_IP` to the
server's public IP and put a TLS reverse proxy (Caddy is easiest) in front.
See [`DEPLOY_PUBLIC.md`](../DEPLOY_PUBLIC.md) and the
[deployment guide](../deployment/DEPLOYMENT_GUIDE.md).

---

## Claiming and recovering ownership

Hearth has a single **owner** (the top admin). Ownership is claimed once with a
code the server prints, and it binds to the claiming client's device identity.

- **First claim:** on a fresh database, the server prints a claim code in its
  logs. Native-service hosts can find it with:
  ```
  journalctl --user -u hearth-server --since "5 minutes ago" | grep -i 'claim code'
  ```
  Paste it into **Settings → Server**.

- **Locked out?** If your device identity changes (a reinstall into a different
  profile, connecting from a browser tab, or a data reset), ownership can end
  up stranded on the old identity. The server operator can always reclaim from
  the host machine:
  ```
  hearth-reclaim-owner
  ```
  (or, from source: `node src/index.js --reclaim-owner`). This mints a fresh
  claim code and re-opens claiming. Enter the new code in Settings → Server to
  take ownership on your current client, then remove any duplicate members from
  the roster.

**Tip:** treat one client — your installed desktop app — as your canonical
identity, and use browser tabs only for quick access. Every browser profile
that connects registers as a separate member.

---

## Keeping Hearth updated

- **Client:** the desktop app checks the releases page and updates itself.
  **Settings → Audio → Check for updates** (also runs automatically). It
  downloads the new version and restarts.
- **Server (native package):** the server monitor (**Settings → Server**)
  tells you when a newer release exists. Apply it by re-running the install
  (`makepkg -si --force` for the Arch package, or your platform's equivalent)
  and restarting the service. Your data and settings are preserved across
  upgrades.

For the server to check for updates against the private repo, it needs a
read-only access token in its environment file — see
[`INSTALL_NATIVE.md`](../INSTALL_NATIVE.md).

---

## Quick troubleshooting index

| Symptom | Likely cause | Where to look |
|---------|--------------|---------------|
| Windows blocks the installer | Unsigned app / SmartScreen | Windows section above |
| macOS "can't be opened" | Unsigned app / Gatekeeper | macOS section above |
| macOS screen share fails silently | Screen Recording permission | macOS pitfalls |
| Can't share screen on Windows | Elevated process or 24H2 privacy gate | Windows pitfalls |
| AppImage won't launch | Missing FUSE | Linux AppImage pitfalls |
| Wayland picker never appears | Missing `xdg-desktop-portal-*` backend | Wayland section |
| No desktop audio in share (Linux) | Chromium can't capture it | Wayland section / PipeWire sink |
| Screen share choppy at 4K (NVIDIA) | No NVENC in browser WebRTC | Streaming internals doc |
| Locked out of ownership | Device identity changed | Ownership section |
| Can't connect at all | Wrong address / Tailscale down | `CONNECTION_GUIDE.md` |

For anything deeper, the [engineering docs](../engineering/) cover the system
internals, and the [deployment guide](../deployment/DEPLOYMENT_GUIDE.md) covers
running the server at scale.
