# Host Install — running the Hearth server

**Who this is for:** the one person hosting. Any always-on-ish PC works;
the server is light (one CPU core forwards a 10-person hangout comfortably).
The real resource is **upload bandwidth** — see `STREAM_SETTINGS.md`.

## Prerequisites

- Node.js **22 or newer** (`node -v` to check)
  - Linux: your package manager (`sudo pacman -S nodejs-lts-jod npm`,
    `sudo apt install nodejs npm`) or <https://nodejs.org>
  - Windows / macOS: installer from <https://nodejs.org>
- Tailscale installed and signed in (`docs/CONNECTION_GUIDE.md`)
- mediasoup ships prebuilt media workers for Linux x64/arm64, Windows x64,
  and macOS — no compiler needed on common platforms. If npm ever falls back
  to building from source it will say so; installing `python3` + a C++
  toolchain fixes that, but you almost certainly won't need it.

## Install & run

```bash
cd server
npm install
npm start
```

Expected output:

```
  ┌──────────────────────────────────────────────────┐
  │  Hearth server v0.1.0                             │
  ├──────────────────────────────────────────────────┤
  │  Give your friends this address:                  │
  │    http://100.101.8.24:4443                       │
  │  Media port: 44444 udp+tcp (via Tailscale,        │
  │  no router port-forwarding needed)                │
  └──────────────────────────────────────────────────┘
```

Sanity checks:

```bash
npm run selftest                    # boots mediasoup, prints codecs, exits
curl http://127.0.0.1:4443/health   # {"ok":true,...}
```

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `HEARTH_PORT` | 4443 | HTTP + signaling |
| `HEARTH_MEDIA_PORT` | 44444 | one UDP+TCP port for all media |
| `HEARTH_ANNOUNCED_IP` | autodetect | set only if autodetect picks the wrong interface |
| `HEARTH_NAME` | Hearth | shown in every client's rail |

Channels: edit `server/channels.json` (array of names), restart.

Firewall: traffic arrives on the `tailscale0` interface. Most distros/router
setups allow it by default. If you run ufw with deny-incoming:

```bash
sudo ufw allow in on tailscale0 to any port 4443 proto tcp
sudo ufw allow in on tailscale0 to any port 44444 proto udp
sudo ufw allow in on tailscale0 to any port 44444 proto tcp
```

**Do not** forward these ports on your router or expose them publicly; the
server intentionally has no auth because the tailnet is the auth boundary.

## Run it as a service (Linux, systemd)

`server/hearth-server.service.example` is ready to adapt:

```bash
sudo cp hearth-server.service.example /etc/systemd/system/hearth-server.service
# edit User= and WorkingDirectory= for your setup
sudo systemctl daemon-reload
sudo systemctl enable --now hearth-server
journalctl -u hearth-server -f          # watch the boot banner / logs
```

Windows: simplest is a shortcut to `npm start` in `shell:startup`, or use
[NSSM](https://nssm.cc) to wrap it as a service. macOS: a `launchd` plist or
just keep a terminal tab.

## Upgrade / rollback

The server is stateless (channel membership lives in memory). Upgrade =
replace the folder, `npm install`, restart. Rollback = restore the previous
folder, restart. Clients reconnect automatically and rejoin their channel.
