'use strict';
/**
 * Jukebox — plays music into a voice channel as a real audio producer.
 *
 * Pipeline (all on the host machine):
 *   yt-dlp -o - <url>  →  ffmpeg (opus/48k/stereo, paced with -re)
 *   → RTP to 127.0.0.1  →  mediasoup PlainTransport  →  everyone consumes
 *   it like any other peer. Per-listener volume is therefore free: the
 *   jukebox is just another rail row with a slider.
 *
 * Sources: YouTube plays directly. Spotify / Pandora links cannot be
 * pulled (DRM) — they are resolved to "artist - title" via oEmbed / page
 * metadata and played from the best YouTube match (ytsearch1:).
 *
 * Requires yt-dlp and ffmpeg on the host; the feature self-disables when
 * they're missing (hello caps.jukebox = false).
 */

const { spawn, spawnSync } = require('child_process');
const unfurl = require('./unfurl');
const config = require('./config');

const SSRC = 22222222;
const PAYLOAD_TYPE = 101;
const RESOLVE_TIMEOUT_MS = 20_000;
const MAX_QUEUE = 25;
const MAX_TRACK_SECONDS = 4 * 3600; // refuse 10-hour loops by accident

let availability = null;

function binOk(bin, args) {
  try {
    return spawnSync(bin, args, { timeout: 4000 }).status === 0;
  } catch { return false; }
}

/** Both binaries present? Cached after first check. */
function available() {
  if (availability === null) {
    availability = {
      ytdlp: binOk('yt-dlp', ['--version']),
      ffmpeg: binOk('ffmpeg', ['-version'])
    };
    availability.ok = availability.ytdlp && availability.ffmpeg;
  }
  return availability.ok;
}

const canPause = () => process.platform !== 'win32'; // SIGSTOP/SIGCONT

/* ───────────────────────── link classification ─────────────────────── */

function classifySource(raw) {
  let u;
  try { u = new URL(raw); } catch { return { kind: 'invalid' }; }
  const host = u.hostname.replace(/^www\.|^m\./, '').toLowerCase();
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') {
    return { kind: 'youtube', url: raw };
  }
  if (host === 'open.spotify.com') return { kind: 'spotify', url: raw };
  if (host === 'pandora.com') return { kind: 'pandora', url: raw };
  return { kind: 'other', url: raw };
}

/** Strip site suffixes off page titles → a clean search string. */
function titleToQuery(title) {
  return String(title)
    .replace(/\s*[-|–·]\s*(song and lyrics by|song by|listen with lyrics)\s*/i, ' ')
    .replace(/\s*\|\s*(Spotify|Pandora|Deezer).*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** yt-dlp -j against a URL or ytsearch1: query → {title, duration, url}. */
function ytdlpProbe(input) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp',
      ['-j', '--no-playlist', '--no-warnings', input],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('lookup timed out'));
    }, RESOLVE_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !out.trim()) {
        return reject(new Error(err.split('\n')[0]?.slice(0, 140) || 'lookup failed'));
      }
      try {
        const j = JSON.parse(out.trim().split('\n')[0]);
        resolve({
          title: j.title || 'unknown track',
          duration: Number(j.duration) || 0,
          url: j.webpage_url || input
        });
      } catch { reject(new Error('could not parse track info')); }
    });
  });
}

/** Any supported link → playable {title, duration, url, via}. */
async function resolveTrack(raw) {
  const src = classifySource(raw);
  if (src.kind === 'invalid') throw new Error('that is not a link');

  if (src.kind === 'youtube' || src.kind === 'other') {
    try {
      const meta = await ytdlpProbe(src.url);
      return { ...meta, via: src.kind === 'youtube' ? 'youtube' : 'direct' };
    } catch (err) {
      if (src.kind === 'youtube') throw err;
      // Unknown site yt-dlp can't handle → try title search below.
    }
  }

  // Spotify / Pandora / unknown: page title → YouTube search.
  const card = await unfurl.fetchCard(raw, config.unfurl);
  if (!card?.title) throw new Error('could not read a track title from that link');
  const query = titleToQuery(card.title);
  if (query.length < 3) throw new Error('could not build a search from that link');
  const meta = await ytdlpProbe(`ytsearch1:${query}`);
  return { ...meta, via: `${src.kind}→youtube`, resolvedFrom: query };
}

/* ─────────────────────────── the session ───────────────────────────── */

class JukeboxSession {
  constructor(channelId, router, io) {
    this.channelId = channelId;
    this.router = router;
    this.io = io;
    this.transport = null;
    this.producer = null;
    this.queue = [];
    this.nowPlaying = null;
    this.paused = false;
    this.procs = [];
    this.closed = false;
  }

  peerId() { return `jukebox:${this.channelId}`; }

  summary() {
    return {
      id: this.peerId(),
      userId: this.peerId(),
      name: '🎵 Jukebox',
      state: { muted: false, deafened: false, camOn: false, sharing: false, serverMuted: false },
      producers: this.producer
        ? [{ id: this.producer.id, kind: 'audio', mediaTag: 'jukebox' }]
        : []
    };
  }

  publicState() {
    return {
      channelId: this.channelId,
      nowPlaying: this.nowPlaying
        ? { title: this.nowPlaying.title, duration: this.nowPlaying.duration,
            by: this.nowPlaying.by, via: this.nowPlaying.via }
        : null,
      paused: this.paused,
      queue: this.queue.map((t) => ({ title: t.title, duration: t.duration, by: t.by }))
    };
  }

  async ensureProducer(audioLevelObserver) {
    if (this.producer) return;
    this.transport = await this.router.createPlainTransport({
      listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
      rtcpMux: false,
      comedia: true
    });
    this.producer = await this.transport.produce({
      kind: 'audio',
      rtpParameters: {
        codecs: [{
          mimeType: 'audio/opus', payloadType: PAYLOAD_TYPE,
          clockRate: 48000, channels: 2,
          // MUST byte-match what browser mic producers declare: mediasoup
          // copies producer codec params into every consumer, and libwebrtc
          // rejects a BUNDLE where the same payload type carries different
          // opus fmtp — the second audio consumer then fails to attach.
          parameters: {
            minptime: 10, 'sprop-stereo': 1, usedtx: 0, useinbandfec: 1
          }
        }],
        encodings: [{ ssrc: SSRC }]
      },
      appData: { peerId: this.peerId(), mediaTag: 'jukebox' }
    });
    audioLevelObserver?.addProducer({ producerId: this.producer.id }).catch(() => {});

    this.io.to(this.channelId).emit('peer:joined', this.summary());
    this.io.to(this.channelId).emit('producer:new', {
      peerId: this.peerId(), producerId: this.producer.id,
      kind: 'audio', mediaTag: 'jukebox'
    });
  }

  broadcast() {
    this.io.to(this.channelId).emit('jukebox:update', this.publicState());
  }

  startPipeline(track) {
    const rtpPort = this.transport.tuple.localPort;
    const rtcpPort = this.transport.rtcpTuple.localPort;

    const dl = spawn('yt-dlp',
      ['-f', 'bestaudio/best', '--no-playlist', '--no-warnings', '-o', '-', track.url],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const ff = spawn('ffmpeg',
      ['-hide_banner', '-loglevel', 'error',
       '-re', '-i', 'pipe:0', '-vn', '-map', '0:a:0',
       '-acodec', 'libopus', '-ab', '128k', '-ac', '2', '-ar', '48000',
       '-f', 'tee',
       `[select=a:f=rtp:ssrc=${SSRC}:payload_type=${PAYLOAD_TYPE}]` +
       `rtp://127.0.0.1:${rtpPort}?rtcpport=${rtcpPort}`],
      { stdio: ['pipe', 'ignore', 'pipe'] });

    dl.stdout.pipe(ff.stdin);
    dl.stderr.on('data', () => {});
    ff.stderr.on('data', (d) => {
      const line = String(d).trim();
      if (line) console.error(`[jukebox ${this.channelId}] ffmpeg:`, line.slice(0, 160));
    });
    dl.on('error', () => {});
    ff.stdin.on('error', () => {}); // EPIPE when we kill dl first
    this.procs = [dl, ff];

    ff.on('close', () => {
      if (this.closed) return;
      this.procs = [];
      this.nowPlaying = null;
      this.playNext().catch((err) =>
        console.error('[jukebox] advance failed:', err.message));
    });
  }

  async playNext() {
    if (this.closed) return;
    const track = this.queue.shift();
    if (!track) {
      this.broadcast();
      this.destroy(); // silence → tear down; recreated on next queue
      return;
    }
    this.nowPlaying = track;
    this.paused = false;
    this.startPipeline(track);
    this.broadcast();
  }

  async add(track) {
    if (this.queue.length >= MAX_QUEUE) throw new Error(`queue is full (${MAX_QUEUE})`);
    this.queue.push(track);
    if (!this.nowPlaying) await this.playNext();
    else this.broadcast();
  }

  skip() {
    for (const p of this.procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
    // ffmpeg 'close' advances the queue.
  }

  setPaused(paused) {
    if (!canPause()) throw new Error('pause is not supported on a Windows host — skip instead');
    if (!this.nowPlaying) throw new Error('nothing is playing');
    const sig = paused ? 'SIGSTOP' : 'SIGCONT';
    for (const p of this.procs) { try { p.kill(sig); } catch { /* gone */ } }
    if (paused) this.producer?.pause(); else this.producer?.resume();
    this.paused = paused;
    this.broadcast();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
    this.procs = [];
    if (this.producer) {
      this.io.to(this.channelId).emit('producer:closed', {
        peerId: this.peerId(), producerId: this.producer.id
      });
      this.io.to(this.channelId).emit('peer:left', { id: this.peerId() });
    }
    try { this.producer?.close(); } catch { /* closed */ }
    try { this.transport?.close(); } catch { /* closed */ }
    this.producer = null;
    this.transport = null;
    this.nowPlaying = null;
    this.queue = [];
    this.io.emit('dir:dirty');
  }
}

module.exports = {
  available, canPause, classifySource, titleToQuery, resolveTrack,
  JukeboxSession, MAX_TRACK_SECONDS
};
