/**
 * Audio toolkit: devices, mic constraints, level metering, voice-activity
 * gating, and per-element output-device routing.
 */

export async function listDevices() {
  // Labels are empty until at least one getUserMedia grant has happened;
  // callers should acquire a mic first (we do, on join).
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    mics: devices.filter((d) => d.kind === 'audioinput'),
    outputs: devices.filter((d) => d.kind === 'audiooutput'),
    cams: devices.filter((d) => d.kind === 'videoinput')
  };
}

/**
 * Acquire a microphone stream.
 * `music` mode = stereo, processing off — for sharing what you're listening
 * to through a real mic or a virtual cable without Opus mangling it.
 */
export async function getMicStream({ deviceId, ec = true, ns = true, agc = true, music = false } = {}) {
  const audio = {
    echoCancellation: music ? false : ec,
    noiseSuppression: music ? false : ns,
    autoGainControl: music ? false : agc,
    channelCount: music ? 2 : 1
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ audio });
}

export async function getCamStream({ deviceId, width, height, fps } = {}) {
  const video = {
    width: width ? { ideal: width } : undefined,
    height: height ? { ideal: height } : undefined,
    frameRate: fps ? { ideal: fps } : undefined
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ video });
}

/** Rolling RMS level meter over a MediaStream. onLevel(0..1) ~30x/sec. */
export class MicMeter {
  constructor(stream, onLevel) {
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.src = this.ctx.createMediaStreamSource(stream);
    this.src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.dead = false;

    const tick = () => {
      if (this.dead) return;
      this.analyser.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (const s of this.buf) sum += s * s;
      const rms = Math.sqrt(sum / this.buf.length);
      onLevel(Math.min(1, rms * 4), rmsToDb(rms));
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop() {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    this.src.disconnect();
    this.ctx.close().catch(() => {});
  }
}

const rmsToDb = (rms) => (rms > 0 ? 20 * Math.log10(rms) : -100);

/**
 * Voice-activity gate. Opens instantly on speech above `thresholdDb`,
 * closes after `hangMs` of quiet. Drive a track.enabled from the callbacks.
 */
export class VadGate {
  constructor({ thresholdDb = -45, hangMs = 500, onOpen, onClose }) {
    this.thresholdDb = thresholdDb;
    this.hangMs = hangMs;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.open = false;
    this.lastVoice = 0;
  }
  feed(db, now = performance.now()) {
    if (db >= this.thresholdDb) {
      this.lastVoice = now;
      if (!this.open) { this.open = true; this.onOpen?.(); }
    } else if (this.open && now - this.lastVoice > this.hangMs) {
      this.open = false;
      this.onClose?.();
    }
  }
  setThreshold(db) { this.thresholdDb = db; }
}

/** Route an <audio>/<video> element to a specific output device. */
export async function applyOutput(el, sinkId) {
  if (!sinkId || typeof el.setSinkId !== 'function') return;
  try { await el.setSinkId(sinkId); } catch { /* device unplugged, etc. */ }
}
