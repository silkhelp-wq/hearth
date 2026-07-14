# Hearth — DevOps Deployment Guide

> **Audience:** DevOps / operators · **Prerequisites:** Linux administration, basic networking · **Time:** 20-minute read · **Applies to:** v0.6.x

Running the Hearth server in production: on-premises, on a VPS, or in any cloud.
This goes well beyond the home-host quick start — it covers networking, TLS,
process supervision, containers, cloud-specific notes, monitoring, backups, and
scaling considerations. For the simple home setup, the
[install guide](../install/INSTALL_GUIDE.md) and
[`INSTALL_NATIVE.md`](../INSTALL_NATIVE.md) are enough; this is for operators.

---

## 1. What you're deploying

A single Node.js process (the Hearth server) that needs:

- **Node.js 20+** (22 recommended).
- Two network ports reachable by clients:
  - **TCP 4443** — signaling (Socket.IO) + HTTP (Express: `/health`, `/info`,
    `/speedtest`).
  - **UDP + TCP 44444** — all mediasoup media (SRTP).
- A **persistent data directory** (SQLite DB + assets).
- A **correctly advertised address** (`HEARTH_ANNOUNCED_IP`) that clients can
  actually reach.

The last point is the one that trips people up in the cloud: mediasoup
advertises a specific IP in its ICE candidates, and it **must** be the address
clients route to, or media fails even when signaling works.

---

## 2. Networking model & the announced-IP rule

Hearth supports two connectivity models:

### 2.1 Private (Tailscale) — simplest, most secure

Put the server and all clients on a Tailscale tailnet. The server auto-detects
its `100.x.y.z` address; clients connect to it. No public exposure, no TLS
needed (WireGuard already encrypts), no port forwarding. **This is the
recommended model even for a "hosted" server** if your users are willing to run
Tailscale — it eliminates an entire class of security and networking concerns.

### 2.2 Public — for a genuinely public host

Expose the server on a public IP. This requires:

- Setting `HEARTH_ANNOUNCED_IP` to the server's **public** IP (not its private/
  internal cloud IP).
- A **TLS reverse proxy** in front of signaling (browsers and the client expect
  a secure origin for a public host).
- Firewall/security-group rules opening the ports (see §4).

**The announced-IP rule, precisely:** mediasoup binds locally (often to a
private interface in the cloud) but must **announce** the public IP so clients'
ICE can reach it. Always set `HEARTH_ANNOUNCED_IP` to the public address in any
NAT'd/cloud environment. If media connects on the same LAN but not from
outside, this is almost always the cause.

---

## 3. TLS termination

For public hosts, front the **signaling port (4443)** with TLS. The media port
(44444) carries SRTP, which is already encrypted — it is **not** proxied and
does **not** get TLS termination; it goes straight to the instance.

**Caddy (simplest — automatic Let's Encrypt):**

```
hearth.example.com {
    reverse_proxy localhost:4443
}
```

Caddy fetches and renews certificates automatically. Point clients at
`https://hearth.example.com`. See [`DEPLOY_PUBLIC.md`](../DEPLOY_PUBLIC.md) for
the fuller public-host walkthrough.

**nginx (if you already run it):** reverse-proxy `443 → localhost:4443` with
your certs and **WebSocket upgrade headers** (Socket.IO needs them):

```
location / {
    proxy_pass http://localhost:4443;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

**Key point:** only signaling is proxied. Media (44444) must be directly
reachable on the instance — do not try to route it through the HTTP proxy.

---

## 4. Firewall / security-group rules

Open exactly these, scoped as tightly as your model allows:

| Port | Protocol | Purpose | Public model | Tailscale model |
|------|----------|---------|--------------|-----------------|
| 4443 | TCP | Signaling / HTTP (or 443 if TLS-proxied) | Open to clients | Tailnet only |
| 44444 | UDP | Media (primary) | Open to clients | Tailnet only |
| 44444 | TCP | Media (fallback for UDP-blocked clients) | Open to clients | Tailnet only |

In the Tailscale model you can keep **everything** bound to the tailnet and open
nothing publicly. In the public model, both ports must reach the instance;
44444 UDP is the important one (TCP 44444 is the fallback for clients on
UDP-hostile networks).

---

## 5. Process supervision

The server must run continuously and restart on failure/reboot.

### 5.1 systemd (bare-metal / VM — recommended)

The native package ships a **systemd user service**
(`INSTALL_NATIVE.md`). For a system-wide service on a dedicated host, a unit
like:

```ini
[Unit]
Description=Hearth server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hearth
WorkingDirectory=/opt/hearth/server
Environment=HEARTH_ANNOUNCED_IP=203.0.113.10
Environment=HEARTH_DATA_DIR=/var/lib/hearth
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now hearth`. Logs via `journalctl -u hearth -f`.

### 5.2 Environment file

Keep configuration (and the update token) in an environment file the service
loads, so it survives upgrades and data resets:

```
HEARTH_ANNOUNCED_IP=203.0.113.10
HEARTH_DATA_DIR=/var/lib/hearth
HEARTH_UPDATE_TOKEN=<read-only repo token>
```

Reference it in the unit with `EnvironmentFile=`.

---

## 6. Containerized deployment

Hearth runs in a container, with one important networking caveat: **mediasoup's
media port needs host networking** (or a very carefully mapped UDP range),
because ICE/announced-IP and NAT inside container bridges get messy fast.

**Recommended: host networking.**

```dockerfile
FROM node:22-bookworm-slim
WORKDIR /app/server
# system deps for better-sqlite3 / mediasoup build, if building natively
RUN apt-get update && apt-get install -y python3 build-essential && rm -rf /var/lib/apt/lists/*
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
ENV HEARTH_DATA_DIR=/data
VOLUME /data
EXPOSE 4443/tcp 44444/udp 44444/tcp
CMD ["node", "src/index.js"]
```

Run with **host networking** and the announced IP set to the host's public
address:

```
docker run -d --name hearth \
  --network host \
  -e HEARTH_ANNOUNCED_IP=203.0.113.10 \
  -v hearth-data:/data \
  hearth-server
```

If you can't use host networking, you must publish `44444/udp` **and**
`44444/tcp` and set `HEARTH_ANNOUNCED_IP` to the host — but be aware that some
container network stacks mangle UDP/ICE, so host networking is strongly
preferred for the media port.

**docker-compose sketch:**

```yaml
services:
  hearth:
    build: .
    network_mode: host
    environment:
      HEARTH_ANNOUNCED_IP: 203.0.113.10
      HEARTH_DATA_DIR: /data
    volumes:
      - hearth-data:/data
    restart: unless-stopped
volumes:
  hearth-data:
```

---

## 7. Cloud-specific notes (any cloud)

The pattern is the same everywhere; the specifics differ. In all cases: set
`HEARTH_ANNOUNCED_IP` to the **public** IP, open 4443/TCP and 44444/UDP+TCP in
the provider's firewall, and persist the data directory.

### AWS (EC2)

- Launch an instance; attach an **Elastic IP** and use it as
  `HEARTH_ANNOUNCED_IP`.
- **Security group:** inbound 4443/tcp (or 443 if TLS-proxied), 44444/udp,
  44444/tcp.
- Persist data on the root EBS volume or a separate EBS volume mounted at
  `HEARTH_DATA_DIR`.
- **Load balancers:** an ALB/NLB can front **signaling** (TCP 4443/443), but
  **media must go direct to the instance** — do not route 44444 through the LB.
  This is why a single instance with an Elastic IP is the clean pattern.

### Google Cloud (Compute Engine)

- Reserve a **static external IP**; use it as `HEARTH_ANNOUNCED_IP`.
- **VPC firewall rules:** allow 4443/tcp, 44444/udp, 44444/tcp from client
  ranges (or `0.0.0.0/0` for a public host).
- Persist data on the boot disk or an attached persistent disk.

### Azure (VM)

- Assign a **static public IP**; set it as `HEARTH_ANNOUNCED_IP`.
- **Network security group:** inbound rules for 4443/tcp, 44444/udp, 44444/tcp.
- Persist data on the OS disk or a managed data disk.

### DigitalOcean / Linode / Hetzner / any VPS

- The instance's public IP is `HEARTH_ANNOUNCED_IP`.
- Open the ports in the provider's cloud firewall **and** the host firewall
  (ufw/firewalld) if enabled.
- This is often the simplest and cheapest path — a small VPS handles a
  small-group Hearth comfortably.

### The universal cloud gotcha

**Almost every "media won't connect in the cloud" issue is one of two things:**
(1) `HEARTH_ANNOUNCED_IP` set to the instance's *private* IP instead of its
public IP, or (2) 44444 UDP not open in the security group/firewall. Check both
first.

---

## 8. Monitoring & observability

- **Built-in health endpoint:** `GET /health` returns liveness + version — wire
  it to your uptime monitor or load-balancer health check.
- **`/info`** returns server metadata.
- **In-app owner dashboard** (Settings → Server) shows CPU, memory, disk,
  network, and live participant/stream counts, and flags available updates.
- **Logs:** `journalctl -u hearth -f` (systemd) or `docker logs -f hearth`
  (container). Watch for DTLS/ICE errors (connectivity), and note the benign
  cosmetic lines documented in the streaming internals doc.

For heavier setups, scrape `/health` and the host's system metrics into
whatever you already run (Prometheus/Grafana, cloud-native monitoring, etc.).

---

## 9. Backups

The **data directory** (`HEARTH_DATA_DIR`) is the entire state: the SQLite DB
(users, roles, messages, read-state) and stored assets (emojis, previews).

- **SQLite is in WAL mode** — for a consistent hot backup, use
  `sqlite3 hearth.db ".backup backup.db"` rather than copying the file mid-write,
  or stop the service briefly and copy the directory.
- Back up the whole `HEARTH_DATA_DIR` on a schedule; it's small.
- The **environment file** (with the announced IP and update token) should be
  backed up/version-controlled separately (secrets management for the token).

Restore is just putting the data directory back and starting the service — the
owner claim and all history come back with it.

---

## 10. Updates in production

- **Server update detection:** with `HEARTH_UPDATE_TOKEN` set, the owner
  dashboard reports when a newer release exists.
- **Applying an update (native package):** re-run the install and restart the
  service; the data directory is preserved. For a source deploy: pull, `npm ci`,
  restart. For a container: pull/rebuild the image and redeploy with the same
  data volume.
- **Zero-downtime is not a goal** for a small-group server — a few seconds of
  restart is fine. Coordinate updates for a quiet moment.

---

## 11. Scaling considerations

Hearth's SFU is **single-worker, one router per channel** — deliberately sized
for small groups (7–10). Scaling notes for operators eyeing more:

- **Vertical first:** the server's constraint is CPU (media forwarding) and
  **upload bandwidth**. A bigger instance and fatter uplink go a long way for a
  single busy channel.
- **The hard ceiling is host upload:** the server sends N−1 copies of every
  stream. This is a bandwidth wall, not a CPU one, and it's inherent to the SFU
  model (see streaming internals).
- **Horizontal scaling is a real engineering effort, not a config flag:**
  multiple mediasoup workers, worker/router assignment, and possibly
  multi-server piping would be required. This is out of scope for the current
  product and would be a funded workstream.

For the intended use case — a private group of friends — a single modest
instance is correct and sufficient.

---

## 12. Security posture for operators

- **Trust model:** Hearth assumes a **trusted group**. There is no public-server
  abuse hardening, rate limiting for hostile actors, or account system. Do not
  expose a public Hearth to untrusted internet users and expect Discord-grade
  abuse resistance.
- **Prefer the Tailscale model** whenever possible — it removes public exposure
  entirely.
- **The update token** is a read-only, single-repo, fine-grained token. Keep it
  in the environment file / secrets manager, never in the image or git. If it's
  ever exposed, revoke it in GitHub settings and issue a new one.
- **TLS** on signaling for any public host — never run a public Hearth over
  plain HTTP.
- **Unsigned client builds** trigger OS warnings; for a commercial deployment,
  code-signing certificates would be part of hardening.

---

## 13. Deployment checklist

- [ ] Node.js 20+ installed (or container built).
- [ ] `HEARTH_ANNOUNCED_IP` = the **public** (or tailnet) address clients reach.
- [ ] `HEARTH_DATA_DIR` on persistent storage.
- [ ] Ports open: 4443/tcp, 44444/udp, 44444/tcp (or tailnet-only).
- [ ] TLS reverse proxy on signaling (public model).
- [ ] Process supervision (systemd/container restart policy).
- [ ] Environment file with config + update token, backed up.
- [ ] Health check wired to monitoring.
- [ ] Data directory backup scheduled.
- [ ] `GET /health` returns OK from a client's network path.
- [ ] A real client connects, joins voice, and shares a screen end-to-end.
