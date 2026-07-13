'use strict';
/**
 * Text-chat signaling. Attached per-socket by index.js.
 *
 * Broadcast rooms are `text:<channelId>`; membership is maintained by
 * room.syncTextRooms() so VIEW_CHANNEL overwrites actually hide traffic.
 */

const db = require('./db');
const config = require('./config');
const { P, has } = require('./perms');

function guarded(handler) {
  return async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try { reply(await handler(payload || {})); }
    catch (err) { reply({ error: err.message }); }
  };
}

function attachSocket(io, socket, { enqueueUnfurl }) {
  const user = socket.data.user;
  const perms = (channelId) => db.permsFor(user.id, channelId);
  const need = (p, bit, msg) => { if (!has(p, bit)) throw new Error(msg); };

  const textChannel = (channelId) => {
    const ch = db.getChannel(channelId);
    if (!ch || ch.type !== 'text') throw new Error('unknown text channel');
    return ch;
  };
  const room = (channelId) => `text:${channelId}`;

  socket.on('msg:send', guarded(async ({ channelId, content, replyTo }) => {
    textChannel(channelId);
    const p = perms(channelId);
    need(p, P.VIEW_CHANNEL, 'you cannot see that channel');
    need(p, P.SEND_MESSAGES, 'no permission to send messages here');

    content = String(content ?? '').replace(/\r\n/g, '\n');
    if (!content.trim()) throw new Error('empty message');
    if (content.length > config.chat.maxMessageLen) {
      throw new Error(`message too long (max ${config.chat.maxMessageLen})`);
    }
    if (replyTo) {
      const parent = db.getRawMessage(replyTo);
      if (!parent || parent.channel_id !== channelId) replyTo = null;
    }

    const urls = has(p, P.EMBED_LINKS)
      ? db.extractUrls(content, config.unfurl.maxLinksPerMessage) : [];
    const message = db.insertMessage({
      channelId, authorId: user.id, content, replyTo, urls
    });
    io.to(room(channelId)).emit('msg:new', message);
    for (const url of urls) enqueueUnfurl(url, channelId);
    return { message };
  }));

  socket.on('msg:edit', guarded(async ({ id, content }) => {
    const raw = db.getRawMessage(id);
    if (!raw) throw new Error('unknown message');
    if (raw.author_id !== user.id) throw new Error('you can only edit your own messages');

    content = String(content ?? '').replace(/\r\n/g, '\n');
    if (!content.trim()) throw new Error('empty message');
    if (content.length > config.chat.maxMessageLen) {
      throw new Error(`message too long (max ${config.chat.maxMessageLen})`);
    }
    const p = perms(raw.channel_id);
    const urls = has(p, P.EMBED_LINKS)
      ? db.extractUrls(content, config.unfurl.maxLinksPerMessage) : [];
    db.editMessage(id, content, urls);
    const message = db.hydrateMessages([db.getRawMessage(id)], user.id)[0];
    io.to(room(raw.channel_id)).emit('msg:edited', message);
    for (const url of urls) enqueueUnfurl(url, raw.channel_id);
    return { message };
  }));

  socket.on('msg:delete', guarded(async ({ id }) => {
    const raw = db.getRawMessage(id);
    if (!raw) throw new Error('unknown message');
    if (raw.author_id !== user.id) {
      need(perms(raw.channel_id), P.MANAGE_MESSAGES, 'no permission to delete that');
    }
    db.deleteMessage(id);
    io.to(room(raw.channel_id)).emit('msg:deleted', { id, channelId: raw.channel_id });
    return { ok: true };
  }));

  socket.on('msg:history', guarded(async ({ channelId, before, around, limit }) => {
    textChannel(channelId);
    need(perms(channelId), P.VIEW_CHANNEL, 'you cannot see that channel');
    return { messages: db.history({ channelId, before, around, limit }, user.id) };
  }));

  socket.on('msg:search', guarded(async ({ q, channelId }) => {
    q = String(q ?? '').trim();
    if (q.length < 2) throw new Error('search needs at least 2 characters');
    if (channelId) {
      textChannel(channelId);
      need(perms(channelId), P.VIEW_CHANNEL, 'you cannot see that channel');
      return { results: db.search(q, user.id, channelId) };
    }
    const viewable = new Set(
      db.listChannels()
        .filter((c) => c.type === 'text' && has(perms(c.id), P.VIEW_CHANNEL))
        .map((c) => c.id));
    return { results: db.search(q, user.id).filter((m) => viewable.has(m.channelId)) };
  }));

  socket.on('typing', ({ channelId } = {}) => {
    try {
      const p = perms(channelId);
      if (!has(p, P.VIEW_CHANNEL) || !has(p, P.SEND_MESSAGES)) return;
      socket.to(room(channelId)).volatile.emit('typing', {
        channelId, userId: user.id, name: user.name
      });
    } catch { /* ignore */ }
  });

  const react = (on) => guarded(async ({ messageId, emoji }) => {
    emoji = String(emoji ?? '').slice(0, 8);
    if (!emoji || /[<>&"'\s]/.test(emoji)) throw new Error('bad emoji');
    const raw = db.getRawMessage(messageId);
    if (!raw) throw new Error('unknown message');
    need(perms(raw.channel_id), P.VIEW_CHANNEL, 'you cannot see that channel');
    const reactions = db.toggleReaction(messageId, user.id, emoji, on);
    io.to(room(raw.channel_id)).emit('react:update', {
      messageId, channelId: raw.channel_id, reactions
    });
    return { ok: true };
  });
  socket.on('react:add', react(true));
  socket.on('react:remove', react(false));

  const pin = (on) => guarded(async ({ messageId }) => {
    const raw = db.getRawMessage(messageId);
    if (!raw) throw new Error('unknown message');
    need(perms(raw.channel_id), P.MANAGE_MESSAGES, 'no permission to pin here');
    db.setPin(raw.channel_id, messageId, user.id, on);
    io.to(room(raw.channel_id)).emit('pin:update', {
      channelId: raw.channel_id, messageId, pinned: on
    });
    return { ok: true };
  });
  socket.on('pin:add', pin(true));
  socket.on('pin:remove', pin(false));

  socket.on('pins:list', guarded(async ({ channelId }) => {
    textChannel(channelId);
    need(perms(channelId), P.VIEW_CHANNEL, 'you cannot see that channel');
    return { pins: db.listPins(channelId, user.id) };
  }));

  socket.on('read:mark', guarded(async ({ channelId, messageId }) => {
    textChannel(channelId);
    db.markRead(user.id, channelId, Number(messageId) || 0);
    return { ok: true };
  }));
}

module.exports = { attachSocket };
