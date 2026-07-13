'use strict';
/**
 * Room / Peer state and the full signaling protocol.
 *
 * Protocol (all requests use socket.io ack callbacks; errors come back
 * as { error: string }):
 *
 *   client -> server
 *     channels:list                                   -> [{id,name,peers:[{id,name}]}]
 *     room:join        {channelId, name}              -> {routerRtpCapabilities, peers:[...]}
 *     room:leave                                      -> {ok}
 *     transport:create {direction:'send'|'recv'}      -> transport params
 *     transport:connect{transportId, dtlsParameters}  -> {ok}
 *     produce          {transportId,kind,rtpParameters,appData} -> {producerId}
 *     producer:close   {producerId}                   -> {ok}
 *     consume          {producerId, rtpCapabilities}  -> consumer params
 *     consumer:resume  {consumerId}                   -> {ok}
 *     peer:state       {muted,deafened,camOn,sharing} -> {ok}
 *     ping             (ts)                           -> ts        (speed test RTT)
 *
 *   server -> client (broadcast within the room)
 *     peer:joined      {id,name,state}
 *     peer:left        {id}
 *     producer:new     {peerId, producerId, kind, mediaTag}
 *     producer:closed  {peerId, producerId}
 *     peer:state       {id, state}
 *     speaker          {peerId | null}                (dominant speaker)
 */

const soup = require('./soup');

const rooms = new Map(); // channelId -> Room

class Peer {
  constructor(socket, name) {
    this.id = socket.id;
    this.socket = socket;
    this.name = name;
    this.state = { muted: false, deafened: false, camOn: false, sharing: false };
    this.transports = new Map();
    this.producers = new Map();
    this.consumers = new Map();
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      producers: [...this.producers.values()].map((p) => ({
        id: p.id,
        kind: p.kind,
        mediaTag: p.appData?.mediaTag || p.kind
      }))
    };
  }

  close() {
    for (const c of this.consumers.values()) safeClose(c);
    for (const p of this.producers.values()) safeClose(p);
    for (const t of this.transports.values()) safeClose(t);
    this.consumers.clear();
    this.producers.clear();
    this.transports.clear();
  }
}

class Room {
  constructor(channelId, name, router) {
    this.id = channelId;
    this.name = name;
    this.router = router;
    this.peers = new Map();
    this.audioLevelObserver = null;
    this.lastSpeaker = null;
  }

  async ensureAudioObserver(io) {
    if (this.audioLevelObserver) return;
    this.audioLevelObserver = await this.router.createAudioLevelObserver({
      maxEntries: 1,
      threshold: -60,
      interval: 400
    });
    this.audioLevelObserver.on('volumes', (volumes) => {
      const producer = volumes[0]?.producer;
      const peerId = producer?.appData?.peerId || null;
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
    return [...this.peers.values()]
      .filter((p) => p.id !== excludeId)
      .map((p) => p.summary());
  }
}

function safeClose(thing) {
  try { if (thing && !thing.closed) thing.close(); } catch { /* already gone */ }
}

function getOrCreateRoom(channelId) {
  if (rooms.has(channelId)) return rooms.get(channelId);
  const entry = soup.getRouterEntry(channelId);
  if (!entry) return null;
  const room = new Room(channelId, entry.name, entry.router);
  rooms.set(channelId, room);
  return room;
}

function roomOf(socket) {
  const channelId = socket.data.channelId;
  return channelId ? rooms.get(channelId) || null : null;
}

function peerOf(socket) {
  const room = roomOf(socket);
  return room ? room.peers.get(socket.id) || null : null;
}

function channelDirectory() {
  return soup.listChannels().map(({ id, name }) => {
    const room = rooms.get(id);
    return {
      id,
      name,
      peers: room ? [...room.peers.values()].map((p) => ({ id: p.id, name: p.name })) : []
    };
  });
}

function broadcastDirectory(io) {
  io.emit('channels:update', channelDirectory());
}

function leaveRoom(io, socket) {
  const room = roomOf(socket);
  const peer = peerOf(socket);
  if (!room || !peer) return;

  peer.close();
  room.peers.delete(peer.id);
  socket.leave(room.id);
  socket.data.channelId = null;

  socket.to(room.id).emit('peer:left', { id: peer.id });
  if (room.lastSpeaker === peer.id) {
    room.lastSpeaker = null;
    io.to(room.id).emit('speaker', { peerId: null });
  }
  broadcastDirectory(io);
}

/** Wrap a handler so thrown errors become { error } acks instead of crashes. */
function guarded(handler) {
  return async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      reply(await handler(payload || {}));
    } catch (err) {
      console.error('[signal]', err.message);
      reply({ error: err.message });
    }
  };
}

function attach(io) {
  io.on('connection', (socket) => {
    socket.data.channelId = null;

    socket.on('channels:list', guarded(async () => channelDirectory()));

    // Trivial echo used by the client speed test for RTT.
    socket.on('ping', (ts, ack) => { if (typeof ack === 'function') ack(ts); });

    socket.on('room:join', guarded(async ({ channelId, name }) => {
      if (!channelId || !name) throw new Error('channelId and name are required');
      if (socket.data.channelId) leaveRoom(io, socket); // channel hop

      const room = getOrCreateRoom(channelId);
      if (!room) throw new Error(`unknown channel: ${channelId}`);
      await room.ensureAudioObserver(io);

      const peer = new Peer(socket, String(name).slice(0, 32));
      room.peers.set(peer.id, peer);
      socket.data.channelId = channelId;
      socket.join(channelId);

      socket.to(channelId).emit('peer:joined', {
        id: peer.id, name: peer.name, state: peer.state
      });
      broadcastDirectory(io);

      return {
        routerRtpCapabilities: room.router.rtpCapabilities,
        peers: room.peerSummaries(peer.id)
      };
    }));

    socket.on('room:leave', guarded(async () => {
      leaveRoom(io, socket);
      return { ok: true };
    }));

    socket.on('transport:create', guarded(async ({ direction }) => {
      const room = roomOf(socket);
      const peer = peerOf(socket);
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
      const peer = peerOf(socket);
      const transport = peer?.transports.get(transportId);
      if (!transport) throw new Error('unknown transport');
      await transport.connect({ dtlsParameters });
      return { ok: true };
    }));

    socket.on('produce', guarded(async ({ transportId, kind, rtpParameters, appData }) => {
      const room = roomOf(socket);
      const peer = peerOf(socket);
      const transport = peer?.transports.get(transportId);
      if (!room || !transport) throw new Error('unknown transport');

      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData: { ...appData, peerId: peer.id }
      });
      peer.producers.set(producer.id, producer);

      producer.on('transportclose', () => peer.producers.delete(producer.id));

      const mediaTag = producer.appData.mediaTag || kind;
      if (kind === 'audio' && mediaTag === 'mic') {
        room.audioLevelObserver
          ?.addProducer({ producerId: producer.id })
          .catch(() => {});
      }

      socket.to(room.id).emit('producer:new', {
        peerId: peer.id,
        producerId: producer.id,
        kind,
        mediaTag
      });

      return { producerId: producer.id };
    }));

    socket.on('producer:close', guarded(async ({ producerId }) => {
      const room = roomOf(socket);
      const peer = peerOf(socket);
      const producer = peer?.producers.get(producerId);
      if (!producer) throw new Error('unknown producer');

      safeClose(producer);
      peer.producers.delete(producerId);
      socket.to(room.id).emit('producer:closed', { peerId: peer.id, producerId });
      return { ok: true };
    }));

    socket.on('consume', guarded(async ({ producerId, rtpCapabilities }) => {
      const room = roomOf(socket);
      const peer = peerOf(socket);
      if (!room || !peer) throw new Error('join a channel first');
      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error('cannot consume this producer with your capabilities');
      }

      const transport = [...peer.transports.values()]
        .find((t) => t.appData.direction === 'recv');
      if (!transport) throw new Error('no receive transport');

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true // resumed by the client once its media element is wired
      });
      peer.consumers.set(consumer.id, consumer);

      consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
      consumer.on('producerclose', () => {
        peer.consumers.delete(consumer.id);
        socket.emit('consumer:closed', { consumerId: consumer.id });
      });

      return {
        consumerId: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
      };
    }));

    socket.on('consumer:resume', guarded(async ({ consumerId }) => {
      const peer = peerOf(socket);
      const consumer = peer?.consumers.get(consumerId);
      if (!consumer) throw new Error('unknown consumer');
      await consumer.resume();
      return { ok: true };
    }));

    socket.on('peer:state', guarded(async (state) => {
      const room = roomOf(socket);
      const peer = peerOf(socket);
      if (!room || !peer) throw new Error('join a channel first');
      peer.state = { ...peer.state, ...state };
      socket.to(room.id).emit('peer:state', { id: peer.id, state: peer.state });
      return { ok: true };
    }));

    socket.on('disconnect', () => leaveRoom(io, socket));
  });
}

module.exports = { attach, channelDirectory };
