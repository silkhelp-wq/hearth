# Software Requirements Specification — Hearth v0.1

*Structured after ISO/IEC/IEEE 29148:2018 (tailored for a small self-hosted
project). Requirement keywords per RFC 2119.*

## 1. Introduction

### 1.1 Purpose
Define the requirements for Hearth, a self-hosted voice/video/screen-share
application for a private group of 7–10 friends, and the criteria by which
v0.1 is accepted.

### 1.2 Scope
In scope: voice channels, webcam and screen sharing with user-selectable
quality/codec, audio device management with VAD/PTT, connectivity over a
Tailscale tailnet, an integrated speed test with settings recommendations,
cross-platform desktop clients (Linux, Windows, macOS), and a Node.js host
server. Out of scope for v0.1: text chat, file transfer, recording,
accounts/moderation, public-internet exposure, mobile clients.

### 1.3 Definitions
- **Host** — the machine (and person) running `hearth-server`.
- **SFU** — Selective Forwarding Unit; the host relays each media stream to
  its viewers (mediasoup).
- **Tailnet** — the private WireGuard network created by Tailscale.
- **Channel / hall** — a named voice room; one mediasoup router each.
- **Preset** — a named (resolution, fps, target bitrate) tuple
  (`docs/STREAM_SETTINGS.md`).

### 1.4 References
`ARCHITECTURE.md`, `STREAM_SETTINGS.md`, `TEST_PLAN.md`,
`CONNECTION_GUIDE.md`; ISO/IEC/IEEE 29148:2018; ISO/IEC/IEEE 29119.

## 2. Overall description

Fixed, mutually-trusting user group on a shared tailnet. The tailnet is the
security boundary: the server SHALL NOT be exposed to the public internet
and implements no user authentication. Users range from highly technical
(host) to "installs an app and pastes an address."

## 3. Functional requirements

### Connectivity
- **FR-1** The server SHALL be reachable by clients via a single base
  address (`http://<ip>:<port>`) with no router/NAT configuration,
  presuming host and clients share a tailnet.
- **FR-2** The server SHALL autodetect and announce a Tailscale address
  when present, falling back to a LAN address; `HEARTH_ANNOUNCED_IP` SHALL
  override.
- **FR-3** All WebRTC media for all peers SHALL flow through one
  configurable UDP(+TCP fallback) port (default 44444).
- **FR-4** The client SHALL auto-reconnect after signaling loss and rejoin
  the previous channel.

### Channels & presence
- **FR-5** The server SHALL expose named channels from `channels.json`;
  clients SHALL display live occupancy and support one-click join/hop.
- **FR-6** Clients SHALL see join/leave, mute/deafen/sharing state, and a
  dominant-speaker indicator (server `AudioLevelObserver`, ≤500 ms cadence).

### Audio
- **FR-7** Users SHALL select input and output devices at runtime; output
  selection SHALL apply to already-playing audio.
- **FR-8** Echo cancellation, noise suppression, and auto gain SHALL be
  individually toggleable; **Music mode** SHALL provide stereo Opus
  (128 kbps target) with processing disabled.
- **FR-9** Transmission gating SHALL support Voice Activity (adjustable
  threshold −70…−20 dB with live meter) and Push-to-Talk.
- **FR-10** PTT SHALL bind to a keyboard key or mouse button and SHALL
  operate while the app is unfocused (global hook); if the hook is
  unavailable, PTT SHALL degrade to focused-window operation with the
  limitation shown to the user.
- **FR-11** Mute SHALL stop transmission regardless of gating; Deafen SHALL
  additionally silence all received audio and imply mute. Per-person volume
  SHALL be adjustable locally.

### Video & screen share
- **FR-12** Users SHALL share a webcam (480p/720p/1080p presets) and a
  screen or window chosen from a picker (system portal on Wayland).
- **FR-13** Screen quality SHALL be selectable from the preset table
  (480p30 … 4K60, plus uncapped Source) with the target bitrates listed in
  `STREAM_SETTINGS.md`; no preset SHALL be artificially restricted.
- **FR-14** Users SHALL express a codec preference (Auto/AV1/VP9/H.264/VP8);
  Auto SHALL negotiate the best mutually-supported codec. Server codec
  support SHALL include Opus, AV1, VP9, VP8, H.264.
- **FR-15** An optional per-tile stats overlay SHALL show received codec,
  resolution, fps, and bitrate (1 s refresh).
- **FR-16** On Windows, screen share SHALL optionally include system audio
  (loopback). Other OSes SHALL show the limitation rather than fail
  silently.
- **FR-17** A share SHALL end from the app or the OS control, closing the
  server-side producer either way.

### Speed test & recommendations
- **FR-18** The client SHALL measure ping (WS echo), download, and upload
  against the connected server — i.e., through the tailnet path.
- **FR-19** Results SHALL be reportable to the server and visible to the
  crew (name, up/down/ping) to inform planning.
- **FR-20** The client SHALL compute recommended presets from: user upload
  (measured or manual), host upload (manual/reported), channel size, and
  simultaneous-stream count — using the SFU relay model with 75% headroom
  and voice overhead — and SHALL state which side is the limit.
- **FR-21** A one-click action SHALL apply the recommended preset.

### Server operations
- **FR-22** `GET /health` and `GET /info` SHALL report liveness and
  channel directory. A `--selftest` mode SHALL verify the media stack and
  exit non-zero on failure. The boot banner SHALL print the exact address
  to share.

## 4. Non-functional requirements

- **NFR-1 Capacity:** 10 concurrent users per channel with ≥2 simultaneous
  video streams, on a host with ≥4 CPU cores, bandwidth permitting.
- **NFR-2 Latency:** mouth-to-ear audio ≤300 ms between tailnet peers with
  direct (non-relayed) connectivity ≤120 ms RTT.
- **NFR-3 Portability:** client runs on Ubuntu 22.04+/Arch (X11 & Wayland),
  Windows 10/11, macOS 13+; server on Linux x64/arm64, Windows x64, macOS.
- **NFR-4 Security posture:** transport security delegated to WireGuard;
  Electron hardening (context isolation, no nodeIntegration, CSP);
  no telemetry; nothing persisted server-side beyond in-memory state.
- **NFR-5 Usability:** a non-technical user completes Tailscale join +
  first connect in ≤10 minutes using `CONNECTION_GUIDE.md` alone.
- **NFR-6 Recoverability:** host restart requires no client action beyond
  the automatic rejoin (FR-4); server is stateless.
- **NFR-7 Maintainability:** per the engineering standards in
  `ARCHITECTURE.md`; dependency versions verified against the registry at
  release time.

## 5. Acceptance criteria

v0.1 is accepted when every test case marked **P0** in `TEST_PLAN.md`
passes on all three client OSes against a Linux host over a real tailnet,
including the 10-user × 60-minute soak (TC-11).
