# Client Install — the Hearth desktop app

> **Audience:** everyone joining a Hearth · **Difficulty:** none — no
> technical knowledge needed · **Time:** ~10 minutes including Tailscale

**The short version:** install Tailscale (the group's private network), install
Hearth from the Releases page, paste the address your host gave you. The
[complete step-by-step guide with per-OS pitfalls](install/INSTALL_GUIDE.md)
walks every click; this page is the quick reference.

## 1. Join the group's network first

If your host gave you an address starting with `http://100.` you need
[Tailscale](https://tailscale.com/download) installed and signed in **before
Hearth can connect** — ask your host for the invite link to their network
(tailnet), accept it, and leave Tailscale running. If your address starts with
`https://` (a public host), skip this step.

## 2. Install Hearth

Download from the **[Releases page](https://github.com/silkhelp-wq/hearth/releases/latest)**:

| Your computer | Download | First-run note |
|---|---|---|
| Windows 10/11 | `Hearth.Setup.<version>.exe` | SmartScreen will warn once: **More info → Run anyway** |
| Mac (Apple Silicon) | `Hearth-<version>-arm64.dmg` | First open: **right-click the app → Open → Open** |
| Linux (any distro) | `Hearth-<version>.AppImage` | Mark executable, then run (details in the full guide) |
| Ubuntu/Debian | `hearth_<version>_amd64.deb` | `sudo apt install ./hearth_<version>_amd64.deb` |

The warnings are because the builds are unsigned (a private hobby app, not a
notarized commercial product) — expected, and you only clear them once.

## 3. Connect

Launch Hearth → paste the server address from your host → pick a display name
→ connect. **You're done when** you see the channel list on the left and can
click a voice hall. If it won't connect, 9 times out of 10 Tailscale isn't
running or you haven't accepted the tailnet invite — see the
[Connection Guide](CONNECTION_GUIDE.md).

First use of mic / camera / screen share triggers an OS permission prompt —
that's your operating system, not Hearth. Allow them. (macOS screen share
additionally needs **System Settings → Privacy & Security → Screen Recording →
Hearth**, then restart the app.)

## Feature availability by platform

| Feature | Linux | Windows | macOS |
|---|---|---|---|
| Voice / camera / screen video | ✅ | ✅ | ✅ |
| Screen share **with system audio** | ➖ (PipeWire loopback tip below) | ✅ (built-in loopback) | ➖ (needs e.g. BlackHole) |
| Global push-to-talk (works while gaming) | ✅ | ✅ | ✅ (grant Accessibility + Input Monitoring when asked) |
| Output-device selection | ✅ | ✅ | ✅ |

Linux system-audio tip: route app audio into a virtual source (`pw-loopback`
or Helvum) and pick that virtual source as your **microphone** in Music mode.
Native loopback capture is on the roadmap.

## Where settings live

Everything (server address, devices, presets, PTT bind) persists locally in
the app's profile. Nothing is stored server-side except your latest speed-test
report (name + numbers, in memory only). The app keeps itself updated —
**Settings → Audio → Check for updates** forces a check.

---

## For developers

### Run from source (all OSes)

Prereq: Node.js 22+.

> **npm 11+ note:** if `npm install` warns about blocked install scripts,
> approve Electron's once and rebuild:
> `npm install-scripts approve electron` then `npm rebuild electron`.

```bash
cd client
npm install
npm start          # bundles the renderer, launches Electron
```

### Build installers

electron-builder builds **for the OS you're on** (cross-building is
unreliable; build on each platform — or push a `v*` tag and let CI build all
three and attach them to the release):

```bash
cd client
npm install
npm run dist:linux    # → release/Hearth-<version>.AppImage + .deb
npm run dist:win      # → release/Hearth Setup <version>.exe   (run on Windows)
npm run dist:mac      # → release/Hearth-<version>.dmg         (run on macOS)
```
