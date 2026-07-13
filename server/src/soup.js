'use strict';
/**
 * mediasoup plumbing: one worker, one WebRtcServer (single media port),
 * and one router per voice channel.
 *
 * Sizing note: a single worker (one CPU core) comfortably forwards the
 * traffic of a 10-person hangout with a couple of concurrent streams.
 * If you ever outgrow it, shard channels across additional workers —
 * each worker needs its own WebRtcServer port.
 */

const mediasoup = require('mediasoup');
const config = require('./config');

let worker = null;
let webRtcServer = null;
const routers = new Map(); // channelId -> Router

async function init() {
  worker = await mediasoup.createWorker(config.mediasoup.worker);

  worker.on('died', (err) => {
    console.error('[soup] mediasoup worker died, exiting in 2s:', err);
    setTimeout(() => process.exit(1), 2000);
  });

  webRtcServer = await worker.createWebRtcServer(config.mediasoup.webRtcServer);

  for (const [index, name] of config.channels.entries()) {
    const id = `ch-${index}`;
    const router = await worker.createRouter({
      mediaCodecs: config.mediasoup.router.mediaCodecs
    });
    routers.set(id, { id, name, router });
  }

  return { worker, webRtcServer, routers };
}

function getRouterEntry(channelId) {
  return routers.get(channelId) || null;
}

function listChannels() {
  return [...routers.values()].map(({ id, name }) => ({ id, name }));
}

async function createTransport(router) {
  const transport = await router.createWebRtcTransport({
    webRtcServer,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate:
      config.mediasoup.webRtcTransport.initialAvailableOutgoingBitrate
  });

  const { maxIncomingBitrate } = config.mediasoup.webRtcTransport;
  if (maxIncomingBitrate) {
    try { await transport.setMaxIncomingBitrate(maxIncomingBitrate); } catch { /* non-fatal */ }
  }

  return transport;
}

module.exports = { init, getRouterEntry, listChannels, createTransport };
