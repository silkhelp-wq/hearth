/**
 * Hearth renderer application — glue between the UI skeleton, HearthRTC,
 * the chat module, the audio toolkit, and the Electron bridge.
 */

import { HearthRTC } from './rtc.js';
import { listDevices, getMicStream, getCamStream, MicMeter, VadGate, applyOutput } from './audio.js';
import { SCREEN_PRESETS, CAM_PRESETS, VIDEO_CODECS, preset, OPUS_KBPS } from './presets.js';
import { recommend, fmtKbps } from './recommend.js';
import { runFullTest, fetchCrewReports } from './speedtest.js';
import { createChat } from './chat.js';
import { mentionsMe } from './markdown.js';
import { P, ALL, PERM_LABELS, has, basePerms } from './permbits.js';

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
  identity: { token: '' },
  audio: {
    inId: '', outId: '',
    ec: true, ns: true, agc: true, music: false, bitrate: 128000,
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
      identity: { ...DEFAULTS.identity, ...raw.identity },
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

/** Device identity: one random token per install. New token = new person. */
function ensureToken() {
  if (!settings.identity.token || settings.identity.token.length < 24) {
    const rand = crypto.getRandomValues(new Uint8Array(16));
    settings.identity.token = `${crypto.randomUUID()}-${[...rand]
      .map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    saveSettings();
  }
  return settings.identity.token;
}

/* ─────────────────────────────── state ──────────────────────────────── */

const rtc = new HearthRTC();

const state = {
  connected: false,
  me: null,               // {id, name, isOwner}
  users: new Map(),       // userId -> {id, name, isOwner, roleIds, online}
  roles: [],
  dirMap: new Map(),      // channelId -> directory entry (with myPerms)
  viewId: null,           // channel currently on the stage (text or voice)
  unread: new Map(),      // channelId -> {count, mention}
  readState: {},          // channelId -> last read message id
  ownerClaimed: true,
  serverMutedMe: false,
  canSpeak: true,
  channelId: null,        // connected voice channel
  channelName: '',
  peers: new Map(),       // peerId -> {name, userId, state}
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
  volumes: new Map(),     // peerId -> 0..1
  lastReco: null,
  statsTimer: null,
  editingChannel: null,
  editingRole: null,
  accessDraft: null,      // roleId -> {perm -> 'inherit'|'allow'|'deny'}
  caps: {},               // server capabilities from hello
  emojis: [],             // custom server emojis
  jb: null,               // jukebox state for the connected voice channel
  localMuted: new Map(),  // peerId -> previous volume (mute-for-me)
  pendingAfterHello: null // {voice, view} rejoin targets after reconnect
};

const vad = new VadGate({
  thresholdDb: settings.audio.vadDb,
  onOpen: () => { state.vadOpen = true; applyMicGate(); },
  onClose: () => { state.vadOpen = false; applyMicGate(); }
});

const myBasePerms = () =>
  basePerms(state.me, state.roles, state.users.get(state.me?.id)?.roleIds || []);

/* ─────────────────────────────── chat ───────────────────────────────── */

const chat = createChat({
  rtc,
  getMe: () => state.me || { id: '', name: settings.displayName },
  getUsers: () => state.users,
  getRoles: () => state.roles,
  getChannel: (id) => state.dirMap.get(id),
  getEmojis: () => state.emojis,
  getCaps: () => state.caps,
  getBaseUrl: () => rtc.baseUrl,
  onIncoming,
  onRead
});

function onIncoming(channelId, m) {
  if (!state.me || m.authorId === state.me.id) return;
  const cur = state.unread.get(channelId) || { count: 0, mention: false };
  cur.count += 1;
  if (mentionsMe(m.content, state.me.name)) { cur.mention = true; playPing(); }
  state.unread.set(channelId, cur);
  renderRail();
}

function onRead(channelId, lastId) {
  state.readState[channelId] = Math.max(state.readState[channelId] || 0, lastId);
  state.unread.delete(channelId);
  renderRail();
}

let pingCtx = null;
function playPing() {
  try {
    pingCtx = pingCtx || new AudioContext();
    const t = pingCtx.currentTime;
    for (const [freq, at] of [[880, 0], [660, 0.09]]) {
      const osc = pingCtx.createOscillator();
      const gain = pingCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + at);
      gain.gain.exponentialRampToValueAtTime(0.12, t + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.16);
      osc.connect(gain).connect(pingCtx.destination);
      osc.start(t + at); osc.stop(t + at + 0.18);
    }
  } catch { /* audio not ready */ }
}

/* ─────────────────────────── connect screen ─────────────────────────── */

function logLine(text, cls = '') {
  const log = $('connect-log');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text + '\n';
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

let rawWired = false;
let helloResolve = null;

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
    await rtc.connect(url, { token: ensureToken(), name });
    HearthRTC.audioBitrate = settings.audio.bitrate || 128000;
    if (!rawWired) { wireRaw(); chat.wire(); rawWired = true; }

    const hello = await new Promise((resolve, reject) => {
      helloResolve = resolve;
      setTimeout(() => reject(new Error('server never said hello — is it v0.2+?')), 8000);
    });
    logLine(`> linked · ${Math.round(performance.now() - t0)} ms`, 'ok');

    const online = hello.channels.reduce((n, c) => n + c.peers.length, 0);
    logLine(`> ${hello.serverName || 'hall'} is open — ${online} in voice`, 'ok');
    if (!hello.ownerClaimed) {
      logLine('> this hall has no owner yet — the claim code is in the server console', 'ok');
    }

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

/* ─────────────────────────── hello / directory ──────────────────────── */

function applyHello(h) {
  state.me = h.user;
  state.roles = h.roles || [];
  state.users = new Map((h.users || []).map((u) => [u.id, u]));
  state.readState = h.readState || {};
  state.ownerClaimed = !!h.ownerClaimed;
  state.caps = h.caps || {};
  state.emojis = h.emojis || [];
  $('server-name').textContent = h.serverName || 'Hearth';
  $('self-name').textContent = state.me.name;

  applyDirectory(h.channels || []);
  renderServerPanel();

  const after = state.pendingAfterHello;
  state.pendingAfterHello = null;
  if (after?.voice && state.dirMap.has(after.voice)) {
    joinChannel(after.voice).catch(console.error);
  }
  if (after?.view) {
    const ch = state.dirMap.get(after.view);
    if (ch?.type === 'text') viewText(ch);
  }
}

function applyDirectory(dir) {
  state.directory = dir;
  state.dirMap = new Map(dir.map((c) => [c.id, c]));

  // Viewed channel vanished (deleted or hidden by an overwrite)?
  if (state.viewId && !state.dirMap.has(state.viewId)) {
    if (chat.current() === state.viewId) chat.close();
    state.viewId = null;
    showStage();
    updateEmptyStage('That channel is gone.');
  }
  renderRail();
  chat.refreshPermsUI();
  updateVoiceStrip();

  const bp = myBasePerms();
  $('btn-add-text').classList.toggle('hidden', !has(bp, P.CREATE_CHANNELS));
  $('btn-add-voice').classList.toggle('hidden', !has(bp, P.CREATE_CHANNELS));
  if (state.viewId) {
    const ch = state.dirMap.get(state.viewId);
    $('chat-edit-btn').classList.toggle('hidden',
      !(ch?.type === 'text' && has(ch.myPerms, P.MANAGE_CHANNELS)));
  }
}

/* ──────────────────────────── channel rail ──────────────────────────── */

function renderRail() {
  renderTextList();
  renderVoiceList();
}

function chanTools(ch) {
  const tools = document.createElement('span');
  tools.className = 'chan-tools';
  if (has(ch.myPerms, P.MANAGE_CHANNELS)) {
    const edit = document.createElement('button');
    edit.className = 'edit'; edit.textContent = '⚙'; edit.title = 'Channel settings';
    edit.addEventListener('click', (e) => { e.stopPropagation(); openChannelEdit(ch); });
    tools.appendChild(edit);

    const del = document.createElement('button');
    del.textContent = '🗑'; del.title = 'Delete channel';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const what = ch.type === 'text' ? `#${ch.name} and all its messages` : `the ${ch.name} hall`;
      if (!confirm(`Delete ${what}? This cannot be undone.`)) return;
      rtc.request('channel:delete', { channelId: ch.id }).catch((err) => alert(err.message));
    });
    tools.appendChild(del);
  }
  return tools;
}

function renderTextList() {
  const list = $('text-list');
  list.textContent = '';
  for (const ch of state.directory.filter((c) => c.type === 'text')) {
    const el = document.createElement('div');
    el.className = 'channel chan-row' + (ch.id === state.viewId ? ' current' : '');
    el.dataset.id = ch.id;

    const nameRow = document.createElement('div');
    nameRow.className = 'channel-name';
    const label = document.createElement('span');
    label.className = 'chan-name';
    label.textContent = `# ${ch.name}`;
    nameRow.appendChild(label);
    nameRow.appendChild(chanTools(ch));

    const info = state.unread.get(ch.id);
    const read = state.readState[ch.id] || 0;
    if (info?.count) {
      const b = document.createElement('span');
      b.className = 'chan-badge' + (info.mention ? ' mention' : '');
      b.textContent = info.count > 99 ? '99+' : String(info.count);
      nameRow.appendChild(b);
      el.classList.add('unread');
    } else if ((ch.lastMessageId || 0) > read) {
      const d = document.createElement('span');
      d.className = 'chan-dot';
      nameRow.appendChild(d);
      el.classList.add('unread');
    }

    el.appendChild(nameRow);
    el.addEventListener('click', () => viewText(ch));
    list.appendChild(el);
  }
}

function renderVoiceList() {
  const list = $('channel-list');
  list.textContent = '';

  for (const ch of state.directory.filter((c) => c.type === 'voice')) {
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
    nameRow.appendChild(chanTools(ch));
    el.appendChild(nameRow);

    if (ch.peers.length) {
      const peersBox = document.createElement('div');
      peersBox.className = 'channel-peers';
      for (const p of ch.peers) peersBox.appendChild(railPeerRow(p, ch.id));
      el.appendChild(peersBox);
    }
    el.addEventListener('click', () => {
      if (ch.id === state.channelId) showStage();
      else joinChannel(ch.id).catch((err) => updateEmptyStage(err.message));
    });
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

  // Volume lives in the right-click menu now (works for the jukebox too).
  refreshPeerFlags(row, p.id, p.state);
  return row;
}

function refreshPeerFlags(row, peerId, fallbackState = null) {
  const st = state.peers.get(peerId)?.state || fallbackState;
  const flags = row.querySelector('.flags');
  if (!st || !flags) return;
  flags.textContent =
    (st.serverMuted ? '🔕' : st.deafened ? '⛔' : st.muted ? '🔇' : '') +
    (st.sharing ? ' 🖥' : '');
}

function refreshRailStates() {
  document.querySelectorAll('.rail-peer').forEach((row) =>
    refreshPeerFlags(row, row.dataset.peer));
}

/* ─────────────────────────── stage switching ────────────────────────── */

function viewText(ch) {
  state.viewId = ch.id;
  $('stage-head').classList.add('hidden');
  $('tile-grid').classList.add('hidden');
  $('empty-stage').classList.add('hidden');
  $('chat-edit-btn').classList.toggle('hidden', !has(ch.myPerms, P.MANAGE_CHANNELS));
  chat.open(ch).catch((err) => console.error('[chat]', err));
  renderRail();
}

function showStage() {
  chat.close();
  state.viewId = state.channelId;
  $('stage-head').classList.remove('hidden');
  $('tile-grid').classList.remove('hidden');
  updateEmptyStage();
  renderRail();
}

/* ─────────────────────────── join / leave ───────────────────────────── */

async function joinChannel(channelId) {
  if (channelId === state.channelId) return;

  if (state.channelId) await leaveChannel({ keepMic: true });

  const { peers, canSpeak, jukebox: jbState } = await rtc.join(channelId);
  state.channelId = channelId;
  state.canSpeak = canSpeak;
  state.jb = jbState || null;
  state.channelName = state.dirMap.get(channelId)?.name || 'hall';

  state.peers.clear();
  for (const p of peers) state.peers.set(p.id, { name: p.name, userId: p.userId, state: p.state });

  $('stage-title').textContent = state.channelName;
  $('controls').classList.remove('hidden');
  updateVoiceStrip();
  updateJukeboxBar();

  // Discord behavior: connecting to voice while reading a text channel
  // keeps the text view — the rail strip shows the connection. The stage
  // takes over only when no text channel is open.
  const viewingText = state.viewId &&
    state.dirMap.get(state.viewId)?.type === 'text';
  if (viewingText) renderRail();
  else showStage();

  if (canSpeak && !state.serverMutedMe) {
    await startMic();
  } else {
    stopMicStream();
    updateEmptyStage(state.serverMutedMe
      ? 'A moderator muted you — you can listen, but not speak.'
      : 'You can listen here, but you do not have permission to speak.');
  }
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
  state.canSpeak = true;
  $('stage-title').textContent = 'Pick a hall';
  $('controls').classList.add('hidden');

  if (!keepMic) stopMicStream();
  state.jb = null;
  updateVoiceStrip();
  updateJukeboxBar();
  if (state.viewId === null || !state.dirMap.get(state.viewId) ||
      state.dirMap.get(state.viewId)?.type === 'voice') {
    state.viewId = null;
    updateEmptyStage();
    renderRail();
  }
}

/** Rail strip mirroring Discord's "Voice Connected" panel. */
function updateVoiceStrip() {
  const strip = $('voice-strip');
  strip.classList.toggle('hidden', !state.channelId);
  if (state.channelId) {
    $('vs-channel').textContent =
      state.dirMap.get(state.channelId)?.name || state.channelName;
  }
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
  else if (rtc.joined && state.canSpeak && !state.serverMutedMe) {
    await rtc.produceMic(track, { music: settings.audio.music });
  }

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

const micTransmitting = () =>
  !state.muted && !state.deafened && !state.serverMutedMe && rtc.producers.has('mic');

function applyMicGate() {
  const track = state.micStream?.getAudioTracks()[0];
  if (!track) return;
  const gateOpen = settings.audio.mode === 'ptt' ? state.pttDown : state.vadOpen;
  track.enabled = !state.muted && !state.deafened && !state.serverMutedMe && gateOpen;
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

function setServerMuted(muted) {
  state.serverMutedMe = muted;
  applyMicGate();
  let chip = $('srv-muted-chip');
  if (muted) {
    if (!chip) {
      chip = document.createElement('span');
      chip.id = 'srv-muted-chip';
      chip.className = 'srv-muted-chip';
      chip.textContent = 'muted by moderator';
      $('controls').prepend(chip);
    }
  } else {
    chip?.remove();
    // Producer was closed server-side; bring the mic back if allowed.
    const track = state.micStream?.getAudioTracks()[0];
    if (track && rtc.joined && state.canSpeak && !rtc.producers.has('mic')) {
      rtc.produceMic(track, { music: settings.audio.music }).catch(console.error);
    }
  }
}

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

  const plat = bridge.platform;
  $('share-audio').disabled = false;
  $('share-audio').checked = plat === 'win32';
  $('share-audio-note').textContent =
    plat === 'win32' ? 'captures what Windows is playing'
    : plat === 'darwin' ? 'macOS needs a loopback driver (e.g. BlackHole) selected as output'
    : 'Linux: tick to try the desktop-audio portal; if silent, route audio through a PipeWire virtual mic and pick it as your microphone instead';

  $('modal-share').showModal();

  const grid = $('share-sources');
  grid.textContent = 'Looking for screens and windows…';
  const sources = await bridge.getScreenSources();
  grid.textContent = '';
  if (!sources.length) {
    grid.textContent = 'Nothing to share was found. On Wayland, approve the screen picker when it appears.';
    return;
  }
  if (bridge.platform === 'win32' && sources.every((s) => !s.thumbnail)) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent =
      'Windows returned no previews — capture access looks blocked. ' +
      'If Hearth was launched from an Administrator terminal, close it and use a normal one. ' +
      'On Windows 11 24H2+, also check Settings → Privacy & security → screen-capture permissions, then update the GPU driver.';
    grid.appendChild(note);
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

  const withAudio = $('share-audio').checked;
  await bridge.chooseShareSource({ id: pickedSource.id, withAudio });

  const video = p.width
    ? { width: { ideal: p.width }, height: { ideal: p.height }, frameRate: { ideal: p.fps } }
    : true;

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: withAudio });
  } catch (err) {
    const winHint = bridge.platform === 'win32'
      ? ' Windows blocked the capture — don\u2019t launch Hearth from an Administrator terminal, and check Settings → Privacy & security → screen-capture permissions (Win11 24H2+).'
      : ' On Wayland, approve the portal dialog.';
    updateEmptyStage(`Screen share failed (${err.name}).${winHint}`);
    $('modal-share').close();
    return;
  }
  $('modal-share').close();

  state.screenStream = stream;
  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0] || null;

  // Requested audio but the OS/portal didn't provide it (common on Linux).
  if (withAudio && !audioTrack && bridge.platform !== 'win32') {
    updateEmptyStage('Sharing — but your system didn\u2019t hand over desktop audio. ' +
      'To share sound on Linux, route it through a PipeWire virtual mic and select ' +
      'that as your microphone in Settings → Audio.');
  }

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

/* ─────────────────── stream theater / pop-out viewer ────────────────── */

const theater = { key: null, drag: null, resize: null };

function openTheater(peerId, tag, label, stream) {
  const el = $('theater');
  theater.key = tileKey(peerId, tag);
  $('th-title').textContent = label;
  const v = $('th-video');
  v.srcObject = stream;
  v.muted = true; // audio still comes through the voice path, not this element
  el.classList.remove('hidden');
  if (el.dataset.mode === 'full') exitFsMode();
  if (!el.style.width) {                 // first open → sensible float size/pos
    el.style.width = '480px';
    el.style.height = '300px';
    el.style.left = (window.innerWidth - 520) + 'px';
    el.style.top = '90px';
  }
}

function closeTheater() {
  $('theater').classList.add('hidden');
  $('th-video').srcObject = null;
  theater.key = null;
  if ($('theater').dataset.mode === 'full') exitFsMode();
}

function setTheaterMode(mode) {
  const el = $('theater');
  if (mode === 'fit') {
    el.dataset.mode = 'fit';
    el.style.left = el.style.top = el.style.width = el.style.height = '';
  } else {
    el.dataset.mode = 'float';
    if (!el.style.width) {
      el.style.width = '480px'; el.style.height = '300px';
      el.style.left = (window.innerWidth - 520) + 'px'; el.style.top = '90px';
    }
  }
}

function toggleFullscreen() {
  const el = $('theater');
  if (document.fullscreenElement) { document.exitFullscreen(); return; }
  el.dataset.prevMode = el.dataset.mode;
  el.dataset.mode = 'full';
  el.requestFullscreen?.().catch(() => {});
}

function exitFsMode() {
  const el = $('theater');
  el.dataset.mode = el.dataset.prevMode || 'float';
}

function wireTheater() {
  $('th-close').addEventListener('click', closeTheater);
  $('th-fit').addEventListener('click', () =>
    setTheaterMode($('theater').dataset.mode === 'fit' ? 'float' : 'fit'));
  $('th-full').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) exitFsMode();
  });

  // Drag by the title bar (float mode only).
  $('theater').querySelector('.th-bar').addEventListener('mousedown', (e) => {
    const el = $('theater');
    if (el.dataset.mode !== 'float' || e.target.closest('.th-btn')) return;
    const r = el.getBoundingClientRect();
    theater.drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.preventDefault();
  });

  // Resize from the corner grip (float mode only).
  $('th-resize').addEventListener('mousedown', (e) => {
    const el = $('theater');
    if (el.dataset.mode !== 'float') return;
    const r = el.getBoundingClientRect();
    theater.resize = { w: r.width, h: r.height, x: e.clientX, y: e.clientY };
    e.preventDefault();
    e.stopPropagation();
  });

  window.addEventListener('mousemove', (e) => {
    const el = $('theater');
    if (theater.drag) {
      const x = Math.max(0, Math.min(e.clientX - theater.drag.dx, window.innerWidth - 120));
      const y = Math.max(0, Math.min(e.clientY - theater.drag.dy, window.innerHeight - 40));
      el.style.left = x + 'px'; el.style.top = y + 'px';
    } else if (theater.resize) {
      el.style.width = Math.max(240, theater.resize.w + (e.clientX - theater.resize.x)) + 'px';
      el.style.height = Math.max(160, theater.resize.h + (e.clientY - theater.resize.y)) + 'px';
    }
  });
  window.addEventListener('mouseup', () => { theater.drag = null; theater.resize = null; });
}


function attachTile(peerId, tag, label, stream, badge = '') {
  removeTile(peerId, tag);
  const node = $('tpl-tile').content.firstElementChild.cloneNode(true);
  node.dataset.key = tileKey(peerId, tag);
  node.dataset.peer = peerId;
  node.dataset.tag = tag;
  node.querySelector('.who').textContent = label;
  node.querySelector('.badge').textContent = badge;
  node.querySelector('video').srcObject = stream;
  node.title = 'Click to pop out';
  node.addEventListener('dblclick', () => openTheater(peerId, tag, label, stream));
  const expand = document.createElement('button');
  expand.className = 'tile-expand';
  expand.textContent = '⛶';
  expand.title = 'Pop out';
  expand.addEventListener('click', (e) => {
    e.stopPropagation();
    openTheater(peerId, tag, label, stream);
  });
  node.appendChild(expand);
  $('tile-grid').appendChild(node);
  updateEmptyStage();
}

function removeTile(peerId, tag) {
  document.querySelector(`.tile[data-key="${CSS.escape(tileKey(peerId, tag))}"]`)?.remove();
  if (theater.key === tileKey(peerId, tag)) closeTheater();
  updateEmptyStage();
}

const audioEls = (peerId) =>
  document.querySelectorAll(`#audio-sink audio[data-peer="${CSS.escape(peerId)}"]`);

function updateEmptyStage(message) {
  if (state.viewId && state.dirMap.get(state.viewId)?.type === 'text') return;
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
  state.peers.set(p.id, { name: p.name, userId: p.userId, state: p.state });
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

rtc.on('speaker', ({ peerId }) => {
  document.querySelectorAll('.rail-peer').forEach((row) =>
    row.classList.toggle('speaking', row.dataset.peer === peerId));
  document.querySelectorAll('.tile').forEach((tile) =>
    tile.classList.toggle('speaking',
      tile.dataset.peer === peerId && tile.dataset.key.endsWith(':cam')));
});

/* ──────────────────────── v0.2 raw server events ────────────────────── */

function wireRaw() {
  rtc.onRaw('hello', (h) => {
    applyHello(h);
    helloResolve?.(h);
    helloResolve = null;
  });

  rtc.onRaw('dir:dirty', async () => {
    const list = await rtc.request('channels:list').catch(() => null);
    if (Array.isArray(list)) applyDirectory(list);
  });

  rtc.onRaw('users:update', (users) => {
    state.users = new Map((users || []).map((u) => [u.id, u]));
    if (state.me) {
      const me = state.users.get(state.me.id);
      if (me) { state.me.isOwner = me.isOwner; state.me.name = me.name; }
    }
    renderServerPanel();
    renderRail();
  });

  rtc.onRaw('roles:update', (roles) => {
    state.roles = roles || [];
    renderServerPanel();
    renderRail();
  });

  rtc.onRaw('force:muted', ({ muted }) => setServerMuted(!!muted));

  rtc.onRaw('kicked', ({ by }) => {
    alert(`You were kicked from the hall by ${by}.`);
    window.location.reload();
  });

  rtc.onRaw('room:closed', () => {
    leaveChannel().catch(console.error);
    updateEmptyStage('That hall was deleted.');
  });

  rtc.onRaw('emoji:update', (list) => {
    state.emojis = list || [];
    renderServerPanel();
  });

  rtc.onRaw('jukebox:update', (st) => {
    if (st?.channelId !== state.channelId) return;
    state.jb = st;
    updateJukeboxBar();
  });
}

/* ───────────────────────── channel management ───────────────────────── */

function openCreateChannel(type) {
  $('chan-name').value = '';
  document.querySelector(`input[name="chantype"][value="${type}"]`).checked = true;
  $('modal-channel').showModal();
  $('chan-name').focus();
}

async function createChannel() {
  const name = $('chan-name').value.trim();
  const type = document.querySelector('input[name="chantype"]:checked').value;
  if (!name) return;
  try {
    const { channel } = await rtc.request('channel:create', { name, type });
    $('modal-channel').close();
    const list = await rtc.request('channels:list');
    if (Array.isArray(list)) applyDirectory(list);
    if (channel.type === 'text') {
      const ch = state.dirMap.get(channel.id);
      if (ch) viewText(ch);
    }
  } catch (err) { alert(err.message); }
}

const ACCESS_PERMS = {
  text: [[P.VIEW_CHANNEL, 'view'], [P.SEND_MESSAGES, 'send'], [P.EMBED_LINKS, 'links']],
  voice: [[P.VIEW_CHANNEL, 'view'], [P.CONNECT, 'connect'], [P.SPEAK, 'speak']]
};

async function openChannelEdit(ch) {
  state.editingChannel = ch;
  $('chanedit-title').textContent =
    ch.type === 'text' ? `# ${ch.name} — settings` : `${ch.name} — settings`;
  $('chanedit-name').value = ch.name;
  $('chanedit-topic').value = ch.topic || '';

  let overwrites = [];
  try {
    ({ overwrites } = await rtc.request('channel:overwrites:get', { channelId: ch.id }));
  } catch (err) { alert(err.message); return; }

  const perms = ACCESS_PERMS[ch.type];
  const grid = $('access-grid');
  grid.textContent = '';
  state.accessDraft = new Map();

  const head = document.createElement('div');
  head.className = 'access-row';
  head.innerHTML = `<span></span>` +
    perms.map(([, label]) => `<span class="access-head">${label}</span>`).join('');
  grid.appendChild(head);

  const roles = [...state.roles].sort((a, b) => b.position - a.position);
  for (const role of roles) {
    const existing = overwrites.find(
      (o) => o.target_type === 'role' && o.target_id === role.id);
    const draft = {};
    const row = document.createElement('div');
    row.className = 'access-row';

    const name = document.createElement('span');
    name.className = 'access-role';
    name.textContent = role.name;
    name.style.color = role.color;
    row.appendChild(name);

    for (const [bit] of perms) {
      const cur = existing && (existing.allow & bit) ? 'allow'
        : existing && (existing.deny & bit) ? 'deny' : 'inherit';
      draft[bit] = cur;
      const btn = document.createElement('button');
      btn.className = 'tri';
      btn.dataset.state = cur;
      btn.textContent = cur;
      btn.addEventListener('click', () => {
        const nxt = { inherit: 'allow', allow: 'deny', deny: 'inherit' }[btn.dataset.state];
        btn.dataset.state = nxt;
        btn.textContent = nxt;
        draft[bit] = nxt;
      });
      row.appendChild(btn);
    }
    state.accessDraft.set(role.id, draft);
    grid.appendChild(row);
  }
  $('modal-channel-edit').showModal();
}

async function saveChannelEdit() {
  const ch = state.editingChannel;
  if (!ch) return;
  try {
    await rtc.request('channel:update', {
      channelId: ch.id,
      name: $('chanedit-name').value.trim() || ch.name,
      topic: $('chanedit-topic').value.trim()
    });
    for (const [roleId, draft] of state.accessDraft) {
      let allow = 0, deny = 0;
      for (const [bit, mode] of Object.entries(draft)) {
        if (mode === 'allow') allow |= Number(bit);
        if (mode === 'deny') deny |= Number(bit);
      }
      await rtc.request('channel:overwrites:set', {
        channelId: ch.id, targetType: 'role', targetId: roleId, allow, deny
      });
    }
    $('modal-channel-edit').close();
  } catch (err) { alert(err.message); }
}

/* ───────────────────────── server panel (roles) ─────────────────────── */

function renderServerPanel() {
  if (!state.me) return;
  const bp = myBasePerms();

  $('srv-owner-row').classList.toggle('hidden', state.ownerClaimed);
  $('btn-add-role').classList.toggle('hidden', !has(bp, P.MANAGE_ROLES));

  // members
  const members = $('srv-members');
  members.textContent = '';
  const sorted = [...state.users.values()]
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  for (const u of sorted) {
    const row = document.createElement('div');
    row.className = 'srv-row';
    row.innerHTML = `<span class="srv-dot${u.online ? ' on' : ''}"></span>`;
    const name = document.createElement('span');
    name.className = 'srv-name';
    name.textContent = u.name;
    row.appendChild(name);
    if (u.isOwner) {
      const star = document.createElement('span');
      star.className = 'srv-owner-star';
      star.textContent = '★ owner';
      row.appendChild(star);
    }

    for (const role of [...state.roles].sort((a, b) => b.position - a.position)) {
      if (role.id === 'everyone') continue;
      const hasIt = u.roleIds.includes(role.id);
      const chip = document.createElement('button');
      chip.className = 'role-chip' + (hasIt ? '' : ' off') +
        (has(bp, P.MANAGE_ROLES) ? ' toggle' : '');
      chip.style.color = role.color;
      chip.textContent = role.name;
      chip.title = has(bp, P.MANAGE_ROLES) ? 'Toggle role' : role.name;
      if (has(bp, P.MANAGE_ROLES)) {
        chip.addEventListener('click', () =>
          rtc.request('role:assign', { userId: u.id, roleId: role.id, on: !hasIt })
            .catch((err) => alert(err.message)));
      }
      row.appendChild(chip);
    }

    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    row.appendChild(spacer);

    if (u.id !== state.me.id && !u.isOwner) {
      if (has(bp, P.MUTE_MEMBERS)) {
        const curMuted = isServerMutedInDir(u.id);
        const mute = document.createElement('button');
        mute.className = 'srv-act';
        mute.textContent = curMuted ? '🔕 unmute' : '🔇 mute';
        mute.title = 'Server mute (voice)';
        mute.addEventListener('click', () =>
          rtc.request('member:mute', { userId: u.id, muted: !curMuted })
            .catch((err) => alert(err.message)));
        row.appendChild(mute);
      }
      if (has(bp, P.KICK_MEMBERS)) {
        const kick = document.createElement('button');
        kick.className = 'srv-act danger';
        kick.textContent = 'kick';
        kick.addEventListener('click', () => {
          if (confirm(`Kick ${u.name}? They can rejoin unless you change permissions.`)) {
            rtc.request('member:kick', { userId: u.id }).catch((err) => alert(err.message));
          }
        });
        row.appendChild(kick);
      }
    }
    members.appendChild(row);
  }

  // roles
  const rolesBox = $('srv-roles');
  rolesBox.textContent = '';
  for (const role of [...state.roles].sort((a, b) => b.position - a.position)) {
    const row = document.createElement('div');
    row.className = 'srv-row';
    const chip = document.createElement('span');
    chip.className = 'role-chip';
    chip.style.color = role.color;
    chip.textContent = role.name;
    row.appendChild(chip);

    const summary = document.createElement('span');
    summary.className = 'mono small';
    summary.textContent = (role.permissions & P.ADMINISTRATOR)
      ? 'administrator'
      : `${countBits(role.permissions)} perms`;
    row.appendChild(summary);

    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    row.appendChild(spacer);

    if (has(bp, P.MANAGE_ROLES)) {
      const edit = document.createElement('button');
      edit.className = 'srv-act';
      edit.textContent = 'edit';
      edit.addEventListener('click', () => openRoleModal(role));
      row.appendChild(edit);

      if (role.id !== 'everyone' && role.id !== 'admin') {
        const del = document.createElement('button');
        del.className = 'srv-act danger';
        del.textContent = 'delete';
        del.addEventListener('click', () => {
          if (confirm(`Delete the ${role.name} role?`)) {
            rtc.request('role:delete', { id: role.id }).catch((err) => alert(err.message));
          }
        });
        row.appendChild(del);
      }
    }
    rolesBox.appendChild(row);
  }

  renderEmojiManager(bp);
  renderStoragePanel(bp);
}

function renderEmojiManager(bp) {
  const wrap = $('srv-emoji-wrap');
  const canManage = has(bp, P.MANAGE_EMOJIS);
  wrap.classList.toggle('hidden', !canManage && !state.emojis.length);
  const box = $('srv-emojis');
  box.textContent = '';
  wrap.querySelector('.rail-add').classList.toggle('hidden', !canManage);
  $('emoji-name').classList.toggle('hidden', !canManage);
  if (!state.emojis.length) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.textContent = canManage
      ? 'No custom emojis yet — name one, then hit + to pick a PNG or animated GIF.'
      : 'No custom emojis yet.';
    box.appendChild(d);
  }
  for (const e of state.emojis) {
    const row = document.createElement('div');
    row.className = 'emoji-row';
    row.innerHTML =
      `<img class="cemoji big" src="${rtc.baseUrl}/emoji/${e.id}.${e.ext}" alt="" draggable="false">` +
      `<span class="mono">:${escapeHtml(e.name)}:</span>` +
      `<span class="hint">${e.animated ? 'animated · ' : ''}${(e.bytes / 1024).toFixed(0)} KB</span>`;
    if (canManage) {
      const del = document.createElement('button');
      del.className = 'srv-act danger';
      del.textContent = 'delete';
      del.addEventListener('click', () =>
        rtc.request('emoji:delete', { id: e.id }).catch((err) => alert(err.message)));
      row.appendChild(del);
    }
    box.appendChild(row);
  }
}

async function uploadEmoji(file) {
  const status = $('emoji-status');
  const name = $('emoji-name').value.trim().toLowerCase();
  if (!/^[a-z0-9_]{2,32}$/.test(name)) {
    status.textContent = 'name first: 2-32 chars, a-z 0-9 _';
    return;
  }
  const maxKB = state.caps.emojiMaxKB || 512;
  if (file.size > maxKB * 1024) {
    status.textContent = `too big — max ${maxKB} KB`;
    return;
  }
  status.textContent = 'uploading…';
  try {
    const data = await file.arrayBuffer();
    await rtc.request('emoji:add', { name, data });
    $('emoji-name').value = '';
    status.textContent = `:${name}: added`;
    setTimeout(() => { status.textContent = ''; }, 2500);
  } catch (err) {
    status.textContent = err.message;
  }
}

async function renderStoragePanel(bp) {
  const wrap = $('srv-storage-wrap');
  const admin = has(bp, P.ADMINISTRATOR);
  wrap.classList.toggle('hidden', !admin);
  $('srv-monitor-wrap').classList.toggle('hidden', !admin);
  if (!admin) return;
  try {
    const { settings: st2, usage } = await rtc.request('server:settings:get', {});
    $('cap-chat').value = st2.chatCapMB;
    $('cap-emoji').value = st2.emojiCapMB;
    $('cap-preview').value = st2.previewCapMB;
    const mb = (b) => (b / 1024 / 1024).toFixed(1);
    $('storage-usage').textContent =
      `in use — chat ${mb(usage.chatBytes)} MB · emojis ${mb(usage.emojiBytes)} MB · previews ${mb(usage.previewBytes)} MB`;
  } catch { /* not admin anymore / transient */ }
}

async function saveStorage() {
  try {
    await rtc.request('server:settings:set', {
      chatCapMB: Number($('cap-chat').value),
      emojiCapMB: Number($('cap-emoji').value),
      previewCapMB: Number($('cap-preview').value)
    });
    renderStoragePanel(myBasePerms());
  } catch (err) { alert(err.message); }
}

/* ─────────────────────── server monitor ─────────────────────────── */

let monitorTimer = null;
const fmtBytes = (b) => {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtRate = (bps) => `${fmtBytes(bps)}/s`;
const fmtUptime = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

async function pollMonitor() {
  if (!has(myBasePerms(), P.ADMINISTRATOR)) return;
  try {
    const s = await rtc.request('server:stats', {});
    $('monitor-host').textContent =
      `${s.host.hostname} · ${s.host.platform} · ${s.host.arch} · ${s.host.cores} cores · ` +
      `host up ${fmtUptime(s.host.uptimeSec)} · Hearth up ${fmtUptime(s.host.procUptimeSec)}`;

    const cpuFill = $('mon-cpu-fill');
    cpuFill.style.width = `${s.cpu.percent}%`;
    cpuFill.classList.toggle('hot', s.cpu.percent > 85);
    $('mon-cpu-val').textContent = `${s.cpu.percent}% · load ${s.cpu.load1.toFixed(2)}`;

    const memPct = Math.round((s.memory.used / s.memory.total) * 100);
    $('mon-mem-fill').style.width = `${memPct}%`;
    $('mon-mem-val').textContent =
      `${memPct}% · ${fmtBytes(s.memory.used)} / ${fmtBytes(s.memory.total)} · Hearth ${fmtBytes(s.process.rss)}`;

    const diskPct = s.disk.total ? Math.round((s.disk.used / s.disk.total) * 100) : 0;
    $('mon-disk-fill').style.width = `${diskPct}%`;
    $('mon-disk-val').textContent = s.disk.total
      ? `${diskPct}% · ${fmtBytes(s.disk.free)} free of ${fmtBytes(s.disk.total)}`
      : 'unavailable';

    $('mon-net-val').innerHTML =
      `↓ ${fmtRate(s.network.rxBps)}<br>↑ ${fmtRate(s.network.txBps)}`;
    $('mon-live-val').textContent =
      `${s.live.online}/${s.live.users} online · ${s.live.voice} in voice · ` +
      `${s.live.rooms} rooms · ${s.live.producers} streams` +
      (s.live.jukeboxes ? ` · ${s.live.jukeboxes} 🎵` : '');
    $('mon-store-val').textContent =
      `chat ${fmtBytes(s.storage.chatBytes)} · emoji ${fmtBytes(s.storage.emojiBytes)} · ` +
      `previews ${fmtBytes(s.storage.previewBytes)}`;
  } catch { /* transient / lost admin */ }
}

function startMonitor() {
  stopMonitor();
  if (!has(myBasePerms(), P.ADMINISTRATOR)) return;
  pollMonitor();
  monitorTimer = setInterval(pollMonitor, 2000);
}
function stopMonitor() {
  clearInterval(monitorTimer);
  monitorTimer = null;
}

async function checkServerUpdate() {
  const status = $('server-update-status');
  const btn = $('btn-server-update-check');
  btn.disabled = true;
  status.textContent = 'checking…';
  try {
    const res = await rtc.request('server:update:check', {});
    if (res.available) {
      status.textContent = `server update available: ${res.latest} (running v${res.current}) — ` +
        `re-run install-server.sh on the host to update (your data is kept)`;
    } else if (res.error) {
      status.textContent = `server v${res.current} · check failed: ${res.error}`;
    } else if (res.reason) {
      status.textContent = `server v${res.current} (update check not configured on host)`;
    } else {
      status.textContent = `server up to date — v${res.current}`;
    }
  } catch (err) {
    status.textContent = `check failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

const countBits = (n) => { let c = 0; while (n) { c += n & 1; n >>>= 1; } return c; };

function isServerMutedInDir(userId) {
  for (const ch of state.directory) {
    for (const p of ch.peers || []) {
      if (p.userId === userId) return !!p.state?.serverMuted;
    }
  }
  return false;
}

function openRoleModal(role) {
  state.editingRole = role;
  const isEveryone = role?.id === 'everyone';
  $('role-title').textContent = role ? `Edit ${role.name}` : 'New role';
  $('role-name').value = role?.name || '';
  $('role-name').disabled = isEveryone;
  $('role-color').value = /^#[0-9a-f]{6}$/i.test(role?.color || '') ? role.color : '#7fa3b8';

  const box = $('role-perms');
  box.textContent = '';
  for (const [bit, label] of PERM_LABELS) {
    if (bit === P.ADMINISTRATOR && (isEveryone || !state.me?.isOwner)) continue;
    const lab = document.createElement('label');
    lab.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.bit = bit;
    cb.checked = !!(role && (role.permissions & bit));
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(' ' + label));
    box.appendChild(lab);
  }
  $('btn-role-delete').classList.toggle('hidden',
    !role || isEveryone || role.id === 'admin');
  $('modal-role').showModal();
}

async function saveRole() {
  let permissions = 0;
  for (const cb of $('role-perms').querySelectorAll('input:checked')) {
    permissions |= Number(cb.dataset.bit);
  }
  const payload = {
    name: $('role-name').value.trim(),
    color: $('role-color').value,
    permissions
  };
  try {
    if (state.editingRole) {
      await rtc.request('role:update', { id: state.editingRole.id, ...payload });
    } else {
      await rtc.request('role:create', payload);
    }
    $('modal-role').close();
  } catch (err) { alert(err.message); }
}

async function claimOwner() {
  const code = $('owner-code').value.trim();
  const status = $('owner-status');
  try {
    await rtc.request('owner:claim', { code });
    status.textContent = 'you are the owner now';
    state.ownerClaimed = true;
    if (state.me) state.me.isOwner = true;
    renderServerPanel();
    const list = await rtc.request('channels:list').catch(() => null);
    if (Array.isArray(list)) applyDirectory(list);
  } catch (err) {
    status.textContent = err.message;
  }
}

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
  renderServerPanel();
  $('modal-settings').showModal();
}

function fillSettingsForm() {
  $('set-ec').checked = settings.audio.ec;
  $('set-ns').checked = settings.audio.ns;
  $('set-agc').checked = settings.audio.agc;
  $('set-music').checked = settings.audio.music;
  $('set-audio-bitrate').value = String(settings.audio.bitrate || 128000);
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
  settings.audio.bitrate = Number($('set-audio-bitrate').value) || 128000;
  saveSettings();
  await rtc.setAudioBitrate(settings.audio.bitrate);
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

/* ────────────────────────────── jukebox ─────────────────────────────── */

const fmtDur = (s) => {
  s = Math.max(0, Math.round(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function myVoicePerms() {
  return state.channelId ? (state.dirMap.get(state.channelId)?.myPerms ?? 0) : 0;
}

function updateJukeboxBar() {
  const bar = $('jukebox-bar');
  const show = Boolean(state.channelId && state.caps.jukebox);
  bar.classList.toggle('hidden', !show);
  if (!show) { $('jb-queue-pop').classList.add('hidden'); return; }

  const jb = state.jb;
  const np = jb?.nowPlaying;
  $('jb-title').textContent = np
    ? np.title
    : 'nothing playing — paste a link to start the jukebox';
  $('jb-sub').textContent = np
    ? `${jb.paused ? '⏸ paused · ' : ''}${fmtDur(np.duration)} · queued by ${np.by}` +
      (np.via && np.via !== 'youtube' ? ` · via ${np.via}` : '')
    : '';
  const canControl = has(myVoicePerms(), P.SPEAK);
  $('jb-skip').classList.toggle('hidden', !(np && canControl));
  $('jb-pause').classList.toggle('hidden',
    !(np && canControl && state.caps.jukeboxPause));
  const n = jb?.queue?.length || 0;
  $('jb-count').textContent = n ? String(n) : '';
  $('jb-input').disabled = !canControl;
  $('jb-add').disabled = !canControl;
  if (!$('jb-queue-pop').classList.contains('hidden')) renderQueuePop();
}

function renderQueuePop() {
  const pop = $('jb-queue-pop');
  pop.textContent = '';
  const items = state.jb?.queue || [];
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'jb-q-empty';
    d.textContent = 'Queue is empty.';
    pop.appendChild(d);
    return;
  }
  items.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'jb-q-row';
    row.innerHTML =
      `<span class="jb-q-n mono">${i + 1}</span>` +
      `<span class="jb-q-title">${escapeHtml(t.title)}</span>` +
      `<span class="jb-q-meta mono">${fmtDur(t.duration)} · ${escapeHtml(t.by)}</span>`;
    pop.appendChild(row);
  });
}

async function queueTrack() {
  const input = $('jb-input');
  const url = input.value.trim();
  if (!url) return;
  const btn = $('jb-add');
  btn.disabled = true; btn.textContent = 'finding…';
  try {
    await rtc.request('jukebox:queue', { url });
    input.value = '';
  } catch (err) {
    $('jb-sub').textContent = err.message;
    setTimeout(updateJukeboxBar, 3500);
  } finally {
    btn.disabled = false; btn.textContent = 'Play';
  }
}

/* ─────────────────────── peer context menu ──────────────────────────── */

function findPeerInDir(peerId) {
  for (const ch of state.directory) {
    const p = (ch.peers || []).find((x) => x.id === peerId);
    if (p) return { ...p, channelId: ch.id };
  }
  return null;
}

function closeCtxMenu() {
  $('ctx-menu').classList.add('hidden');
}

function openPeerMenu(x, y, peerId) {
  const menu = $('ctx-menu');
  menu.textContent = '';

  const inDir = findPeerInDir(peerId);
  const live = state.peers.get(peerId);
  const name = live?.name || inDir?.name || 'someone';
  const userId = live?.userId || inDir?.userId || null;
  const isJukebox = peerId.startsWith('jukebox:');
  const isSelf = peerId === rtc.socket?.id;
  const els = audioEls(peerId);

  const head = document.createElement('div');
  head.className = 'ctx-head';
  head.textContent = name;
  menu.appendChild(head);

  // Volume + mute-for-me: anyone I can currently hear (jukebox included).
  if (!isSelf && els.length) {
    const volRow = document.createElement('div');
    volRow.className = 'ctx-slider';
    const label = document.createElement('span');
    const pct = Math.round((state.volumes.get(peerId) ?? 1) * 100);
    label.textContent = `Volume ${pct}%`;
    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = 0; vol.max = 100; vol.value = pct;
    vol.addEventListener('input', () => {
      const v = vol.value / 100;
      state.volumes.set(peerId, v);
      state.localMuted.delete(peerId);
      for (const el of audioEls(peerId)) el.volume = v;
      label.textContent = `Volume ${vol.value}%`;
      syncMuteRow();
    });
    volRow.append(label, vol);
    menu.appendChild(volRow);

    const muteRow = document.createElement('button');
    muteRow.className = 'ctx-item';
    const syncMuteRow = () => {
      const muted = (state.volumes.get(peerId) ?? 1) === 0;
      muteRow.textContent = muted ? '🔊 Unmute for me' : '🔇 Mute for me';
    };
    syncMuteRow();
    muteRow.addEventListener('click', () => {
      const cur = state.volumes.get(peerId) ?? 1;
      let next;
      if (cur === 0) {
        next = state.localMuted.get(peerId) ?? 1;
        state.localMuted.delete(peerId);
      } else {
        state.localMuted.set(peerId, cur);
        next = 0;
      }
      state.volumes.set(peerId, next);
      for (const el of audioEls(peerId)) el.volume = next;
      vol.value = Math.round(next * 100);
      label.textContent = `Volume ${vol.value}%`;
      syncMuteRow();
    });
    menu.appendChild(muteRow);
  }

  if (isJukebox && has(myVoicePerms(), P.SPEAK)) {
    const skip = document.createElement('button');
    skip.className = 'ctx-item';
    skip.textContent = '⏭ Skip this track';
    skip.addEventListener('click', () => {
      closeCtxMenu();
      rtc.request('jukebox:skip', {}).catch((err) => alert(err.message));
    });
    menu.appendChild(skip);
  }

  // Moderation: real people only, never yourself, never the owner.
  const target = userId ? state.users.get(userId) : null;
  if (target && userId !== state.me?.id && !target.isOwner) {
    const chPerms = inDir ? (state.dirMap.get(inDir.channelId)?.myPerms ?? 0)
                          : myBasePerms();
    let divided = false;
    const divide = () => {
      if (divided || !menu.childElementCount) return;
      const hr = document.createElement('div');
      hr.className = 'ctx-div';
      menu.appendChild(hr);
      divided = true;
    };
    if (has(chPerms, P.MUTE_MEMBERS)) {
      divide();
      const muted = !!(live?.state?.serverMuted || inDir?.state?.serverMuted);
      const b = document.createElement('button');
      b.className = 'ctx-item';
      b.textContent = muted ? '🔔 Server unmute' : '🔕 Server mute';
      b.addEventListener('click', () => {
        closeCtxMenu();
        rtc.request('member:mute', { userId, muted: !muted })
          .catch((err) => alert(err.message));
      });
      menu.appendChild(b);
    }
    if (has(myBasePerms(), P.KICK_MEMBERS)) {
      divide();
      const b = document.createElement('button');
      b.className = 'ctx-item danger';
      b.textContent = '⏻ Kick from server';
      b.addEventListener('click', () => {
        closeCtxMenu();
        if (confirm(`Kick ${name}? They can rejoin unless you change permissions.`)) {
          rtc.request('member:kick', { userId }).catch((err) => alert(err.message));
        }
      });
      menu.appendChild(b);
    }
  }

  if (!menu.childElementCount || menu.childElementCount === 1) {
    const none = document.createElement('div');
    none.className = 'ctx-none';
    none.textContent = isSelf ? 'That\u2019s you.' : 'No actions available.';
    menu.appendChild(none);
  }

  menu.classList.remove('hidden');
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
}

/* ───────────────────────── reconnect handling ───────────────────────── */

let banner = null;

rtc.on('disconnected', () => {
  if (!state.connected) return;
  state.pendingAfterHello = { voice: state.channelId, view: state.viewId };
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'banner';
    banner.textContent = 'Connection to the hall lost — reconnecting…';
    document.body.appendChild(banner);
  }
});

rtc.on('reconnected', () => {
  banner?.remove(); banner = null;
  // Server-side peer state is gone; rebuild from scratch. A fresh 'hello'
  // arrives on the new connection and applyHello() handles the rejoin.
  state.channelId = null;
  state.peers.clear();
  for (const el of document.querySelectorAll('#tile-grid .tile')) el.remove();
  $('audio-sink').textContent = '';
});

/* ────────────────────────────── wiring ──────────────────────────────── */

function wire() {
  $('btn-connect').addEventListener('click', doConnect);
  $('in-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') doConnect(); });
  $('in-server').value = settings.serverUrl;
  $('in-name').value = settings.displayName;

  $('btn-mute').addEventListener('click', () => setMuted(!state.muted));
  $('btn-rail-mute').addEventListener('click', () => setMuted(!state.muted));
  $('btn-deafen').addEventListener('click', () => setDeafened(!state.deafened));
  $('btn-rail-deafen').addEventListener('click', () => setDeafened(!state.deafened));
  $('btn-cam').addEventListener('click', () => toggleCam().catch(console.error));
  $('btn-share').addEventListener('click', () => openSharePicker().catch(console.error));
  $('btn-leave').addEventListener('click', () => leaveChannel().catch(console.error));
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-rail-settings').addEventListener('click', openSettings);
  $('vs-info').addEventListener('click', () => { if (state.channelId) showStage(); });
  $('btn-vs-leave').addEventListener('click', () => leaveChannel().catch(console.error));

  // jukebox
  $('jb-add').addEventListener('click', () => queueTrack());
  $('jb-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') queueTrack(); });
  $('jb-skip').addEventListener('click', () =>
    rtc.request('jukebox:skip', {}).catch((err) => alert(err.message)));
  $('jb-pause').addEventListener('click', () =>
    rtc.request('jukebox:pause', { paused: !state.jb?.paused })
      .catch((err) => alert(err.message)));
  $('jb-queue-btn').addEventListener('click', () => {
    const pop = $('jb-queue-pop');
    pop.classList.toggle('hidden');
    if (!pop.classList.contains('hidden')) renderQueuePop();
  });

  // right-click menus on people (rail rows + video tiles)
  const ctxTarget = (e) => {
    const row = e.target.closest('.rail-peer');
    if (row?.dataset.peer) return row.dataset.peer;
    const tile = e.target.closest('.tile');
    if (tile?.dataset.peer && tile.dataset.peer !== 'self') return tile.dataset.peer;
    return null;
  };
  document.addEventListener('contextmenu', (e) => {
    const peerId = ctxTarget(e);
    if (!peerId) { closeCtxMenu(); return; }
    e.preventDefault();
    openPeerMenu(e.clientX, e.clientY, peerId);
  });
  window.addEventListener('mousedown', (e) => {
    if (!$('ctx-menu').contains(e.target)) closeCtxMenu();
    const pop = $('jb-queue-pop');
    if (!pop.classList.contains('hidden') &&
        !pop.contains(e.target) && !$('jb-queue-btn').contains(e.target)) {
      pop.classList.add('hidden');
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeCtxMenu(); $('jb-queue-pop').classList.add('hidden'); }
  });

  // channel management
  $('btn-add-text').addEventListener('click', () => openCreateChannel('text'));
  $('btn-add-voice').addEventListener('click', () => openCreateChannel('voice'));
  $('btn-chan-cancel').addEventListener('click', () => $('modal-channel').close());
  $('btn-chan-create').addEventListener('click', () => createChannel());
  $('chan-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createChannel(); });
  $('chat-edit-btn').addEventListener('click', () => {
    const ch = state.dirMap.get(chat.current());
    if (ch) openChannelEdit(ch);
  });
  $('btn-chanedit-close').addEventListener('click', () => $('modal-channel-edit').close());
  $('btn-chanedit-save').addEventListener('click', () => saveChannelEdit());

  // roles & owner
  $('btn-add-role').addEventListener('click', () => openRoleModal(null));
  $('btn-role-cancel').addEventListener('click', () => $('modal-role').close());
  $('btn-role-save').addEventListener('click', () => saveRole());
  $('btn-role-delete').addEventListener('click', () => {
    const role = state.editingRole;
    if (role && confirm(`Delete the ${role.name} role?`)) {
      rtc.request('role:delete', { id: role.id })
        .then(() => $('modal-role').close())
        .catch((err) => alert(err.message));
    }
  });
  $('btn-claim-owner').addEventListener('click', () => claimOwner());
  $('emoji-file').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) uploadEmoji(f);
  });
  $('btn-save-storage').addEventListener('click', () => saveStorage());

  // share modal
  $('btn-share-cancel').addEventListener('click', () => $('modal-share').close());
  $('btn-share-start').addEventListener('click', () => startShare().catch(console.error));

  // settings modal
  $('btn-settings-close').addEventListener('click', () => {
    if (state.micTestEl) toggleMicTest();
    stopMonitor();
    $('modal-settings').close();
  });
  document.querySelectorAll('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-panel').forEach((p) =>
        p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.tab));
      if (tab.dataset.tab === 'server') startMonitor();
      else stopMonitor();
    }));
  $('btn-monitor-refresh').addEventListener('click', () => pollMonitor());
  $('btn-server-update-check').addEventListener('click', () => checkServerUpdate());
  $('btn-check-update').addEventListener('click', () => checkUpdate(false));
  $('btn-do-update').addEventListener('click', () => doUpdate());

  for (const id of ['set-mic', 'set-ec', 'set-ns', 'set-agc', 'set-music', 'set-audio-bitrate']) {
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

  wireTheater();
  statsLoop();
}

const isTyping = (e) =>
  ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target?.tagName);

/* ─────────────────────────── auto-update ────────────────────────────── */

let pendingUpdate = null;

async function initUpdates() {
  if (!bridge.appVersion) return; // web / non-electron
  try {
    const v = await bridge.appVersion();
    $('update-version').textContent = `v${v}`;
  } catch { /* ignore */ }
  bridge.onUpdateProgress?.((pct) => {
    $('update-status').textContent = `downloading… ${pct}%`;
  });
  // Quiet check shortly after launch.
  setTimeout(() => checkUpdate(true), 4000);
}

async function checkUpdate(quiet = false) {
  if (!bridge.checkUpdate) return;
  const status = $('update-status');
  const btn = $('btn-check-update');
  if (!quiet) { btn.disabled = true; status.textContent = 'checking…'; }
  try {
    const res = await bridge.checkUpdate();
    if (res.available) {
      pendingUpdate = res;
      status.textContent = `update available: ${res.latest} (you have v${res.current})`;
      $('btn-do-update').classList.toggle('hidden', !res.assetId);
      if (!res.assetId) status.textContent += ' — open Releases to download';
    } else if (res.error) {
      if (!quiet) status.textContent = `check failed: ${res.error}`;
    } else if (res.reason) {
      if (!quiet) status.textContent = `Hearth v${await bridge.appVersion()} (auto-update not configured)`;
    } else {
      if (!quiet) status.textContent = `up to date — v${res.current}`;
    }
  } catch (err) {
    if (!quiet) status.textContent = `check failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function doUpdate() {
  if (!pendingUpdate?.assetId) return;
  const btn = $('btn-do-update');
  btn.disabled = true;
  $('update-status').textContent = 'downloading…';
  try {
    const dl = await bridge.downloadUpdate(pendingUpdate.assetId, pendingUpdate.assetName);
    if (!dl.ok) throw new Error(dl.error);
    $('update-status').textContent = 'installing — Hearth will restart…';
    await bridge.installUpdate(dl.file);
  } catch (err) {
    $('update-status').textContent = `update failed: ${err.message}`;
    btn.disabled = false;
  }
}

wire();

initUpdates();
