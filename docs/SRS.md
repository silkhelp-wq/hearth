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

---

## 6. v0.2 additions — identity, permissions, text chat

### 6.1 Functional requirements

| ID | Requirement |
|---|---|
| FR-20 | The client SHALL generate a persistent random identity token per install and present it on connect; the server SHALL identify users by token hash only. |
| FR-21 | The server SHALL print an owner claim code at boot until claimed; a user entering it SHALL become owner, bypassing all permission checks and immune to mute/kick. |
| FR-22 | The system SHALL support roles (name, color, position, permission bitfield) with `@everyone` as base, plus per-channel allow/deny overwrites for roles and members, resolved base → everyone-overwrite → role-overwrites → member-overwrite. |
| FR-23 | Default permissions SHALL be: `@everyone` = view, send, embed links, **create channels**, connect, speak; `Admin` = administrator. Creating channels SHALL be a separate permission from managing (rename/delete/access) them. |
| FR-24 | Users with `CREATE_CHANNELS` SHALL be able to create text and voice channels in-app; `MANAGE_CHANNELS` SHALL gate rename, topic, access overwrites, and deletion. Deleting the last channel of a type SHALL be refused. |
| FR-25 | Text channels SHALL support sending, editing own messages, deleting own messages (or any with `MANAGE_MESSAGES`), replies, pins (`MANAGE_MESSAGES`), and unicode emoji reactions. |
| FR-26 | Messages SHALL render safe markdown: fenced/inline code, bold/italic/strike, quotes, autolinked URLs — HTML SHALL always be escaped; images SHALL NOT be supported. |
| FR-27 | The client SHALL show typing indicators, per-channel unread badges, and SHALL play a ping on @mention of the user's name. |
| FR-28 | The server SHALL provide FTS5 full-text search over messages the requesting user can view. |
| FR-29 | For authors with `EMBED_LINKS`, the server SHALL unfurl up to 3 URLs per message into **text-only** cards (title/description/site), cached 7 days, with SSRF guards (http/https only, no private ranges, 5 s / 512 KB caps). |
| FR-30 | Chat storage SHALL live in SQLite and SHALL NOT exceed `HEARTH_CHAT_CAP_MB` (default 1024): when exceeded, the oldest messages (pins included) SHALL be pruned in batches until under the cap. |
| FR-31 | Voice join SHALL require `VIEW_CHANNEL`+`CONNECT`; producing microphone audio SHALL require `SPEAK`. `MUTE_MEMBERS` SHALL allow moderator mute (closes live mic producer); `KICK_MEMBERS` SHALL allow disconnecting a user. The owner SHALL be immune to both. |
| FR-32 | Channel/role/permission changes SHALL propagate live via a directory-dirty broadcast; hidden channels SHALL be excluded from a user's directory and from chat event fan-out. |
| FR-33 | Per-user read state SHALL persist server-side and seed unread badges on connect. |

### 6.2 Non-functional deltas

- **NFR:** message length ≤ 4000 chars; history pages of ≤ 100.
- **NFR:** clients older than v0.2 (no token) SHALL be rejected with a clear
  upgrade message.
- **NFR:** moderator-mute state MAY reset on server restart (in-memory).

### 6.3 v0.3 additions — jukebox & member menu

| ID | Requirement |
|---|---|
| FR-34 | Users with `SPEAK` in a voice channel SHALL be able to queue audio by URL; YouTube SHALL play directly, Spotify/Pandora links SHALL resolve by title to the best YouTube match; the host SHALL stream decoded opus into the channel via a PlainTransport producer heard synchronously by all members. |
| FR-35 | The jukebox SHALL appear as a synthetic channel member with queue/skip (and pause on POSIX hosts) controls, a queue cap of 25, and SHALL self-disable when `yt-dlp`/`ffmpeg` are absent (capability advertised in hello). |
| FR-36 | Right-clicking a member (rail or tile) SHALL open a menu with a per-listener volume slider and mute-for-me, plus server mute (`MUTE_MEMBERS`) and kick (`KICK_MEMBERS`) where permitted; the owner SHALL be exempt from moderation. |

### 6.4 v0.4 additions — GIFs, emojis, storage

| ID | Requirement |
|---|---|
| FR-37 | The server SHALL proxy GIF search to Tenor, GIPHY, and Imgur, each enabled only when its host-side key is configured; selected GIFs SHALL post as CDN URLs and clients SHALL inline-render bare links only from the server-advertised media-host allowlist. |
| FR-38 | Users with `MANAGE_EMOJIS` SHALL upload custom emojis (PNG/GIF/WebP ≤512 KB, content-validated); emojis SHALL be usable as `:name:` tokens in messages (with autocomplete) and as reactions (`ce:<id>`), animated GIFs animating in place. |
| FR-39 | Emoji uploads SHALL be refused once total emoji bytes exceed the live emoji cap. |
| FR-40 | Administrators SHALL adjust chat, emoji, and preview-cache caps at runtime with clamped ranges and usage readouts; the prune loop SHALL honor the live values. |
