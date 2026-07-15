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

## 2. Server distribution (host without the source)

The server is distributed the same way as the client: a portable
**tarball** (`hearth-server-<version>.tar.gz`) published to the public
`hearth-releases` repo on every tagged release, via the `Server Release`
workflow. Anyone can host without touching the private source.

Inside the tarball: the server `src/`, its `package.json`/lockfile, and
**one-command installers** for every hosting style — plus a beginner README
(the simple setup guide). The installers:

| File | For |
|------|-----|
| `install.sh` | Linux — home machine or VPS (sets up a background service) |
| `install-windows.ps1` | Windows host |
| `Dockerfile` + `docker-compose.yml` | any cloud / container host |

The tarball ships **source** (the server never runs on untrusted machines —
it lives only on the host's own box), and `npm install` on the target
compiles the native modules (`better-sqlite3`, `mediasoup`) for that machine.
This is the correct model for a self-hosted server: the operator gets code
they can inspect and run, and nothing sensitive is exposed because the server
holds no secret worth hiding — its value is in running, not in obscurity.

## 3. Code protection — the honest version

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
| **asar + integrity** | App files ship inside an asar archive with **embedded integrity validation** (`onlyLoadAppFromAsar`, `enableEmbeddedAsarIntegrityValidation`) — the archive can't be edited or swapped without the app refusing to run. |
| **Electron fuses** | `RUN_AS_NODE` disabled, `NODE_OPTIONS` injection blocked, `--inspect`/CLI debugging of the packaged app disabled, cookie encryption on. Closes the common runtime pry-open paths. |
| **No secrets in builds** | With the public feed, installers carry no tokens at all. |

**Can it be made truly unbreakable? No — and be wary of anyone who says
otherwise.** Every protection above raises *cost*, not certainty. The client
runs on the user's own machine; their browser engine must be handed something
it can execute, so a determined person with a debugger can always observe
behavior. This is equally true of Discord, Slack, VS Code, and every other
Electron app — none are "unbreakable," and they don't need to be.

Optional next rungs (not shipped, documented for completeness):
- **V8 bytecode** (`bytenode`) for the *main* process — compiles Node code to
  bytecode so no JS text ships for that layer. Note it does NOT cover the
  renderer (your UI/app logic runs in Chromium and needs real JS); it
  complicates builds and is Node-version-pinned. Meaningful for the main
  process only, at real cost.
- **Commercial JS obfuscators** (e.g. control-flow flattening) for the
  renderer — heavier scrambling than minification, at a runtime-performance
  and debuggability cost.

Neither is justified for a private friend-group app. **The protection that
actually matters is already in place: the source repo is private, and no
credentials ship.** What reaches users is dense, unlabeled, integrity-locked
machine code — which is the practical ceiling for any desktop software.

**Threat-model reality check:** for a private friend-group app, the assets
worth protecting are the *server* (never distributed publicly — it lives only
on the host) and any credentials (none ship). The client binary being
studyable is a normal, acceptable property of desktop software.

---

## 4. Mobile (Android / iPhone / iPad) — what it takes

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
