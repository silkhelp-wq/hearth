'use strict';
/**
 * Hearth server configuration.
 *
 * Env overrides:
 *   HEARTH_PORT           HTTP + signaling port           (default 4443)
 *   HEARTH_MEDIA_PORT     single UDP/TCP media port       (default 44444)
 *   HEARTH_ANNOUNCED_IP   IP clients use to reach media   (default: autodetect, Tailscale preferred)
 *   HEARTH_NAME           server display name             (default "Hearth")
 *   HEARTH_DATA_DIR       SQLite + state directory        (default <server>/data)
 *   HEARTH_CHAT_CAP_MB    chat DB size cap, prune-oldest  (default 5120)
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

function detectAnnouncedAddress() {
  if (process.env.HEARTH_ANNOUNCED_IP) return process.env.HEARTH_ANNOUNCED_IP;
  let lanFallback = null;
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const info of iface || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const [a, b] = info.address.split('.').map(Number);
      if (a === 100 && b >= 64 && b <= 127) return info.address; // Tailscale CGNAT range
      if (!lanFallback) lanFallback = info.address;
    }
  }
  return lanFallback || '127.0.0.1';
}

/** channels.json seeds the DB on first boot only; edits after that live in the app. */
function loadSeedChannels() {
  const file = path.join(__dirname, '..', 'channels.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch { /* fall through */ }
  return ['The Hearth', 'Gaming', 'Movie Night', 'AFK'];
}

const announcedAddress = detectAnnouncedAddress();
const mediaPort = Number(process.env.HEARTH_MEDIA_PORT || 44444);
const dataDir = process.env.HEARTH_DATA_DIR || path.join(__dirname, '..', 'data');

module.exports = {
  serverName: process.env.HEARTH_NAME || 'Hearth',
  httpPort: Number(process.env.HEARTH_PORT || 4443),
  mediaPort,
  announcedAddress,
  seedVoiceChannels: loadSeedChannels(),

  dataDir,
  dbPath: path.join(dataDir, 'hearth.db'),

  chat: {
    capBytes: Number(process.env.HEARTH_CHAT_CAP_MB || 5120) * 1024 * 1024,
    maxMessageLen: 4000,
    pruneBatch: 500,
    pruneIntervalMs: 30 * 60 * 1000
  },

  storage: {
    // Env values are DEFAULTS; the owner can change these live in
    // Settings -> Server -> Storage (persisted in the kv table).
    chatCapMB: Number(process.env.HEARTH_CHAT_CAP_MB || 5120),
    emojiCapMB: Number(process.env.HEARTH_EMOJI_CAP_MB || 64),
    previewCapMB: Number(process.env.HEARTH_PREVIEW_CAP_MB || 32),
    emojiMaxKB: 512
  },

  gifs: {
    tenorKey: process.env.HEARTH_TENOR_KEY || '',
    giphyKey: process.env.HEARTH_GIPHY_KEY || '',
    imgurClientId: process.env.HEARTH_IMGUR_CLIENT_ID || ''
  },

  unfurl: {
    timeoutMs: 5000,
    maxBytes: 512 * 1024,
    maxLinksPerMessage: 3,
    titleMax: 120,
    descriptionMax: 240
  },

  mediasoup: {
    worker: { logLevel: 'warn', logTags: ['info', 'ice', 'dtls', 'rtp'] },
    webRtcServer: {
      listenInfos: [
        { protocol: 'udp', ip: '0.0.0.0', announcedAddress, port: mediaPort },
        { protocol: 'tcp', ip: '0.0.0.0', announcedAddress, port: mediaPort }
      ]
    },
    router: {
      mediaCodecs: [
        { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
        { kind: 'video', mimeType: 'video/AV1', clockRate: 90000 },
        { kind: 'video', mimeType: 'video/VP9', clockRate: 90000,
          parameters: { 'profile-id': 0, 'x-google-start-bitrate': 1000 } },
        { kind: 'video', mimeType: 'video/VP8', clockRate: 90000,
          parameters: { 'x-google-start-bitrate': 1000 } },
        { kind: 'video', mimeType: 'video/H264', clockRate: 90000,
          parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1, 'x-google-start-bitrate': 1000 } }
      ]
    },
    webRtcTransport: {
      initialAvailableOutgoingBitrate: 10_000_000,
      maxIncomingBitrate: 30_000_000
    }
  }
};
