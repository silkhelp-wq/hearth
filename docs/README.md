# Hearth Documentation

Everything about Hearth, organized by who you are and what you need. Hearth is a
self-hosted voice, video, screen-share, and chat app for a small group of
friends — one person hosts the server, everyone else runs the desktop app.

---

## Start here

- **Just want to use it?** → [Installation Guide](install/INSTALL_GUIDE.md) —
  every OS, with the gotchas.
- **Want to understand how it works?** → [Architecture](ARCHITECTURE.md) and the
  [Diagrams](diagrams/DIAGRAMS.md).
- **Hosting the server?** → [Installation Guide, Part 2](install/INSTALL_GUIDE.md#part-2--the-server-host-one-person)
  for home hosting, or the [Deployment Guide](deployment/DEPLOYMENT_GUIDE.md)
  for production/cloud.

---

## By audience

### 👤 Users & hosts

| Document | What it covers |
|----------|----------------|
| [Installation Guide](install/INSTALL_GUIDE.md) | Complete cross-platform install (Windows/macOS/Linux), server setup, ownership, updates, and a troubleshooting index |
| [Client Install](INSTALL_CLIENT.md) | Focused client install notes |
| [Host Install](INSTALL_HOST.md) | Server host quick start + all environment variables |
| [Native Install](INSTALL_NATIVE.md) | systemd service, native packaging, auto-update, owner reclaim |
| [Connection Guide](CONNECTION_GUIDE.md) | Tailscale networking and connecting |
| [Stream Settings](STREAM_SETTINGS.md) | Quality presets, the recommendation engine, and host relay math |

### 💼 Business & investors

| Document | What it covers |
|----------|----------------|
| [Investor Pitch](business/INVESTOR_PITCH.md) | Problem, solution, market, business model, competition, traction, risks, and the ask |
| [Business Requirements (BRD)](business/BRD.md) | Business objectives, scope, stakeholders, and success criteria |
| [Use Cases](business/USE_CASES.md) | End-to-end usage scenarios tied to requirements and tests |

### 🔧 Engineers & testers

| Document | What it covers |
|----------|----------------|
| [Architecture](ARCHITECTURE.md) | System design narrative with per-version notes |
| [Engineering Guide](engineering/ENGINEERING_GUIDE.md) | Modules, protocols, data model, data flows, build & release |
| [Streaming Internals](engineering/STREAMING_INTERNALS.md) | SFU model, codecs, bitrate, temporal layers, and the hardware-encoding reality on Linux/NVIDIA |
| [Test Strategy](engineering/TEST_STRATEGY.md) | Test layers, risk matrix, regression hot-spots, verification checklist |
| [Test Plan](TEST_PLAN.md) | Concrete numbered test cases (TC-01…) |
| [Software Requirements (SRS)](SRS.md) | Formal functional/non-functional requirements |

### ☁️ DevOps & operators

| Document | What it covers |
|----------|----------------|
| [Deployment Guide](deployment/DEPLOYMENT_GUIDE.md) | On-prem and any-cloud deployment: networking, TLS, containers, cloud-specific notes, monitoring, backups, scaling, security |
| [Distribution & Code Protection](deployment/DISTRIBUTION.md) | Public downloads for non-collaborators, shipped-code hardening (honest limits), and the mobile roadmap |
| [Public Deploy](DEPLOY_PUBLIC.md) | Public VPS hosting with TLS |

### 📊 Diagrams

| Document | What it covers |
|----------|----------------|
| [Diagrams](diagrams/DIAGRAMS.md) | Architecture, connectivity, sequence flows, focus mode, auto-update, permissions, ownership, deployment topology, and data model — all as GitHub-rendered Mermaid |

---

## Documentation map

```
docs/
├── README.md                       ← you are here
├── ARCHITECTURE.md                 System design + per-version notes
├── SRS.md                          Software requirements
├── TEST_PLAN.md                    Numbered test cases
├── CONNECTION_GUIDE.md             Tailscale / connecting
├── STREAM_SETTINGS.md              Presets + recommendation engine
├── INSTALL_CLIENT.md               Client install notes
├── INSTALL_HOST.md                 Server host + env vars
├── INSTALL_NATIVE.md               Service + packaging + reclaim
├── DEPLOY_PUBLIC.md                Public VPS + TLS
├── install/
│   └── INSTALL_GUIDE.md            Complete cross-platform install + pitfalls
├── business/
│   ├── INVESTOR_PITCH.md           Investor pitch deck (prose)
│   ├── BRD.md                      Business requirements
│   └── USE_CASES.md                Usage scenarios
├── engineering/
│   ├── ENGINEERING_GUIDE.md        Deep technical reference
│   ├── STREAMING_INTERNALS.md      Media / codecs / hardware encode
│   └── TEST_STRATEGY.md            QA approach
├── deployment/
│   └── DEPLOYMENT_GUIDE.md         On-prem + cloud ops
└── diagrams/
    └── DIAGRAMS.md                 Mermaid diagrams
```

---

## Current status

Hearth is at **v0.6.8**, a working product in daily use. Voice, video, 4K screen
share with focus mode, chat with reactions/search/custom emojis, roles &
permissions, jukebox, host monitoring dashboard, native packaging, and
end-to-end-proven auto-update on both client and server. It stays private —
self-hosted on hardware the group controls, over an encrypted Tailscale mesh.
