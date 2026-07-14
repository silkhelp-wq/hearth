# Hearth — Engineering Guide

Deep technical documentation for engineers working on Hearth and testers
verifying it. Assumes familiarity with WebRTC concepts, Node.js, and Electron.
For the high-level design narrative, read [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
first — this document goes a layer deeper into the modules, protocols, and data
model, and points to specialized docs for streaming internals and test
strategy.

---

## 1. System at a glance

Hearth is a two-process system:

- **Server** (`server/`) — Node.js. Handles signaling (Socket.IO), the SFU
  (mediasoup), persistence (SQLite via better-sqlite3), and an HTTP surface
  (Express) for health, info, and a bandwidth speed test.
- **Client** (`client/`) — Electron. Main process manages the window, OS
  integration (screen-capture portals, tray, auto-update). Renderer is a
  bundled (esbuild) web app that does the WebRTC work and the UI.

They speak over two channels:

- **Signaling & control:** Socket.IO over TCP **4443** (also the Express port).
- **Media:** mediasoup `WebRtcServer` over UDP+TCP **44444** — a single port
  for *all* media of *all* peers (SRTP-encrypted).

```
Client (Electron)                         Server (Node.js)
┌───────────────────────┐                 ┌────────────────────────────────┐
│ main process          │                 │ express        :4443/tcp       │
│  · window / tray      │   Socket.IO     │   /health /info /speedtest     │
│  · screen portal      │◄──────4443─────►│ socket.io      :4443/tcp       │
│  · auto-update        │                 │   signaling, rooms, control    │
│ renderer (esbuild)    │                 │ mediasoup SFU                  │
│  · WebRTC transports  │   SRTP media    │   WebRtcServer :44444 udp/tcp  │
│  · UI, state store    │◄─────44444─────►│   1 worker · router / channel  │
└───────────────────────┘                 └────────────────────────────────┘
```

---

## 2. Repository layout

```
hearth/
├── server/
│   ├── src/
│   │   ├── index.js        # boot, express endpoints, speed test, CLI flags
│   │   ├── config.js       # env config; announced-address autodetect
│   │   ├── soup.js         # mediasoup worker / WebRtcServer / routers
│   │   ├── room.js         # Room & Peer registries; signaling protocol
│   │   ├── db.js           # SQLite schema + all data access
│   │   ├── perms.js        # permission bitfield + resolution
│   │   ├── chat.js         # message CRUD, FTS, pruning
│   │   ├── jukebox.js      # YouTube audio → voice participant
│   │   ├── monitor.js      # host metrics for the owner dashboard
│   │   ├── selfupdate.js   # server-side update check vs the repo
│   │   ├── gifs.js         # GIF search proxy (Tenor/Giphy)
│   │   └── unfurl.js       # link preview fetching
│   └── packaging/          # native (Arch) package + systemd service
├── client/
│   ├── electron/
│   │   ├── main.js         # main process, flags, display-media handler
│   │   ├── preload.js      # context bridge (safe IPC surface)
│   │   └── updater.js      # auto-update
│   ├── src/
│   │   ├── app.js          # UI, state, event wiring (the big one)
│   │   ├── rtc.js          # WebRTC / mediasoup-client transport logic
│   │   ├── chat.js         # chat UI
│   │   ├── presets.js      # stream presets, codecs, opus bitrates
│   │   ├── audio.js        # mic capture constraints
│   │   └── styles.css      # theme (Burning Crusade skin)
│   └── packaging/          # native (Arch) package wrapping the AppImage
└── docs/                   # this documentation set
```

---

## 3. The server modules in depth

### 3.1 `config.js` — configuration & address detection

All runtime configuration comes from environment variables with sensible
defaults. The most important behavior is **announced-address autodetection**:
mediasoup must advertise an IP that clients can actually reach. The logic
prefers, in order: an explicit `HEARTH_ANNOUNCED_IP`, then a Tailscale CGNAT
address (100.64.0.0/10), then a LAN address.

**Environment variables:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `HEARTH_ANNOUNCED_IP` | (autodetect) | Public/reachable IP mediasoup advertises |
| `HEARTH_NAME` | `Hearth` | Server display name |
| `HEARTH_PORT` | `4443` | Express + Socket.IO (signaling) TCP port |
| `HEARTH_MEDIA_PORT` | `44444` | mediasoup WebRtcServer UDP+TCP port |
| `HEARTH_DATA_DIR` | `server/data` | SQLite DB + assets location |
| `HEARTH_CHAT_CAP_MB` | `1024` | Chat storage cap before pruning |
| `HEARTH_EMOJI_CAP_MB` | `64` | Custom-emoji storage cap |
| `HEARTH_PREVIEW_CAP_MB` | `32` | Link-preview cache cap |
| `HEARTH_TENOR_KEY` | (none) | Tenor GIF API key (optional) |
| `HEARTH_GIPHY_KEY` | (none) | Giphy GIF API key (optional) |
| `HEARTH_IMGUR_CLIENT_ID` | (none) | Imgur client ID (optional) |
| `HEARTH_UPDATE_TOKEN` | (none) | Read-only repo token for server update checks |

### 3.2 `soup.js` — the SFU

One mediasoup **worker**, one **WebRtcServer** (so all media shares port
44444), and **one router per channel**. A router is the mediasoup construct
that routes RTP between producers and consumers; giving each voice channel its
own router isolates channels cleanly. Producers (uploaded streams) are consumed
by every other peer in the channel — the fan-out that defines an SFU.

### 3.3 `room.js` — signaling & presence

Holds the **Room** and **Peer** registries and implements the full signaling
protocol (documented at the top of the file). Responsibilities:

- Transport creation (WebRTC transports for send/recv).
- Produce/consume orchestration.
- Per-room `AudioLevelObserver` → dominant-speaker events.
- Video consumer layer preferences (see streaming internals — this is where the
  temporal-layer fix lives).
- Consumer pause/resume (the mechanism behind focus mode).

### 3.4 `db.js` — persistence

SQLite in **WAL mode** with **FTS5** full-text search. Schema tables: `kv`,
`users`, `roles`, `user_roles`, `channels`, `overwrites`, `messages`,
`reactions`, `pins`, `message_links`, `link_previews`, `emojis`, `read_state`.
All data access goes through this module (prepared statements, transactions for
multi-table operations). Notable operations: owner claim/reclaim/transfer,
member deletion (removes user + references, keeps messages), and storage
pruning driven by the live caps.

### 3.5 `perms.js` — permissions

A **bitfield** permission model, Discord-style:

| Bit | Permission | Value |
|-----|-----------|-------|
| 0 | VIEW_CHANNEL | 1 |
| 1 | SEND_MESSAGES | 2 |
| 2 | EMBED_LINKS | 4 |
| 3 | MANAGE_MESSAGES | 8 |
| 4 | CREATE_CHANNELS | 16 |
| 5 | MANAGE_CHANNELS | 32 |
| 6 | MANAGE_ROLES | 64 |
| 7 | CONNECT | 128 |
| 8 | SPEAK | 256 |
| 9 | MUTE_MEMBERS | 512 |
| 10 | KICK_MEMBERS | 1024 |
| 11 | ADMINISTRATOR | 2048 |
| 12 | MANAGE_EMOJIS | 4096 |

`ALL = (1 << 13) - 1` (8191). Effective permissions resolve from role
assignments plus per-channel allow/deny overwrites. Note the deliberate design
choice: `CREATE_CHANNELS` is split from `MANAGE_CHANNELS`, so the default
posture is "everyone can create channels, only Admins can delete them."

### 3.6 `index.js` — boot, HTTP, and CLI

Boots the server, mounts Express endpoints, and handles CLI flags:

- `--selftest` — runs the built-in test suite (db + perms + chat + mediasoup)
  and exits 0/1. This is the smoke test CI and developers run.
- `--reclaim-owner` — the host-side owner recovery: mints a fresh claim code
  and re-opens claiming, independent of any client state.

**HTTP endpoints:** `/health` (liveness + version), `/info` (server metadata),
`/speedtest` (streamed download + counted upload for the client's
recommendation engine).

---

## 4. The client in depth

### 4.1 Main process (`electron/main.js`)

- Sets Chromium command-line flags (hardware-accel features, Wayland/Vulkan
  handling — see streaming internals).
- Pins `userData` to a single profile path so dev (`npm start`) and packaged
  runs share **one device identity** (this prevents the "duplicate member /
  lost owner" class of bug).
- Implements the **display-media request handler**, which is
  platform-branched: on Wayland the OS portal is the sole picker (no in-app
  enumeration, or the portal would prompt twice and abort); on X11/Windows/
  macOS an in-app picker with a strict source-id match is used.

### 4.2 Preload (`electron/preload.js`)

Exposes a **minimal, safe IPC surface** to the renderer via
`contextBridge` — platform, `isWayland`, screen-source access, the
share-source choice, and update controls. The renderer never touches Node
directly.

### 4.3 Renderer (`src/`)

- `rtc.js` — creates WebRTC transports, produces mic/camera/screen streams,
  consumes others', and manages codec selection and opus bitrate. Contains the
  audio-producer-recreation logic (opus `maxaveragebitrate` is fixed at
  producer creation and can't be renegotiated, so bitrate changes rebuild the
  audio producers as a unit).
- `app.js` — the UI and state store; wires every control, renders tiles, the
  member roster, the context menus (including independent mic vs stream-audio
  volume), focus mode, the theater pop-out, and settings.
- `presets.js` — stream presets (480p30 → 4K60), the codec list
  (`auto/av1/vp9/h264/vp8`), and opus bitrate steps.

---

## 5. Key data flows

### 5.1 Joining a voice channel

1. Client connects Socket.IO → authenticates by device token → server
   registers/loads the user.
2. Client requests router RTP capabilities; loads a mediasoup-client Device.
3. Client creates send + recv WebRTC transports (DTLS handshake over 44444).
4. Client produces its mic (and camera/screen when toggled).
5. Server notifies peers; each consumes the new producer.
6. `AudioLevelObserver` drives dominant-speaker UI.

### 5.2 Screen share (Wayland)

1. User clicks Share → picks quality/codec (no in-app source list on Wayland).
2. "Go live" calls `getDisplayMedia` → the OS portal opens **once** → user
   picks a screen/window there.
3. The main-process handler returns that single portal source to libwebrtc.
4. Renderer produces the screen track (with the chosen codec and preset).
5. Consumers request the top temporal layer for full framerate (see streaming
   internals).

### 5.3 Focus mode

1. Viewer clicks a stream tile → renderer marks it focused.
2. Other video consumers are **server-paused** (`consumer:pause`) — zero
   packets, real bandwidth/decode savings — with a "paused" overlay.
3. Clicking another tile switches focus (resume + fresh keyframe); clicking the
   focused tile unfocuses and resumes all. Audio never pauses.

---

## 6. Build & release

- **Client build:** `npm run build` (esbuild bundles the renderer to
  `dist/renderer.js`).
- **Installers:** a tagged `v*` push triggers CI, which builds Windows
  (`.exe`), macOS (`.dmg`), and Linux (`.AppImage`, `.deb`) and attaches them
  to the GitHub release. The CI also injects the read-only update token into
  the client build so shipped installers can auto-update.
- **Native Arch packages:** built locally from `client/packaging/` and
  `server/packaging/` (the client package wraps a downloaded AppImage).

**Versioning:** client and server versions are kept in lockstep. Tag with the
matching `vX.Y.Z`.

**Release discipline (hard-won):**
- Always `git pull --no-rebase` before pushing — the `⇡⇣` prompt state means
  local and remote have diverged and a push will be rejected.
- Never let `makepkg` build artifacts (`pkg/`, `src/`, `*.AppImage`) get
  committed — `.gitignore` covers them, but verify `git status` before every
  commit. GitHub rejects files over 100 MB, and the AppImage is ~123 MB.
- If a tag points at the wrong commit, delete it on both sides
  (`git push --delete origin vX; git tag -d vX`) before recreating.

---

## 7. Where to go next

- **Streaming, codecs, and hardware encoding:**
  [`STREAMING_INTERNALS.md`](STREAMING_INTERNALS.md)
- **Test strategy and how to verify changes:**
  [`TEST_STRATEGY.md`](TEST_STRATEGY.md)
- **Formal requirements:** [`../SRS.md`](../SRS.md)
- **Full architecture narrative with per-version notes:**
  [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
