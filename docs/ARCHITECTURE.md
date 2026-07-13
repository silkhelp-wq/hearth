# Architecture

## Context & goals

Private, self-hosted group voice/video for 7–10 friends. Hard requirements:
no port forwarding, no accounts/cloud, cross-platform desktop, quality
knobs the crew actually controls (presets, codecs, bitrates), and honest
bandwidth guidance. Non-goals for v0.1: text chat, file sharing, public
internet exposure, federation.

## High-level design

```
                         Tailscale tailnet (WireGuard mesh)
   ┌─────────────┐        100.x.y.z addresses, E2E encrypted
   │  Client A   │◄──────────────────────────────────────────┐
   │  (Electron) │                                           │
   └──────┬──────┘        ┌──────────────────────────────┐   │
          │  socket.io    │        HOST machine          │   │
          ├──────────────►│  Node.js                     │   │
          │  (signaling,  │  ├─ express      :4443/tcp   │   │
          │   :4443/tcp)  │  │   /health /info /speedtest│   │
          │               │  ├─ socket.io    :4443/tcp   │   │
          │  SRTP media   │  │   rooms, peers, producers │   │
          └──────────────►│  └─ mediasoup SFU            │◄──┘
                          │      WebRtcServer :44444     │  Clients B..J
                          │      1 worker, router/channel│
                          └──────────────────────────────┘
```

**SFU topology:** every participant uploads each of their streams once; the
host fans them out. This is what makes 7–10-person video possible on
residential upload (a full mesh would cost each sharer `(N−1) ×` their
bitrate). The corollary — host upload is the shared ceiling — is surfaced
to users by the recommendation engine (`docs/STREAM_SETTINGS.md`).

## Components

**Server** (`server/src/`)
- `config.js` — env config; announced-address autodetect that prefers the
  Tailscale CGNAT range (100.64.0.0/10), falls back to LAN.
- `soup.js` — one mediasoup worker, one `WebRtcServer` (so *all* media for
  every peer shares a single UDP/TCP port: 44444), one router per channel.
- `room.js` — Room/Peer registries and the full signaling protocol
  (documented at the top of the file); per-room `AudioLevelObserver`
  drives dominant-speaker events.
- `index.js` — express endpoints (health/info + speed test:
  streamed download, counted upload, crew report board) and boot.

**Client** (`client/`)
- `electron/main.js` — window; screen-share source plumbing
  (`desktopCapturer` + `setDisplayMediaRequestHandler`, PipeWire portal on
  Wayland via `WebRTCPipeWireCapturer`); global push-to-talk via
  `uiohook-napi` (keyboard **and** mouse buttons, works unfocused) with a
  focused-window fallback when the hook can't load.
- `electron/preload.js` — minimal `contextBridge` surface (`window.hearth`).
- `src/rtc.js` — mediasoup-client wrapper: transports, produce (with codec
  forcing + `contentHint`), consume, per-consumer RTP stats.
- `src/audio.js` — devices, constraint building (EC/NS/AGC/music-stereo),
  RMS meter, VAD gate, `setSinkId` routing.
- `src/speedtest.js`, `src/recommend.js`, `src/presets.js` — measurement
  and the budget model.
- `src/app.js` — UI state machine (connect → directory → channel → media).

## Media/signaling flow (join)

```
join(channel,name) ──► routerRtpCapabilities + existing peers/producers
device.load() ──► transport:create(send) ─► transport:connect (DTLS)
             └─► transport:create(recv) ─► transport:connect
produce(mic [, cam, screen]) ──► broadcast producer:new to room
for each remote producer: consume (created paused) ─► consumer:resume
AudioLevelObserver ──► 'speaker' broadcasts ──► ember ring in UI
```

Consumers start **paused** and resume only after the client has wired the
track to an element — the standard mediasoup pattern that avoids losing the
first keyframes.

## Key decisions & trade-offs

| Decision | Why | Trade-off accepted |
|---|---|---|
| Tailscale for connectivity | The only way to honor "share an IP, zero router config" against NAT physics; free tier fits a friend group | One-time install per person |
| SFU (mediasoup) over P2P mesh | Mesh upload cost is quadratic-ish; unusable at 8+ | Host upload becomes the ceiling (mitigated by the advisor) |
| One `WebRtcServer` port | One-line firewall story | Single worker; fine for ≤~20 peers, shard workers beyond |
| Plain HTTP/WS inside the tailnet | WireGuard already encrypts + authenticates the path | Server must never be exposed publicly (documented) |
| Electron client | Global PTT, native screen pickers, one codebase ×3 OS | ~100 MB installers |
| `uiohook-napi` for PTT | Electron's `globalShortcut` has no key-up event, so real hold-to-talk is impossible with it | Native module (prebuilds ship for all 3 OSes; graceful fallback wired) |
| Client-side quality caps (`maxBitrate` per preset) | User agency; matches Discord mental model | A modified client could exceed them — acceptable in a friends-only trust model (server still caps at 30 Mbps) |
| No auth/accounts | Tailnet membership *is* the access control | Anyone on the tailnet can join; that's the invited crew by construction |

## Engineering standards

- **Language level:** Node 20+ / ES2022; renderer bundled by esbuild
  targeting Chromium ≥130 (Electron 43).
- **Style:** 2-space indent, single quotes, semicolons; `const` by default.
  Modules stay under ~450 lines; one responsibility per file.
- **Electron security posture:** `contextIsolation: true`,
  `nodeIntegration: false`, narrow preload API, CSP in the renderer HTML.
- **Error handling:** every signaling handler is wrapped (`guarded()`),
  returning `{error}` acks instead of crashing the socket; media-device
  failures degrade to listen-only with a visible explanation.
- **Dependencies:** pinned with caret ranges; versions verified against the
  npm registry on 2026-07-12 (mediasoup/mediasoup-client 3.21.0,
  socket.io 4.8.3, electron 43.1.0, uiohook-napi 1.5.5,
  esbuild 0.28.1, electron-builder 26.15.3). Re-verify before upgrading.
- **Docs:** requirements in `SRS.md`, verification in `TEST_PLAN.md`; both
  updated in the same change as the behavior they describe.

## Known limits / roadmap

Simulcast/SVC layers (per-viewer quality adaptation), Linux/macOS system-
audio capture, host-side admin (kick/rename channels live), Opus bitrate
slider, TURN-less operation is inherent (no TURN needed — the tailnet is
the transport). Single worker by design; shard routers across workers with
per-worker `WebRtcServer` ports if the crew ever outgrows it.
