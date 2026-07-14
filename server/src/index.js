'use strict';
/**
 * Hearth server entrypoint (v0.2: identity, roles, text chat).
 *
 *   npm start            boot the server
 *   npm run selftest     exercise db + perms + chat + mediasoup, exit 0/1
 *
 * Security note: designed for a Tailscale tailnet (WireGuard encrypts and
 * authenticates the path). Do not expose this port to the public internet.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const config = require('./config');
const db = require('./db');
const soup = require('./soup');
const room = require('./room');
const chat = require('./chat');
const unfurl = require('./unfurl');
const jukebox = require('./jukebox');
const gifs = require('./gifs');
const monitor = require('./monitor');
const selfupdate = require('./selfupdate');
const { P, ALL, has } = require('./perms');

const SELFTEST = process.argv.includes('--selftest');
const VERSION = require('../package.json').version;

/* ─────────────────────────── speed test app ────────────────────────── */

const RANDOM_CHUNK = crypto.randomBytes(4 * 1024 * 1024);
const speedReports = new Map();

function buildApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => res.json({ ok: true, version: VERSION }));
  app.use('/emoji', express.static(path.join(config.dataDir, 'emoji'),
    { maxAge: '30d', immutable: true, fallthrough: false }));
  app.get('/info', (_req, res) => res.json({
    name: config.serverName,
    version: VERSION,
    announcedAddress: config.announcedAddress,
    channels: room.publicDirectory().map(({ id, name, type }) => ({ id, name, type }))
  }));

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

  app.post('/speedtest/upload',
    express.raw({ type: '*/*', limit: '9mb' }),
    (req, res) => res.json({ bytes: req.body?.length || 0 }));

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
    res.json([...speedReports.values()].sort((a, b) => a.name.localeCompare(b.name))));

  app.get('/', (_req, res) => {
    res.type('text/plain').send(
      `${config.serverName} server v${VERSION} is up.\n` +
      `Point the Hearth app at: http://${config.announcedAddress}:${config.httpPort}\n`);
  });
  return app;
}

/* ────────────────────────────── helpers ────────────────────────────── */

const online = new Map(); // userId -> Set(socketId)

function usersWithOnline() {
  return db.listUsers().map((u) => ({ ...u, online: online.has(u.id) }));
}

function topRolePosition(userId) {
  const user = db.getUser(userId);
  if (user?.is_owner) return Infinity;
  const ids = db.userRoleIds(userId);
  let top = 0;
  for (const r of db.listRoles()) {
    if (ids.includes(r.id)) top = Math.max(top, r.position);
  }
  return top;
}

function guarded(handler) {
  return async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try { reply(await handler(payload || {})); }
    catch (err) { reply({ error: err.message }); }
  };
}

/* ──────────────────────────── unfurl queue ─────────────────────────── */

const unfurlPending = new Set();
const PREVIEW_TTL = 7 * 24 * 3600 * 1000;

function makeEnqueueUnfurl(io) {
  return (url, channelId) => {
    if (unfurlPending.has(url)) return;
    const cached = db.getPreview(url);
    if (cached && Date.now() - cached.fetched_at < PREVIEW_TTL) return;
    unfurlPending.add(url);
    unfurl.fetchCard(url, config.unfurl)
      .then((card) => {
        db.savePreview(url, card);
        if (card) io.to(`text:${channelId}`).emit('preview', { url, card });
      })
      .catch(() => db.savePreview(url, null))
      .finally(() => unfurlPending.delete(url));
  };
}

/* ─────────────────────────────── boot ──────────────────────────────── */

async function main() {
  db.init({ dbPath: config.dbPath, seedVoiceChannels: config.seedVoiceChannels });
  await soup.init();

  const app = buildApp();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' }, maxHttpBufferSize: 1e6 });
  const enqueueUnfurl = makeEnqueueUnfurl(io);
  fs.mkdirSync(path.join(config.dataDir, 'emoji'), { recursive: true });

  // Rolling prune, driven by the LIVE storage settings (owner-editable).
  const prune = () => {
    try {
      const st = db.getStorageSettings(config.storage);
      const r = db.pruneToCap(st.chatCapMB * 1024 * 1024, config.chat.pruneBatch);
      if (r.deleted) {
        console.log(`[prune] removed ${r.deleted} old messages; db now ${(r.size / 1e6).toFixed(1)} MB`);
      }
      const pv = db.prunePreviews(st.previewCapMB * 1024 * 1024);
      if (pv) console.log(`[prune] dropped ${pv} cached link previews`);
    } catch (err) { console.error('[prune]', err.message); }
  };

  // Identity: device token in the socket handshake. New token = new user.
  io.use((socket, next) => {
    const { token, name } = socket.handshake.auth || {};
    if (!token || String(token).length < 16) {
      return next(new Error('this server requires Hearth v0.2+ (no identity token sent)'));
    }
    const cleanName = String(name || '').trim().slice(0, 32) || 'friend';
    let user = db.userByToken(token);
    if (!user) user = db.createUser(token, cleanName);
    else if (user.name !== cleanName) { db.renameUser(user.id, cleanName); user.name = cleanName; }
    socket.data.user = { id: user.id, name: user.name, isOwner: !!user.is_owner };
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;

    if (!online.has(user.id)) online.set(user.id, new Set());
    online.get(user.id).add(socket.id);
    io.emit('users:update', usersWithOnline());

    room.syncTextRooms(io, socket);
    room.attachSocket(io, socket);
    chat.attachSocket(io, socket, { enqueueUnfurl });

    socket.emit('hello', {
      user: { ...user, isOwner: !!db.getUser(user.id)?.is_owner },
      users: usersWithOnline(),
      roles: db.listRoles(),
      channels: room.directoryFor(user.id),
      readState: db.readState(user.id),
      ownerClaimed: db.ownerClaimed(),
      serverName: config.serverName,
      emojis: db.listEmojis(),
      caps: {
        maxMessageLen: config.chat.maxMessageLen,
        jukebox: jukebox.available(),
        jukeboxPause: jukebox.available() && jukebox.canPause(),
        gifProviders: gifs.providers(),
        emojiMaxKB: config.storage.emojiMaxKB,
        mediaHosts: gifs.MEDIA_HOSTS
      }
    });

    socket.on('user:rename', guarded(async ({ name }) => {
      name = String(name || '').trim().slice(0, 32);
      if (!name) throw new Error('name cannot be empty');
      db.renameUser(user.id, name);
      user.name = name;
      io.emit('users:update', usersWithOnline());
      room.dirDirty(io);
      return { ok: true };
    }));

    socket.on('owner:claim', guarded(async ({ code }) => {
      const res = db.claimOwner(user.id, String(code || '').trim());
      if (res.error) throw new Error(res.error);
      user.isOwner = true;
      io.emit('users:update', usersWithOnline());
      room.dirDirty(io);
      console.log(`[owner] ${user.name} claimed ownership`);
      return { ok: true };
    }));

    socket.on('users:list', guarded(async () => usersWithOnline()));
    socket.on('roles:list', guarded(async () => db.listRoles()));

    const needManageRoles = () => {
      if (!has(db.permsFor(user.id), P.MANAGE_ROLES)) {
        throw new Error('no permission to manage roles');
      }
    };
    const isOwnerUser = () => !!db.getUser(user.id)?.is_owner;
    const guardAdminBit = (permissions) => {
      if ((permissions & P.ADMINISTRATOR) && !isOwnerUser()) {
        throw new Error('only the owner can grant Administrator');
      }
    };

    socket.on('role:create', guarded(async ({ name, color, permissions }) => {
      needManageRoles();
      name = String(name || '').trim().slice(0, 32);
      if (!name) throw new Error('role needs a name');
      permissions = Number(permissions) & ALL;
      guardAdminBit(permissions);
      const role = db.createRole({ name, color: String(color || '#7fa3b8'), permissions });
      io.emit('roles:update', db.listRoles());
      return { role };
    }));

    socket.on('role:update', guarded(async ({ id, name, color, permissions }) => {
      needManageRoles();
      const existing = db.listRoles().find((r) => r.id === id);
      if (!existing) throw new Error('unknown role');
      if ((existing.permissions & P.ADMINISTRATOR) && !isOwnerUser()) {
        throw new Error('only the owner can edit Administrator roles');
      }
      if (permissions != null) guardAdminBit(Number(permissions));
      const role = db.updateRole(id, {
        name: name != null ? String(name).trim().slice(0, 32) : undefined,
        color: color != null ? String(color) : undefined,
        permissions: permissions != null ? Number(permissions) : undefined
      });
      io.emit('roles:update', db.listRoles());
      room.syncTextRooms(io);
      room.dirDirty(io);
      return { role };
    }));

    socket.on('role:delete', guarded(async ({ id }) => {
      needManageRoles();
      const existing = db.listRoles().find((r) => r.id === id);
      if (!existing) throw new Error('unknown role');
      if ((existing.permissions & P.ADMINISTRATOR) && !isOwnerUser()) {
        throw new Error('only the owner can delete Administrator roles');
      }
      if (!db.deleteRole(id)) throw new Error('built-in roles cannot be deleted');
      io.emit('roles:update', db.listRoles());
      io.emit('users:update', usersWithOnline());
      room.syncTextRooms(io);
      room.dirDirty(io);
      return { ok: true };
    }));

    socket.on('role:assign', guarded(async ({ userId, roleId, on }) => {
      needManageRoles();
      const role = db.listRoles().find((r) => r.id === roleId);
      if (!role || !db.getUser(userId)) throw new Error('unknown user or role');
      if ((role.permissions & P.ADMINISTRATOR) && !isOwnerUser()) {
        throw new Error('only the owner can assign Administrator roles');
      }
      if (!isOwnerUser() && role.position >= topRolePosition(user.id)) {
        throw new Error('that role is above yours');
      }
      db.assignRole(userId, roleId, !!on);
      io.emit('users:update', usersWithOnline());
      room.syncTextRooms(io);
      room.dirDirty(io);
      return { ok: true };
    }));

    /* ---- emojis / gifs / storage ---- */

    const MAGIC = {
      gif: (b) => b.length > 6 && b.toString('ascii', 0, 4) === 'GIF8',
      png: (b) => b.length > 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG',
      webp: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' &&
                   b.toString('ascii', 8, 12) === 'WEBP'
    };

    socket.on('emoji:add', guarded(async ({ name, data }) => {
      if (!has(db.permsFor(user.id), P.MANAGE_EMOJIS)) {
        throw new Error('no permission to manage emojis');
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
      if (!buf.length) throw new Error('empty file');
      if (buf.length > config.storage.emojiMaxKB * 1024) {
        throw new Error(`emoji too big (max ${config.storage.emojiMaxKB} KB)`);
      }
      const ext = MAGIC.gif(buf) ? 'gif' : MAGIC.png(buf) ? 'png'
        : MAGIC.webp(buf) ? 'webp' : null;
      if (!ext) throw new Error('emojis must be PNG, GIF, or WebP');

      const st = db.getStorageSettings(config.storage);
      if (db.emojiTotalBytes() + buf.length > st.emojiCapMB * 1024 * 1024) {
        throw new Error(`emoji storage is full (${st.emojiCapMB} MB cap — raise it in Storage settings or delete some)`);
      }
      const emoji = db.addEmoji({
        name: String(name || '').trim().toLowerCase(),
        ext, animated: ext !== 'png', bytes: buf.length, uploadedBy: user.id
      });
      fs.mkdirSync(path.join(config.dataDir, 'emoji'), { recursive: true });
      fs.writeFileSync(path.join(config.dataDir, 'emoji', `${emoji.id}.${ext}`), buf);
      io.emit('emoji:update', db.listEmojis());
      return { emoji };
    }));

    socket.on('emoji:delete', guarded(async ({ id }) => {
      if (!has(db.permsFor(user.id), P.MANAGE_EMOJIS)) {
        throw new Error('no permission to manage emojis');
      }
      const emoji = db.emojiById(id);
      if (!emoji) throw new Error('unknown emoji');
      db.deleteEmoji(id);
      try { fs.unlinkSync(path.join(config.dataDir, 'emoji', `${emoji.id}.${emoji.ext}`)); }
      catch { /* already gone */ }
      io.emit('emoji:update', db.listEmojis());
      return { ok: true };
    }));

    socket.on('gif:search', guarded(async ({ q, provider }) =>
      gifs.search(q, provider)));

    const needAdmin = () => {
      if (!has(db.permsFor(user.id), P.ADMINISTRATOR)) {
        throw new Error('server settings need Administrator');
      }
    };

    socket.on('server:settings:get', guarded(async () => {
      needAdmin();
      return {
        settings: db.getStorageSettings(config.storage),
        usage: {
          chatBytes: db.dbSizeBytes(),
          emojiBytes: db.emojiTotalBytes(),
          previewBytes: db.previewCacheBytes()
        }
      };
    }));

    socket.on('server:settings:set', guarded(async (next) => {
      needAdmin();
      const settings = db.setStorageSettings(next || {}, config.storage);
      prune();
      console.log(`[settings] storage caps → chat ${settings.chatCapMB}MB, ` +
        `emoji ${settings.emojiCapMB}MB, previews ${settings.previewCapMB}MB (by ${user.name})`);
      return { settings };
    }));

    socket.on('server:stats', guarded(async () => {
      needAdmin();
      return monitor.snapshot({
        dataDir: config.dataDir,
        storage: {
          chatBytes: db.dbSizeBytes(),
          emojiBytes: db.emojiTotalBytes(),
          previewBytes: db.previewCacheBytes()
        },
        live: {
          users: db.listUsers().length,
          online: online.size,
          ...room.liveStats()
        }
      });
    }));

    socket.on('server:update:check', guarded(async () => {
      needAdmin();
      return selfupdate.checkForUpdate();
    }));

    socket.on('disconnect', () => {
      const set = online.get(user.id);
      set?.delete(socket.id);
      if (set && set.size === 0) online.delete(user.id);
      io.emit('users:update', usersWithOnline());
    });
  });

  prune();
  setInterval(prune, config.chat.pruneIntervalMs).unref();

  httpServer.listen(config.httpPort, '0.0.0.0', () => {
    const url = `http://${config.announcedAddress}:${config.httpPort}`;
    console.log('');
    console.log('  ┌──────────────────────────────────────────────────┐');
    console.log(`  │  ${config.serverName} server v${VERSION}`.padEnd(53) + '│');
    console.log('  ├──────────────────────────────────────────────────┤');
    console.log('  │  Give your friends this address:'.padEnd(53) + '│');
    console.log(`  │    ${url}`.padEnd(53) + '│');
    console.log(`  │  Media port: ${config.mediaPort} udp+tcp (via Tailscale)`.padEnd(53) + '│');
    console.log('  └──────────────────────────────────────────────────┘');
    if (!db.ownerClaimed()) {
      console.log('');
      console.log(`  Owner claim code: ${db.ownerCode()}`);
      console.log('  Enter it in the app under Settings -> Server to take ownership.');
    }
    console.log('');
    if (config.announcedAddress.startsWith('127.')) {
      console.warn('  [warn] No Tailscale or LAN address detected — is tailscaled running?');
    }
  });
}

/* ────────────────────────────── selftest ───────────────────────────── */

async function selftest() {
  let step = 'init';
  const ok = (label) => console.log(`[selftest] ${label}: OK`);
  const assert = (cond, label) => {
    if (!cond) throw new Error(`assert failed: ${label}`);
  };
  try {
    db.init({ dbPath: ':memory:', seedVoiceChannels: config.seedVoiceChannels });
    const chans = db.listChannels();
    assert(chans.some((c) => c.type === 'text'), 'seed text channel');
    assert(chans.filter((c) => c.type === 'voice').length === config.seedVoiceChannels.length,
      'seed voice channels');
    ok('db schema + seed');

    step = 'identity/perms';
    const tok = 'selftest-token-000000000001';
    const u = db.createUser(tok, 'tester');
    assert(db.userByToken(tok)?.id === u.id, 'token lookup');
    let p = db.permsFor(u.id);
    assert(has(p, P.CREATE_CHANNELS) && !has(p, P.MANAGE_CHANNELS),
      'defaults: everyone creates, admins delete');
    assert(db.claimOwner(u.id, 'wrong').error, 'wrong owner code rejected');
    assert(db.claimOwner(u.id, db.ownerCode()).ok, 'owner claim');
    assert(db.permsFor(u.id) === ALL, 'owner has all perms');
    ok('identity + permission engine');

    step = 'overwrites';
    const u2 = db.createUser('selftest-token-000000000002', 'friend');
    const secret = db.createChannel({ name: 'secret', type: 'text', createdBy: u.id });
    db.setOverwrite(secret.id, 'role', 'everyone', 0, P.VIEW_CHANNEL);
    assert(!has(db.permsFor(u2.id, secret.id), P.VIEW_CHANNEL), 'deny overwrite hides channel');
    db.setOverwrite(secret.id, 'user', u2.id, P.VIEW_CHANNEL, 0);
    assert(has(db.permsFor(u2.id, secret.id), P.VIEW_CHANNEL), 'member allow overrides role deny');
    ok('channel overwrites');

    step = 'chat';
    const general = db.listChannels().find((c) => c.type === 'text');
    const urls = db.extractUrls('look at https://example.com/thing and (https://example.org).', 3);
    assert(urls.length === 2 && urls[1] === 'https://example.org', 'url extraction trims punctuation');
    const msg = db.insertMessage({
      channelId: general.id, authorId: u2.id,
      content: 'obsidian golem strategy https://example.com/thing', replyTo: null, urls
    });
    assert(msg.previews.length === 2, 'previews attached (pending cards)');
    db.savePreview('https://example.com/thing',
      { url: 'https://example.com/thing', title: 'Example', description: 'd', siteName: 'example.com' });
    assert(db.search('golem', u.id).length === 1, 'FTS search hits');
    assert(db.toggleReaction(msg.id, u.id, '🔥', true)[0].count === 1, 'reaction toggles');
    db.setPin(general.id, msg.id, u.id, true);
    assert(db.listPins(general.id, u.id).length === 1, 'pin listed');
    db.markRead(u.id, general.id, msg.id);
    assert(db.readState(u.id)[general.id] === msg.id, 'read state');
    ok('messages / search / reactions / pins / read-state');

    step = 'prune';
    const before = db.dbSizeBytes();
    const pr = db.pruneToCap(1, 100);
    assert(pr.deleted >= 1, 'prune removed oldest messages');
    assert(db.dbSizeBytes() <= before, 'db not larger after prune');
    ok('rolling prune');

    step = 'mediasoup';
    await soup.init();
    const voice = db.listChannels().find((c) => c.type === 'voice');
    const router = await soup.getOrCreateRouter(voice.id);
    assert(router.rtpCapabilities.codecs.length > 0, 'router codecs');
    const codecs = config.mediasoup.router.mediaCodecs.map((c) => c.mimeType.split('/')[1]).join(', ');
    ok(`mediasoup worker + WebRtcServer + lazy router (${codecs})`);

    step = 'jukebox';
    const cls = jukebox.classifySource;
    assert(cls('https://www.youtube.com/watch?v=x').kind === 'youtube', 'youtube classified');
    assert(cls('https://youtu.be/x').kind === 'youtube', 'youtu.be classified');
    assert(cls('https://open.spotify.com/track/x').kind === 'spotify', 'spotify classified');
    assert(cls('https://www.pandora.com/artist/a/s/song').kind === 'pandora', 'pandora classified');
    assert(cls('not a url').kind === 'invalid', 'garbage rejected');
    assert(jukebox.titleToQuery('Losing It - song and lyrics by FISHER | Spotify')
      === 'Losing It FISHER', 'spotify title cleaned');
    ok('jukebox link classification');

    step = 'emojis + storage settings';
    const em = db.addEmoji({ name: 'pog', ext: 'gif', animated: true, bytes: 1000, uploadedBy: u.id });
    assert(db.emojiByName('pog')?.id === em.id, 'emoji lookup');
    let threw = false;
    try { db.addEmoji({ name: 'pog', ext: 'png', animated: false, bytes: 1, uploadedBy: u.id }); }
    catch { threw = true; }
    assert(threw, 'duplicate emoji name rejected');
    threw = false;
    try { db.addEmoji({ name: 'Bad Name!', ext: 'png', animated: false, bytes: 1, uploadedBy: u.id }); }
    catch { threw = true; }
    assert(threw, 'invalid emoji name rejected');
    assert(db.emojiTotalBytes() === 1000, 'emoji byte accounting');
    const msg2 = db.insertMessage({
      channelId: general.id, authorId: u.id,
      content: 'post-prune reaction target', replyTo: null, urls: []
    });
    const rx = db.toggleReaction(msg2.id, u.id, `ce:${em.id}`, true);
    assert(rx.some((r) => r.emoji === `ce:${em.id}`), 'custom-emoji reaction stored');
    assert(db.deleteEmoji(em.id), 'emoji delete');

    const st1 = db.setStorageSettings({ chatCapMB: 2048, emojiCapMB: 1, previewCapMB: 5 }, config.storage);
    assert(st1.chatCapMB === 2048 && st1.emojiCapMB === 4, 'settings persist + clamp to floor');
    assert(db.getStorageSettings(config.storage).chatCapMB === 2048, 'settings reload');
    db.savePreview('https://example.com/pv', { url: 'x', title: 'y'.repeat(200), description: 'z'.repeat(200), siteName: 's' });
    assert(db.prunePreviews(1) >= 1, 'preview cache prunes past cap');
    assert(Array.isArray(require('./gifs').providers()) &&
      require('./gifs').providers().length === 0, 'gif providers gated on keys');
    ok('emojis, custom reactions, live storage settings, preview prune');

    const { spawnSync, spawn } = require('child_process');
    const hasFfmpeg = (() => {
      try { return spawnSync('ffmpeg', ['-version'], { timeout: 4000 }).status === 0; }
      catch { return false; }
    })();
    if (hasFfmpeg) {
      step = 'jukebox pipeline';
      const session = new jukebox.JukeboxSession(voice.id, router,
        { to: () => ({ emit: () => {} }), emit: () => {} });
      await session.ensureProducer(null);
      const rtp = session.transport.tuple.localPort;
      const rtcp = session.transport.rtcpTuple.localPort;
      const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
        '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-map', '0:a:0',
        '-acodec', 'libopus', '-ab', '128k', '-ac', '2', '-ar', '48000',
        '-f', 'tee',
        `[select=a:f=rtp:ssrc=22222222:payload_type=101]rtp://127.0.0.1:${rtp}?rtcpport=${rtcp}`]);
      await new Promise((r) => ff.on('close', r));
      const stats = await session.producer.getStats();
      const got = stats.find((s) => s.type === 'inbound-rtp')?.packetCount || 0;
      session.destroy();
      assert(got > 20, `RTP flowed into the producer (${got} packets)`);
      ok(`jukebox pipeline — ffmpeg → PlainTransport (${got} pkts)`);
    } else {
      console.log('[selftest] jukebox pipeline: SKIPPED (no ffmpeg here)');
    }
    soup.closeRouter(voice.id);

    console.log(`[selftest] announce: ${config.announcedAddress} (media port ${config.mediaPort})`);
    console.log('[selftest] ALL PASS');
    process.exit(0);
  } catch (err) {
    console.error(`[selftest] FAILED at ${step}:`, err.message);
    process.exit(1);
  }
}

(SELFTEST ? selftest() : main()).catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
