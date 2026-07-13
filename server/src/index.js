'use strict';
/**
 * Hearth server entrypoint.
 *
 *   npm start            boot the server
 *   npm run selftest     boot mediasoup, print capabilities, exit 0
 *
 * Transport security note: Hearth is designed to run over a Tailscale
 * tailnet, which provides WireGuard encryption and authenticated peers.
 * The HTTP/WS layer is therefore deliberately plain — do not expose this
 * port to the public internet.
 */

const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const config = require('./config');
const soup = require('./soup');
const room = require('./room');

const SELFTEST = process.argv.includes('--selftest');
const VERSION = require('../package.json').version;

// ---------------------------------------------------------------- speed test

// 4 MiB of random bytes, generated once and streamed repeatedly.
const RANDOM_CHUNK = crypto.randomBytes(4 * 1024 * 1024);
const speedReports = new Map(); // name -> {name, upMbps, downMbps, pingMs, at}

function buildApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => res.json({ ok: true, version: VERSION }));

  app.get('/info', (_req, res) => res.json({
    name: config.serverName,
    version: VERSION,
    announcedAddress: config.announcedAddress,
    channels: room.channelDirectory()
  }));

  // Download test: stream `mb` mebibytes of incompressible data.
  app.get('/speedtest/download', (req, res) => {
    const mb = Math.min(Math.max(Number(req.query.mb) || 12, 1), 64);
    const total = mb * 1024 * 1024;
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(total),
      'Cache-Control': 'no-store'
    });
    let sent = 0;
    const push = () => {
      while (sent < total) {
        const chunk = RANDOM_CHUNK.subarray(0, Math.min(RANDOM_CHUNK.length, total - sent));
        sent += chunk.length;
        if (!res.write(chunk)) { res.once('drain', push); return; }
      }
      res.end();
    };
    push();
  });

  // Upload test: client POSTs random bodies; we just count what arrived.
  app.post(
    '/speedtest/upload',
    express.raw({ type: '*/*', limit: '9mb' }),
    (req, res) => res.json({ bytes: req.body?.length || 0 })
  );

  // Clients report results so the host can see the whole crew's numbers.
  app.post('/speedtest/report', express.json(), (req, res) => {
    const { name, upMbps, downMbps, pingMs } = req.body || {};
    if (name) {
      speedReports.set(String(name).slice(0, 32), {
        name: String(name).slice(0, 32),
        upMbps: Number(upMbps) || 0,
        downMbps: Number(downMbps) || 0,
        pingMs: Number(pingMs) || 0,
        at: new Date().toISOString()
      });
    }
    res.json({ ok: true });
  });

  app.get('/speedtest/reports', (_req, res) =>
    res.json([...speedReports.values()].sort((a, b) => a.name.localeCompare(b.name)))
  );

  app.get('/', (_req, res) => {
    res.type('text/plain').send(
      `${config.serverName} server v${VERSION} is up.\n` +
      `Point the Hearth app at: http://${config.announcedAddress}:${config.httpPort}\n`
    );
  });

  return app;
}

// ----------------------------------------------------------------------- boot

async function main() {
  await soup.init();

  if (SELFTEST) {
    const codecs = config.mediasoup.router.mediaCodecs
      .map((c) => c.mimeType.split('/')[1])
      .join(', ');
    console.log('[selftest] mediasoup worker + WebRtcServer + routers: OK');
    console.log(`[selftest] channels: ${config.channels.join(' | ')}`);
    console.log(`[selftest] codecs:   ${codecs}`);
    console.log(`[selftest] announce: ${config.announcedAddress} (media port ${config.mediaPort})`);
    process.exit(0);
  }

  const app = buildApp();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: '*' },
    maxHttpBufferSize: 1e6
  });
  room.attach(io);

  httpServer.listen(config.httpPort, '0.0.0.0', () => {
    const url = `http://${config.announcedAddress}:${config.httpPort}`;
    console.log('');
    console.log('  ┌──────────────────────────────────────────────────┐');
    console.log(`  │  ${config.serverName} server v${VERSION}`.padEnd(53) + '│');
    console.log('  ├──────────────────────────────────────────────────┤');
    console.log(`  │  Give your friends this address:`.padEnd(53) + '│');
    console.log(`  │    ${url}`.padEnd(53) + '│');
    console.log(`  │  Media port: ${config.mediaPort} udp+tcp (via Tailscale,`.padEnd(53) + '│');
    console.log('  │  no router port-forwarding needed)'.padEnd(53) + '│');
    console.log('  └──────────────────────────────────────────────────┘');
    console.log('');
    if (config.announcedAddress.startsWith('127.')) {
      console.warn('  [warn] No Tailscale or LAN address detected — clients on other');
      console.warn('         machines will not reach media. Is tailscaled running?');
    }
  });
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
