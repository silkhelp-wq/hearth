# Hearth — Test Strategy

> **Audience:** engineers & QA · **Prerequisites:** basic familiarity with the codebase · **Time:** 10-minute read · **Applies to:** v0.6.x

How Hearth is tested, what's automated vs. manual, and how to verify a change
before shipping it. Pairs with [`../TEST_PLAN.md`](../TEST_PLAN.md), which holds
the concrete numbered test cases (TC-01…TC-59+). This document is the *approach*;
the test plan is the *checklist*.

---

## 1. Testing philosophy

Hearth is a small, fast-moving project maintained by one engineer, so the
testing strategy is pragmatic:

- **Automate what's cheap and catches regressions** — the server's core logic
  (db, permissions, chat, mediasoup boot) runs as a self-test on every build.
- **Manually verify what needs real hardware and humans** — anything involving
  live media, multiple participants, OS-specific capture, or the actual UI.
- **Treat the build pipeline as a test** — a green CI release across three OSes
  is itself a signal that the client packages correctly everywhere.

The guiding principle: **a change isn't done until it's been exercised**, and
the level of verification scales with the risk of the change.

---

## 2. Test layers

### 2.1 Server self-test (automated)

`node src/index.js --selftest` exercises database operations, permission
resolution, chat + full-text search, storage settings, member
deletion/ownership, and mediasoup worker/router creation, then exits 0 (pass)
or 1 (fail). This is the fast smoke test:

- Run it locally before committing server changes.
- CI runs it as a gate.
- It's the first thing to run when something seems broken server-side.

**When you add server logic, add a self-test assertion for it.** The member-
removal and owner-reclaim paths, for example, each got selftest coverage when
they were built.

### 2.2 Client build (automated)

`npm run build` (esbuild) must succeed — a syntax error or bad import fails the
bundle. `node --check` on the Electron main/preload files catches main-process
syntax errors. Both run before packaging.

### 2.3 Release pipeline (automated, cross-platform)

A tagged push builds installers for Windows, macOS, and Linux. A green run
means the client compiles and packages on all three platforms — a real
integration signal, since platform-specific build breaks (native modules,
electron-builder targets) surface here.

### 2.4 Manual functional testing (the bulk of real coverage)

Live media, multi-participant behavior, OS capture, and UI can't be
meaningfully unit-tested here. These are verified by hand against the test plan.
Key areas that **require** manual testing:

- Voice quality, echo cancellation, VAD/PTT gating.
- Screen share on each OS (especially the Wayland portal flow).
- Multi-participant streaming: ghosting, sync, focus mode, per-stream volume.
- The recommendation engine against real speed-test numbers.
- Auto-update end-to-end (an older installed build detecting a newer release).
- Owner claim/reclaim/transfer and member moderation.

### 2.5 Multi-participant testing

The single most important thing manual testing here needs is **a second
participant** (or a second device on the tailnet). A stream only ghosts, lags,
or desyncs *for a viewer* — the sharer's local preview always looks fine. So
streaming regressions are invisible when testing solo. Reserve a "two-person
pass" for anything touching media forwarding, codecs, layers, or focus mode.

---

## 3. Risk-based verification matrix

How much testing a change needs, by area:

| Change area | Self-test | Build | Manual (solo) | Manual (2-person) |
|-------------|-----------|-------|---------------|-------------------|
| DB / permissions / chat | ✅ required | — | light | — |
| Signaling / room logic | ✅ | ✅ | ✅ | ✅ if media-affecting |
| Codec / bitrate / layers | — | ✅ | ✅ | ✅ **required** |
| Screen-share flow | — | ✅ | ✅ per-OS | ✅ |
| UI / controls | — | ✅ | ✅ | — unless media |
| Auto-update | — | ✅ | — | — (needs a real release) |
| Packaging / flags | — | ✅ | ✅ launch | — |
| Ownership / moderation | ✅ | ✅ | ✅ | — |

---

## 4. Regression hot-spots (learned the hard way)

Areas where changes have historically broken things — test these
specifically when nearby:

- **Opus audio bitrate** — changing it must recreate producers, or you get a PT
  111 fmtp collision. Verify: change quality mid-call several times; watch for
  "codec collision" in the console. (TC-55)
- **Temporal layers / SVC** — enabling scalability without setting consumer
  layer preferences causes framerate starvation. Verify: a viewer sees full
  framerate within ~2s. (TC-50)
- **Wayland screen share** — enumerating sources on Wayland double-prompts the
  portal and aborts. Verify: exactly one portal dialog on "Go live." (TC-52)
- **Device identity** — dev vs. packaged runs must share one profile, or you
  get duplicate members and stranded ownership. Verify: same member via
  `npm start` and the installed build. (TC-53)
- **Mute/deafen feedback** — the state worked but was once invisible on the
  dark theme. Verify: buttons visibly change (solid red) and actually gate
  audio. (TC-58)
- **Git/packaging hygiene** — makepkg artifacts must not enter git; verify
  `git status` is clean of `pkg/`/`.AppImage` before every commit.

---

## 5. How to verify a change (the checklist)

Before committing:

1. **Server change?** Run `node src/index.js --selftest` → expect `ALL PASS`.
2. **Client change?** Run `npm run build` → expect `[build] dist/ ready`.
   Run `node --check electron/main.js electron/preload.js` if you touched them.
3. **Run it.** Launch the app (`npm start` or the installed build) and exercise
   the changed feature.
4. **Media change?** Do a two-person pass — the change is unverified until a
   viewer confirms it.
5. **Check `git status`** for stray build artifacts.
6. **Add/extend a test case** in the test plan (and a self-test assertion if
   server-side).

Before releasing:

7. `git pull --no-rebase` (avoid divergence rejection).
8. Confirm the version bump (client + server in lockstep).
9. Tag, push, watch CI go green across all three OSes.
10. Verify the release has all four assets (exe/dmg/AppImage/deb).

---

## 6. Test data & environments

- **Local dev:** run server from source with a scratch `HEARTH_DATA_DIR` to
  avoid touching real data (e.g., the selftest and reclaim flows use temp
  dirs).
- **Fresh-DB testing:** removing the data dir yields a clean slate and a new
  owner claim code — useful for testing first-run and ownership flows.
- **Two-device tailnet:** the cheapest "second participant" is a second machine
  (or VM) on the same Tailscale tailnet.

---

## 7. What isn't tested (and the risk)

- **Load/scale beyond small groups** — the SFU is single-worker by design;
  behavior at 100+ participants is untested and out of scope.
- **Adversarial members** — the security model assumes a trusted group; there's
  no public-server hardening or abuse testing.
- **Long-run stability** — soak testing over days/weeks isn't formalized;
  real-world daily use is the current stability signal.
- **Automated UI testing** — the renderer UI is verified manually; there's no
  end-to-end UI automation harness.

These gaps are acceptable for the current stage and would be first targets if
the product moves toward a commercial, at-scale footing.
