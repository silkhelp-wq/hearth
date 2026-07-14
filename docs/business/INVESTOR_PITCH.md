# Hearth — Investor Pitch

> **Audience:** investors & business stakeholders · **Prerequisites:** none · **Time:** 10-minute read · **Applies to:** v0.6.x

**Mages of the Beaches LLC**
Prepared for investor discussion · v0.6.8 product stage

> **A note on framing.** Hearth today is a working, self-hosted group
> communications app built for a private crew of friends. This document lays
> out the case for what it *could become* as a funded product. It is
> deliberately honest about where the product is real and where the market
> thesis is still to be proven — investors reward clarity, not hype.

---

## 1. The one-liner

**Hearth is Discord you actually own.** Self-hosted voice, video, screen
share, and chat for small groups — no accounts, no data harvesting, no
platform that can deplatform you, and no monthly fee. You run it; it's yours.

---

## 2. The problem

Group voice/video chat has consolidated around a handful of platforms —
Discord, Slack, Teams, Zoom — that share three structural problems for a
growing segment of users:

1. **You don't own it.** Your community, your history, your presence all live
   on someone else's servers, governed by someone else's terms. Accounts get
   banned, servers get nuked, features get paywalled, and policies change
   under you.
2. **You are the product.** Free tiers are monetized through data, ads, and
   upsell funnels. "Free" communications are rarely private communications.
3. **It doesn't fit small, trusted groups.** The dominant tools are built for
   scale — public servers, enterprise seats, sprawling feature sets. A gaming
   crew, a family, a band, a small studio, a friend group of eight wants
   something simpler, private, and permanent.

There is a real and growing appetite for **self-sovereign software** — the
same impulse driving the popularity of self-hosted tools like Jellyfin
(vs. Netflix), Nextcloud (vs. Google Drive), and Home Assistant (vs. cloud
smart-home platforms). Real-time group communications is a conspicuous gap in
that movement.

---

## 3. The solution

Hearth is a two-part system a non-expert can run:

- **A desktop app** (Windows, macOS, Linux) that each person installs.
- **A server** that one person in the group hosts — on a spare PC, a home
  server, a Raspberry Pi, or a cheap cloud VM.

The hard problems are already solved in the shipping product:

- **Zero network configuration.** Connectivity rides on a
  [Tailscale](https://tailscale.com) mesh — no port forwarding, no exposed
  ports, end-to-end encrypted. This is the single biggest barrier to
  self-hosting, and Hearth removes it.
- **Real-time group media that scales to the group.** A selective forwarding
  unit (SFU) architecture means 7–10 people can share video on ordinary home
  internet.
- **The full feature set people expect:** voice channels, webcam, screen share
  up to 4K, text chat with reactions/threads/search, roles and permissions, a
  music jukebox, custom emojis, and a server-health dashboard for the host.
- **It updates itself.** Both client and server have a working auto-update
  path, so a hosted instance stays current without the host babysitting it.

**The product is not a mockup.** It is deployed and in daily use by its
initial group, running the complete feature set described above.

---

## 4. Why now

Three tailwinds converge:

1. **Trust in centralized platforms is eroding.** Deplatforming, data
   breaches, sudden policy shifts, and enshittification of free tiers have
   pushed users to look for alternatives they control.
2. **Self-hosting has gone mainstream-adjacent.** Tailscale, Docker, and
   projects like Jellyfin/Nextcloud/Home Assistant have normalized "run your
   own." Millions of people now self-host *something*. The tooling and the
   audience both exist.
3. **The networking problem is finally solved.** WireGuard-based mesh VPNs
   (Tailscale, Netbird, Headscale) made peer-to-peer connectivity trivial in
   the last few years. Hearth is built on that foundation — it would have been
   an infrastructure nightmare five years ago.

---

## 5. Market

**Reference points (not a bottom-up TAM claim):**

- Discord reports on the order of 200M+ monthly active users; the vast
  majority are in small private servers, not large public ones — Hearth's
  exact shape of user.
- The self-hosting community is large and monetizable: Jellyfin, Nextcloud,
  and Home Assistant each have millions of installs, and the commercial arms
  around them (Nextcloud GmbH, Nabu Casa for Home Assistant) demonstrate that
  self-hosted open products *can* build real businesses.
- Privacy-forward communications (Signal, Session, Matrix/Element) show
  sustained demand for tools that don't monetize user data.

**Initial beachhead:** gaming friend groups and small tight-knit communities —
technically comfortable, already frustrated with Discord's direction, and the
natural early adopters of "own your own server."

---

## 6. Business model options

Hearth's architecture supports several revenue paths that do **not** require
monetizing user data — a key differentiator:

1. **Managed hosting (primary candidate).** Sell a one-click hosted Hearth
   server for groups that want the ownership model without running hardware.
   Recurring revenue, clear value, à la Nabu Casa for Home Assistant.
2. **Pro client features.** A paid tier for power features (higher stream
   limits, advanced moderation, richer integrations) while the core stays
   free and self-hostable.
3. **Support & deployment for organizations.** Small businesses, clubs, and
   studios that want a private comms platform they control, with setup and
   support.
4. **Open-core.** Core open and free; enterprise/advanced modules commercial.

The through-line: **users who want to self-host always can, for free.** Revenue
comes from convenience and advanced capability, never from surveillance. That
positioning is the moat *and* the marketing.

---

## 7. Competitive landscape

| | Owns their data | No accounts required | Small-group focus | Real-time A/V | Self-hostable |
|---|---|---|---|---|---|
| **Hearth** | ✅ | ✅ | ✅ | ✅ | ✅ |
| Discord | ❌ | ❌ | ⚠️ | ✅ | ❌ |
| Slack/Teams | ❌ | ❌ | ❌ | ✅ | ❌ |
| Matrix/Element | ✅ | ⚠️ | ⚠️ | ⚠️ | ✅ |
| Mumble | ✅ | ✅ | ✅ | ⚠️ voice only | ✅ |
| Jitsi | ⚠️ | ✅ | ⚠️ | ✅ | ✅ |

**Honest read on the field:** Matrix is the most direct philosophical
competitor but is notoriously complex to run and its A/V story is weaker.
Mumble is beloved but voice-only and dated. Jitsi is great for ad-hoc video
calls but isn't a persistent community home. Hearth's wedge is the
**combination**: persistent Discord-shaped community + true ownership +
genuinely easy to run. No incumbent occupies that exact square.

**The elephant:** Discord's incumbency, network effects, and polish are
enormous. Hearth does not win by being a better Discord for everyone — it wins
with the segment that specifically wants ownership and privacy, and grows from
there.

---

## 8. Traction & status

- **Working product at v0.6.8**, in daily use by its initial group.
- Full feature set shipped: voice, video, 4K screen share with focus mode,
  chat with reactions/search/emojis, roles/permissions, jukebox, host
  monitoring dashboard.
- **Cross-platform release pipeline** producing signed-ready installers for
  Windows, macOS, and Linux on every tagged release.
- **Auto-update proven end-to-end** on both client and server.
- Built and maintained by an engineer with 14+ years across QA, DevOps, cloud
  infrastructure, and full-stack development.

**What has not been done yet (and that's the point of funding):** no public
launch, no marketing, no managed-hosting product, no user base beyond the
initial group. This is pre-seed-stage: a real product looking for the resources
to find out if the market thesis holds.

---

## 9. The ask & use of funds

Funding would go toward proving the commercial thesis:

1. **Managed-hosting MVP** — build the one-click hosted-server product, the
   likeliest revenue engine.
2. **Public launch & onboarding polish** — turn the "one person clones a repo"
   host flow into something a non-developer can do.
3. **Security & scale hardening** — third-party review, load testing beyond
   the small-group case, and the operational maturity a paid product needs.
4. **Early growth** — reach the self-hosting and gaming communities where the
   first paying users live.

---

## 10. Risks (told straight)

- **Market thesis unproven.** Demand for self-hosted group comms is inferred
  from adjacent movements, not yet demonstrated for this product. First
  funded milestone is to test it cheaply.
- **Incumbent dominance.** Discord is free, polished, and everywhere.
  Mitigation: don't fight head-on; win the ownership/privacy segment.
- **Self-hosting friction.** Even with Tailscale, running a server is a
  barrier. Mitigation: managed hosting removes it entirely for those who want
  that.
- **Monetization tension.** The free-and-self-hostable core must stay genuinely
  free to keep the community's trust, which caps some revenue models.
  Mitigation: the Nabu Casa / Nextcloud playbook shows this can work.
- **Small team.** Currently founder-led. Funding addresses this directly.

---

## Appendix — Product proof points

For the technical diligence that backs the claims above:

- **Architecture & system design:** [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- **Engineering internals:** [`../engineering/`](../engineering/)
- **Deployment (on-prem & cloud):** [`../deployment/DEPLOYMENT_GUIDE.md`](../deployment/DEPLOYMENT_GUIDE.md)
- **Test coverage & QA:** [`../TEST_PLAN.md`](../TEST_PLAN.md) and
  [`../engineering/TEST_STRATEGY.md`](../engineering/TEST_STRATEGY.md)
- **Requirements:** [`../SRS.md`](../SRS.md) and
  [`BRD.md`](BRD.md)
