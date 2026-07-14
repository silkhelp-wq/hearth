# Test Plan — Hearth v0.1

*Structured after ISO/IEC/IEEE 29119-3 (tailored). Traceability targets are
the FR/NFR numbers in `SRS.md`.*

## 1. Strategy

Real-time media across three OSes is dominated by integration behavior, so
the pyramid here is deliberately top-heavy — with automation where it pays:

```
        /  System / E2E (manual, cross-OS)  \   ← the product truth
       /  Integration (server smoke, HTTP)   \
      /  Unit (pure modules: recommend, presets)\
```

- **Unit (automated, future CI):** `recommend.js` budget math and
  `presets.js` integrity are pure functions — the highest-value automation
  targets. Example assertions included in §4.
- **Integration (automated today):** `npm run selftest` boots the real
  mediasoup worker/WebRtcServer/routers; HTTP smoke covers
  `/health`, `/info`, `/speedtest/*`. Both are release gates.
- **System (manual):** the TC matrix below, run on a real tailnet.

**Coverage focus:** join/leave lifecycle, media correctness per preset ×
codec, audio gating (VAD/PTT/mute/deafen), bandwidth advisor accuracy,
reconnection, and the three OS-specific share paths. Skipped by design:
UI pixel tests, load beyond 12 users, adversarial/security testing (out of
scope per SRS §2).

## 2. Environments

| Role | Required configurations |
|---|---|
| Host | Linux x64 (primary; Arch/CachyOS and Ubuntu 24.04), Node 22 |
| Clients | Linux Wayland (KDE), Linux X11, Windows 11, macOS 14+ |
| Network | Real tailnet with ≥1 remote (non-LAN) participant; one deliberately relayed (DERP) peer if available |
| Tooling | In-app stats overlay; `journalctl`/console logs; a second stopwatch human for latency spot-checks |

Entry criteria: `npm run selftest` passes on host; client `npm run build`
clean. Exit criteria: all **P0** pass on every client OS; P1 failures
triaged with issues filed.

## 3. System test cases

Severity: **P0** = release-blocking, **P1** = should-fix.

| ID&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | Pri | Traces&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | Steps | Expected |
|---|---|---|---|---|
| TC-01 | P0 | NFR-3 | Install & launch client on each OS (source and packaged) | App opens to connect screen; mic permission prompt on first join |
| TC-02 | P0 | FR-1/2, NFR-5 | Fresh friend follows CONNECTION_GUIDE end-to-end | Connected in ≤10 min; console shows `linked · <ms>` |
| TC-03 | P0 | FR-5/6 | Two clients join same channel; speak alternately | Two-way audio; ember ring follows the actual speaker within ~0.5 s; occupancy correct in rail |
| TC-04 | P0 | FR-7 | Mid-call, switch mic; switch output device | New mic heard remotely without rejoin; already-playing audio moves to new output |
| TC-05 | P0 | FR-9/10 | Bind PTT to a key and to Mouse4; test with app unfocused (game running) | Transmits only while held, both binds, unfocused included; fallback message if hook unavailable |
| TC-06 | P0 | FR-9 | Set VAD threshold just above room noise; whisper vs. talk | Whisper below threshold not transmitted; speech opens gate instantly; ~0.5 s hang, no word clipping |
| TC-07 | P0 | FR-11 | Mute; Deafen; per-person volume slider | Mute stops TX (flag visible to others); Deafen silences RX+TX; slider changes only that person locally |
| TC-08 | P0 | FR-12/13/14/15 | Share screen at 720p60 and 1080p30; force each codec incl. AV1; watch stats overlay on a viewer | Received codec/resolution/fps match selection (±1 fps tolerance); bitrate ≈ preset target under motion |
| TC-09 | P0 | FR-18 | Run speed test on a client whose line rate is known (router/ISP figure) | Up/down within ±20% of known figure; ping plausible for path |
| TC-10 | P0 | FR-20/21 | Enter host-up 50, people 8, sharers 1 → Recommend → Apply | Verdict = 1080p30, budget ≈ 5.0 Mbps, "limited by host relay capacity"; Apply sets the preset (matches STREAM_SETTINGS worked example) |
| TC-11 | P0 | NFR-1/2 | 10 users, 60 min: continuous voice + 2 concurrent 720p60 streams | No crash; no cumulative desync; host CPU (one core) < 80%; audio latency subjectively conversational |
| TC-12 | P0 | FR-4, NFR-6 | Drop a client's network 15 s; separately restart the server mid-call | Banner shows; on recovery client auto-rejoins same channel; media resumes ≤10 s after path/server return |
| TC-13 | P0 | FR-16 | Windows: share game window with "system audio" checked | Viewers hear game audio in sync (<200 ms AV skew); sharer's mic path unaffected |
| TC-14 | P0 | FR-12 | Linux **Wayland/KDE**: start a screen share | PipeWire portal appears; chosen screen/window streams; no black frames |
| TC-15 | P1 | FR-17 | End share via OS "stop sharing" control (not the app button) | Producer closes; tile disappears for all; Share button resets |
| TC-16 | P1 | FR-8 | Music mode on; play an instrument/music through the selected input | Stereo received; no NS pumping/AGC squash vs. music mode off |
| TC-17 | P1 | FR-13 | "Source" preset on a 4K/120 desktop | Native resolution flows; sender throttled ≤30 Mbps (server cap), stats confirm |
| TC-18 | P1 | FR-19 | Three users run the speed test; open crew table | All three rows visible with fresh timestamps on every client |
| TC-19 | P1 | FR-5 | Channel-hop rapidly (5 hops in 30 s) | No orphan tiles/audio; occupancy correct everywhere; server logs no handler errors |
| TC-20 | P1 | FR-3 | Host firewall: allow only 4443/tcp + 44444/udp+tcp on tailscale0 | Full functionality (proves single-port media claim) |

## 4. Unit assertions (automation backlog)

```js
// recommend.js — worked example from STREAM_SETTINGS.md
recommend({ clientUpMbps: 100, hostUpMbps: 50, people: 8, sharers: 1 })
  → best.id === '1080p30', limitedBy === 'host relay capacity',
    perStreamKbps ≈ 5037 (±1)

recommend({ clientUpMbps: 3, hostUpMbps: 0, people: 8, sharers: 1 })
  → limitedBy === 'your upload', best.id === '480p30', hostUnknown === true

// presets.js — table integrity
SCREEN_PRESETS strictly ascending in kbps (excluding 'source');
every preset id unique; OPUS_KBPS === 40
```

## 5. Reporting

Record per run: date, host commit, OS matrix, per-TC pass/fail, stats-
overlay screenshots for TC-08, and host `journalctl -u hearth-server`
extract for any failure. File issues with TC ID in the title.

---

## v0.2 test cases — identity, permissions, chat

| ID | Case | Steps | Expected |
|---|---|---|---|
| TC-21 | P1 | Owner claim | Boot fresh server; enter console code in Settings → Server | Claimer becomes owner (★); code stops printing; wrong code rejected |
| TC-22 | P1 | Default create/delete split | As a fresh (roleless) user: create a text channel; try to delete any channel | Create succeeds; delete button absent / request refused |
| TC-23 | P1 | Admin delete | Owner assigns Admin role; Admin deletes a channel | Channel and its messages disappear for everyone live |
| TC-24 | P1 | View overwrite hides | Deny `view` for `@everyone` on a channel; check second client | Channel vanishes from rail; its events stop arriving; member-allow for one user brings it back for them only |
| TC-25 | P1 | Speak gating | Deny `speak` on a voice hall for a role; member joins | Join succeeds listen-only; mic produce refused with message |
| TC-26 | P1 | Moderator mute/kick | Admin mutes then kicks a member in voice | Target's mic drops instantly + 🔕 flag; unmute restores; kick disconnects with attribution; owner immune |
| TC-27 | P1 | Chat E2E | Send, reply, edit, delete, pin, react from two clients | All render live on both; (edited) flag; delete removes; reply jump works |
| TC-28 | P1 | Mentions & unread | Mention a user viewing another channel | Ping sound + ember badge count; opening channel clears; plain messages show dot only |
| TC-29 | P1 | Search | Post a distinctive phrase; search it in-channel | Result row jumps to the message with flash highlight |
| TC-30 | P1 | Link preview | Send a public https URL | Text-only card (site/title/description) appears within seconds; `http://192.168.…` never unfurls |
| TC-31 | P1 | Rolling prune | Set `HEARTH_CHAT_CAP_MB=1`, spam messages, wait for prune (or reboot) | Oldest messages removed until under cap; server log line; newest retained |
| TC-32 | P1 | Old client rejected | Connect with a v0.1 build | Clear "requires Hearth v0.2+" error on the connect screen |
| TC-33 | P1 | Markdown safety | Send `<img onerror=…>` and a fenced code block | Renders as escaped text / code; no HTML executes |
| TC-34 | P1 | Jukebox E2E | Two clients in a hall; paste a YouTube link | Both hear the same audio in sync; 🎵 Jukebox row appears; skip advances; queue lists pending tracks |
| TC-35 | P1 | Link resolution | Paste a Spotify track link | Title resolves, YouTube match plays, now-playing shows "via spotify→youtube"; garbage input errors cleanly |
| TC-36 | P1 | Member menu | Right-click a peer and the jukebox | Volume slider changes only local playback; mute-for-me toggles; server mute/kick present only with perms; owner shows neither |
| TC-37 | P1 | GIF flow | Set a Tenor key, search, click a GIF | Posts inline for everyone; provider tabs match configured keys; no keys → GIF button absent |
| TC-38 | P1 | Custom emoji | Upload an animated GIF as :party:, type :par → autocomplete, react with it | Animates inline and jumbo when alone; reaction chip shows the image; non-managers see no upload UI |
| TC-39 | P1 | Emoji cap | Set emoji cap to 4 MB, upload past it | Upload refused with a clear message until cap raised or emojis deleted |
| TC-40 | P1 | Live caps | Change chat cap as admin, save | Usage readout refreshes; prune honors new value without restart; non-admins see no Storage section |
| TC-41 | P1 | Stream clarity | Watch a fast-motion share as a second user | No trailing/ghosting after the initial keyframe; sender unaffected |
| TC-42 | P1 | Pop-out viewer | Click a stream's ⛶, drag it, resize, fit, fullscreen | Floats and moves; fit snaps inside the stage; fullscreen fills the display; closes when the share stops |
| TC-43 | P1 | Jukebox queue | Queue 3 tracks back-to-back, let them play through | Each advances automatically; none dropped; skip mid-track advances cleanly |
| TC-44 | P1 | Public host | Set HEARTH_ANNOUNCED_IP to a public IP, open ports, connect off-tailnet | Voice/video/screen all connect with no Tailscale |
| TC-45 | P1 | Voice bitrate | Set quality to 24 kbps then 510 kbps mid-call | Audio audibly changes; no codec-collision errors; setting persists |
| TC-46 | P1 | Server monitor | Open Settings → Server as owner | CPU/mem/disk/net update live every 2s; live counts match reality; non-admins never see it |
| TC-47 | P1 | Service install | Run install-server.sh, reboot | Server auto-starts with no terminal; data survives; --uninstall keeps a data backup |
| TC-48 | P1 | Native package | makepkg -si on CachyOS, enable the user service | Installs to /opt, runs as service, data in ~/.local/share/hearth |
| TC-49 | P1 | Auto-update | With a token set, publish a newer release, open Settings | App shows update available; Update now downloads+installs+restarts; reinstall leaves no stale files |
| TC-50 | P1 | Smooth streams | Two 60fps streams, watch as a third | Full framerate within ~2s of joining; no quarter-rate choppiness |
| TC-51 | P1 | Focus mode | Click one of two streams | It fills the stage; other shows "paused" and stops consuming; click other to switch; click focused to restore grid |
| TC-52 | P1 | CI auto-update | Set HEARTH_UPDATE_TOKEN secret, release, run older installed build | Settings shows "update available"; Update now installs and restarts |
| TC-53 | P1 | One identity | Run via npm start AND the installed build | Same member both ways; no duplicate user; owner claim holds |
| TC-54 | P1 | Member removal | Admin removes a duplicate member | They vanish from the roster, live sessions boot, messages remain; owner and self are refused |
| TC-55 | P1 | Live bitrate change | In a voice call, change quality 128k→510k→48k | Audio keeps working each time; no "codec collision"/BUNDLE errors; bitrate audibly changes |
| TC-56 | P1 | Owner reclaim | Run hearth-reclaim-owner on the host, enter the code in-app | Current identity becomes ★ owner; old owner row loses the crown; works regardless of prior token state |
| TC-57 | P1 | Stream audio volume | Peer shares a loud game; right-click them | A separate "Stream audio" slider lowers only the game sound, not their voice; present even if their mic is muted |
| TC-58 | P1 | Mute/deafen feedback | Click the mic/headphone buttons by your name | Button turns solid red + glow, icon switches to 🔇/🔴; muting actually gates the mic (was working before, just invisible on the dark theme) |
| TC-59 | P1 | Encoder check | Enable the 'stats' toggle during a screen share; try H.264 then VP8 | Overlay shows codec + hw:/sw: encoder; identify which (if any) codec reaches a hardware encoder on this GPU; if all sw:, lower preset to VP8 720p/30 to stop lag |
| TC-60 | P1 | Join/leave sounds | Second client joins then leaves your hall | Rising blip on join, falling on leave; nothing for your own join; toggles in Settings → Notifications silence each |
| TC-61 | P1 | Go-live notify | Peer starts a screen share | Fanfare + "X went live" toast; off when its toggle or the master switch is off |
| TC-62 | P1 | Viewer notify | Second client focuses/watches your stream | You get one "X is watching your stream" toast+sound; focus-switching back and forth does NOT repeat it |
| TC-63 | P1 | Master switch | Untick "Enable all notifications" | Every sound/toast stops incl. mention ping; per-event boxes grey out; re-tick restores prior per-event choices |
| TC-64 | P1 | Stream PiP | While a peer streams, click a text channel | Stream shrinks to a draggable mini-window over chat; click returns to the stage focused on it; ✕ hides it until the stream changes; ends when the stream stops |
| TC-65 | P1 | Self badge sync | Start/stop a share; mute/unmute; deafen | Your OWN rail badges (🖥/🔇/⛔) change instantly on every toggle — no lingering stream icon after Stop |
| TC-66 | P1 | Image embeds | Paste a bare https .gif and .png URL as messages | Each renders inline (lazy-loaded), click opens original; a dead link degrades to a plain link, never a broken-image icon |
| TC-67 | P1 | Video embeds | Paste a bare .mp4/.webm URL | Inline video player with controls; only metadata preloads until you press play; dead link degrades to a plain link |
| TC-68 | P1 | YouTube lite embed | Paste a youtube.com/watch and a youtu.be link | Thumbnail + ▶ renders (one jpg fetched); click swaps in the nocookie player and plays; nothing else loads before the click |
| TC-69 | P1 | 5 GB chat cap | Fresh install; check Settings → Server storage caps | Chat history default reads 5120 MB; prune-oldest still enforces the cap |
