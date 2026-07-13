/**
 * Hearth renderer application — glue between the UI skeleton, HearthRTC,
 * the audio toolkit, and the Electron bridge (window.hearth).
 */

import { HearthRTC } from './rtc.js';
import { listDevices, getMicStream, getCamStream, MicMeter, VadGate, applyOutput } from './audio.js';
import { SCREEN_PRESETS, CAM_PRESETS, VIDEO_CODECS, preset, OPUS_KBPS } from './presets.js';
import { recommend, fmtKbps } from './recommend.js';
import { runFullTest, fetchCrewReports } from './speedtest.js';

const $ = (id) => document.getElementById(id);
const bridge = window.hearth || {
  platform: 'unknown',
  getScreenSources: async () => [],
  chooseShareSource: async () => {},
  pttAvailable: async () => false,
  setPttBinding: async () => {},
  captureNextInput: async () => null,
  onPtt: () => {}
};

/* ────────────────────────────── settings ────────────────────────────── */

const DEFAULTS = {
  serverUrl: '',
  displayName: '',
  audio: {
    inId: '', outId: '',
    ec: true, ns: true, agc: true, music: false,
    mode: 'vad', vadDb: -45,
    ptt: null // {type:'key'|'mouse'|'focus', code, label}
  },
  video: { camId: '', camPreset: 'cam720' },
  stream: { preset: '1080p30', codec: 'auto', optimize: 'motion' },
  net: { upMbps: 0, hostUpMbps: 0, people: 8, sharers: 1 }
};

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem('hearth-settings-v1') || '{}');
    return {
      ...structuredClone(DEFAULTS),
      ...raw,
      audio: { ...DEFAULTS.audio, ...raw.audio },
      video: { ...DEFAULTS.video, ...raw.video },
      stream: { ...DEFAULTS.stream, ...raw.stream },
      net: { ...DEFAULTS.net, ...raw.net }
    };
  } catch { return structuredClone(DEFAULTS); }
}
const settings = loadSettings();
const saveSettings = () =>
  localStorage.setItem('hearth-settings-v1', JSON.stringify(settings));

/* ─────────────────────────────── state ──────────────────────────────── */

const rtc = new HearthRTC();

const state = {
  connected: false,
  channelId: null,
  channelName: '',
  peers: new Map(),      // peerId -> {name, state}
  directory: [],
  muted: false,
  deafened: false,
  camOn: false,
  sharing: false,
  pttDown: false,
  vadOpen: false,
  micStream: null,
  micMeter: null,
  camStream: null,
  screenStream: null,
  micTestEl: null,
  volumes: new Map(),    // peerId -> 0..1
  lastReco: null,
  statsTimer: null
};

const vad = new VadGate({
  thresholdDb: settings.audio.vadDb,
  onOpen: () => { state.vadOpen = true; applyMicGate(); },
  onClose: () => { state.vadOpen = false; applyMicGate(); }
});

/* ─────────────────────────── connect screen ─────────────────────────── */

function logLine(text, cls = '') {
  const log = $('connect-log');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text + '\n';
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

async function doConnect() {
  const url = normalizeUrl($('in-server').value.trim());
  const name = $('in-name').value.trim();
  $('connect-log').textContent = '';

  if (!url || !name) { logLine('> server address and display name are both required', 'err'); return; }

  settings.serverUrl = url;
  settings.displayName = name;
  saveSettings();

  $('btn-connect').disabled = true;
  logLine(`> reaching ${url} …`);

  try {
    const t0 = performance.now();
    await rtc.connect(url);
    logLine(`> linked · ${Math.round(performance.now() - t0)} ms`, 'ok');

    const info = await fetch(`${url}/info`).then((r) => r.json()).catch(() => null);
    const dir = await rtc.channels();
    onDirectory(dir);

    const online = dir.reduce((n, c) => n + c.peers.length, 0);
    logLine(`> ${info?.name || 'hall'} is open — ${online} inside`, 'ok');

    $('server-name').textContent = info?.name || 'Hearth';
    $('server-addr').textContent = url.replace(/^https?:\/\//, '');
    $('self-name').textContent = name;

    setTimeout(() => {
      $('screen-connect').classList.add('hidden');
      $('screen-main').classList.remove('hidden');
    }, 350);
    state.connected = true;
  } catch (err) {
    logLine(`> ${err.message}`, 'err');
    logLine('> check the address, and that you are on the same tailnet');
  } finally {
    $('btn-connect').disabled = false;
  }
}

function normalizeUrl(input) {
  if (!input) return '';
  let url = input;
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  if (!/:\d+/.test(url.replace(/^https?:\/\//, ''))) url = `${url}:4443`;
  return url.replace(/\/+$/, '');
}

/* ──────────────────────────── channel rail ──────────────────────────── */

function onDirectory(dir) {
  state.directory = dir;
  const list = $('channel-list');
  list.textContent = '';

  for (const ch of dir) {
    const el = document.createElement('div');
    el.className = 'channel' +
      (ch.peers.length ? ' occupied' : '') +
      (ch.id === state.channelId ? ' current' : '');
    el.dataset.id = ch.id;

    const nameRow = document.createElement('div');
    nameRow.className = 'channel-name';
    nameRow.innerHTML = `<span class="occ"></span>`;
    const label = document.createElement('span');
    label.textContent = ch.name;
    nameRow.appendChild(label);
    el.appendChild(nameRow);

    if (ch.peers.length) {
      const peersBox = document.createElement('div');
      peersBox.className = 'channel-peers';
      for (const p of ch.peers) peersBox.appendChild(railPeerRow(p, ch.id));
      el.appendChild(peersBox);
    }
    list.appendChild(el);
  }
}

function railPeerRow(p, channelId) {
  const row = document.createElement('div');
  row.className = 'rail-peer';
  row.dataset.peer = p.id;

  const dot = document.createElement('span');
  dot.className = 'dot';
  row.appendChild(dot);

  const name = document.createElement('span');
  name.textContent = p.name;
  row.appendChild(name);

  const flags = document.createElement('span');
  flags.className = 'flags';
  row.appendChild(flags);

  // Per-person volume, only meaningful for people in *my* channel.
  if (channelId === state.channelId && p.id !== rtc.socket?.id) {
    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = 0; vol.max = 100;
    vol.value = Math.round((state.volumes.get(p.id) ?? 1) * 100);
    vol.title = 'Volume';
    vol.addEventListener('input', () => {
      const v = vol.value / 100;
      state.volumes.set(p.id, v);
      for (const el of audioEls(p.id)) el.volume = v;
    });
    row.appendChild(vol);
  }
  refreshPeerFlags(row, p.id);
  return row;
}

function refreshPeerFlags(row, peerId) {
  const st = state.peers.get(peerId)?.state;
  const flags = row.querySelector('.flags');
  if (!st || !flags) return;
  flags.textContent =
    (st.deafened ? '⛔' : st.muted ? '🔇' : '') + (st.sharing ? ' 🖥' : '');
}

function refreshRailStates() {
  document.querySelectorAll('.rail-peer').forEach((row) =>
    refreshPeerFlags(row, row.dataset.peer));
}

/* ─────────────────────────── join / leave ───────────────────────────── */

async function joinChannel(channelId) {
  if (channelId === state.channelId) return;

  if (state.channelId) await leaveChannel({ keepMic: true });

  const { peers } = await rtc.join(channelId, settings.displayName);
  state.channelId = channelId;
  state.channelName =
    state.directory.find((c) => c.id === channelId)?.name || 'hall';

  state.peers.clear();
  for (const p of peers) state.peers.set(p.id, { name: p.name, state: p.state });

  $('stage-title').textContent = state.channelName;
  $('controls').classList.remove('hidden');
  updateEmptyStage();

  await startMic();
  await broadcastState();
}

async function leaveChannel({ keepMic = false } = {}) {
  await stopShare(true);
  await stopCam(true);
  await rtc.leave();

  for (const el of document.querySelectorAll('#tile-grid .tile')) el.remove();
  $('audio-sink').textContent = '';
  state.peers.clear();
  state.channelId = null;
  state.channelName = '';
  $('stage-title').textContent = 'Pick a hall';
  $('controls').classList.add('hidden');

  if (!keepMic) stopMicStream();
  updateEmptyStage();
}

/* ───────────────────────────── mic engine ───────────────────────────── */

async function startMic() {
  stopMicStream();
  try {
    state.micStream = await getMicStream({
      deviceId: settings.audio.inId || undefined,
      ec: settings.audio.ec,
      ns: settings.audio.ns,
      agc: settings.audio.agc,
      music: settings.audio.music
    });
  } catch (err) {
    console.warn('mic unavailable:', err);
    updateEmptyStage(`Mic unavailable (${err.name}) — you are listen-only. Pick another input in Settings → Audio.`);
    return;
  }

  const track = state.micStream.getAudioTracks()[0];
  if (rtc.producers.has('mic')) await rtc.replaceMicTrack(track);
  else if (rtc.joined) await rtc.produceMic(track, { music: settings.audio.music });

  state.micMeter = new MicMeter(state.micStream, onMicLevel);
  applyMicGate();
  refreshDeviceLists(); // labels become available after first grant
}

function stopMicStream() {
  state.micMeter?.stop(); state.micMeter = null;
  state.micStream?.getTracks().forEach((t) => t.stop());
  state.micStream = null;
}

function onMicLevel(level, db) {
  // settings meter
  const fill = $('mic-meter');
  if (fill && $('modal-settings').open) fill.style.width = `${Math.round(level * 100)}%`;

  if (settings.audio.mode === 'vad') vad.feed(db);

  // local speaking dot
  const transmitting = micTransmitting() &&
    (settings.audio.mode === 'ptt' ? state.pttDown : db >= settings.audio.vadDb);
  $('self-dot').classList.toggle('speaking', transmitting);
}

const micTransmitting = () => !state.muted && !state.deafened && rtc.producers.has('mic');

function applyMicGate() {
  const track = state.micStream?.getAudioTracks()[0];
  if (!track) return;
  const gateOpen = settings.audio.mode === 'ptt' ? state.pttDown : state.vadOpen;
  track.enabled = !state.muted && !state.deafened && gateOpen;
}

function setMuted(muted) {
  state.muted = muted;
  applyMicGate();
  $('btn-mute').classList.toggle('warn', muted);
  $('btn-mute').querySelector('span').textContent = muted ? 'Muted' : 'Mute';
  $('btn-rail-mute').classList.toggle('active', muted);
  broadcastState();
}

function setDeafened(deafened) {
  state.deafened = deafened;
  for (const el of document.querySelectorAll('#audio-sink audio')) el.muted = deafened;
  applyMicGate();
  $('btn-deafen').classList.toggle('warn', deafened);
  $('btn-deafen').querySelector('span').textContent = deafened ? 'Deafened' : 'Deafen';
  $('btn-rail-deafen').classList.toggle('active', deafened);
  broadcastState();
}

const broadcastState = () =>
  rtc.joined
    ? rtc.request('peer:state', {
        muted: state.muted, deafened: state.deafened,
        camOn: state.camOn, sharing: state.sharing
      }).catch(() => {})
    : Promise.resolve();

/* ────────────────────────────── camera ──────────────────────────────── */

async function toggleCam() {
  if (state.camOn) return stopCam();

  const camPreset = preset(settings.video.camPreset) || CAM_PRESETS[1];
  try {
    state.camStream = await getCamStream({
      deviceId: settings.video.camId || undefined,
      width: camPreset.width, height: camPreset.height, fps: camPreset.fps
    });
  } catch (err) {
    updateEmptyStage(`Camera unavailable (${err.name}). Pick another one in Settings → Video.`);
    return;
  }

  const track = state.camStream.getVideoTracks()[0];
  await rtc.produceCam(track, camPreset);
  attachTile('self', 'cam', `${settings.displayName} (you)`, new MediaStream([track]));
  track.addEventListener('ended', () => stopCam());

  state.camOn = true;
  $('btn-cam').classList.add('on');
  broadcastState();
  updateEmptyStage();
}

async function stopCam(silent = false) {
  if (!state.camOn && !state.camStream) return;
  await rtc.closeProducer('cam');
  state.camStream?.getTracks().forEach((t) => t.stop());
  state.camStream = null;
  removeTile('self', 'cam');
  state.camOn = false;
  $('btn-cam').classList.remove('on');
  if (!silent) { broadcastState(); updateEmptyStage(); }
}

/* ──────────────────────────── screen share ──────────────────────────── */

let pickedSource = null;

async function openSharePicker() {
  if (state.sharing) return stopShare();

  pickedSource = null;
  $('btn-share-start').disabled = true;

  // options
  const presetSel = $('share-preset');
  presetSel.textContent = '';
  for (const p of SCREEN_PRESETS) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.kbps ? `${p.label} — ~${fmtKbps(p.kbps)}` : p.label;
    presetSel.appendChild(o);
  }
  presetSel.value = settings.stream.preset;

  const codecSel = $('share-codec');
  codecSel.textContent = '';
  for (const c of VIDEO_CODECS) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c === 'auto' ? 'Auto (negotiate)' : c.toUpperCase();
    codecSel.appendChild(o);
  }
  codecSel.value = settings.stream.codec;
  $('share-optimize').value = settings.stream.optimize;

  const win = bridge.platform === 'win32';
  $('share-audio').disabled = !win;
  $('share-audio').checked = win;
  $('share-audio-note').textContent = win
    ? 'captures what Windows is playing'
    : 'system audio capture is Windows-only in v0.1 — your mic still works';

  $('modal-share').showModal();

  const grid = $('share-sources');
  grid.textContent = 'Looking for screens and windows…';
  const sources = await bridge.getScreenSources();
  grid.textContent = '';
  if (!sources.length) {
    grid.textContent = 'Nothing to share was found. On Wayland, approve the screen picker when it appears.';
    return;
  }

  for (const s of sources) {
    const btn = document.createElement('button');
    btn.className = 'share-src';
    btn.type = 'button';

    const img = document.createElement('img');
    img.className = 'thumb';
    if (s.thumbnail) img.src = s.thumbnail;
    btn.appendChild(img);

    const name = document.createElement('span');
    name.className = 'src-name';
    if (s.appIcon) {
      const ic = document.createElement('img');
      ic.className = 'appicon';
      ic.src = s.appIcon;
      name.appendChild(ic);
    }
    name.appendChild(document.createTextNode(s.name));
    btn.appendChild(name);

    btn.addEventListener('click', () => {
      grid.querySelectorAll('.picked').forEach((n) => n.classList.remove('picked'));
      btn.classList.add('picked');
      pickedSource = s;
      $('btn-share-start').disabled = false;
    });
    grid.appendChild(btn);
  }
}

async function startShare() {
  const p = preset($('share-preset').value) || preset('1080p30');
  settings.stream.preset = $('share-preset').value;
  settings.stream.codec = $('share-codec').value;
  settings.stream.optimize = $('share-optimize').value;
  saveSettings();

  const withAudio = $('share-audio').checked && bridge.platform === 'win32';
  await bridge.chooseShareSource({ id: pickedSource.id, withAudio });

  const video = p.width
    ? { width: { ideal: p.width }, height: { ideal: p.height }, frameRate: { ideal: p.fps } }
    : true;

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: withAudio });
  } catch (err) {
    updateEmptyStage(`Screen share failed (${err.name}). On Wayland, approve the portal dialog.`);
    $('modal-share').close();
    return;
  }
  $('modal-share').close();

  state.screenStream = stream;
  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0] || null;

  await rtc.produceScreen({
    videoTrack,
    audioTrack,
    preset: p,
    codecPref: settings.stream.codec,
    optimize: settings.stream.optimize
  });

  attachTile('self', 'screen', `${settings.displayName} (you)`, new MediaStream([videoTrack]), 'LIVE');
  videoTrack.addEventListener('ended', () => stopShare());

  state.sharing = true;
  $('btn-share').classList.add('on');
  $('btn-share').querySelector('span').textContent = 'Stop';
  broadcastState();
  updateEmptyStage();
}

async function stopShare(silent = false) {
  if (!state.sharing && !state.screenStream) return;
  await rtc.closeProducer('screen');
  await rtc.closeProducer('screen-audio');
  state.screenStream?.getTracks().forEach((t) => t.stop());
  state.screenStream = null;
  removeTile('self', 'screen');
  state.sharing = false;
  $('btn-share').classList.remove('on');
  $('btn-share').querySelector('span').textContent = 'Share';
  if (!silent) { broadcastState(); updateEmptyStage(); }
}

/* ─────────────────────────── tiles & audio ──────────────────────────── */

const tileKey = (peerId, tag) => `${peerId}:${tag}`;

function attachTile(peerId, tag, label, stream, badge = '') {
  removeTile(peerId, tag);
  const node = $('tpl-tile').content.firstElementChild.cloneNode(true);
  node.dataset.key = tileKey(peerId, tag);
  node.dataset.peer = peerId;
  node.querySelector('.who').textContent = label;
  node.querySelector('.badge').textContent = badge;
  node.querySelector('video').srcObject = stream;
  $('tile-grid').appendChild(node);
  updateEmptyStage();
}

function removeTile(peerId, tag) {
  document.querySelector(`.tile[data-key="${CSS.escape(tileKey(peerId, tag))}"]`)?.remove();
  updateEmptyStage();
}

const audioEls = (peerId) =>
  document.querySelectorAll(`#audio-sink audio[data-peer="${CSS.escape(peerId)}"]`);

function updateEmptyStage(message) {
  const hasTiles = Boolean(document.querySelector('#tile-grid .tile'));
  $('empty-stage').classList.toggle('hidden', hasTiles);
  if (message) $('empty-line').textContent = message;
  else if (!state.channelId) $('empty-line').textContent = 'Join a hall on the left to start talking.';
  else $('empty-line').textContent = 'Voices only so far. Share your screen or turn on your camera.';
}

rtc.on('consumer-added', ({ consumerId, peerId, mediaTag, kind, track }) => {
  const who = state.peers.get(peerId)?.name || 'someone';
  if (kind === 'video') {
    attachTile(peerId, mediaTag, who, new MediaStream([track]),
      mediaTag === 'screen' ? 'LIVE' : '');
  } else {
    const el = document.createElement('audio');
    el.autoplay = true;
    el.dataset.peer = peerId;
    el.dataset.consumer = consumerId;
    el.srcObject = new MediaStream([track]);
    el.volume = state.volumes.get(peerId) ?? 1;
    el.muted = state.deafened;
    applyOutput(el, settings.audio.outId);
    $('audio-sink').appendChild(el);
  }
});

rtc.on('consumer-closed', ({ consumerId, peerId, mediaTag }) => {
  document.querySelector(`#audio-sink audio[data-consumer="${CSS.escape(consumerId)}"]`)?.remove();
  if (mediaTag === 'cam' || mediaTag === 'screen') removeTile(peerId, mediaTag);
});

rtc.on('peer-joined', (p) => {
  state.peers.set(p.id, { name: p.name, state: p.state });
});

rtc.on('peer-left', ({ id }) => {
  state.peers.delete(id);
  for (const el of audioEls(id)) el.remove();
  document.querySelectorAll(`.tile[data-peer="${CSS.escape(id)}"]`).forEach((n) => n.remove());
  updateEmptyStage();
});

rtc.on('peer-state', ({ id, state: st }) => {
  const peer = state.peers.get(id);
  if (peer) peer.state = st;
  refreshRailStates();
});

rtc.on('channels', onDirectory);

rtc.on('speaker', ({ peerId }) => {
  document.querySelectorAll('.rail-peer').forEach((row) =>
    row.classList.toggle('speaking', row.dataset.peer === peerId));
  document.querySelectorAll('.tile').forEach((tile) =>
    tile.classList.toggle('speaking',
      tile.dataset.peer === peerId && tile.dataset.key.endsWith(':cam')));
});

/* ─────────────────────────── stats overlay ──────────────────────────── */

function statsLoop() {
  clearInterval(state.statsTimer);
  state.statsTimer = setInterval(async () => {
    const on = $('chk-stats').checked;
    for (const [consumerId, entry] of rtc.consumers) {
      if (entry.mediaTag !== 'cam' && entry.mediaTag !== 'screen') continue;
      const tile = document.querySelector(
        `.tile[data-key="${CSS.escape(tileKey(entry.peerId, entry.mediaTag))}"] .tile-stats`);
      if (!tile) continue;
      if (!on) { tile.classList.add('hidden'); continue; }
      const s = await rtc.consumerStats(consumerId);
      if (s) {
        tile.textContent = `${s.codec} ${s.width}x${s.height}@${s.fps}\n${fmtKbps(s.kbps)}`;
        tile.classList.remove('hidden');
      }
    }
    // Own outgoing streams: also show which encoder Chromium actually picked.
    for (const tag of ['cam', 'screen']) {
      const tile = document.querySelector(
        `.tile[data-key="${CSS.escape(tileKey('self', tag))}"] .tile-stats`);
      if (!tile) continue;
      if (!on) { tile.classList.add('hidden'); continue; }
      const s = await rtc.producerStats(tag);
      if (s) {
        tile.textContent =
          `${s.codec} ${s.width}x${s.height}@${s.fps}\n${fmtKbps(s.kbps)} · ${shortEncoder(s.encoder)}`;
        tile.classList.remove('hidden');
      }
    }
  }, 1000);
}

/* ───────────────────────────── settings ─────────────────────────────── */

function openSettings() {
  fillSettingsForm();
  refreshDeviceLists();
  refreshCrewTable();
  $('modal-settings').showModal();
}

function fillSettingsForm() {
  $('set-ec').checked = settings.audio.ec;
  $('set-ns').checked = settings.audio.ns;
  $('set-agc').checked = settings.audio.agc;
  $('set-music').checked = settings.audio.music;
  $('set-vad').checked = settings.audio.mode === 'vad';
  $('set-ptt').checked = settings.audio.mode === 'ptt';
  $('set-vad-th').value = settings.audio.vadDb;
  $('vad-th-label').textContent = `${settings.audio.vadDb} dB`;
  positionVadMark();
  $('ptt-label').textContent = settings.audio.ptt?.label || 'not set';

  const camSel = $('set-cam-preset');
  camSel.textContent = '';
  for (const p of CAM_PRESETS) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = `${p.label} — ~${fmtKbps(p.kbps)}`;
    camSel.appendChild(o);
  }
  camSel.value = settings.video.camPreset;

  const sp = $('set-stream-preset');
  sp.textContent = '';
  for (const p of SCREEN_PRESETS) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.kbps ? `${p.label} — ~${fmtKbps(p.kbps)}` : p.label;
    sp.appendChild(o);
  }
  sp.value = settings.stream.preset;

  const sc = $('set-stream-codec');
  sc.textContent = '';
  for (const c of VIDEO_CODECS) {
    const o = document.createElement('option');
    o.value = c; o.textContent = c === 'auto' ? 'Auto (negotiate)' : c.toUpperCase();
    sc.appendChild(o);
  }
  sc.value = settings.stream.codec;

  $('net-up').value = settings.net.upMbps || '';
  $('net-hostup').value = settings.net.hostUpMbps || '';
  $('net-people').value = settings.net.people;
  $('net-sharers').value = settings.net.sharers;

  bridge.pttAvailable().then((ok) => {
    $('ptt-scope').textContent = ok
      ? 'works even while gaming (global hook)'
      : 'global hook unavailable — key works while Hearth is focused';
  });
}

async function refreshDeviceLists() {
  const { mics, outputs, cams } = await listDevices().catch(() => ({ mics: [], outputs: [], cams: [] }));
  fillDeviceSelect($('set-mic'), mics, settings.audio.inId, 'Microphone');
  fillDeviceSelect($('set-out'), outputs, settings.audio.outId, 'Output');
  fillDeviceSelect($('set-cam'), cams, settings.video.camId, 'Camera');
}

function fillDeviceSelect(sel, devices, currentId, fallback) {
  sel.textContent = '';
  const def = document.createElement('option');
  def.value = ''; def.textContent = 'System default';
  sel.appendChild(def);
  devices.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `${fallback} ${i + 1}`;
    sel.appendChild(o);
  });
  sel.value = currentId && [...sel.options].some((o) => o.value === currentId) ? currentId : '';
}

function positionVadMark() {
  const pct = ((settings.audio.vadDb - -70) / (-20 - -70)) * 100;
  $('vad-mark').style.left = `${pct}%`;
}

async function onAudioSettingsChanged() {
  settings.audio.inId = $('set-mic').value;
  settings.audio.ec = $('set-ec').checked;
  settings.audio.ns = $('set-ns').checked;
  settings.audio.agc = $('set-agc').checked;
  settings.audio.music = $('set-music').checked;
  saveSettings();
  if (state.micStream || rtc.joined) await startMic();
}

async function bindPtt() {
  $('ptt-label').textContent = 'press a key or mouse button…';
  let binding = await bridge.captureNextInput();

  if (!binding) {
    // Fallback: capture inside the window.
    binding = await new Promise((resolve) => {
      const onKey = (e) => {
        e.preventDefault();
        window.removeEventListener('keydown', onKey, true);
        resolve({ type: 'focus', code: e.code, label: `${e.code} (focused)` });
      };
      window.addEventListener('keydown', onKey, true);
      setTimeout(() => {
        window.removeEventListener('keydown', onKey, true);
        resolve(null);
      }, 10_000);
    });
  }

  if (binding) {
    settings.audio.ptt = binding;
    saveSettings();
    if (binding.type !== 'focus') await bridge.setPttBinding(binding);
  }
  $('ptt-label').textContent = settings.audio.ptt?.label || 'not set';
}

function toggleMicTest() {
  if (state.micTestEl) {
    state.micTestEl.remove();
    state.micTestEl = null;
    $('btn-mic-test').textContent = 'Test mic';
    return;
  }
  if (!state.micStream) return;
  const el = document.createElement('audio');
  el.autoplay = true;
  el.srcObject = state.micStream;
  applyOutput(el, settings.audio.outId);
  $('audio-sink').appendChild(el);
  state.micTestEl = el;
  $('btn-mic-test').textContent = 'Stop test';
}

/* ─────────────────────── speed test & advice ────────────────────────── */

async function runSpeedTest() {
  if (!rtc.socket?.connected) return;
  $('btn-speedtest').disabled = true;
  const phase = $('speedtest-phase');
  try {
    const res = await runFullTest({
      baseUrl: rtc.baseUrl,
      socket: rtc.socket,
      name: settings.displayName,
      onPhase: (p) => { phase.textContent = `testing ${p}…`; }
    });
    phase.textContent = '';
    $('net-results').textContent =
      `ping ${res.pingMs} ms · down ${res.downMbps} Mbps · up ${res.upMbps} Mbps`;
    settings.net.upMbps = res.upMbps;
    $('net-up').value = res.upMbps;
    saveSettings();
    refreshCrewTable();
  } catch (err) {
    phase.textContent = `failed: ${err.message}`;
  } finally {
    $('btn-speedtest').disabled = false;
  }
}

async function refreshCrewTable() {
  if (!rtc.baseUrl) return;
  const reports = await fetchCrewReports(rtc.baseUrl).catch(() => []);
  const table = $('crew-table');
  table.textContent = '';
  if (!reports.length) {
    table.innerHTML = '<tr><td>No reports yet — each person can run the test from this tab.</td></tr>';
    return;
  }
  table.innerHTML = '<tr><th>who</th><th>up</th><th>down</th><th>ping</th></tr>';
  for (const r of reports) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(r.name)}</td><td>${r.upMbps} Mbps</td>` +
      `<td>${r.downMbps} Mbps</td><td>${r.pingMs} ms</td>`;
    table.appendChild(tr);
  }
}

function runRecommend() {
  settings.net.upMbps = Number($('net-up').value) || 0;
  settings.net.hostUpMbps = Number($('net-hostup').value) || 0;
  settings.net.people = Number($('net-people').value) || 8;
  settings.net.sharers = Number($('net-sharers').value) || 1;
  saveSettings();

  const reco = recommend({
    clientUpMbps: settings.net.upMbps,
    hostUpMbps: settings.net.hostUpMbps,
    people: settings.net.people,
    sharers: settings.net.sharers
  });
  state.lastReco = reco;

  const out = $('reco-out');
  out.textContent = '';

  const verdict = document.createElement('p');
  verdict.className = 'verdict';
  if (!reco.perStreamKbps) {
    verdict.innerHTML = 'Enter at least your upload (run the test) to get a verdict.';
  } else if (!reco.best) {
    verdict.innerHTML = `Budget is <b>${fmtKbps(reco.perStreamKbps)}</b> per stream — ` +
      `below 480p30. Reduce simultaneous streams or viewers.`;
  } else {
    verdict.innerHTML =
      `Best fit: <b>${reco.best.label}</b> · budget ${fmtKbps(reco.perStreamKbps)} per stream ` +
      `(${reco.viewers} viewers × ${reco.sharers} stream${reco.sharers > 1 ? 's' : ''}, ` +
      `limited by ${reco.limitedBy})` +
      (reco.hostUnknown ? ' — host upload unknown, so only your side was checked' : '');
  }
  out.appendChild(verdict);

  const table = document.createElement('table');
  table.innerHTML = '<tr><th>preset</th><th>needs</th><th>verdict</th></tr>';
  for (const row of reco.rows) {
    const tr = document.createElement('tr');
    if (reco.best && row.id === reco.best.id) tr.className = 'pick';
    tr.innerHTML = `<td>${row.label}</td><td>${fmtKbps(row.kbps)}</td>` +
      `<td class="${row.ok ? 'yes' : 'no'}">${row.ok ? 'fits' : 'over budget'}</td>`;
    table.appendChild(tr);
  }
  out.appendChild(table);

  $('btn-apply-reco').disabled = !reco.best;
}

function applyReco() {
  if (!state.lastReco?.best) return;
  settings.stream.preset = state.lastReco.best.id;
  saveSettings();
  $('set-stream-preset').value = settings.stream.preset;
}

/** "libaom" → "sw:libaom" · "MediaFoundationVideoEncodeAccelerator" → "hw:MediaFoundation" */
const shortEncoder = (e) => {
  if (!e || e === '?') return '';
  const hw = /MediaFoundation|VideoToolbox|Vaapi|V4L2|NVENC|AMF/i.test(e);
  const name =
    e.replace(/VideoEncodeAccelerator|EncodeAccelerator|VideoEncoder/g, '')
      .split('(')[0].trim() || e;
  return `${hw ? 'hw' : 'sw'}:${name}`;
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ───────────────────────── reconnect handling ───────────────────────── */

let banner = null;
let lastChannel = null;

rtc.on('disconnected', () => {
  if (!state.connected) return;
  lastChannel = state.channelId;
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'banner';
    banner.textContent = 'Connection to the hall lost — reconnecting…';
    document.body.appendChild(banner);
  }
});

rtc.on('reconnected', async () => {
  banner?.remove(); banner = null;
  // Server-side peer state is gone; rebuild from scratch.
  const rejoin = lastChannel;
  state.channelId = null;
  for (const el of document.querySelectorAll('#tile-grid .tile')) el.remove();
  $('audio-sink').textContent = '';
  const dir = await rtc.channels().catch(() => []);
  onDirectory(dir);
  if (rejoin) await joinChannel(rejoin).catch(console.error);
});

/* ────────────────────────────── wiring ──────────────────────────────── */

function wire() {
  $('btn-connect').addEventListener('click', doConnect);
  $('in-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') doConnect(); });
  $('in-server').value = settings.serverUrl;
  $('in-name').value = settings.displayName;

  $('channel-list').addEventListener('click', (e) => {
    const ch = e.target.closest('.channel');
    if (ch) joinChannel(ch.dataset.id).catch((err) => updateEmptyStage(err.message));
  });

  $('btn-mute').addEventListener('click', () => setMuted(!state.muted));
  $('btn-rail-mute').addEventListener('click', () => setMuted(!state.muted));
  $('btn-deafen').addEventListener('click', () => setDeafened(!state.deafened));
  $('btn-rail-deafen').addEventListener('click', () => setDeafened(!state.deafened));
  $('btn-cam').addEventListener('click', () => toggleCam().catch(console.error));
  $('btn-share').addEventListener('click', () => openSharePicker().catch(console.error));
  $('btn-leave').addEventListener('click', () => leaveChannel().catch(console.error));
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-rail-settings').addEventListener('click', openSettings);

  // share modal
  $('btn-share-cancel').addEventListener('click', () => $('modal-share').close());
  $('btn-share-start').addEventListener('click', () => startShare().catch(console.error));

  // settings modal
  $('btn-settings-close').addEventListener('click', () => {
    if (state.micTestEl) toggleMicTest();
    $('modal-settings').close();
  });
  document.querySelectorAll('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-panel').forEach((p) =>
        p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.tab));
    }));

  for (const id of ['set-mic', 'set-ec', 'set-ns', 'set-agc', 'set-music']) {
    $(id).addEventListener('change', () => onAudioSettingsChanged().catch(console.error));
  }
  $('set-out').addEventListener('change', () => {
    settings.audio.outId = $('set-out').value;
    saveSettings();
    for (const el of document.querySelectorAll('#audio-sink audio')) {
      applyOutput(el, settings.audio.outId);
    }
  });
  $('set-vad').addEventListener('change', () => { settings.audio.mode = 'vad'; saveSettings(); applyMicGate(); });
  $('set-ptt').addEventListener('change', () => { settings.audio.mode = 'ptt'; saveSettings(); applyMicGate(); });
  $('set-vad-th').addEventListener('input', () => {
    settings.audio.vadDb = Number($('set-vad-th').value);
    $('vad-th-label').textContent = `${settings.audio.vadDb} dB`;
    vad.setThreshold(settings.audio.vadDb);
    positionVadMark();
    saveSettings();
  });
  $('btn-ptt-bind').addEventListener('click', () => bindPtt().catch(console.error));
  $('btn-mic-test').addEventListener('click', toggleMicTest);

  $('set-cam').addEventListener('change', () => { settings.video.camId = $('set-cam').value; saveSettings(); });
  $('set-cam-preset').addEventListener('change', () => { settings.video.camPreset = $('set-cam-preset').value; saveSettings(); });
  $('set-stream-preset').addEventListener('change', () => { settings.stream.preset = $('set-stream-preset').value; saveSettings(); });
  $('set-stream-codec').addEventListener('change', () => { settings.stream.codec = $('set-stream-codec').value; saveSettings(); });

  $('btn-speedtest').addEventListener('click', () => runSpeedTest());
  $('btn-recommend').addEventListener('click', runRecommend);
  $('btn-apply-reco').addEventListener('click', applyReco);

  $('chk-stats').addEventListener('change', statsLoop);

  // Global PTT from the main process.
  bridge.onPtt((down) => { state.pttDown = down; applyMicGate(); });
  if (settings.audio.ptt && settings.audio.ptt.type !== 'focus') {
    bridge.setPttBinding(settings.audio.ptt);
  }
  // Focus-mode PTT fallback.
  window.addEventListener('keydown', (e) => {
    if (settings.audio.ptt?.type === 'focus' && e.code === settings.audio.ptt.code &&
        !e.repeat && !isTyping(e)) {
      state.pttDown = true; applyMicGate();
    }
    // quick keys
    if (isTyping(e) || $('modal-settings').open || $('modal-share').open) return;
    if (e.code === 'KeyM' && state.channelId) setMuted(!state.muted);
    if (e.code === 'KeyD' && state.channelId) setDeafened(!state.deafened);
  });
  window.addEventListener('keyup', (e) => {
    if (settings.audio.ptt?.type === 'focus' && e.code === settings.audio.ptt.code) {
      state.pttDown = false; applyMicGate();
    }
  });

  statsLoop();
}

const isTyping = (e) =>
  ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target?.tagName);

wire();
