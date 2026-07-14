# Hearth — Business Requirements Document (BRD)

> **Audience:** business stakeholders · product · **Prerequisites:** none · **Time:** 10-minute read · **Applies to:** v0.6.x

**Product:** Hearth — self-hosted group communications
**Owner:** Mages of the Beaches LLC
**Status:** Reflects v0.6.8 shipping product
**Companion documents:** [`SRS.md`](../SRS.md) (software requirements),
[`INVESTOR_PITCH.md`](INVESTOR_PITCH.md) (market case),
[`USE_CASES.md`](USE_CASES.md) (usage scenarios)

---

## 1. Purpose

This document captures the *business* requirements for Hearth — the goals,
scope, stakeholders, and success criteria driving the product — as distinct
from the *software* requirements (which specify system behavior; see the SRS).
It answers "why are we building this and what must it achieve," not "how does
the code behave."

---

## 2. Business objectives

| # | Objective | Rationale |
|---|-----------|-----------|
| BO-1 | Give small groups a private communications home they fully own | Core value proposition; the reason the product exists |
| BO-2 | Eliminate the technical barriers that normally make self-hosting hard | Self-hosting adoption dies on networking/setup friction |
| BO-3 | Match the feature expectations set by Discord for small groups | Users won't switch to something that feels like a downgrade |
| BO-4 | Never monetize user data | Both an ethical stance and the central market differentiator |
| BO-5 | Keep the self-hostable core free and open | Preserves community trust and the ownership promise |
| BO-6 | Make a hosted instance maintainable by one non-expert | The host is a hobbyist, not an ops team |

---

## 3. Scope

### 3.1 In scope

- Cross-platform desktop client (Windows, macOS, Linux).
- Self-hostable server (home hardware, Raspberry Pi, or any cloud VM).
- Real-time voice, webcam, and screen share for small groups (target 7–10).
- Persistent text chat with modern affordances (reactions, threads via
  replies, search, markdown, mentions, link previews).
- Roles, permissions, and a claimable/recoverable server owner.
- Zero-config networking via Tailscale, plus an optional public-host path.
- Bounded local storage with automatic pruning.
- A music jukebox that streams into voice.
- Custom emojis.
- A host-facing server monitoring dashboard.
- Self-updating client and server.

### 3.2 Out of scope (current stage)

- Public/federated servers or a global directory.
- Mobile clients (iOS/Android).
- Large-scale (100+ concurrent) deployments.
- Monetization features (billing, seats, paid tiers) — architecturally
  possible, not built.
- End-user file storage/sharing beyond chat.
- Compliance certifications (SOC 2, HIPAA, etc.).

### 3.3 Explicitly deferred

- Bans (only kick/remove exist today).
- Persistent moderator mute across restarts (currently in-memory).
- Native Wayland global push-to-talk (currently X11/XWayland-based).
- Automated Linux desktop-audio capture for screen share.

---

## 4. Stakeholders

| Stakeholder | Interest |
|-------------|----------|
| **The group / end users** | A private, reliable, full-featured place to hang out |
| **The host** | Easy to stand up, easy to keep running, doesn't demand expertise |
| **The owner/admin** | Control over membership, roles, and moderation |
| **Mages of the Beaches LLC** | A product that could become a business without violating its principles |
| **Prospective investors** | Evidence of a real product and a plausible market |
| **DevOps/operators (future/commercial)** | Deployable and operable at scale, on any infrastructure |

---

## 5. Business requirements

### 5.1 Functional (business-level)

| # | Requirement | Priority | Status |
|---|-------------|----------|--------|
| BR-1 | A person with no networking expertise can join by pasting one address | Must | ✅ |
| BR-2 | One person can host the server without port forwarding | Must | ✅ |
| BR-3 | The group gets voice, video, screen share, and text chat | Must | ✅ |
| BR-4 | The host controls who is admin (claimable, recoverable ownership) | Must | ✅ |
| BR-5 | No user account or third-party identity is required to participate | Must | ✅ |
| BR-6 | The system runs on commodity/home hardware | Must | ✅ |
| BR-7 | Data stays on hardware the group controls | Must | ✅ |
| BR-8 | Updates reach users without manual redistribution | Should | ✅ |
| BR-9 | Storage cannot grow without bound and threaten the host | Should | ✅ |
| BR-10 | The host can see the server's health at a glance | Should | ✅ |
| BR-11 | The server is deployable to any cloud for those who prefer it | Could | ✅ (documented) |
| BR-12 | A managed/hosted offering can be built on the same codebase | Could | ⚠️ future |

### 5.2 Non-functional (business-level)

| # | Requirement | Target |
|---|-------------|--------|
| NBR-1 | Group media quality is usable on residential upload | 7–10 people on typical home internet |
| NBR-2 | Host operational burden is minimal | Set up once; self-updates; survives reboots as a service |
| NBR-3 | Cross-platform parity | Windows, macOS, Linux all first-class |
| NBR-4 | Privacy by architecture | No data leaves group-controlled infrastructure; E2E-encrypted transport |
| NBR-5 | Cost to run is low | Free software; runs on hardware you already own or a cheap VM |
| NBR-6 | Recoverability | Owner lockout is always recoverable from the host |

---

## 6. Success criteria

**Current stage (product validation):**

- ✅ A group can install, connect, and use the full feature set unaided.
- ✅ The host can stand up and maintain the server without ongoing expert help.
- ✅ Updates ship and apply automatically.
- ✅ The system is stable in daily real-world use.

**Next stage (commercial validation) — not yet achieved:**

- A managed-hosting MVP that a non-developer can subscribe to and use.
- A measurable base of groups beyond the initial crew.
- Evidence that some users will pay for hosting/convenience/pro features.
- Demonstrated operability at more than small-group scale.

---

## 7. Assumptions & dependencies

- **Tailscale** (or an equivalent WireGuard mesh) is available for the
  zero-config path. The public-host path removes this dependency at the cost of
  requiring TLS setup.
- **Node.js 20+** on the host.
- Clients run a supported desktop OS.
- The group is small and trusted — Hearth's security model assumes members are
  not adversarial (there is no public-server hardening).
- GitHub Releases is the current update-distribution channel.

---

## 8. Constraints

- **Small-group scale by design.** The SFU runs a single worker/router per
  channel; this is right for 7–10 people, not for hundreds. Scaling is a
  future engineering effort, not a config change.
- **Unsigned builds** currently trigger OS security warnings — acceptable for a
  private group, a friction point for a commercial launch (code-signing certs
  would be part of productization).
- **Hardware-encode limits on Linux/NVIDIA** cap browser-WebRTC screen-share
  quality (see engineering docs) — a platform constraint, not a product defect.
- **Founder-led** with limited bandwidth until/unless funded.

---

## 9. Traceability

Each business requirement maps to concrete software requirements in the
[SRS](../SRS.md) and is exercised by cases in the
[Test Plan](../TEST_PLAN.md). For example: BR-2 (no port forwarding) →
SRS networking requirements → connection tests; BR-4 (recoverable ownership) →
owner-claim/reclaim requirements → TC-56 (owner reclaim). See
[`USE_CASES.md`](USE_CASES.md) for end-to-end scenarios that tie business
goals to user-visible flows.
