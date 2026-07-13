'use strict';
/**
 * Hearth server configuration.
 *
 * Everything can be overridden with environment variables:
 *   HEARTH_PORT           HTTP + signaling port           (default 4443)
 *   HEARTH_MEDIA_PORT     single UDP/TCP media port       (default 44444)
 *   HEARTH_ANNOUNCED_IP   IP clients use to reach media   (default: autodetect, Tailscale preferred)
 *   HEARTH_NAME           server display name             (default "Hearth")
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

/**
 * Pick the address we tell clients to send media to.
 * Preference order:
 *   1. HEARTH_ANNOUNCED_IP env var
 *   2. A Tailscale address (CGNAT range 100.64.0.0/10 used by Tailscale)
 *   3. First non-internal IPv4 (LAN fallback)
 *   4. 127.0.0.1 (single-machine testing)
 */
function detectAnnouncedAddress() {
  if (process.env.HEARTH_ANNOUNCED_IP) return process.env.HEARTH_ANNOUNCED_IP;

  let lanFallback = null;
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const info of iface || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const [a, b] = info.address.split('.').map(Number);
      const isTailscale = a === 100 && b >= 64 && b <= 127;
      if (isTailscale) return info.address;
      if (!lanFallback) lanFallback = info.address;
    }
  }
  return lanFallback || '127.0.0.1';
}

function loadChannels() {
  const file = path.join(__dirname, '..', 'channels.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch (err) {
    console.warn(`[config] could not read channels.json (${err.message}); using defaults`);
  }
  return ['The Hearth', 'Gaming', 'Movie Night', 'AFK'];
}

const announcedAddress = detectAnnouncedAddress();
const mediaPort = Number(process.env.HEARTH_MEDIA_PORT || 44444);

module.exports = {
  serverName: process.env.HEARTH_NAME || 'Hearth',
  httpPort: Number(process.env.HEARTH_PORT || 4443),
  mediaPort,
  announcedAddress,
  channels: loadChannels(),

  mediasoup: {
    worker: {
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp']
    },

    // One shared UDP/TCP port for all peers, courtesy of WebRtcServer.
    webRtcServer: {
      listenInfos: [
        { protocol: 'udp', ip: '0.0.0.0', announcedAddress, port: mediaPort },
        { protocol: 'tcp', ip: '0.0.0.0', announcedAddress, port: mediaPort }
      ]
    },

    router: {
      // Order = server preference. Clients may force a specific codec per stream.
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2
        },
        {
          kind: 'video',
          mimeType: 'video/AV1',
          clockRate: 90000
        },
        {
          kind: 'video',
          mimeType: 'video/VP9',
          clockRate: 90000,
          parameters: { 'profile-id': 0, 'x-google-start-bitrate': 1000 }
        },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: { 'x-google-start-bitrate': 1000 }
        },
        {
          kind: 'video',
          mimeType: 'video/H264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 1000
          }
        }
      ]
    },

    webRtcTransport: {
      initialAvailableOutgoingBitrate: 1_000_000,
      // Per-sending-peer ceiling. "Source" preset rides under this.
      maxIncomingBitrate: 30_000_000
    }
  }
};
