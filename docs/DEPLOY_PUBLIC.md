# Running Hearth on a public server (no Tailscale)

Tailscale is the zero-config default: nothing is exposed to the internet and
the tailnet handles identity + encryption. But Hearth needs **no code change**
to run on a normal VPS instead — mediasoup already supports a public announced
address. You trade "invisible to the internet" for "reachable by anyone with
the link", so this path is for a box you control and keep patched.

## What you need

- A small Linux VPS (1 vCPU / 1 GB is plenty for 7–10 people; media is
  forwarded, not transcoded). Any provider works.
- The server's **public IPv4**.
- Two inbound ports open in the provider's firewall/security group:
  - **TCP 4443** — the app + signaling (`HEARTH_PORT`)
  - **UDP + TCP 44444** — WebRTC media (`HEARTH_MEDIA_PORT`)

## Setup

1. Copy the `server/` folder to the VPS, install Node 22+, `yt-dlp`, and
   `ffmpeg`, then `npm install` and approve the native build scripts as in
   `INSTALL_HOST.md`.

2. Point mediasoup at the public IP and start it:

   ```
   export HEARTH_ANNOUNCED_IP=203.0.113.10      # your VPS public IPv4
   export HEARTH_PORT=4443
   export HEARTH_MEDIA_PORT=44444
   npm start
   ```

   `HEARTH_ANNOUNCED_IP` is the whole trick — it's the address mediasoup puts
   in the ICE candidates it hands to clients, so it must be the IP they can
   actually reach (the public one), even though the socket binds to `0.0.0.0`
   internally. Without it, clients would be told to connect to the box's
   private LAN address and media would never flow.

3. Friends enter `http://203.0.113.10:4443` on the connect screen. Done —
   no Tailscale on anyone's machine.

## Strongly recommended: put TLS in front

Browsers increasingly restrict features on plain `http://`, and you don't want
the hall wide open. Point a domain at the VPS and run a reverse proxy
(Caddy is the least effort — automatic Let's Encrypt):

```
hall.example.com {
    reverse_proxy 127.0.0.1:4443
}
```

Then friends use `https://hall.example.com`. The **media port (44444) still
needs to be open directly** — WebRTC media does not go through the HTTP proxy,
only signaling does.

## Locking it down

- The owner-claim code still prints on first boot; claim it immediately so
  nobody else can seize the server.
- Consider a per-person device token you hand out, and keep the box's OS and
  `yt-dlp` updated.
- If you'd rather stay invisible but skip Tailscale specifically, any
  WireGuard mesh (e.g. Netbird, Headscale) works identically — Hearth only
  cares that clients can reach `HEARTH_ANNOUNCED_IP`.
