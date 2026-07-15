# Architecture

## Context & goals

Private, self-hosted group voice/video for 7–10 friends. Hard requirements:
no port forwarding, no accounts/cloud, cross-platform desktop, quality
knobs the crew actually controls (presets, codecs, bitrates), and honest
bandwidth guidance. Non-goals for v0.1: text chat, file sharing, public
internet exposure, federation.

## High-level design

```
                         Tailscale tailnet (WireGuard mesh)
   ┌─────────────┐        100.x.y.z addresses, E2E encrypted
   │  Client A   │◄──────────────────────────────────────────┐
   │  (Electron) │                                           │
   └──────┬──────┘        ┌──────────────────────────────┐   │
          │  socket.io    │        HOST machine          │   │
          ├──────────────►│  Node.js                     │   │
          │  (signaling,  │  ├─ express      :4443/tcp   │   │
          │   :4443/tcp)  │  │   /health /info /speedtest│   │
          │               │  ├─ socket.io    :4443/tcp   │   │
          │  SRTP media   │  │   rooms, peers, producers │   │
          └──────────────►│  └─ mediasoup SFU            │◄──┘
                          │      WebRtcServer :44444     │  Clients B..J
                          │      1 worker, router/channel│
                          └──────────────────────────────┘
```

**SFU topology:** every participant uploads each of their streams once; the
host fans them out. This is what makes 7–10-person video possible on
residential upload (a full mesh would cost each sharer `(N−1) ×` their
bitrate). The corollary — host upload is the shared ceiling — is surfaced
to users by the recommendation engine (`docs/STREAM_SETTINGS.md`).

## Components

**Server** (`server/src/`)
- `config.js` — env config; announced-address autodetect that prefers the
  Tailscale CGNAT range (100.64.0.0/10), falls back to LAN.
- `soup.js` — one mediasoup worker, one `WebRtcServer` (so *all* media for
  every peer shares a single UDP/TCP port: 44444), one router per channel.
- `room.js` — Room/Peer registries and the full signaling protocol
  (documented at the top of the file); per-room `AudioLevelObserver`
  drives dominant-speaker events.
- `index.js` — express endpoints (health/info + speed test:
  streamed download, counted upload, crew report board) and boot.

**Client** (`client/`)
- `electron/main.js` — window; screen-share source plumbing
  (`desktopCapturer` + `setDisplayMediaRequestHandler`, PipeWire portal on
  Wayland via `WebRTCPipeWireCapturer`); global push-to-talk via
  `uiohook-napi` (keyboard **and** mouse buttons, works unfocused) with a
  focused-window fallback when the hook can't load.
- `electron/preload.js` — minimal `contextBridge` surface (`window.hearth`).
- `src/rtc.js` — mediasoup-client wrapper: transports, produce (with codec
  forcing + `contentHint`), consume, per-consumer RTP stats.
- `src/audio.js` — devices, constraint building (EC/NS/AGC/music-stereo),
  RMS meter, VAD gate, `setSinkId` routing.
- `src/speedtest.js`, `src/recommend.js`, `src/presets.js` — measurement
  and the budget model.
- `src/app.js` — UI state machine (connect → directory → channel → media).

## Media/signaling flow (join)

```
join(channel,name) ──► routerRtpCapabilities + existing peers/producers
device.load() ──► transport:create(send) ─► transport:connect (DTLS)
             └─► transport:create(recv) ─► transport:connect
produce(mic [, cam, screen]) ──► broadcast producer:new to room
for each remote producer: consume (created paused) ─► consumer:resume
AudioLevelObserver ──► 'speaker' broadcasts ──► ember ring in UI
```

Consumers start **paused** and resume only after the client has wired the
track to an element — the standard mediasoup pattern that avoids losing the
first keyframes.

## Key decisions & trade-offs

| Decision | Why | Trade-off accepted |
|---|---|---|
| Tailscale for connectivity | The only way to honor "share an IP, zero router config" against NAT physics; free tier fits a friend group | One-time install per person |
| SFU (mediasoup) over P2P mesh | Mesh upload cost is quadratic-ish; unusable at 8+ | Host upload becomes the ceiling (mitigated by the advisor) |
| One `WebRtcServer` port | One-line firewall story | Single worker; fine for ≤~20 peers, shard workers beyond |
| Plain HTTP/WS inside the tailnet | WireGuard already encrypts + authenticates the path | Server must never be exposed publicly (documented) |
| Electron client | Global PTT, native screen pickers, one codebase ×3 OS | ~100 MB installers |
| `uiohook-napi` for PTT | Electron's `globalShortcut` has no key-up event, so real hold-to-talk is impossible with it | Native module (prebuilds ship for all 3 OSes; graceful fallback wired) |
| Client-side quality caps (`maxBitrate` per preset) | User agency; matches Discord mental model | A modified client could exceed them — acceptable in a friends-only trust model (server still caps at 30 Mbps) |
| No auth/accounts | Tailnet membership *is* the access control | Anyone on the tailnet can join; that's the invited crew by construction |

## Engineering standards

- **Language level:** Node 22+ / ES2022; renderer bundled by esbuild
  targeting Chromium ≥130 (Electron 43).
- **Style:** 2-space indent, single quotes, semicolons; `const` by default.
  Modules stay under ~450 lines; one responsibility per file.
- **Electron security posture:** `contextIsolation: true`,
  `nodeIntegration: false`, narrow preload API, CSP in the renderer HTML.
- **Error handling:** every signaling handler is wrapped (`guarded()`),
  returning `{error}` acks instead of crashing the socket; media-device
  failures degrade to listen-only with a visible explanation.
- **Dependencies:** pinned with caret ranges; versions verified against the
  npm registry on 2026-07-12 (mediasoup/mediasoup-client 3.21.0,
  socket.io 4.8.3, electron 43.1.0, uiohook-napi 1.5.5,
  esbuild 0.28.1, electron-builder 26.15.3). Re-verify before upgrading.
- **Docs:** requirements in `SRS.md`, verification in `TEST_PLAN.md`; both
  updated in the same change as the behavior they describe.

## Known limits / roadmap

Simulcast/SVC layers (per-viewer quality adaptation), Linux/macOS system-
audio capture, host-side admin (kick/rename channels live), Opus bitrate
slider, TURN-less operation is inherent (no TURN needed — the tailnet is
the transport). Single worker by design; shard routers across workers with
per-worker `WebRtcServer` ports if the crew ever outgrows it.

---

## v0.2 — identity, permissions, and text chat

### Identity: device tokens, no passwords

Each install generates a random token once (`localStorage`) and presents it in
the socket.io auth handshake. The server stores only the SHA-256 of the token;
an unknown hash creates a new user, a known one logs the same person back in.
There is nothing to phish and nothing to reset — lose the token, you're simply
a new person (an Admin can re-role you).

**Owner claim:** first boot writes a random claim code into the database and
prints it in the server console until someone enters it under
Settings → Server. The owner bypasses all permission checks and is immune to
mute/kick.

### Permission model

Bitfield permissions, resolved with the same algorithm Discord documents:

```
base   = OR(@everyone, …user's roles)          ADMINISTRATOR or owner ⇒ all
channel = base
        → apply @everyone overwrite   (deny stripped, then allow added)
        → apply role overwrites       (ORed denies stripped, ORed allows added)
        → apply member overwrite      (deny stripped, then allow added)
```

One deliberate deviation: `CREATE_CHANNELS` is split out of
`MANAGE_CHANNELS` (Discord bundles them), so the shipped default —
`@everyone` = view/send/embed/create/connect/speak, `Admin` = administrator —
expresses *"everyone creates channels, Admins delete them."*

### Storage (SQLite via better-sqlite3, WAL)

```
users(id, name, token_hash, is_owner)        roles(id, name, color, position, permissions)
user_roles(user_id, role_id)                 channels(id, name, type, topic, position)
overwrites(channel_id, target_type, target_id, allow, deny)
messages(id ↑, channel_id, author_id, content, reply_to, created_at, edited_at)
reactions(message_id, user_id, emoji)        pins(message_id, channel_id, …)
message_links(message_id, url)               link_previews(url, ok, title, description, site_name)
read_state(user_id, channel_id, last_read_id)
messages_fts — FTS5 external-content index, kept in sync by triggers
```

**Rolling prune:** every 30 minutes (and at boot) the server checkpoints the
WAL, stats the file, and — if it exceeds `HEARTH_CHAT_CAP_MB` — deletes the
oldest messages in batches of 500 (pins included, by design) until back under
the cap, then reclaims pages with `incremental_vacuum`.

### Chat fan-out

Every authenticated socket is joined to a `text:<channelId>` room for each
text channel it can `VIEW_CHANNEL`; message/typing/reaction/pin events
broadcast to those rooms, so a deny overwrite genuinely hides traffic, not
just UI. Membership is re-synced whenever channels, roles, or overwrites
change. *Known edge:* a permission change re-evaluates room membership
immediately, but a client whose currently-open view was revoked only fully
refreshes on the next directory update it acts on.

**Directory model:** any channel/role/occupancy change broadcasts a
payload-free `dir:dirty`; each client re-requests `channels:list`, which is
computed per-user (hidden channels filtered, effective `myPerms` attached).

### Link previews (text-only)

On send, up to 3 URLs are extracted (only if the author has `EMBED_LINKS`).
Uncached URLs are fetched server-side — 5 s timeout, 512 KB read cap,
`text/html` only, private-range/localhost targets refused — parsed for
title/og tags, cached 7 days, and pushed to the channel as a ~1 KB card.
No images are stored or proxied, ever.

### Voice changes

Routers are now created lazily per voice channel (channels are dynamic).
`room:join` gates on `VIEW_CHANNEL + CONNECT`; producing a mic track gates on
`SPEAK` and not being moderator-muted. Moderator mute closes the live mic
producer server-side and survives until toggled off (state is in-memory —
a server restart clears it).

### Jukebox (v0.3)

One optional session per voice channel. The host resolves a link
(`yt-dlp -j`; Spotify/Pandora titles resolve via oEmbed/page metadata to a
`ytsearch1:` query), then pipes `yt-dlp -o - | ffmpeg -re … libopus 48k
stereo` as RTP into a mediasoup **PlainTransport** (`comedia`), producing a
normal audio producer. Clients therefore treat the jukebox as just another
peer — the rail row, speaking ring, per-listener volume, and deafen all work
with zero special cases. Queue/skip/pause are gated on `SPEAK` in that
channel; pause is SIGSTOP/SIGCONT (Linux/macOS hosts). The session tears
down when the queue drains or the last human leaves.

### GIFs, custom emojis, live storage (v0.4)

**GIF picker:** the server proxies search to Tenor / GIPHY / Imgur using
host-side API keys (never shipped to clients); a pick posts the CDN URL as a
normal message, which clients render inline only for the approved media-host
allowlist. Nothing is stored server-side.

**Custom emojis:** PNG / animated GIF / WebP uploads (≤512 KB, magic-byte
validated) live in `data/emoji/` behind an immutable-cache static route, with
a `MANAGE_EMOJIS` permission bit (1<<12). Messages carry plain `:name:`
tokens; clients render them (jumbo when the message is emoji-only). Reactions
store `ce:<id>` tokens next to unicode ones.

**Live storage settings:** chat / emoji / preview caps persist in the kv
table (env values are just defaults), editable by Administrators in
Settings → Server with live usage readouts; the prune loop and the emoji
upload gate read the current values every pass.

### Video quality, pop-out viewer, public hosting (v0.5)

**Ghosting fix:** viewers decode the *transmitted* stream (the sender renders
their own capture locally, which is why only viewers saw trailing artifacts).
The SFU now calls `consumer.requestKeyFrame()` on every video consumer resume,
and clients re-request a keyframe shortly after attaching a track and expose
`consumer:keyframe` for stall recovery. Screen producers declare
`scalabilityMode: L1T3` for an explicit temporal structure and set
`degradationPreference` (maintain-resolution for text, balanced for motion).

**Pop-out viewer:** a floating theater element (drag by title bar, resize from
the grip, fit-inside-stage, or native fullscreen); audio stays on the voice
path, the element is muted. It keys off `peer:tag` so it auto-closes when that
stream ends.

**Public hosting:** `HEARTH_ANNOUNCED_IP` already lets mediasoup advertise a
reachable public address, so a VPS deployment needs only that env var and two
open ports — no Tailscale required. Full guide in `DEPLOY_PUBLIC.md`.

**Jukebox robustness:** the queue advance is now serialized behind an
`advancing` flag with a per-pipeline token, eliminating a double-advance race
where a track ending while another was queued could silently drop one (the
"have to empty the queue to recover" bug).

**Share audio:** the system-audio toggle is enabled on all platforms and
honored via getDisplayMedia; on Linux, where Chromium/Wayland can't capture
desktop audio directly, the UI points to the PipeWire virtual-mic route rather
than silently producing no sound.

### Audio quality, monitoring, packaging, auto-update (v0.6)

**Voice bitrate:** Opus is already the crispest WebRTC codec; the lever is
bitrate. `HearthRTC.audioBitrate` (16k–510k) feeds every audio producer's
`opusMaxAverageBitrate` and encoding `maxBitrate`, kept identical across
producers on a transport to avoid the fmtp-collision class of bug. Changing
it live re-applies via `setParameters` and restarts the mic producer.

**Server monitor:** `monitor.js` samples CPU (os.cpus() deltas), memory,
disk (statfs on the data volume), and network throughput (/proc/net/dev
deltas on Linux). `server:stats` (admin-gated) returns that plus live media
counts from `room.liveStats()`; the client polls every 2s only while the
Server tab is open.

**Native packaging:** the desktop app builds AppImage + deb + **pacman**
(CachyOS/Arch) + exe + dmg. The server ships a PKGBUILD and an
`install-server.sh` that register a **systemd user service** (auto-start,
Restart=on-failure) and preserve `data/` across updates. Reinstalls wipe
program files first, so nothing stale remains.

**Auto-update (private repo):** both app and server read a read-only,
single-repo GitHub token (git-ignored, injected at build time) and poll the
Releases API. The app downloads the matching platform asset (AppImage
self-replaces; others hand off to the OS installer) and restarts; the server
reports availability and is updated by re-running its installer. No token →
feature silently disabled, app still works.

### Wayland screen-share fix (v0.6.2)

On Wayland every `desktopCapturer.getSources()` call raises the xdg-desktop
portal. The old two-step flow (enumerate to build an in-app picker, then
`getDisplayMedia`) therefore prompted the portal TWICE, and the mismatched
portal sessions aborted with `AbortError` after the user picked in both
dialogs. The fix makes the portal the sole picker on Wayland: the share
dialog shows no in-app source grid there (just quality/codec/audio), and
"Go live" fires a single `getDisplayMedia`, whose one portal prompt is the
picker. X11/Windows/macOS keep the in-app source list — their getSources()
doesn't prompt. Wayland is detected via WAYLAND_DISPLAY / XDG_SESSION_TYPE.

### Stream lag fix + focus mode (v0.6.3)

**The v0.5 L1T3 change made screen streams SVC**, so mediasoup's bandwidth
estimator chooses the forwarded temporal layer — and with a 1 Mbps initial
estimate it sat on T0 (quarter framerate: the "choppy/laggy" regression).
Fix: consumers now request the top temporal layer on creation
(`setPreferredLayers`, still congestion-degradable) and
`initialAvailableOutgoingBitrate` starts at 10 Mbps.

**Focus mode:** single-click a tile to watch one stream — it fills the stage,
other video tiles shrink to a strip and their consumers are **server-paused**
(zero packets, real bandwidth/decode savings) with a "paused" overlay; click
another to switch (resume + keyframe), click the focused tile to unfocus and
resume all. Double-click still pops out the theater. Audio never pauses.

**CI auto-update token:** the release workflow now writes
`client/build/update-token.txt` from the `HEARTH_UPDATE_TOKEN` repo secret,
so CI-built installers can actually check the private repo for updates
(previously only source-built clients could).

### Identity profile pin + member removal (v0.6.4)

Unpackaged Electron (`npm start`) and packaged builds default to different
userData dirs (package `name` vs `productName`), so the localStorage device
token — and therefore the member identity and any owner claim — silently
split between them. `main.js` now pins userData to one path ('Hearth') for
every launch mode. Administrators also get **member removal** (`member:remove`):
boots live sockets, deletes the user row + role/reaction/read-state
references, keeps their messages (ghost author), and can never target the
owner or yourself — the cleanup tool for duplicate identities.

### Audio-bitrate fmtp collision fix (v0.6.5)

Opus `maxaveragebitrate` is fixed at producer creation and cannot be
renegotiated. The v0.6 live-bitrate control patched `maxBitrate` via
setParameters but left the *fmtp* untouched, so an existing producer kept its
old bitrate while a newly-created one used the new value — two different fmtp
on PT 111 = a fatal BUNDLE collision that broke audio negotiation. Fix:
`setAudioBitrate` now REPLACES every audio producer (mic + screen-audio) as a
unit, closing each before creating its replacement so mismatched producers
never coexist; and `onAudioSettingsChanged` runs exactly one of
setAudioBitrate / startMic so the mic is never produced twice.

### Owner recovery from the host (v0.6.5)

Ownership binds to a client device token; if that token changes (reinstall
into a different profile, browser tab, data reset) the crown strands on the
old identity with no in-app way back — you'd be locked out. Fix: the server
operator can always reclaim from the box. `index.js --reclaim-owner` (wrapped
as the `hearth-reclaim-owner` command the package puts on PATH) clears the
owner flag, mints a fresh claim code, and re-opens claiming; enter the code in
Settings → Server to take ownership on your current identity. The v0.6.4
userData pin prevents most token churn going forward; this is the guaranteed
escape hatch when it still happens.

### Independent stream-audio volume (v0.6.6)

Screen-share audio (the `screen-audio` producer — game/desktop sound) shared
one volume key with the peer's mic, so a loud stream drowned their voice with
no separate control. Audio elements now carry `data-tag` (mic vs
screen-audio); `audioEls()` returns mic-only, `streamAudioEls()` the stream,
each keyed independently (`screen:<peerId>`). The right-click menu shows a
"🖥 Stream audio" slider whenever the peer shares screen audio — reachable
even if their mic is muted. Client PKGBUILD icon extraction is now non-fatal
(guarded), fixing the makepkg 'cannot stat hearth.png' abort.

### Hardware-encode reality on Linux/NVIDIA (v0.6.8)

Chromium's Linux hardware video *encode* goes through VA-API, and on NVIDIA
the nvidia-vaapi-driver is decode-only — so NVENC is NOT exposed to
Chromium's WebRTC encoder. This is the architectural reason browser-WebRTC
screen share is software-encoded (and CPU-bound / laggy at 4K) while
Sunshine/Moonlight are smooth: they call NVENC directly via the NVIDIA SDK,
bypassing VA-API. No Electron flag changes this. v0.6.8 adds the fuller
VA-API + WebRtcHW264Encoding flag set for the best chance of a hardware path
(H.264 is the codec most likely to reach one on NVIDIA), and the stats
overlay already reports the live encoder as hw:/sw: so you can verify. If it
reads sw: on NVIDIA, the realistic mitigation is VP8 + lower res/fps to make
software encode keep up, or accept the constraint and use Sunshine for
game-grade streaming.

### Discord-style notifications + stream PiP (v0.7.0)

**Notifications:** WebAudio-synthesized sounds (no assets) for hall
join/leave, "went live" (with toast), and "X is watching your stream" — the
last driven by a new `stream:viewer` event the server emits to the producing
peer on the FIRST resume of each screen consumer (focus-mode pause/resume
reuses consumers, so no repeat spam). The @mention ping now routes through the
same system. Settings → Notifications has per-event toggles plus a master
switch; defaults all on, persisted in settings.

**Picture-in-picture:** switching to a text channel while a stream is live
shrinks it to a draggable mini-window over chat (`#pip`), mirroring the
focused (else first) screen tile's MediaStream — muted, since audio already
flows through the audio sink. Click returns to the stage focused on that
stream; ✕ dismisses until the stream changes; it follows stream start/stop
while you read.

### Self-state mirror fix (v0.7.1)

The server relays `peer:state` with `socket.to(room)`, which excludes the
sender — so a client's OWN rail badges (🖥 stream, 🔇 mute, ⛔ deafen) rendered
from a stale local cache and could linger after the state changed (e.g. the
stream icon surviving a share stop). `broadcastState` now mirrors the snapshot
into the sender's own cached peer entry and refreshes the rail immediately;
self-state never depends on a round trip that doesn't include you.

### Chat media embeds + 5 GB chat cap (v0.8.0)

A message that is a single bare https URL now embeds: images
(gif/png/jpg/webp/avif) render inline lazily; video files (mp4/webm/mov) get a
real `<video controls preload="metadata">` player (fixing the old
broken-image rendering of mp4 links, which the picker-CDN allowlist funneled
into an `<img>`); YouTube links render as a lite embed — one thumbnail jpg,
and the youtube-nocookie player only loads on click. Dead media degrades to a
plain link via error handlers. All embeds are DOM-constructed (no innerHTML)
and the CSP was widened deliberately: `img-src https:`, `media-src https:`,
`frame-src youtube-nocookie.com` only.

Memory posture: nothing new is cached in RAM by Hearth — link-preview cards
stay in the SQLite `link_previews` table (own cap), images are lazy-loaded,
video preloads metadata only, and YouTube loads nothing until clicked.
Chromium's transient decode buffers remain Chromium's own.

The chat storage default rose 1 GB → **5 GB** (`HEARTH_CHAT_CAP_MB=5120`),
still rolling-prune-oldest at the cap. Existing servers keep their stored
setting — raise it in Settings → Server → storage caps.

### Full-window layout + UI tightening (v0.8.1)

The root layout used `height: 100vh`, and Chromium's vh units can go stale
after resizes under Wayland fractional scaling — leaving a dead zone below
the composer that grew as the window did. The chain is now `height: 100%`
end-to-end (html → body → .screen), which tracks reflow reliably, with
`overflow: hidden` on body so nothing scrolls the shell itself. The window
also persists its size/position/maximized state (`window-state.json` in
userData) and reopens exactly as left. Spacing pass: slimmer bottom control
bar, 232px rail, tighter message rhythm and composer padding — less chrome,
same theme.

### Public distribution + shipped-code hardening (v0.8.2)

Installers now mirror to a PUBLIC installers-only repo
(`hearth-releases`) on every tagged release (CI step, gated on the
`HEARTH_PUBLIC_RELEASE_TOKEN` secret) — anyone can download without repo
access, and both updaters check that public feed FIRST with no token,
falling back to private+token only if it's absent. Once the public repo has
a release, installers ship zero credentials. Hardening: the renderer bundle
previously embedded an inline sourcemap — the complete original source, 84%
of the bundle — now stripped; output is minified (2.3 MB → ~369 KB) with
asar pinned explicitly. DIAGRAMS.md fix: mermaid dotted-edge labels
containing dots (`-.Socket.IO signaling.->`) collide with the `-. .->` 
delimiters; converted to pipe-label form and all 10 diagrams validated
against mermaid 11.16.0.

### Public server distribution + deeper client hardening (v0.9.0)

**Server now ships publicly:** a `Server Release` workflow packages a portable
`hearth-server-<ver>.tar.gz` (server src + lockfile + one-command installers
for Linux/Windows/Docker + a beginner README) and publishes it to the public
`hearth-releases` repo on every tag — anyone can host without private-repo
access. `install/server/` holds `install.sh` (Linux, sets up a systemd user
service), `install-windows.ps1`, `Dockerfile`, and `docker-compose.yml`.
`npm install` on the target compiles the native modules (better-sqlite3,
mediasoup) for that machine.

**Client hardening deepened:** Electron fuses now disable `RUN_AS_NODE`, block
`NODE_OPTIONS` injection and `--inspect` debugging of the packaged app, and
enforce asar integrity (`onlyLoadAppFromAsar` + embedded validation — the
archive can't be edited or swapped). Renderer minification strengthened
(identifier/property mangling, `debugger` dropped, debug console stripped) so
function names like `broadcastState` no longer appear in the bundle. Honest
ceiling documented: no code running on a user's machine is truly unbreakable;
the protections that matter (private source, zero shipped credentials,
integrity-locked dense machine code) are in place.

**Kid-level docs:** `docs/SIMPLE_SETUP.md` — plain-language, emoji-signposted
install for the app and all three server hosting styles, written for a total
beginner; surfaced at the top of the docs index and shipped inside the server
tarball as its README.

### AppImage update loop fix + launch version check (v0.9.1)

**The update loop, root-caused:** `installUpdate` replaced the running AppImage
with `copyFileSync`, but Linux refuses to write a file that is currently
executing (**ETXTBSY**, "text file busy"). The error was swallowed by a bare
`catch`, so it fell through to launching the freshly-downloaded /tmp copy —
the user saw the new version *that session*, while the file on disk stayed
old. Every menu launch then ran the stale build and offered the same update
again, forever. Fix: stage the new AppImage beside the target (same
filesystem), sanity-check its size, then `renameSync` over the target —
rename swaps the directory entry atomically and is legal while the old inode
executes.

**Compounding cause:** the menu entry pointed at a *versioned* filename
(`Hearth-0.6.5.AppImage`), so even a working update elsewhere could never be
picked up. `install/client/install-linux.sh` now installs to one stable path
(`~/Applications/Hearth.AppImage`), points the `.desktop` there, purges stale
AppImages and menu entries, and leaves `~/.config/Hearth` (identity/settings)
alone. It ships as a release asset in both repos.

**Launch version check:** ~4s after the window opens (never blocking startup),
the app checks the public feed and, if something newer exists, shows a native
dialog — *Update now* (downloads, installs, relaunches) or *Not now* (carry on;
update later from Settings). The dialog warns that staying on an old version
might prevent joining the host, since app and server must speak the same
protocol. Silent on any failure — offline must never block the app.

### Server-release workflow gate fix (v0.9.2)

The Server Release workflow gated its job with
`if: ${{ secrets.HEARTH_PUBLIC_RELEASE_TOKEN != '' }}`. The `secrets` context
is **not available in a job-level `if`** (GitHub allows only github/needs/vars/
inputs there), so the expression is a parse error and the workflow never ran —
no server tarball was ever published. Fixed by mapping the secret to a
workflow-level `env` and gating the publish STEP instead (`if:
env.PUBLIC_RELEASE_TOKEN != ''`), the same pattern release.yml already proves.
Note `env` is likewise unavailable in job-level `if` — step-level gating is the
only correct place.

### CRLF corruption of shipped shell scripts (v0.9.2)

`install-linux.sh` shipped with CRLF endings and died on first run with
`set: pipefail: invalid option name`. Cause: the release workflow is a matrix
(ubuntu/windows/macos) and every runner executed the upload step — GitHub's
**Windows runner checks out with `autocrlf=true`**, rewriting the LF script to
CRLF, and its upload overwrote the Linux one (95 lines → 95 extra bytes, an
exact tell). Two fixes: a `.gitattributes` pinning `*.sh` (plus Dockerfile/yml)
to `eol=lf` and `*.ps1` to `eol=crlf` so no checkout can rewrite them, and the
release workflow now uploads the shell script from the ubuntu runner only.

Note (v0.9.3): the CRLF fix is `.gitattributes` alone — pinning `*.sh` to
`eol=lf` makes EVERY checkout (including GitHub's Windows runner, which
defaults to autocrlf=true) produce LF, so the matrix upload is harmless and
release.yml needs no conditional.
