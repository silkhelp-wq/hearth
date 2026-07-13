# Hearth

Self-hosted voice, camera, and screen-share hangout for a fixed crew of
friends. One of you runs the server; everyone else pastes one address into
the desktop app. No accounts, no cloud, no port forwarding — connectivity
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
- **Cross-platform**: Linux, Windows, macOS (Electron)

## Quick start (host, ~5 minutes)

Prereqs: [Node.js 20+](https://nodejs.org) and [Tailscale](https://tailscale.com/download)
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

## Configuration

Server environment variables (all optional):

| Var | Default | Meaning |
|---|---|---|
| `HEARTH_PORT` | `4443` | HTTP + signaling port |
| `HEARTH_MEDIA_PORT` | `44444` | Single UDP/TCP media port |
| `HEARTH_ANNOUNCED_IP` | autodetect | Address clients reach media on (Tailscale preferred) |
| `HEARTH_NAME` | `Hearth` | Server display name |

Channels are just strings in `server/channels.json`.

## License

MIT — see `LICENSE`.
