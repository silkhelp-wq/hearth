/**
 * HearthRTC — everything WebRTC, wrapped.
 * Socket.io signaling + mediasoup-client transports/producers/consumers.
 */

import { io } from 'socket.io-client';
import { Device } from 'mediasoup-client';

class Emitter {
  #handlers = new Map();
  on(ev, fn) {
    if (!this.#handlers.has(ev)) this.#handlers.set(ev, new Set());
    this.#handlers.get(ev).add(fn);
    return () => this.#handlers.get(ev)?.delete(fn);
  }
  emit(ev, payload) {
    for (const fn of this.#handlers.get(ev) || []) fn(payload);
  }
}

export class HearthRTC extends Emitter {
  constructor() {
    super();
    this.socket = null;
    this.device = null;
    this.sendTransport = null;
    this.recvTransport = null;
    this.producers = new Map();  // mediaTag -> producer
    this.consumers = new Map();  // consumerId -> { consumer, peerId, mediaTag }
    this.baseUrl = null;
    this.joined = null;          // channelId while in a room
  }

  // ------------------------------------------------------------ connection

  connect(baseUrl, auth = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    return new Promise((resolve, reject) => {
      const socket = io(this.baseUrl, {
        auth,
        transports: ['websocket'],
        reconnectionDelayMax: 5000,
        timeout: 8000
      });
      this.socket = socket;

      socket.once('connect', () => resolve());
      socket.once('connect_error', (err) =>
        reject(new Error(`could not reach server: ${err.message}`)));

      socket.on('disconnect', (reason) => this.emit('disconnected', reason));
      socket.io.on('reconnect', () => this.emit('reconnected'));

      socket.on('channels:update', (dir) => this.emit('channels', dir));
      socket.on('peer:joined', (p) => this.emit('peer-joined', p));
      socket.on('peer:left', (p) => this.emit('peer-left', p));
      socket.on('peer:state', (p) => this.emit('peer-state', p));
      socket.on('speaker', (p) => this.emit('speaker', p));
      socket.on('consumer:closed', ({ consumerId }) => this.#dropConsumer(consumerId));
      socket.on('producer:new', (p) => {
        if (this.joined) this.#consume(p).catch((e) => console.error('[rtc] consume:', e));
      });
      socket.on('producer:closed', ({ producerId }) => {
        for (const [id, entry] of this.consumers) {
          if (entry.consumer.producerId === producerId) this.#dropConsumer(id);
        }
      });
    });
  }

  /** Subscribe to a raw server event (call after connect()). */
  onRaw(event, cb) { this.socket.on(event, cb); }

  request(event, data) {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) return reject(new Error('not connected'));
      this.socket.emit(event, data, (res) => {
        if (res && res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  async channels() { return this.request('channels:list'); }

  // ------------------------------------------------------------------ join

  async join(channelId) {
    const { routerRtpCapabilities, peers, canSpeak } =
      await this.request('room:join', { channelId });

    this.device = new Device();
    await this.device.load({ routerRtpCapabilities });

    this.sendTransport = await this.#makeTransport('send');
    this.recvTransport = await this.#makeTransport('recv');
    this.joined = channelId;

    // Pull in everyone who's already producing.
    for (const peer of peers) {
      for (const prod of peer.producers) {
        this.#consume({
          peerId: peer.id,
          producerId: prod.id,
          kind: prod.kind,
          mediaTag: prod.mediaTag
        }).catch((e) => console.error('[rtc] consume:', e));
      }
    }
    return { peers, canSpeak };
  }

  async leave() {
    this.joined = null;
    for (const tag of [...this.producers.keys()]) await this.closeProducer(tag);
    for (const id of [...this.consumers.keys()]) this.#dropConsumer(id);
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = this.recvTransport = null;
    this.device = null;
    try { await this.request('room:leave'); } catch { /* server may be gone */ }
  }

  async #makeTransport(direction) {
    const params = await this.request('transport:create', { direction });
    const transport = direction === 'send'
      ? this.device.createSendTransport(params)
      : this.device.createRecvTransport(params);

    transport.on('connect', ({ dtlsParameters }, done, fail) => {
      this.request('transport:connect', { transportId: transport.id, dtlsParameters })
        .then(done, fail);
    });

    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters, appData }, done, fail) => {
        this.request('produce', { transportId: transport.id, kind, rtpParameters, appData })
          .then(({ producerId }) => done({ id: producerId }), fail);
      });
    }
    return transport;
  }

  // --------------------------------------------------------------- produce

  #pickCodec(pref) {
    if (!pref || pref === 'auto') return undefined;
    return this.device.rtpCapabilities.codecs.find(
      (c) => c.mimeType.toLowerCase() === `video/${pref.toLowerCase()}`
    );
  }

  async produceMic(track, { music = false } = {}) {
    const producer = await this.sendTransport.produce({
      track,
      stopTracks: false, // app owns the mic stream (meter, device swaps)
      codecOptions: {
        opusStereo: music,
        opusDtx: !music,
        opusFec: true,
        opusMaxAverageBitrate: music ? 128000 : 64000
      },
      appData: { mediaTag: 'mic' }
    });
    this.producers.set('mic', producer);
    return producer;
  }

  async produceCam(track, preset) {
    const producer = await this.sendTransport.produce({
      track,
      encodings: preset?.kbps ? [{ maxBitrate: preset.kbps * 1000 }] : undefined,
      codecOptions: { videoGoogleStartBitrate: 1000 },
      appData: { mediaTag: 'cam' }
    });
    this.producers.set('cam', producer);
    return producer;
  }

  async produceScreen({ videoTrack, audioTrack, preset, codecPref, optimize }) {
    videoTrack.contentHint = optimize === 'text' ? 'detail' : 'motion';

    const video = await this.sendTransport.produce({
      track: videoTrack,
      encodings: preset?.kbps ? [{ maxBitrate: preset.kbps * 1000 }] : undefined,
      codecOptions: { videoGoogleStartBitrate: 1500 },
      codec: this.#pickCodec(codecPref),
      appData: { mediaTag: 'screen' }
    });
    this.producers.set('screen', video);

    if (audioTrack) {
      const audio = await this.sendTransport.produce({
        track: audioTrack,
        codecOptions: { opusStereo: true, opusDtx: true, opusMaxAverageBitrate: 128000 },
        appData: { mediaTag: 'screen-audio' }
      });
      this.producers.set('screen-audio', audio);
    }
    return video;
  }

  async closeProducer(mediaTag) {
    const producer = this.producers.get(mediaTag);
    if (!producer) return;
    this.producers.delete(mediaTag);
    try { await this.request('producer:close', { producerId: producer.id }); } catch { /* ok */ }
    producer.close();
  }

  async replaceMicTrack(track) {
    await this.producers.get('mic')?.replaceTrack({ track });
  }

  // --------------------------------------------------------------- consume

  async #consume({ peerId, producerId, kind, mediaTag }) {
    const params = await this.request('consume', {
      producerId,
      rtpCapabilities: this.device.rtpCapabilities
    });
    const consumer = await this.recvTransport.consume({
      id: params.consumerId,
      producerId: params.producerId,
      kind: params.kind,
      rtpParameters: params.rtpParameters
    });
    this.consumers.set(consumer.id, { consumer, peerId, mediaTag });

    this.emit('consumer-added', {
      consumerId: consumer.id,
      peerId,
      mediaTag,
      kind,
      track: consumer.track
    });
    await this.request('consumer:resume', { consumerId: consumer.id });
  }

  #dropConsumer(consumerId) {
    const entry = this.consumers.get(consumerId);
    if (!entry) return;
    this.consumers.delete(consumerId);
    entry.consumer.close();
    this.emit('consumer-closed', { consumerId, peerId: entry.peerId, mediaTag: entry.mediaTag });
  }

  /** { codec, encoder, fps, width, height, kbps } for an own outgoing video stream, or null. */
  async producerStats(mediaTag) {
    const producer = this.producers.get(mediaTag);
    if (!producer || producer.kind !== 'video' || producer.closed) return null;
    const stats = await producer.getStats();
    let outbound = null;
    const byId = new Map();
    stats.forEach((r) => byId.set(r.id, r));
    stats.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') outbound = r;
    });
    if (!outbound) return null;

    const store = (this._prodStats ??= new Map());
    const prev = store.get(mediaTag) || { bytes: outbound.bytesSent, at: performance.now() };
    const now = performance.now();
    const kbps = now > prev.at
      ? Math.max(0, ((outbound.bytesSent - prev.bytes) * 8) / ((now - prev.at) / 1000) / 1000)
      : 0;
    store.set(mediaTag, { bytes: outbound.bytesSent, at: now });

    const codec = byId.get(outbound.codecId)?.mimeType?.split('/')[1] || '?';
    return {
      codec,
      encoder: outbound.encoderImplementation || '?',
      fps: Math.round(outbound.framesPerSecond || 0),
      width: outbound.frameWidth || 0,
      height: outbound.frameHeight || 0,
      kbps: Math.round(kbps)
    };
  }

  /** { codec, fps, width, height, kbps } for a video consumer, or null. */
  async consumerStats(consumerId) {
    const entry = this.consumers.get(consumerId);
    if (!entry) return null;
    const stats = await entry.consumer.getStats();
    let inbound = null;
    const byId = new Map();
    stats.forEach((r) => byId.set(r.id, r));
    stats.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') inbound = r;
    });
    if (!inbound) return null;

    const prev = entry.lastBytes ?? inbound.bytesReceived;
    const prevAt = entry.lastAt ?? performance.now();
    const now = performance.now();
    const kbps = Math.max(0, ((inbound.bytesReceived - prev) * 8) / ((now - prevAt) / 1000) / 1000);
    entry.lastBytes = inbound.bytesReceived;
    entry.lastAt = now;

    const codec = byId.get(inbound.codecId)?.mimeType?.split('/')[1] || '?';
    return {
      codec,
      fps: Math.round(inbound.framesPerSecond || 0),
      width: inbound.frameWidth || 0,
      height: inbound.frameHeight || 0,
      kbps: Math.round(kbps)
    };
  }
}
