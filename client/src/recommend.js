/**
 * Streaming-settings recommendation engine.
 *
 * The bottleneck model (SFU on the host):
 *
 *   sharer  --(1x stream)-->  HOST  --(viewers copies)-->  everyone else
 *
 * So a stream at B kbps costs:
 *   - the sharer:  B kbps of upload
 *   - the host:    B * viewers kbps of upload, per simultaneous sharer
 *   - each viewer: B kbps of download, per stream they watch
 *
 * Voice also rides on the host: with N people in a channel, the host relays
 * roughly N * (N-1) * OPUS_KBPS of audio. That's subtracted off the top.
 *
 * `headroom` keeps us at 75% of measured line rate — speed tests are
 * best-case numbers and games/browsers want bandwidth too.
 */

import { SCREEN_PRESETS, OPUS_KBPS } from './presets.js';

export function recommend({
  clientUpMbps = 0,   // the would-be sharer's measured upload
  hostUpMbps = 0,     // the host machine's upload (0 = unknown)
  people = 8,         // humans in the channel, host included if they're in it
  sharers = 1,        // simultaneous streams you want to support
  headroom = 0.75
}) {
  people = Math.max(2, Math.round(people));
  sharers = Math.max(1, Math.round(sharers));
  const viewers = people - 1;

  const clientCapKbps = clientUpMbps > 0
    ? Math.max(0, clientUpMbps * 1000 * headroom - OPUS_KBPS)
    : Infinity;

  let hostCapKbps = Infinity;
  if (hostUpMbps > 0) {
    const voiceKbps = people * (people - 1) * OPUS_KBPS;
    const videoBudget = hostUpMbps * 1000 * headroom - voiceKbps;
    hostCapKbps = Math.max(0, videoBudget / (viewers * sharers));
  }

  const perStreamKbps = Math.min(clientCapKbps, hostCapKbps);
  const limitedBy =
    perStreamKbps === Infinity ? 'none'
      : clientCapKbps <= hostCapKbps ? 'your upload'
      : 'host relay capacity';

  const rows = SCREEN_PRESETS.filter((p) => p.kbps > 0).map((p) => ({
    ...p,
    ok: p.kbps <= perStreamKbps
  }));

  const best = [...rows].reverse().find((r) => r.ok) || null;

  return {
    perStreamKbps: perStreamKbps === Infinity ? null : Math.round(perStreamKbps),
    limitedBy,
    viewers,
    sharers,
    best,           // highest preset that fits (null if even 480p30 doesn't)
    rows,           // every preset with an ok/notok verdict
    hostUnknown: !(hostUpMbps > 0)
  };
}

export const fmtKbps = (kbps) =>
  kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
