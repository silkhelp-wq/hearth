'use strict';
/**
 * Voice rooms, dynamic channels, and permission-gated signaling.
 *
 * Identity comes from the socket.io auth middleware (socket.data.user).
 * All requests use ack callbacks; errors come back as { error }.
 *
 * Directory model: any channel/role/occupancy change broadcasts a
 * payload-free 'dir:dirty'; clients respond with 'channels:list', which
 * returns the directory *for that user* (hidden channels filtered out,
 * effective permissions attached).
 */

const soup = require('./soup');
const db = require('./db');
const jukebox = require('./jukebox');
const { P, has } = require('./perms');

const rooms = new Map();        // channelId -> Room (voice, live only)
const serverMuted = new Set();  // userIds muted by a moderator

class Peer {
  constructor(socket) {
    this.id = socket.id;
    this.socket = socket;
    this.user = socket.data.user;
    this.state = { muted: false, deafened: false, camOn: false, sharing: false };
    this.transports = new Map();
    this.producers = new Map();
    this.consumers = new Map();
  }
  summary() {
    return {
      id: this.id,
      userId: this.user.id,
      name: this.user.name,
      state: { ...this.state, serverMuted: serverMuted.has(this.user.id) },
      producers: [...this.producers.values()].map((p) => ({
        id: p.id, kind: p.kind, mediaTag: p.appData?.mediaTag || p.kind
      }))
    };
  }
  close() {
    for (const c of this.consumers.values()) safeClose(c);
    for (const p of this.producers.values()) safeClose(p);
    for (const t of this.transports.values()) safeClose(t);
    this.consumers.clear(); this.producers.clear(); this.transports.clear();
  }
}

class Room {
  constructor(channelId, router) {
    this.id = channelId;
    this.router = router;
    this.peers = new Map();
    this.jukebox = null;
    this.audioLevelObserver = null;
    this.lastSpeaker = null;
  }
  async ensureAudioObserver(io) {
    if (this.audioLevelObserver) return;
    this.audioLevelObserver = await this.router.createAudioLevelObserver({
      maxEntries: 1, threshold: -60, interval: 400
    });
    this.audioLevelObserver.on('volumes', (volumes) => {
      const peerId = volumes[0]?.producer?.appData?.peerId || null;
      if (peerId !== this.lastSpeaker) {
        this.lastSpeaker = peerId;
        io.to(this.id).emit('speaker', { peerId });
      }
    });
    this.audioLevelObserver.on('silence', () => {
      if (this.lastSpeaker !== null) {
        this.lastSpeaker = null;
        io.to(this.id).emit('speaker', { peerId: null });
      }
    });
  }
  peerSummaries(excludeId) {
    const out = [...this.peers.values()]
      .filter((p) => p.id !== excludeId).map((p) => p.summary());
    if (this.jukebox?.producer) out.push(this.jukebox.summary());
    return out;
  }
}

function safeClose(thing) {
  try { if (thing && !thing.closed) thing.close(); } catch { /* gone */ }
}

async function getOrCreateRoom(channelId) {
  if (rooms.has(channelId)) return rooms.get(channelId);
  const ch = db.getChannel(channelId);
  if (!ch || ch.type !== 'voice') return null;
  const router = await soup.getOrCreateRouter(channelId);
  const room = new Room(channelId, router);
  rooms.set(channelId, room);
  return room;
}

/* ─────────────────────────── directory ─────────────────────────────── */

function publicDirectory() {
  const last = db.lastMessageIds();
  return db.listChannels().map((c) => {
    const room = rooms.get(c.id);
    const peers = c.type === 'voice'
      ? [...(room?.peers.values() || [])].map((p) => ({
          id: p.id, userId: p.user.id, name: p.user.name,
          state: { ...p.state, serverMuted: serverMuted.has(p.user.id) }
        }))
      : [];
    if (c.type === 'voice' && room?.jukebox?.producer) {
      const jb = room.jukebox.summary();
      peers.push({ id: jb.id, userId: jb.userId, name: jb.name, state: jb.state });
    }
    return {
      id: c.id, name: c.name, type: c.type, topic: c.topic, position: c.position,
      peers,
      lastMessageId: last[c.id] || 0
    };
  });
}

function directoryFor(userId) {
  return publicDirectory()
    .map((c) => ({ ...c, myPerms: db.permsFor(userId, c.id) }))
    .filter((c) => has(c.myPerms, P.VIEW_CHANNEL));
}

const dirDirty = (io) => io.emit('dir:dirty');

/** Keep each socket joined to exactly the text rooms it may VIEW. */
function syncTextRooms(io, onlySocket = null) {
  const textChannels = db.listChannels().filter((c) => c.type === 'text');
  const sockets = onlySocket ? [onlySocket] : [...io.sockets.sockets.values()];
  for (const socket of sockets) {
    const user = socket.data.user;
    if (!user) continue;
    for (const ch of textChannels) {
      const roomName = `text:${ch.id}`;
      const can = has(db.permsFor(user.id, ch.id), P.VIEW_CHANNEL);
      const inRoom = socket.rooms.has(roomName);
      if (can && !inRoom) socket.join(roomName);
      else if (!can && inRoom) socket.leave(roomName);
    }
  }
}

/* ──────────────────────────── voice ops ────────────────────────────── */

function leaveVoice(io, socket) {
  const channelId = socket.data.voiceChannelId;
  if (!channelId) return;
  const room = rooms.get(channelId);
  socket.data.voiceChannelId = null;
  if (!room) return;
  const peer = room.peers.get(socket.id);
  if (peer) {
    peer.close();
    room.peers.delete(socket.id);
    socket.to(room.id).emit('peer:left', { id: peer.id });
    if (room.lastSpeaker === peer.id) {
      room.lastSpeaker = null;
      io.to(room.id).emit('speaker', { peerId: null });
    }
  }
  if (room.peers.size === 0 && room.jukebox) {
    room.jukebox.destroy();
    room.jukebox = null;
  }
  socket.leave(channelId);
  dirDirty(io);
}

function findVoicePeer(userId) {
  for (const room of rooms.values()) {
    for (const peer of room.peers.values()) {
      if (peer.user.id === userId) return { room, peer };
    }
  }
  return null;
}

/* ─────────────────────────── socket wiring ─────────────────────────── */

function guarded(handler) {
  return async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try { reply(await handler(payload || {})); }
    catch (err) { reply({ error: err.message }); }
  };
}

function attachSocket(io, socket) {
  const user = socket.data.user;
  socket.data.voiceChannelId = null;

  const perms = (channelId = null) => db.permsFor(user.id, channelId);
  const need = (p, bit, msg) => { if (!has(p, bit)) throw new Error(msg); };

  const currentRoom = () =>
    socket.data.voiceChannelId ? rooms.get(socket.data.voiceChannelId) : null;
  const currentPeer = () => currentRoom()?.peers.get(socket.id) || null;

  socket.on('channels:list', guarded(async () => directoryFor(user.id)));
  socket.on('ping', (ts, ack) => { if (typeof ack === 'function') ack(ts); });

  /* ---- voice ---- */

  socket.on('room:join', guarded(async ({ channelId }) => {
    const ch = db.getChannel(channelId);
    if (!ch || ch.type !== 'voice') throw new Error('unknown voice channel');
    const p = perms(channelId);
    need(p, P.VIEW_CHANNEL, 'you cannot see that channel');
    need(p, P.CONNECT, 'no permission to connect there');

    if (socket.data.voiceChannelId) leaveVoice(io, socket);

    const room = await getOrCreateRoom(channelId);
    await room.ensureAudioObserver(io);

    const peer = new Peer(socket);
    room.peers.set(peer.id, peer);
    socket.data.voiceChannelId = channelId;
    socket.join(channelId);

    socket.to(channelId).emit('peer:joined', peer.summary());
    dirDirty(io);

    return {
      routerRtpCapabilities: room.router.rtpCapabilities,
      peers: room.peerSummaries(peer.id),
      canSpeak: has(p, P.SPEAK) && !serverMuted.has(user.id),
      jukebox: room.jukebox?.publicState() || null
    };
  }));

  /* ---- jukebox ---- */

  const jukeboxRoom = () => {
    if (!jukebox.available()) {
      throw new Error('jukebox needs yt-dlp and ffmpeg installed on the host');
    }
    const room = currentRoom();
    if (!room) throw new Error('join a voice channel first');
    need(perms(room.id), P.SPEAK, 'you need speak permission to control music');
    return room;
  };

  socket.on('jukebox:queue', guarded(async ({ url }) => {
    const room = jukeboxRoom();
    url = String(url || '').trim().slice(0, 500);
    if (!url) throw new Error('paste a link first');

    const meta = await jukebox.resolveTrack(url);
    if (meta.duration > jukebox.MAX_TRACK_SECONDS) {
      throw new Error('that track is too long');
    }
    if (!room.jukebox || room.jukebox.closed) {
      room.jukebox = new jukebox.JukeboxSession(room.id, room.router, io);
    }
    await room.ensureAudioObserver(io);
    await room.jukebox.ensureProducer(room.audioLevelObserver);
    await room.jukebox.add({ ...meta, by: user.name });
    dirDirty(io);
    return { queued: { title: meta.title, duration: meta.duration, via: meta.via } };
  }));

  socket.on('jukebox:skip', guarded(async () => {
    const room = jukeboxRoom();
    if (!room.jukebox?.nowPlaying) throw new Error('nothing is playing');
    room.jukebox.skip();
    return { ok: true };
  }));

  socket.on('jukebox:pause', guarded(async ({ paused }) => {
    const room = jukeboxRoom();
    if (!room.jukebox) throw new Error('nothing is playing');
    room.jukebox.setPaused(!!paused);
    return { ok: true };
  }));

  socket.on('jukebox:state', guarded(async () => {
    const room = currentRoom();
    return { state: room?.jukebox?.publicState() || null };
  }));

  socket.on('room:leave', guarded(async () => { leaveVoice(io, socket); return { ok: true }; }));

  socket.on('transport:create', guarded(async ({ direction }) => {
    const room = currentRoom();
    const peer = currentPeer();
    if (!room || !peer) throw new Error('join a channel first');
    const transport = await soup.createTransport(room.router);
    transport.appData = { direction };
    peer.transports.set(transport.id, transport);
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    };
  }));

  socket.on('transport:connect', guarded(async ({ transportId, dtlsParameters }) => {
    const transport = currentPeer()?.transports.get(transportId);
    if (!transport) throw new Error('unknown transport');
    await transport.connect({ dtlsParameters });
    return { ok: true };
  }));

  socket.on('produce', guarded(async ({ transportId, kind, rtpParameters, appData }) => {
    const room = currentRoom();
    const peer = currentPeer();
    const transport = peer?.transports.get(transportId);
    if (!room || !transport) throw new Error('unknown transport');

    const mediaTag = appData?.mediaTag || kind;
    if (kind === 'audio' && mediaTag === 'mic') {
      if (serverMuted.has(user.id)) throw new Error('you were muted by a moderator');
      need(perms(room.id), P.SPEAK, 'no speak permission in this channel');
    }

    const producer = await transport.produce({
      kind, rtpParameters, appData: { ...appData, peerId: peer.id }
    });
    peer.producers.set(producer.id, producer);
    producer.on('transportclose', () => peer.producers.delete(producer.id));

    if (kind === 'audio' && mediaTag === 'mic') {
      room.audioLevelObserver?.addProducer({ producerId: producer.id }).catch(() => {});
    }
    socket.to(room.id).emit('producer:new', {
      peerId: peer.id, producerId: producer.id, kind, mediaTag
    });
    return { producerId: producer.id };
  }));

  socket.on('producer:close', guarded(async ({ producerId }) => {
    const room = currentRoom();
    const peer = currentPeer();
    const producer = peer?.producers.get(producerId);
    if (!producer) throw new Error('unknown producer');
    safeClose(producer);
    peer.producers.delete(producerId);
    socket.to(room.id).emit('producer:closed', { peerId: peer.id, producerId });
    return { ok: true };
  }));

  socket.on('consume', guarded(async ({ producerId, rtpCapabilities }) => {
    const room = currentRoom();
    const peer = currentPeer();
    if (!room || !peer) throw new Error('join a channel first');
    if (!room.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error('cannot consume this producer');
    }
    const transport = [...peer.transports.values()]
      .find((t) => t.appData.direction === 'recv');
    if (!transport) throw new Error('no receive transport');
    const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
    // L1T3 screen producers are SVC: mediasoup picks the forwarded temporal
    // layer from its bandwidth estimate, which starts low and can sit at
    // T0 (quarter framerate = "choppy"). Ask for the top layer up front;
    // mediasoup still degrades under real congestion.
    if (consumer.kind === 'video' &&
        (consumer.type === 'svc' || consumer.type === 'simulcast')) {
      consumer.setPreferredLayers({ spatialLayer: 0, temporalLayer: 2 })
        .catch(() => {});
    }
    peer.consumers.set(consumer.id, consumer);
    consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
    consumer.on('producerclose', () => {
      peer.consumers.delete(consumer.id);
      socket.emit('consumer:closed', { consumerId: consumer.id });
    });
    return {
      consumerId: consumer.id, producerId,
      kind: consumer.kind, rtpParameters: consumer.rtpParameters
    };
  }));

  socket.on('consumer:pause', guarded(async ({ consumerId }) => {
    const consumer = currentPeer()?.consumers.get(consumerId);
    if (!consumer) throw new Error('unknown consumer');
    await consumer.pause();
    return { ok: true };
  }));

  socket.on('consumer:keyframe', guarded(async ({ consumerId }) => {
    const consumer = currentPeer()?.consumers.get(consumerId);
    if (!consumer || consumer.kind !== 'video') return { ok: false };
    try { await consumer.requestKeyFrame(); } catch { /* non-fatal */ }
    return { ok: true };
  }));

  socket.on('consumer:resume', guarded(async ({ consumerId }) => {
    const consumer = currentPeer()?.consumers.get(consumerId);
    if (!consumer) throw new Error('unknown consumer');
    await consumer.resume();
    // Force a fresh keyframe on resume. Without this the viewer starts
    // mid-GOP on a P-frame that references frames it never received,
    // producing the "ghosting / trailing" artifacts the SENDER never sees
    // (they render their own capture locally). Video only.
    if (consumer.kind === 'video') {
      try { await consumer.requestKeyFrame(); } catch { /* non-fatal */ }
    }
    return { ok: true };
  }));

  socket.on('peer:state', guarded(async (state) => {
    const room = currentRoom();
    const peer = currentPeer();
    if (!room || !peer) throw new Error('join a channel first');
    peer.state = { ...peer.state, ...state };
    socket.to(room.id).emit('peer:state', {
      id: peer.id,
      state: { ...peer.state, serverMuted: serverMuted.has(user.id) }
    });
    return { ok: true };
  }));

  /* ---- channel management ---- */

  socket.on('channel:create', guarded(async ({ name, type }) => {
    need(perms(), P.CREATE_CHANNELS, 'no permission to create channels');
    name = String(name || '').trim();
    if (!name) throw new Error('channel needs a name');
    if (type !== 'text' && type !== 'voice') throw new Error('bad channel type');
    const channel = db.createChannel({ name, type, createdBy: user.id });
    if (type === 'text') syncTextRooms(io);
    dirDirty(io);
    return { channel };
  }));

  socket.on('channel:update', guarded(async ({ channelId, name, topic }) => {
    need(perms(channelId), P.MANAGE_CHANNELS, 'no permission to manage this channel');
    const channel = db.updateChannel(channelId, { name, topic });
    if (!channel) throw new Error('unknown channel');
    dirDirty(io);
    return { channel };
  }));

  socket.on('channel:delete', guarded(async ({ channelId }) => {
    need(perms(channelId), P.MANAGE_CHANNELS, 'no permission to delete this channel');
    const ch = db.getChannel(channelId);
    if (!ch) throw new Error('unknown channel');
    const all = db.listChannels().filter((c) => c.type === ch.type);
    if (all.length <= 1) throw new Error(`cannot delete the last ${ch.type} channel`);

    if (ch.type === 'voice') {
      const room = rooms.get(channelId);
      if (room) {
        room.jukebox?.destroy();
        room.jukebox = null;
        io.to(channelId).emit('room:closed', { channelId });
        for (const peer of [...room.peers.values()]) leaveVoice(io, peer.socket);
        rooms.delete(channelId);
      }
      soup.closeRouter(channelId);
    }
    db.deleteChannel(channelId);
    if (ch.type === 'text') syncTextRooms(io);
    dirDirty(io);
    return { ok: true };
  }));

  socket.on('channel:overwrites:get', guarded(async ({ channelId }) => {
    need(perms(channelId), P.MANAGE_CHANNELS, 'no permission to manage this channel');
    return { overwrites: db.listOverwrites(channelId) };
  }));

  socket.on('channel:overwrites:set',
    guarded(async ({ channelId, targetType, targetId, allow, deny }) => {
      need(perms(channelId), P.MANAGE_CHANNELS, 'no permission to manage this channel');
      if (targetType !== 'role' && targetType !== 'user') throw new Error('bad target');
      db.setOverwrite(channelId, targetType, String(targetId),
        Number(allow) || 0, Number(deny) || 0);
      syncTextRooms(io);
      dirDirty(io);
      return { ok: true };
    }));

  /* ---- moderation ---- */

  socket.on('member:mute', guarded(async ({ userId, muted }) => {
    const target = db.getUser(userId);
    if (!target) throw new Error('unknown user');
    if (target.is_owner) throw new Error('the owner cannot be muted');
    const located = findVoicePeer(userId);
    need(perms(located?.room.id || null), P.MUTE_MEMBERS, 'no permission to mute members');

    if (muted) serverMuted.add(userId); else serverMuted.delete(userId);

    if (located) {
      const { room, peer } = located;
      if (muted) {
        for (const producer of [...peer.producers.values()]) {
          if (producer.kind === 'audio' && (producer.appData?.mediaTag || '') === 'mic') {
            safeClose(producer);
            peer.producers.delete(producer.id);
            io.to(room.id).emit('producer:closed', { peerId: peer.id, producerId: producer.id });
          }
        }
      }
      peer.socket.emit('force:muted', { muted });
      io.to(room.id).emit('peer:state', { id: peer.id, state: peer.summary().state });
    }
    dirDirty(io);
    return { ok: true };
  }));

  socket.on('member:kick', guarded(async ({ userId }) => {
    need(perms(), P.KICK_MEMBERS, 'no permission to kick members');
    const target = db.getUser(userId);
    if (!target) throw new Error('unknown user');
    if (target.is_owner) throw new Error('the owner cannot be kicked');
    for (const s of io.sockets.sockets.values()) {
      if (s.data.user?.id === userId) {
        s.emit('kicked', { by: user.name });
        s.disconnect(true);
      }
    }
    return { ok: true };
  }));

  socket.on('disconnect', () => leaveVoice(io, socket));
}

/** Live media counts for the owner dashboard. */
function liveStats() {
  let voice = 0, producers = 0, jukeboxes = 0;
  for (const room of rooms.values()) {
    voice += room.peers.size;
    for (const peer of room.peers.values()) producers += peer.producers.size;
    if (room.jukebox?.producer) { producers += 1; jukeboxes += 1; }
  }
  return { voice, rooms: rooms.size, producers, jukeboxes };
}

module.exports = {
  attachSocket, publicDirectory, directoryFor,
  dirDirty, syncTextRooms, leaveVoice, serverMuted, liveStats
};
