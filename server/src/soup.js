'use strict';
/**
 * mediasoup plumbing: one worker, one WebRtcServer (single media port),
 * and routers created lazily per voice channel — channels are dynamic
 * now, so routers come and go with them.
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
  return { worker, webRtcServer };
}

async function getOrCreateRouter(channelId) {
  if (routers.has(channelId)) return routers.get(channelId);
  const router = await worker.createRouter({
    mediaCodecs: config.mediasoup.router.mediaCodecs
  });
  routers.set(channelId, router);
  return router;
}

function closeRouter(channelId) {
  const router = routers.get(channelId);
  if (router) {
    routers.delete(channelId);
    try { router.close(); } catch { /* already closed */ }
  }
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

module.exports = { init, getOrCreateRouter, closeRouter, createTransport };
