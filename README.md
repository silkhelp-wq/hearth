# Hearth

Self-hosted voice, camera, screen-share, and text-chat hangout for a fixed
crew of friends. One of you runs the server; everyone else pastes one address
into the desktop app. No accounts, no cloud, no port forwarding — connectivity
rides on your [Tailscale](https://tailscale.com) tailnet.

- **Voice channels** with device selection, echo cancellation / noise
  suppression / AGC toggles, music mode (stereo Opus), voice activity or
  global push-to-talk (keyboard or mouse button)
- **Screen share + webcam** with Discord-style presets from 480p30 to 4K60
  (nothing paywalled), codec preference (AV1 / VP9 / H.264 / VP8 / auto),
  and a live stats overlay (codec, resolution, fps, bitrate)
- **Built-in speed test** that measures the real path to your server and a
  **recommendation engine** that turns the crew's numbers into the highest
  preset that actually fits — including the host relay math
- **Text channels** (v0.2) with replies, edits, pins, emoji reactions,
  markdown + code blocks, typing indicators, unread badges, @mention pings,
  full-text search, and text-only link preview cards
- **Discord-style roles & permissions**: per-channel allow/deny overwrites,
  role colors, a claimable server owner, moderator mute/kick — with one
  deliberate twist: *creating* channels is split from *managing* them, so the
  default is "everyone creates, Admins delete"
- **Storage that never grows past 1 GB**: chat lives in SQLite; when the cap
  is hit the oldest messages are pruned automatically (a text-only crew of 8
  takes roughly a decade to get there)
- **Jukebox** (v0.3): paste a YouTube link and the host streams the audio
  into the voice channel as a real participant everyone hears in sync —
  queue, skip, pause, and a per-listener volume slider. Spotify and Pandora
  links resolve by title and play the YouTube match (their audio is DRM'd).
  Needs `yt-dlp` + `ffmpeg` on the host; auto-hides otherwise.
- **Right-click anyone** for a volume slider, mute-for-me, and (permission-
  gated) server mute / kick
- **Cross-platform**: Linux, Windows, macOS (Electron)

## Quick start (host, ~5 minutes)

Prereqs: [Node.js 22+](https://nodejs.org) and [Tailscale](https://tailscale.com/download)
running on the host machine.

```bash
cd server
npm install
npm start
```

The boot banner prints the address to hand to your friends, e.g.
`http://100.101.8.24:4443`. That's it — media flows over the tailnet on a
single port (44444/udp+tcp), so there is nothing to configure on any router.

## Quick start (everyone else)

1. Join the host's tailnet once (see `docs/CONNECTION_GUIDE.md` — two
   minutes per person).
2. Run the Hearth app (`docs/INSTALL_CLIENT.md`), paste the address, pick a
   name, step inside.

## Repo map

| Path | What lives there |
|---|---|
| `server/` | Node.js signaling + mediasoup SFU + speed-test endpoints |
| `client/` | Electron app (renderer in `client/src`, main process in `client/electron`) |
| `docs/CONNECTION_GUIDE.md` | Tailscale setup for the whole crew |
| `docs/INSTALL_HOST.md` | Server install & run (all 3 OSes, systemd unit) |
| `docs/INSTALL_CLIENT.md` | App install / packaging (all 3 OSes) |
| `docs/STREAM_SETTINGS.md` | Preset table + the bandwidth math |
| `docs/ARCHITECTURE.md` | Design, data flow, decisions, engineering standards |
| `docs/SRS.md` | Software Requirements Specification (IEEE 29148-style) |
| `docs/TEST_PLAN.md` | Test plan & cases (IEEE 29119-style) |

## Releases & CI

Every push runs CI (`.github/workflows/ci.yml`): the server boots the real
mediasoup stack (`npm run selftest`) and the client renderer must bundle
clean. Pushing a tag like `v0.2.0` triggers the release workflow, which
builds installers on GitHub's Linux/Windows/macOS runners and attaches
`.AppImage`/`.deb`/`.exe`/`.dmg` files to the release — friends grab theirs
from the **Releases** page, no build tools needed.

## Configuration

Server environment variables (all optional):

| Var | Default | Meaning |
|---|---|---|
| `HEARTH_PORT` | `4443` | HTTP + signaling port |
| `HEARTH_MEDIA_PORT` | `44444` | Single UDP/TCP media port |
| `HEARTH_ANNOUNCED_IP` | autodetect | Address clients reach media on (Tailscale preferred) |
| `HEARTH_NAME` | `Hearth` | Server display name |
| `HEARTH_DATA_DIR` | `server/data` | SQLite database + state directory |
| `HEARTH_CHAT_CAP_MB` | `1024` | Chat DB size cap; oldest messages pruned past it |

`server/channels.json` seeds the voice channel list on **first boot only**;
after that, channels are created and deleted inside the app (permission-gated).
The first boot also prints an **owner claim code** — enter it under
Settings → Server to take ownership of the hall.

## License

MIT — see `LICENSE`.
