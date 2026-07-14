'use strict';
/**
 * SQLite persistence layer (better-sqlite3, WAL mode).
 *
 * Everything stateful lives here: identity, roles, channels + overwrites,
 * messages (with FTS5 index), reactions, pins, link-preview cache, and
 * per-user read state. Chat storage is kept under a byte cap by pruning
 * the oldest messages in batches (his call: rolling prune, pins included).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { P, ALL, DEFAULT_EVERYONE, computeBase, computeChannel } = require('./perms');

let db = null;
let dbFile = null;

const now = () => Date.now();
const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ────────────────────────────── schema ─────────────────────────────── */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#9a8e7e',
  position INTEGER NOT NULL DEFAULT 1,
  permissions INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','voice')),
  topic TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS overwrites (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('role','user')),
  target_id TEXT NOT NULL,
  allow INTEGER NOT NULL DEFAULT 0,
  deny INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_type, target_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to INTEGER,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS pins (
  channel_id TEXT NOT NULL,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by TEXT NOT NULL,
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (message_id)
);
CREATE TABLE IF NOT EXISTS message_links (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  PRIMARY KEY (message_id, url)
);
CREATE TABLE IF NOT EXISTS link_previews (
  url TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,
  title TEXT, description TEXT, site_name TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS emojis (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  ext TEXT NOT NULL CHECK (ext IN ('png','gif','webp')),
  animated INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL,
  uploaded_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS read_state (
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='messages', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

/* ─────────────────────────────── init ──────────────────────────────── */

function init({ dbPath, seedVoiceChannels = [] }) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  dbFile = dbPath;
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('auto_vacuum = INCREMENTAL');
  db.exec(SCHEMA);

  // Built-in roles.
  db.prepare(`INSERT OR IGNORE INTO roles (id, name, color, position, permissions)
              VALUES ('everyone', '@everyone', '#9a8e7e', 0, ?)`)
    .run(DEFAULT_EVERYONE);
  db.prepare(`INSERT OR IGNORE INTO roles (id, name, color, position, permissions)
              VALUES ('admin', 'Admin', '#f59e4a', 100, ?)`)
    .run(P.ADMINISTRATOR);

  // First boot: seed channels (one text channel + the voice list).
  const count = db.prepare('SELECT COUNT(*) AS n FROM channels').get().n;
  if (count === 0) {
    createChannel({ name: 'general', type: 'text', createdBy: null });
    for (const name of seedVoiceChannels) {
      createChannel({ name, type: 'voice', createdBy: null });
    }
  }

  // Owner claim code survives restarts until someone claims it.
  if (!kvGet('owner_claimed') && !kvGet('owner_code')) {
    kvSet('owner_code', crypto.randomBytes(4).toString('hex'));
  }
  return db;
}

/* ─────────────────────────────── kv ────────────────────────────────── */

function kvGet(key) {
  return db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
}
function kvSet(key, value) {
  db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

/* ────────────────────────────── users ──────────────────────────────── */

function userByToken(token) {
  return db.prepare('SELECT * FROM users WHERE token_hash = ?').get(sha256(token)) || null;
}

function createUser(token, name) {
  const id = newId('u');
  db.prepare(`INSERT INTO users (id, name, token_hash, created_at)
              VALUES (?, ?, ?, ?)`).run(id, name, sha256(token), now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function renameUser(userId, name) {
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, userId);
}

function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) || null;
}

function listUsers() {
  const users = db.prepare('SELECT id, name, is_owner FROM users ORDER BY name').all();
  const links = db.prepare('SELECT user_id, role_id FROM user_roles').all();
  const byUser = new Map();
  for (const l of links) {
    if (!byUser.has(l.user_id)) byUser.set(l.user_id, []);
    byUser.get(l.user_id).push(l.role_id);
  }
  return users.map((u) => ({
    id: u.id, name: u.name, isOwner: !!u.is_owner,
    roleIds: byUser.get(u.id) || []
  }));
}

function claimOwner(userId, code) {
  if (kvGet('owner_claimed')) return { error: 'owner already claimed' };
  if (!code || code !== kvGet('owner_code')) return { error: 'wrong code' };
  db.prepare('UPDATE users SET is_owner = 1 WHERE id = ?').run(userId);
  kvSet('owner_claimed', '1');
  return { ok: true };
}

const ownerClaimed = () => Boolean(kvGet('owner_claimed'));
const ownerCode = () => kvGet('owner_code');

/* ────────────────────────────── roles ──────────────────────────────── */

function listRoles() {
  return db.prepare('SELECT * FROM roles ORDER BY position DESC, name').all();
}

function createRole({ name, color = '#7fa3b8', permissions = 0 }) {
  const id = newId('r');
  const pos = (db.prepare('SELECT MAX(position) AS p FROM roles WHERE id != ?')
    .get('admin').p || 0) + 1;
  db.prepare(`INSERT INTO roles (id, name, color, position, permissions)
              VALUES (?, ?, ?, ?, ?)`)
    .run(id, name, color, Math.min(pos, 99), permissions & ALL);
  return db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
}

function updateRole(id, { name, color, permissions }) {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!role) return null;
  db.prepare('UPDATE roles SET name = ?, color = ?, permissions = ? WHERE id = ?')
    .run(name ?? role.name,
         color ?? role.color,
         permissions == null ? role.permissions
           : (id === 'everyone' ? (permissions & ~P.ADMINISTRATOR) : permissions) & ALL,
         id);
  return db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
}

function deleteRole(id) {
  if (id === 'everyone' || id === 'admin') return false;
  return db.prepare('DELETE FROM roles WHERE id = ?').run(id).changes > 0;
}

function assignRole(userId, roleId, on) {
  if (roleId === 'everyone') return;
  if (on) {
    db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)')
      .run(userId, roleId);
  } else {
    db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?')
      .run(userId, roleId);
  }
}

function userRoleIds(userId) {
  return db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?')
    .all(userId).map((r) => r.role_id);
}

/* ─────────────────────────── permissions ───────────────────────────── */

/** Effective permissions for a user, optionally within a channel. */
function permsFor(userId, channelId = null) {
  const user = getUser(userId);
  if (!user) return 0;
  const roleIds = userRoleIds(userId);
  const roleRows = db.prepare(
    `SELECT * FROM roles WHERE id = 'everyone' OR id IN (${roleIds.map(() => '?').join(',') || "''"})`
  ).all(...roleIds);
  const base = computeBase(!!user.is_owner, roleRows);
  if (!channelId) return base;
  const ows = db.prepare('SELECT * FROM overwrites WHERE channel_id = ?').all(channelId);
  return computeChannel(base, ows, userId, roleIds);
}

/* ───────────────────────────── channels ────────────────────────────── */

function listChannels() {
  return db.prepare('SELECT * FROM channels ORDER BY type, position, created_at').all();
}

function getChannel(id) {
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id) || null;
}

function createChannel({ name, type, createdBy }) {
  const id = newId(type === 'text' ? 'tc' : 'vc');
  const pos = (db.prepare('SELECT MAX(position) AS p FROM channels WHERE type = ?')
    .get(type).p ?? -1) + 1;
  db.prepare(`INSERT INTO channels (id, name, type, position, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, String(name).slice(0, 40), type, pos, createdBy, now());
  return getChannel(id);
}

function updateChannel(id, { name, topic }) {
  const ch = getChannel(id);
  if (!ch) return null;
  db.prepare('UPDATE channels SET name = ?, topic = ? WHERE id = ?')
    .run(name != null ? String(name).slice(0, 40) : ch.name,
         topic != null ? String(topic).slice(0, 200) : ch.topic, id);
  return getChannel(id);
}

function deleteChannel(id) {
  // Explicit message purge first: guarantees the FTS delete triggers run
  // (FK cascade paths and triggers interact subtly in SQLite).
  db.prepare('DELETE FROM messages WHERE channel_id = ?').run(id);
  return db.prepare('DELETE FROM channels WHERE id = ?').run(id).changes > 0;
}

function listOverwrites(channelId) {
  return db.prepare('SELECT * FROM overwrites WHERE channel_id = ?').all(channelId);
}

function setOverwrite(channelId, targetType, targetId, allow, deny) {
  allow &= ALL; deny &= ALL;
  if (!allow && !deny) {
    db.prepare(`DELETE FROM overwrites WHERE channel_id = ? AND target_type = ? AND target_id = ?`)
      .run(channelId, targetType, targetId);
    return;
  }
  db.prepare(`INSERT INTO overwrites (channel_id, target_type, target_id, allow, deny)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(channel_id, target_type, target_id)
              DO UPDATE SET allow = excluded.allow, deny = excluded.deny`)
    .run(channelId, targetType, targetId, allow, deny);
}

/* ───────────────────────────── messages ────────────────────────────── */

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

function extractUrls(content, max) {
  const seen = new Set();
  for (const m of content.matchAll(URL_RE)) {
    const url = m[0].replace(/[).,;!?]+$/, '');
    if (url.length <= 500) seen.add(url);
    if (seen.size >= max) break;
  }
  return [...seen];
}

function insertMessage({ channelId, authorId, content, replyTo, urls }) {
  const info = db.prepare(
    `INSERT INTO messages (channel_id, author_id, content, reply_to, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(channelId, authorId, content, replyTo || null, now());
  const id = info.lastInsertRowid;
  for (const url of urls) {
    db.prepare('INSERT OR IGNORE INTO message_links (message_id, url) VALUES (?, ?)')
      .run(id, url);
  }
  return hydrateMessages([getRawMessage(id)], authorId)[0];
}

function getRawMessage(id) {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) || null;
}

function editMessage(id, content, urls) {
  db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?')
    .run(content, now(), id);
  db.prepare('DELETE FROM message_links WHERE message_id = ?').run(id);
  for (const url of urls) {
    db.prepare('INSERT OR IGNORE INTO message_links (message_id, url) VALUES (?, ?)')
      .run(id, url);
  }
}

function deleteMessage(id) {
  return db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes > 0;
}

/** Attach author names, reply excerpts, reactions, pins, and preview cards. */
function hydrateMessages(rows, forUserId) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');

  const nameOf = new Map(
    db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));

  const reactions = db.prepare(
    `SELECT message_id, emoji, COUNT(*) AS count,
            SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS me
     FROM reactions WHERE message_id IN (${ph})
     GROUP BY message_id, emoji`).all(forUserId, ...ids);
  const reactByMsg = new Map();
  for (const r of reactions) {
    if (!reactByMsg.has(r.message_id)) reactByMsg.set(r.message_id, []);
    reactByMsg.get(r.message_id).push({ emoji: r.emoji, count: r.count, me: !!r.me });
  }

  const pinned = new Set(db.prepare(
    `SELECT message_id FROM pins WHERE message_id IN (${ph})`)
    .all(...ids).map((p) => p.message_id));

  const links = db.prepare(
    `SELECT ml.message_id, ml.url, lp.ok, lp.title, lp.description, lp.site_name
     FROM message_links ml LEFT JOIN link_previews lp ON lp.url = ml.url
     WHERE ml.message_id IN (${ph})`).all(...ids);
  const linksByMsg = new Map();
  for (const l of links) {
    if (!linksByMsg.has(l.message_id)) linksByMsg.set(l.message_id, []);
    linksByMsg.get(l.message_id).push(
      l.ok ? { url: l.url, title: l.title, description: l.description, siteName: l.site_name }
           : { url: l.url });
  }

  const replyIds = [...new Set(rows.map((r) => r.reply_to).filter(Boolean))];
  const replies = new Map();
  if (replyIds.length) {
    for (const r of db.prepare(
      `SELECT id, author_id, content FROM messages
       WHERE id IN (${replyIds.map(() => '?').join(',')})`).all(...replyIds)) {
      replies.set(r.id, {
        id: r.id,
        author: nameOf.get(r.author_id) || 'unknown',
        excerpt: r.content.slice(0, 90)
      });
    }
  }

  return rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    authorId: r.author_id,
    author: nameOf.get(r.author_id) || 'unknown',
    content: r.content,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    replyTo: r.reply_to ? (replies.get(r.reply_to) || { id: r.reply_to, author: 'deleted', excerpt: '' }) : null,
    reactions: reactByMsg.get(r.id) || [],
    pinned: pinned.has(r.id),
    previews: linksByMsg.get(r.id) || []
  }));
}

function history({ channelId, before, around, limit = 50 }, forUserId) {
  limit = Math.min(Math.max(limit, 1), 100);
  let rows;
  if (around) {
    const half = Math.floor(limit / 2);
    const older = db.prepare(
      `SELECT * FROM messages WHERE channel_id = ? AND id <= ?
       ORDER BY id DESC LIMIT ?`).all(channelId, around, half + 1);
    const newer = db.prepare(
      `SELECT * FROM messages WHERE channel_id = ? AND id > ?
       ORDER BY id ASC LIMIT ?`).all(channelId, around, half);
    rows = [...older.reverse(), ...newer];
  } else if (before) {
    rows = db.prepare(
      `SELECT * FROM messages WHERE channel_id = ? AND id < ?
       ORDER BY id DESC LIMIT ?`).all(channelId, before, limit).reverse();
  } else {
    rows = db.prepare(
      `SELECT * FROM messages WHERE channel_id = ?
       ORDER BY id DESC LIMIT ?`).all(channelId, limit).reverse();
  }
  return hydrateMessages(rows, forUserId);
}

function lastMessageIds() {
  const out = {};
  for (const r of db.prepare(
    'SELECT channel_id, MAX(id) AS last FROM messages GROUP BY channel_id').all()) {
    out[r.channel_id] = r.last;
  }
  return out;
}

/* ─────────────────────── reactions / pins / read ───────────────────── */

function toggleReaction(messageId, userId, emoji, on) {
  if (on) {
    db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)')
      .run(messageId, userId, emoji);
  } else {
    db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
      .run(messageId, userId, emoji);
  }
  return db.prepare(
    `SELECT emoji, COUNT(*) AS count FROM reactions
     WHERE message_id = ? GROUP BY emoji`).all(messageId);
}

function setPin(channelId, messageId, userId, on) {
  if (on) {
    db.prepare(`INSERT OR IGNORE INTO pins (channel_id, message_id, pinned_by, pinned_at)
                VALUES (?, ?, ?, ?)`).run(channelId, messageId, userId, now());
  } else {
    db.prepare('DELETE FROM pins WHERE message_id = ?').run(messageId);
  }
}

function listPins(channelId, forUserId) {
  const rows = db.prepare(
    `SELECT m.* FROM pins p JOIN messages m ON m.id = p.message_id
     WHERE p.channel_id = ? ORDER BY p.pinned_at DESC LIMIT 100`).all(channelId);
  return hydrateMessages(rows, forUserId);
}

function markRead(userId, channelId, lastReadId) {
  db.prepare(`INSERT INTO read_state (user_id, channel_id, last_read_id)
              VALUES (?, ?, ?)
              ON CONFLICT(user_id, channel_id)
              DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`)
    .run(userId, channelId, lastReadId);
}

function readState(userId) {
  const out = {};
  for (const r of db.prepare(
    'SELECT channel_id, last_read_id FROM read_state WHERE user_id = ?').all(userId)) {
    out[r.channel_id] = r.last_read_id;
  }
  return out;
}

/* ────────────────────────────── search ─────────────────────────────── */

function search(q, forUserId, channelId = null, limit = 25) {
  const phrase = `"${String(q).replace(/"/g, '""')}"`;
  const rows = channelId
    ? db.prepare(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH ? AND m.channel_id = ?
         ORDER BY m.id DESC LIMIT ?`).all(phrase, channelId, limit)
    : db.prepare(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH ? ORDER BY m.id DESC LIMIT ?`).all(phrase, limit);
  return hydrateMessages(rows, forUserId);
}

/* ─────────────────────────── link previews ─────────────────────────── */

function getPreview(url) {
  return db.prepare('SELECT * FROM link_previews WHERE url = ?').get(url) || null;
}

function savePreview(url, card) {
  db.prepare(`INSERT INTO link_previews (url, ok, title, description, site_name, fetched_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(url) DO UPDATE SET ok = excluded.ok, title = excluded.title,
                description = excluded.description, site_name = excluded.site_name,
                fetched_at = excluded.fetched_at`)
    .run(url, card ? 1 : 0, card?.title ?? null, card?.description ?? null,
         card?.siteName ?? null, now());
}

/** Move ownership to another member (single-owner invariant). */
function transferOwner(toId) {
  const target = getUser(toId);
  if (!target) throw new Error('unknown user');
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET is_owner = 0 WHERE is_owner = 1').run();
    db.prepare('UPDATE users SET is_owner = 1 WHERE id = ?').run(toId);
  });
  tx();
  return getUser(toId);
}

/** Permanently remove a member. Messages stay (author renders as a ghost);
 *  the owner can never be removed. */
function deleteUser(id) {
  const u = getUser(id);
  if (!u) return false;
  if (u.is_owner) throw new Error('the owner cannot be removed');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM reactions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM read_state WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
  tx();
  return true;
}

/* ────────────────────────────── emojis ─────────────────────────────── */

const EMOJI_NAME_RE = /^[a-z0-9_]{2,32}$/;

function listEmojis() {
  return db.prepare(
    'SELECT id, name, ext, animated, bytes FROM emojis ORDER BY name').all();
}

function emojiByName(name) {
  return db.prepare('SELECT * FROM emojis WHERE name = ?').get(name) || null;
}

function emojiById(id) {
  return db.prepare('SELECT * FROM emojis WHERE id = ?').get(id) || null;
}

function addEmoji({ name, ext, animated, bytes, uploadedBy }) {
  if (!EMOJI_NAME_RE.test(name)) {
    throw new Error('emoji names are 2-32 chars: a-z, 0-9, underscore');
  }
  if (emojiByName(name)) throw new Error(`:${name}: already exists`);
  const id = newId('e');
  db.prepare(`INSERT INTO emojis (id, name, ext, animated, bytes, uploaded_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name, ext, animated ? 1 : 0, bytes, uploadedBy, now());
  return emojiById(id);
}

function deleteEmoji(id) {
  return db.prepare('DELETE FROM emojis WHERE id = ?').run(id).changes > 0;
}

const emojiTotalBytes = () =>
  db.prepare('SELECT COALESCE(SUM(bytes),0) AS b FROM emojis').get().b;

/* ───────────────────── live storage settings (kv) ──────────────────── */

function getStorageSettings(defaults) {
  const raw = kvGet('storage_settings');
  const saved = raw ? JSON.parse(raw) : {};
  return {
    chatCapMB: clampMB(saved.chatCapMB ?? defaults.chatCapMB, 16, 102400),
    emojiCapMB: clampMB(saved.emojiCapMB ?? defaults.emojiCapMB, 4, 4096),
    previewCapMB: clampMB(saved.previewCapMB ?? defaults.previewCapMB, 1, 1024)
  };
}

function setStorageSettings(next, defaults) {
  const merged = getStorageSettings(defaults);
  for (const k of ['chatCapMB', 'emojiCapMB', 'previewCapMB']) {
    if (next[k] != null) merged[k] = next[k];
  }
  const clean = getStorageSettingsFrom(merged);
  kvSet('storage_settings', JSON.stringify(clean));
  return clean;
}

const clampMB = (v, min, max) =>
  Math.min(Math.max(Math.round(Number(v) || 0), min), max);

function getStorageSettingsFrom(o) {
  return {
    chatCapMB: clampMB(o.chatCapMB, 16, 102400),
    emojiCapMB: clampMB(o.emojiCapMB, 4, 4096),
    previewCapMB: clampMB(o.previewCapMB, 1, 1024)
  };
}

/** Rough on-disk weight of the preview cache; prune oldest past the cap. */
function previewCacheBytes() {
  return db.prepare(
    `SELECT COALESCE(SUM(LENGTH(url) + LENGTH(COALESCE(title,'')) +
             LENGTH(COALESCE(description,'')) + LENGTH(COALESCE(site_name,'')) + 64), 0) AS b
     FROM link_previews`).get().b;
}

function prunePreviews(capBytes) {
  let deleted = 0;
  while (previewCacheBytes() > capBytes) {
    const info = db.prepare(
      `DELETE FROM link_previews WHERE url IN (
         SELECT url FROM link_previews ORDER BY fetched_at ASC LIMIT 200)`).run();
    if (!info.changes) break;
    deleted += info.changes;
  }
  return deleted;
}

/* ─────────────────────────────── prune ─────────────────────────────── */

function dbSizeBytes() {
  if (dbFile === ':memory:') {
    return db.prepare('PRAGMA page_count').get().page_count *
           db.prepare('PRAGMA page_size').get().page_size;
  }
  db.pragma('wal_checkpoint(TRUNCATE)');
  return fs.statSync(dbFile).size;
}

/** Rolling prune: delete oldest messages in batches until under the cap. */
function pruneToCap(capBytes, batch = 500) {
  let deleted = 0;
  let size = dbSizeBytes();
  while (size > capBytes) {
    const ids = db.prepare('SELECT id FROM messages ORDER BY id ASC LIMIT ?')
      .all(batch).map((r) => r.id);
    if (!ids.length) break;
    db.prepare(`DELETE FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(...ids);
    deleted += ids.length;
    db.pragma('incremental_vacuum(4000)');
    size = dbSizeBytes();
  }
  return { deleted, size };
}

/* ────────────────────────────── export ─────────────────────────────── */

module.exports = {
  init, kvGet, kvSet,
  userByToken, createUser, renameUser, getUser, listUsers,
  claimOwner, ownerClaimed, ownerCode,
  listRoles, createRole, updateRole, deleteRole, assignRole, userRoleIds,
  permsFor,
  listChannels, getChannel, createChannel, updateChannel, deleteChannel,
  listOverwrites, setOverwrite,
  extractUrls, insertMessage, getRawMessage, editMessage, deleteMessage,
  history, lastMessageIds, hydrateMessages,
  toggleReaction, setPin, listPins, markRead, readState,
  search, getPreview, savePreview,
  deleteUser, transferOwner,
  listEmojis, emojiByName, emojiById, addEmoji, deleteEmoji, emojiTotalBytes,
  getStorageSettings, setStorageSettings, previewCacheBytes, prunePreviews,
  dbSizeBytes, pruneToCap
};
