/**
 * Quality presets, Discord-flavored but with no artificial gating.
 * kbps is the encoder target (maxBitrate). kbps=0 means "uncapped" —
 * the server still caps every sender at 30 Mbps.
 */

export const SCREEN_PRESETS = [
  { id: '480p30',  label: '480p · 30 fps',      width: 854,  height: 480,  fps: 30, kbps: 1200 },
  { id: '720p30',  label: '720p · 30 fps',      width: 1280, height: 720,  fps: 30, kbps: 2500 },
  { id: '720p60',  label: '720p · 60 fps',      width: 1280, height: 720,  fps: 60, kbps: 4000 },
  { id: '1080p30', label: '1080p · 30 fps',     width: 1920, height: 1080, fps: 30, kbps: 4500 },
  { id: '1080p60', label: '1080p · 60 fps',     width: 1920, height: 1080, fps: 60, kbps: 7000 },
  { id: '1440p60', label: '1440p · 60 fps',     width: 2560, height: 1440, fps: 60, kbps: 12000 },
  { id: '2160p30', label: '4K · 30 fps',        width: 3840, height: 2160, fps: 30, kbps: 16000 },
  { id: '2160p60', label: '4K · 60 fps',        width: 3840, height: 2160, fps: 60, kbps: 25000 },
  { id: 'source',  label: 'Source (uncapped)',  width: 0,    height: 0,    fps: 0,  kbps: 0 }
];

export const CAM_PRESETS = [
  { id: 'cam480',  label: '480p',  width: 854,  height: 480,  fps: 30, kbps: 900 },
  { id: 'cam720',  label: '720p',  width: 1280, height: 720,  fps: 30, kbps: 2000 },
  { id: 'cam1080', label: '1080p', width: 1920, height: 1080, fps: 30, kbps: 3500 }
];

export const VIDEO_CODECS = ['auto', 'av1', 'vp9', 'h264', 'vp8'];

export const preset = (id) =>
  SCREEN_PRESETS.find((p) => p.id === id) ||
  CAM_PRESETS.find((p) => p.id === id) ||
  null;

/** Average per-listener Opus cost used in the bandwidth model (kbps). */
export const OPUS_KBPS = 40;
