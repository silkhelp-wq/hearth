# Connection Guide — getting the whole crew into the hall

**Who this is for:** everyone, including the host. Each person does this
once; after that, connecting is "open Hearth, click a channel."

## Why Tailscale

A home PC behind a normal router cannot accept incoming connections on its
bare IP — that's NAT, not a Hearth limitation. Tailscale puts everyone's
machines on a private WireGuard mesh, so the host's machine gets a stable
address (`100.x.y.z`) every crew member can reach directly, with:

- **no port forwarding, no router settings, ever**
- end-to-end WireGuard encryption between every pair of machines
- the same address whether you're home, on a laptop at a café, or on hotel Wi-Fi

Hearth's speed test runs through this exact path, so its numbers reflect
real streaming conditions.

## One-time setup

### Host (the person running the server)

1. Install Tailscale — <https://tailscale.com/download> — and sign in
   (Google/GitHub/etc. login; the free plan covers up to 3 users and 100
   devices, and **sharing individual machines to friends is free and
   unlimited**).
2. Start Hearth's server (`docs/INSTALL_HOST.md`). The boot banner prints
   your address, e.g. `http://100.101.8.24:4443`.
3. Get friends onto your tailnet. Two good options:
   - **Share the machine (recommended):** in the
     [admin console](https://login.tailscale.com/admin/machines), open the
     `…` menu next to the server machine → **Share** → send each friend the
     link. They accept with their own free Tailscale account. They can reach
     *only* that machine — nothing else on your network.
   - **Invite users to the tailnet:** admin console → **Users** → **Invite
     external users**. Simpler to manage, but they join the whole tailnet.
4. Send everyone the address from step 2.

### Everyone else

1. Install Tailscale from the same link, sign in with your own account.
2. Accept the host's share invite (one click).
3. Install the Hearth app (`docs/INSTALL_CLIENT.md`), paste the address,
   enter a display name, **Step inside**.

## Checking it works

- `tailscale status` on any machine should list the host with a `100.x.y.z`
  address.
- Visiting `http://100.x.y.z:4443` in a browser shows a one-line
  "server is up" message.
- In Hearth, the connect screen's console prints `> linked` with the ping.

## If something doesn't connect

| Symptom | Likely cause / fix |
|---|---|
| App says `could not reach server` | Tailscale not running on your machine, or you haven't accepted the share invite. Run `tailscale status`. |
| Browser reaches `:4443` but joining a channel yields no audio | Host firewall is blocking the media port on the tailnet interface. On the host: `sudo ufw allow in on tailscale0 to any port 44444` (both `proto udp` and `proto tcp`), or the equivalent in your firewall. Most default setups need nothing. |
| Everything works at home but not from a hotel | Rare CGNAT/UDP-hostile networks force Tailscale through a relay (DERP). It still works; expect higher ping. `tailscale status` shows `relay` next to the peer. |
| Host banner warns "No Tailscale or LAN address detected" | `tailscaled` isn't running on the host. Start Tailscale, restart the server. |

## LAN parties

On the same LAN you can skip Tailscale entirely: the server banner prints a
LAN address when no tailnet is found, and clients connect to that. Same app,
same everything.
