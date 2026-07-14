# Hearth — Streaming Internals

> **Audience:** engineers working on media · **Prerequisites:** WebRTC, codecs · **Time:** 15-minute read · **Applies to:** v0.6.x

Everything about how media moves through Hearth: the SFU model, codecs,
bitrate, the temporal-layer subtleties that caused (and fixed) lag, and the
hard truth about hardware encoding on Linux/NVIDIA. This is the doc to read
before touching anything in `rtc.js`, `soup.js`, `room.js`, or the Chromium
flags in `main.js`.

---

## 1. The SFU model

Hearth uses a **Selective Forwarding Unit**, not a mesh and not an MCU:

- **Mesh (peer-to-peer):** every sharer sends their stream to every other
  participant. Upload cost per sharer = `(N−1) × bitrate`. Dies on residential
  upload past ~3 people.
- **MCU (mixing):** the server decodes, composites, and re-encodes everything.
  CPU-brutal and adds latency; overkill for a small group.
- **SFU (Hearth):** every participant uploads each stream **once**; the server
  **forwards** (doesn't re-encode) copies to everyone else. Upload cost per
  sharer = `1 × bitrate`. The server's *download* is cheap; its **upload** is
  the shared ceiling, because it sends N−1 copies of every stream.

**The corollary that drives the whole UX:** host upload bandwidth is the
constraint. This is why Hearth has a speed test and a recommendation engine
(`docs/STREAM_SETTINGS.md`) — it turns the crew's real numbers into the highest
preset the host can actually relay.

mediasoup topology: one **worker**, one **WebRtcServer** (all media on port
44444), one **router per channel**. Each producer is consumed by every other
peer in the channel.

---

## 2. Codecs

The codec list (`presets.js`): `auto`, `av1`, `vp9`, `h264`, `vp8`. Users pick
in the share dialog; `auto` lets mediasoup negotiate.

**Tradeoffs:**

| Codec | Compression | Encode cost (software) | HW encode on NVIDIA/Linux (browser) |
|-------|-------------|------------------------|--------------------------------------|
| AV1 | Best | Very high | No |
| VP9 | Great | High | No |
| H.264 | Good | Moderate | **Most likely** path, if any |
| VP8 | OK | **Low** | No |

The practical implication: on a machine that can't hardware-encode (see §5),
**VP8 is the lightest software encode by far.** AV1/VP9 software encoding at 4K
will saturate even a strong CPU. This is the lever when hardware encode isn't
available.

---

## 3. Bitrate & the opus fmtp constraint

Video bitrate is governed by the preset and mediasoup's bandwidth estimator.

Audio (opus) bitrate is adjustable (24k–510k) — but with a **sharp
constraint that caused a real bug:** opus `maxaveragebitrate` is baked into the
producer's fmtp **at creation** and **cannot be renegotiated**. Two audio
producers on the same transport with different `maxaveragebitrate` on the same
payload type (PT 111) is a fatal BUNDLE collision that kills negotiation.

**The fix (v0.6.5):** changing the bitrate doesn't patch live parameters — it
**recreates every audio producer** (mic + screen-audio) as a unit, closing each
before creating its replacement so mismatched producers never coexist. The
settings handler runs exactly one of "recreate for bitrate" vs. "recreate for
device/EC/NS/AGC change," so the mic is never produced twice.

**Lesson for future audio work:** anything that changes an opus SDP parameter
must recreate producers, not renegotiate them.

---

## 4. Temporal layers and the lag saga

This is the subtle one, and it's worth understanding because the symptom
("choppy/laggy stream") is not obviously an encoder-layer problem.

**What happened:** an early ghosting fix added `scalabilityMode: L1T3` to screen
producers. L1T3 means one spatial layer, **three temporal layers** — i.e., the
stream becomes **SVC** (scalable video coding). With SVC, mediasoup's bandwidth
estimator chooses *which temporal layer to forward*. The initial available
outgoing bitrate estimate was **1 Mbps**. For a 25 Mbps game stream, the
estimator concluded it could only afford **temporal layer 0** — which is a
**quarter of the frames** (e.g., 60fps → 15fps). Result: a sharp but
stuttering stream. Worse than before, because before L1T3 there were no layers
to starve.

**The fix (v0.6.3):**
1. Every video consumer requests the **top temporal layer** on creation
   (`setPreferredLayers({ spatialLayer: 0, temporalLayer: 2 })`). mediasoup
   still degrades gracefully under *real* congestion — that's the whole benefit
   of keeping L1T3 — but it starts at full framerate.
2. `initialAvailableOutgoingBitrate` raised from 1 Mbps to **10 Mbps** so the
   estimator doesn't start in a hole.

**Lesson:** enabling SVC changes who decides framerate. If you add scalability
modes, you must also manage consumer layer preferences and the initial BWE, or
you get silent framerate starvation.

---

## 5. Hardware encoding on Linux/NVIDIA — the hard truth

**Summary: NVENC is not available to Hearth's screen-share encoder on
Linux/NVIDIA, and no flag changes that. It is an architectural limitation of
Chromium, not a Hearth bug.**

The chain of facts:

1. Chromium's Linux hardware video **encode** path goes through **VA-API**.
2. On NVIDIA GPUs, VA-API is only available via the `nvidia-vaapi-driver`
   translation shim.
3. That driver is **decode-only** — it does not implement encode.
4. Therefore Chromium (and thus Electron, and thus Hearth's WebRTC) **cannot
   reach NVENC for encoding** on NVIDIA/Linux.

This is precisely why **Sunshine/Moonlight are smooth 4K** and browser-WebRTC
screen share is not: Sunshine calls **NVENC directly through NVIDIA's Video
Codec SDK**, bypassing VA-API and the browser stack entirely. Hearth, being a
Chromium app, has no equivalent path.

**What Hearth does about it:**

- **Flags (best effort):** `main.js` enables the fullest reasonable VA-API +
  H.264 hardware-encode flag set (`AcceleratedVideoEncoder`, `VaapiVideoEncoder`,
  `VaapiVideoDecoder`, `WebRtcHW264Encoding`, `WebRtcAV1HWEncode`). On non-NVIDIA
  hardware (Intel/AMD with working VA-API encode), these can actually engage. On
  NVIDIA they mostly don't — but H.264 is the one codec with *any* chance, so
  it's worth forcing and checking.
- **Diagnostics (the important part):** the stats overlay reports the **live
  encoder implementation** as `hw:<name>` or `sw:<name>`. Enable the "stats"
  toggle (top-right of the window) during a screen share and read the encoder
  line on your stream tile. `shortEncoder()` classifies it by matching
  `MediaFoundation|VideoToolbox|Vaapi|V4L2|NVENC|AMF`. This turns "is hardware
  encode working?" from a guess into an observation.

**Test protocol (needs a second participant, since a stream is only meaningful
to a viewer):**
1. A viewer joins the voice channel; the sharer starts a screen share.
2. Sharer enables the **stats** toggle.
3. Sharer forces **H.264** (not Auto) in the share dialog.
4. Read the encoder line on the stream tile: `hw:` or `sw:` + name.
5. Repeat with **VP8** to compare.

**Decision from the readout:**
- If **any** codec shows `hw:` → use that codec; you get smooth 4K.
- If **all** show `sw:` (the likely NVIDIA outcome) → the mitigation is **VP8 at
  1080p or 720p / 30fps**. VP8 software encode is light enough for a strong CPU
  (e.g., a Ryzen 5800X3D) to keep up, trading resolution for smoothness. For
  true game-grade 4K streaming, Sunshine/Moonlight remain the right tool
  alongside Hearth.

**Platform summary:**

| Platform / GPU | Browser WebRTC HW encode |
|----------------|--------------------------|
| Windows (any modern GPU) | Yes (MediaFoundation) |
| macOS | Yes (VideoToolbox) |
| Linux + Intel/AMD (VA-API) | Often yes |
| **Linux + NVIDIA** | **No (VA-API is decode-only)** |

---

## 6. Ghosting, keyframes, and screen-share correctness

Video ghosting on a viewer (stale frames after resume) is handled by requesting
fresh keyframes at the right moments: the server keyframes on consumer resume,
and the client re-requests a keyframe shortly after wiring the track
(belt-and-suspenders) and on focus switches. Screen producers use a scalability
mode with a degradation preference tuned for motion.

---

## 7. Cosmetic log lines (all benign)

These appear in Linux/Wayland runs and are **not** errors to chase:

- `Frame latency is negative: -X ms` — Chromium VRR/adaptive-sync noise on
  high-refresh (e.g., 120Hz OLED) displays. Rendering unaffected.
- `XkbGetKeyboard failed to locate a valid keyboard` — uiohook (global
  push-to-talk) under Wayland. PTT still works via XWayland.
- `'--ozone-platform=wayland' is not compatible with Vulkan` — despite a
  `disable-features=Vulkan` on Linux, this can still surface. Harmless; parked
  for cleanup.
- `DtlsTransport ... kClosed` — normal teardown when a peer leaves voice.

---

## 8. Known media limitations

- **NVENC unavailable in browser WebRTC on NVIDIA/Linux** (this doc, §5).
- **Desktop audio capture on Linux/Wayland** isn't possible directly through
  Chromium; route through a PipeWire virtual sink selected as the microphone.
- **Push-to-talk is X11/XWayland-based** (uiohook); native Wayland global PTT
  would require a portal/evdev approach.
