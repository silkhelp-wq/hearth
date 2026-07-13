# Stream Settings — presets and the bandwidth math

The in-app **Settings → Network & advice** tab does all of this for you
(speed test → recommendation → apply). This doc explains what it's doing so
the numbers aren't magic.

## Screen-share presets

`kbps` is the encoder target Hearth sets (`maxBitrate`). "Source" is
uncapped client-side; the server caps every sender at **30 Mbps**.

| Preset | Resolution | FPS | Target bitrate |
|---|---|---|---|
| 480p30 | 854×480 | 30 | 1.2 Mbps |
| 720p30 | 1280×720 | 30 | 2.5 Mbps |
| 720p60 | 1280×720 | 60 | 4.0 Mbps |
| 1080p30 | 1920×1080 | 30 | 4.5 Mbps |
| 1080p60 | 1920×1080 | 60 | 7.0 Mbps |
| 1440p60 | 2560×1440 | 60 | 12 Mbps |
| 4K30 | 3840×2160 | 30 | 16 Mbps |
| 4K60 | 3840×2160 | 60 | 25 Mbps |
| Source | native | native | uncapped (≤30 Mbps) |

Camera presets: 480p ≈ 0.9 Mbps · 720p ≈ 2.0 Mbps · 1080p ≈ 3.5 Mbps.

Codec notes: **Auto** negotiates AV1 → VP9 → H.264 → VP8 depending on both
ends' hardware. AV1 looks meaningfully better per bit (worth trying at 720p
tiers); H.264 is the safest "old laptop in the crew" choice. Verify what's
actually flowing with the **stats** toggle above the tile grid.

## The bottleneck model

The host relays everything (SFU). For a stream at **B** Mbps in a channel
of **N** people with **S** simultaneous streams:

| Who | Pays |
|---|---|
| each sharer (upload) | B |
| each viewer (download) | B × S |
| **host (upload)** | **B × (N−1) × S**  ← the usual ceiling |

Voice rides on the host too: roughly `N × (N−1) × 40 kbps`
(10 people ≈ **3.6 Mbps** of host upload before any video).

Hearth budgets **75%** of measured line rate — speed tests are best-case,
and someone is always also downloading a game patch.

## Worked example

8 people, host upload **50 Mbps**, one person streaming:

```
voice overhead   8 × 7 × 40 kbps            =  2.24 Mbps
video budget     50 × 0.75 − 2.24           = 35.26 Mbps
per-stream cap   35.26 ÷ 7 viewers          =  5.04 Mbps
→ best preset: 1080p30 (4.5 ≤ 5.04; 1080p60 needs 7.0 — over)
```

Same crew, **two** simultaneous streams: 35.26 ÷ (7×2) ≈ 2.5 Mbps each →
720p30 for both.

10 people on a **35 Mbps** cable upload: 26.25 − 3.6 = 22.65; ÷9 ≈ 2.5 Mbps
→ 720p30. This is why the host's line matters more than anyone else's.

Sharer-side check: your own upload must clear `B ÷ 0.75` (+ mic). 1080p60
therefore wants ~9.5 Mbps of upload from the person streaming.

## Practical picks

- **Movie night (1 streamer, everyone watching):** highest preset the host
  budget allows, codec Auto, optimize **Motion**.
- **Co-op backseat gaming (2–3 streams):** 720p30–720p60 each.
- **Code/document review:** 1080p30, optimize **Text** — sharpness beats
  frame rate for reading.
- **Host on fast fiber (100+ Mbps up):** 1080p60/1440p60 to a 10-person
  room is completely realistic; run the in-app test and let it verify.
