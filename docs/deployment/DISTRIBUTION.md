# Hearth — Distribution & Code Protection

> **Audience:** maintainer / operators · **Prerequisites:** GitHub basics ·
> **Time:** 10-minute read + 5-minute setup · **Applies to:** v0.8.2+

How Hearth reaches people who have no access to the private repo, what
protects the shipped code, and the roadmap to mobile.

---

## 1. Public downloads, private source

The source repo (`silkhelp-wq/hearth`) stays **private**. Distribution happens
through a second, **public, installers-only** repo:

```
silkhelp-wq/hearth-releases     ← public: installers + install README only
silkhelp-wq/hearth              ← private: all source, CI, docs
```

Every tagged release in the private repo builds the installers on CI and
**mirrors the four assets** (exe / dmg / AppImage / deb) to the public repo.
Anyone — no GitHub account, no repo access — downloads from:

```
https://github.com/silkhelp-wq/hearth-releases/releases/latest
```

**Auto-update rides the same feed.** Both the client updater and the server
monitor now check the public repo FIRST, with no token; only if it's absent do
they fall back to the private repo + read-only token. Once the public repo has
its first release, **the update token becomes unnecessary** for clients — a
strict security improvement (no credential shipped in installers at all).

### One-time setup (maintainer)

1. Create the public repo (a README makes the release page self-explanatory):
   ```
   gh repo create silkhelp-wq/hearth-releases --public \
     --description "Hearth — downloads for Windows / macOS / Linux" \
     --add-readme
   ```
2. Create a **fine-grained PAT** scoped to ONLY `hearth-releases` with
   **Contents: Read and write** (GitHub → Settings → Developer settings →
   Fine-grained tokens). This token can touch nothing but the public
   downloads repo.
3. Store it as a secret in the **private** repo:
   ```
   gh secret set HEARTH_PUBLIC_RELEASE_TOKEN
   ```
4. Tag a release as usual. CI attaches assets to the private release AND
   mirrors them publicly. (If the secret is absent, the mirror step is
   skipped — nothing breaks.)

Put the install quick-start in the public repo's README (copy the per-OS
table from `docs/INSTALL_CLIENT.md`) so the download page teaches installation.

---

## 2. Code protection — the honest version

**Nothing shipped to a user's machine can be made impenetrable.** That is
true of every desktop app ever shipped, and doubly true of Electron, whose
application code is JavaScript executed by a bundled Chromium. Anyone
sufficiently motivated can extract and study what runs on their own hardware.
What we control is the *cost* of doing so, and — far more importantly —
**what we never ship at all**.

What Hearth does (v0.8.2+):

| Layer | What it does |
|-------|--------------|
| **Source never ships** | The repo is private; binaries are public. The strongest protection is structural: the readable source simply isn't published. |
| **No sourcemaps** | Until v0.8.2 the bundle embedded an inline sourcemap — the entire original source, comments and all, inside every release (84% of the bundle!). Now stripped. |
| **Minification** | Identifiers mangled, whitespace/comments gone. Reversing yields spaghetti, not source. |
| **asar packaging** | App files ship inside an asar archive rather than loose on disk. Trivially unpackable — a tidiness layer, not security, and pinned explicitly so it can't regress. |
| **No secrets in builds** | With the public feed, installers carry no tokens at all. |

Optional next rung (not shipped): **V8 bytecode compilation** (e.g.
`bytenode`) compiles the JS to V8 bytecode so no JS text ships. It genuinely
raises the reversing bar but complicates builds, debugging, and native-module
interop, and bytecode is Node-version-pinned. Worth doing only as its own
carefully tested release if the need is real.

**Threat-model reality check:** for a private friend-group app, the assets
worth protecting are the *server* (never distributed publicly — it lives only
on the host) and any credentials (none ship). The client binary being
studyable is a normal, acceptable property of desktop software.

---

## 3. Mobile (Android / iPhone / iPad) — what it takes

Three paths, in ascending cost:

### A. Responsive web / PWA — days of work, ~$0
The Hearth server **already serves the full client to any browser**. Mobile
Chrome and iOS Safari (16+) support WebRTC — mic, camera, and *viewing*
screen shares all work in principle today. What it takes: a mobile-responsive
CSS pass (the desktop three-column layout must collapse), touch-friendly
controls, a web app manifest so it installs to the home screen, and testing
the mobile-browser quirks (iOS autoplay policies, audio-session behavior).
**Limits:** no reliable background audio on iOS, no global push-to-talk, no
push notifications without further server work.

### B. Capacitor apps — weeks part-time, $124 first year
Wrap the same web client in [Capacitor](https://capacitorjs.com) native
shells: real Android/iOS apps reusing ~90% of the existing renderer.
Gains over the PWA: proper microphone/camera permission flows, better audio
session handling (background audio feasible), push notifications, an icon in
the app drawer like anything else. Distribution for a friend group:
**Android = send the APK directly** (sideload, no store, free);
**iOS = TestFlight**, which requires an Apple Developer account ($99/yr) and
a light review pass — there is no free sideloading path Apple sanctions.
Google Play, if ever wanted, is a $25 one-time fee.

### C. Native rewrite (Swift/Kotlin or React Native) — months
Full control, best battery/audio behavior, and complete rework of the client.
Not justified for a 7–10-person group unless mobile becomes the primary way
people use Hearth.

**Recommendation:** ship **A** first — it's nearly free, works on every
device immediately, and teaches you which mobile limitations actually matter
to your crew. Graduate to **B** only if iPhone users need background audio or
a real app feel. Skip C.
