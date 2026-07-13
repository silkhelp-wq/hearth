/**
 * Chat view — everything text. Wired to fixed DOM ids in index.html;
 * app.js injects identity/roster lookups and unread callbacks.
 */

import { renderMarkdown, escapeHtml, timeShort } from './markdown.js';
import { P, has } from './permbits.js';

const $ = (id) => document.getElementById(id);
const EMOJIS = ['👍','❤️','😂','😮','😢','🔥','🎉','👀','💯','😅','🤔','👌','🫡','☠️','🍿','🍺'];
const GROUP_MS = 5 * 60 * 1000;

export function createChat({ rtc, getMe, getUsers, getRoles, getChannel, onIncoming, onRead }) {
  const st = {
    channelId: null,
    oldestId: null,
    historical: false,
    replyTo: null,          // {id, author}
    editingId: null,
    myReacts: new Set(),    // `${msgId}:${emoji}`
    typing: new Map(),      // userId -> {name, until}
    previewWatch: new Map(),// url -> Set(messageId)
    lastTypingSent: 0,
    readTimer: null
  };

  /* ─────────────────────────── helpers ──────────────────────────── */

  const me = () => getMe();
  const names = () => [...getUsers().values()].map((u) => u.name);

  function roleColor(userId) {
    const u = getUsers().get(userId);
    if (!u) return null;
    let best = null;
    for (const r of getRoles()) {
      if (r.id !== 'everyone' && u.roleIds.includes(r.id) &&
          (!best || r.position > best.position)) best = r;
    }
    return best?.color || null;
  }

  const myPerms = () => getChannel(st.channelId)?.myPerms ?? 0;
  const nearBottom = () => {
    const el = $('chat-scroll');
    return el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };

  function scrollToBottom() {
    const el = $('chat-scroll');
    el.scrollTop = el.scrollHeight;
  }

  /* ────────────────────── message rendering ─────────────────────── */

  function reactChips(m) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-reacts';
    for (const r of m.reactions || []) {
      const mine = st.myReacts.has(`${m.id}:${r.emoji}`);
      const chip = document.createElement('button');
      chip.className = 'react-chip' + (mine ? ' mine' : '');
      chip.textContent = `${r.emoji} ${r.count}`;
      chip.addEventListener('click', () =>
        rtc.request(mine ? 'react:remove' : 'react:add',
          { messageId: m.id, emoji: r.emoji })
          .then(() => mine
            ? st.myReacts.delete(`${m.id}:${r.emoji}`)
            : st.myReacts.add(`${m.id}:${r.emoji}`))
          .catch(() => {}));
      wrap.appendChild(chip);
    }
    return wrap;
  }

  function previewCards(m) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-previews';
    for (const p of m.previews || []) {
      if (!p.title) {
        // Pending or failed — watch for the 'preview' broadcast.
        if (!st.previewWatch.has(p.url)) st.previewWatch.set(p.url, new Set());
        st.previewWatch.get(p.url).add(m.id);
        continue;
      }
      wrap.appendChild(cardEl(p));
    }
    return wrap;
  }

  function cardEl(p) {
    const a = document.createElement('a');
    a.className = 'preview-card';
    a.href = p.url;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.dataset.url = p.url;
    a.innerHTML =
      `<span class="pv-site">${escapeHtml(p.siteName || '')}</span>` +
      `<span class="pv-title">${escapeHtml(p.title)}</span>` +
      (p.description ? `<span class="pv-desc">${escapeHtml(p.description)}</span>` : '');
    return a;
  }

  function actionBar(m) {
    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    const btn = (label, title, fn) => {
      const b = document.createElement('button');
      b.textContent = label; b.title = title;
      b.addEventListener('click', fn);
      bar.appendChild(b);
    };
    btn('😀', 'React', (e) => openEmojiPicker(e.currentTarget, m.id));
    btn('↩', 'Reply', () => setReply(m));
    if (m.authorId === me().id) btn('✏', 'Edit', () => startEdit(m.id));
    if (has(myPerms(), P.MANAGE_MESSAGES)) {
      btn('📌', m.pinned ? 'Unpin' : 'Pin', () =>
        rtc.request(m.pinned ? 'pin:remove' : 'pin:add', { messageId: m.id }).catch(() => {}));
    }
    if (m.authorId === me().id || has(myPerms(), P.MANAGE_MESSAGES)) {
      btn('🗑', 'Delete', () =>
        rtc.request('msg:delete', { id: m.id }).catch((e2) => alert(e2.message)));
    }
    return bar;
  }

  function buildMsg(m, grouped) {
    const el = document.createElement('div');
    el.className = 'msg' + (grouped ? ' grouped' : '');
    el.dataset.id = m.id;
    el.dataset.author = m.authorId;
    el.dataset.ts = m.createdAt;

    if (m.replyTo) {
      const r = document.createElement('button');
      r.className = 'msg-reply';
      r.innerHTML = `↰ <b>${escapeHtml(m.replyTo.author)}</b> ${escapeHtml(m.replyTo.excerpt)}`;
      r.addEventListener('click', () => jumpTo(m.replyTo.id));
      el.appendChild(r);
    }
    if (!grouped) {
      const head = document.createElement('div');
      head.className = 'msg-head';
      const author = document.createElement('span');
      author.className = 'msg-author';
      author.textContent = m.author;
      const color = roleColor(m.authorId);
      if (color) author.style.color = color;
      const time = document.createElement('span');
      time.className = 'msg-time';
      time.textContent = timeShort(m.createdAt);
      head.append(author, time);
      if (m.pinned) {
        const pin = document.createElement('span');
        pin.className = 'msg-pinflag'; pin.textContent = '📌';
        head.appendChild(pin);
      }
      el.appendChild(head);
    }

    const body = document.createElement('div');
    body.className = 'msg-body';
    body.innerHTML = renderMarkdown(m.content, names(), me().name) +
      (m.editedAt ? ' <span class="edited">(edited)</span>' : '');
    el.appendChild(body);

    el.appendChild(previewCards(m));
    el.appendChild(reactChips(m));
    el.appendChild(actionBar(m));

    // Seed my-reaction memory from hydration.
    for (const r of m.reactions || []) {
      if (r.me) st.myReacts.add(`${m.id}:${r.emoji}`);
    }
    return el;
  }

  const isGroupedWith = (prevEl, m) =>
    prevEl && prevEl.dataset.author === m.authorId &&
    m.createdAt - Number(prevEl.dataset.ts) < GROUP_MS &&
    !m.replyTo;

  function appendMsg(m) {
    const log = $('chat-log');
    const prev = log.lastElementChild;
    log.appendChild(buildMsg(m, isGroupedWith(prev, m)));
  }

  function renderAll(messages) {
    const log = $('chat-log');
    log.textContent = '';
    for (const m of messages) appendMsg(m);
  }

  /* ─────────────────────────── loading ──────────────────────────── */

  async function open(channel, { around = null } = {}) {
    st.channelId = channel.id;
    st.historical = !!around;
    st.replyTo = null; st.editingId = null;
    clearReplyBar();
    $('chat-name').textContent = `# ${channel.name}`;
    $('chat-topic').textContent = channel.topic || '';
    $('chat-view').classList.remove('hidden');
    $('chat-overlay').classList.add('hidden');
    $('jump-latest').classList.toggle('hidden', !around);
    refreshPermsUI();

    const { messages } = await rtc.request('msg:history',
      around ? { channelId: channel.id, around, limit: 60 }
             : { channelId: channel.id, limit: 60 });
    st.oldestId = messages[0]?.id ?? null;
    renderAll(messages);

    if (around) {
      const target = $('chat-log').querySelector(`.msg[data-id="${around}"]`);
      target?.scrollIntoView({ block: 'center' });
      target?.classList.add('flash');
      setTimeout(() => target?.classList.remove('flash'), 1600);
    } else {
      scrollToBottom();
      markRead();
    }
    $('chat-input').focus();
  }

  function close() {
    st.channelId = null;
    $('chat-view').classList.add('hidden');
  }

  async function loadOlder() {
    if (!st.channelId || !st.oldestId) return;
    const scroller = $('chat-scroll');
    const prevHeight = scroller.scrollHeight;
    const { messages } = await rtc.request('msg:history',
      { channelId: st.channelId, before: st.oldestId, limit: 50 });
    if (!messages.length) { st.oldestId = null; return; }
    st.oldestId = messages[0].id;
    const log = $('chat-log');
    const frag = document.createDocumentFragment();
    let prevEl = null;
    for (const m of messages) {
      const el = buildMsg(m, isGroupedWith(prevEl, m));
      frag.appendChild(el); prevEl = el;
    }
    log.prepend(frag);
    scroller.scrollTop = scroller.scrollHeight - prevHeight;
  }

  async function jumpTo(id) {
    const ch = getChannel(st.channelId);
    if (ch) await open(ch, { around: id });
  }

  /* ─────────────────────── read / notify ────────────────────────── */

  function markRead() {
    if (!st.channelId || st.historical) return;
    const last = $('chat-log').lastElementChild?.dataset.id;
    if (!last) return;
    clearTimeout(st.readTimer);
    st.readTimer = setTimeout(() => {
      rtc.request('read:mark', { channelId: st.channelId, messageId: Number(last) })
        .catch(() => {});
      onRead(st.channelId, Number(last));
    }, 250);
  }

  /* ─────────────────── composer / reply / edit ──────────────────── */

  function setReply(m) {
    st.replyTo = { id: m.id, author: m.author };
    $('reply-who').textContent = m.author;
    $('reply-bar').classList.remove('hidden');
    $('chat-input').focus();
  }
  function clearReplyBar() {
    st.replyTo = null;
    $('reply-bar').classList.add('hidden');
  }

  async function send() {
    const input = $('chat-input');
    const content = input.value.trim();
    if (!content || !st.channelId) return;
    input.value = '';
    autosize(input);
    const replyTo = st.replyTo?.id || null;
    clearReplyBar();
    try {
      await rtc.request('msg:send', { channelId: st.channelId, content, replyTo });
    } catch (err) {
      input.value = content;
      flashInputError(err.message);
    }
  }

  function startEdit(id) {
    const el = $('chat-log').querySelector(`.msg[data-id="${id}"]`);
    const body = el?.querySelector('.msg-body');
    if (!body || st.editingId) return;
    st.editingId = id;
    const original = body.dataset.raw ?? null;
    // Ask the server-rendered content? We keep raw on element when we have it:
    rtc.request('msg:history', { channelId: st.channelId, around: id, limit: 1 })
      .then(({ messages }) => {
        const m = messages.find((x) => x.id === id);
        const ta = document.createElement('textarea');
        ta.className = 'edit-area';
        ta.value = m?.content ?? original ?? '';
        body.replaceWith(ta);
        ta.focus();
        autosize(ta);
        ta.addEventListener('input', () => autosize(ta));
        ta.addEventListener('keydown', async (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            try {
              await rtc.request('msg:edit', { id, content: ta.value.trim() });
            } catch (err) { alert(err.message); }
            st.editingId = null;
          } else if (e.key === 'Escape') {
            st.editingId = null;
            rehydrateOne(id);
          }
        });
      });
  }

  async function rehydrateOne(id) {
    const { messages } = await rtc.request('msg:history',
      { channelId: st.channelId, around: id, limit: 1 }).catch(() => ({ messages: [] }));
    const m = messages.find((x) => x.id === id);
    const el = $('chat-log').querySelector(`.msg[data-id="${id}"]`);
    if (m && el) el.replaceWith(buildMsg(m, el.classList.contains('grouped')));
  }

  function flashInputError(msg) {
    const line = $('typing-line');
    line.textContent = msg;
    line.classList.add('err');
    setTimeout(() => { line.classList.remove('err'); }, 2500);
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  }

  /* ───────────────────────── emoji picker ───────────────────────── */

  function openEmojiPicker(anchor, messageId) {
    const pop = $('emoji-pop');
    pop.textContent = '';
    for (const e of EMOJIS) {
      const b = document.createElement('button');
      b.textContent = e;
      b.addEventListener('click', () => {
        rtc.request('react:add', { messageId, emoji: e })
          .then(() => st.myReacts.add(`${messageId}:${e}`))
          .catch(() => {});
        pop.classList.add('hidden');
      });
      pop.appendChild(b);
    }
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.min(r.left, window.innerWidth - 260) + 'px';
    pop.style.top = Math.max(8, r.top - 78) + 'px';
    pop.classList.remove('hidden');
    const dismiss = (ev) => {
      if (!pop.contains(ev.target)) {
        pop.classList.add('hidden');
        window.removeEventListener('mousedown', dismiss, true);
      }
    };
    setTimeout(() => window.addEventListener('mousedown', dismiss, true), 0);
  }

  /* ───────────────────── pins & search overlay ──────────────────── */

  function overlayList(title, messages, { unpin = false } = {}) {
    const ov = $('chat-overlay');
    ov.textContent = '';
    const head = document.createElement('div');
    head.className = 'ov-head';
    head.innerHTML = `<b>${escapeHtml(title)}</b>`;
    const x = document.createElement('button');
    x.className = 'icon-btn'; x.textContent = '✕';
    x.addEventListener('click', () => ov.classList.add('hidden'));
    head.appendChild(x);
    ov.appendChild(head);

    if (!messages.length) {
      const none = document.createElement('div');
      none.className = 'ov-empty';
      none.textContent = 'Nothing here yet.';
      ov.appendChild(none);
    }
    for (const m of messages) {
      const row = document.createElement('button');
      row.className = 'ov-row';
      row.innerHTML =
        `<span class="ov-author">${escapeHtml(m.author)}</span>` +
        `<span class="ov-snippet">${escapeHtml(m.content.slice(0, 120))}</span>` +
        `<span class="ov-time mono">${timeShort(m.createdAt)}</span>`;
      row.addEventListener('click', () => {
        ov.classList.add('hidden');
        jumpTo(m.id);
      });
      if (unpin && has(myPerms(), P.MANAGE_MESSAGES)) {
        const un = document.createElement('button');
        un.className = 'ov-unpin'; un.textContent = 'unpin'; un.title = 'Unpin';
        un.addEventListener('click', (e) => {
          e.stopPropagation();
          rtc.request('pin:remove', { messageId: m.id })
            .then(() => row.remove()).catch(() => {});
        });
        row.appendChild(un);
      }
      ov.appendChild(row);
    }
    ov.classList.remove('hidden');
  }

  /* ───────────────────────── socket wiring ──────────────────────── */

  function wire() {
    rtc.onRaw('msg:new', (m) => {
      if (m.channelId === st.channelId && !st.historical) {
        const stick = nearBottom() || m.authorId === me().id;
        appendMsg(m);
        if (stick) scrollToBottom();
        if (document.hasFocus() && stick) markRead();
        else onIncoming(m.channelId, m);
      } else {
        onIncoming(m.channelId, m);
      }
    });

    rtc.onRaw('msg:edited', (m) => {
      const el = $('chat-log').querySelector(`.msg[data-id="${m.id}"]`);
      if (el && m.channelId === st.channelId) {
        el.replaceWith(buildMsg(m, el.classList.contains('grouped')));
      }
    });

    rtc.onRaw('msg:deleted', ({ id, channelId }) => {
      if (channelId !== st.channelId) return;
      const el = $('chat-log').querySelector(`.msg[data-id="${id}"]`);
      if (!el) return;
      const next = el.nextElementSibling;
      const hadHead = !el.classList.contains('grouped');
      el.remove();
      if (hadHead && next?.classList.contains('grouped') &&
          next.dataset.author === el.dataset.author) {
        // Promote the next message to carry a header.
        rehydrateOne(Number(next.dataset.id));
      }
    });

    rtc.onRaw('react:update', ({ messageId, channelId, reactions }) => {
      if (channelId !== st.channelId) return;
      const el = $('chat-log').querySelector(`.msg[data-id="${messageId}"]`);
      if (!el) return;
      const fresh = reactChips({
        id: messageId,
        reactions: reactions.map((r) => ({ ...r, me: st.myReacts.has(`${messageId}:${r.emoji}`) }))
      });
      el.querySelector('.msg-reacts').replaceWith(fresh);
    });

    rtc.onRaw('pin:update', ({ channelId, messageId }) => {
      if (channelId === st.channelId) rehydrateOne(messageId);
    });

    rtc.onRaw('preview', ({ url, card }) => {
      const ids = st.previewWatch.get(url);
      if (!ids) return;
      st.previewWatch.delete(url);
      for (const id of ids) {
        const el = $('chat-log').querySelector(`.msg[data-id="${id}"] .msg-previews`);
        if (el && !el.querySelector(`[data-url="${CSS.escape(url)}"]`)) {
          el.appendChild(cardEl(card));
        }
      }
    });

    rtc.onRaw('typing', ({ channelId, userId, name }) => {
      if (channelId !== st.channelId || userId === me().id) return;
      st.typing.set(userId, { name, until: Date.now() + 4000 });
    });

    setInterval(() => {
      const now = Date.now();
      for (const [id, t] of st.typing) if (t.until < now) st.typing.delete(id);
      const line = $('typing-line');
      if (line.classList.contains('err')) return;
      const who = [...st.typing.values()].map((t) => t.name);
      line.textContent = who.length
        ? `${who.join(', ')} ${who.length === 1 ? 'is' : 'are'} typing…` : '';
    }, 900);

    // Composer.
    const input = $('chat-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      if (e.key === 'Escape') clearReplyBar();
    });
    input.addEventListener('input', () => {
      autosize(input);
      const now = Date.now();
      if (input.value && now - st.lastTypingSent > 2500 && st.channelId) {
        st.lastTypingSent = now;
        rtc.socket.emit('typing', { channelId: st.channelId });
      }
    });
    $('reply-cancel').addEventListener('click', clearReplyBar);

    // Scroll: pagination + read marking.
    $('chat-scroll').addEventListener('scroll', () => {
      if ($('chat-scroll').scrollTop < 60) loadOlder();
      if (nearBottom() && !st.historical) markRead();
    });
    window.addEventListener('focus', () => {
      if (st.channelId && nearBottom() && !st.historical) markRead();
    });

    // Pins & search.
    $('chat-pins-btn').addEventListener('click', async () => {
      const { pins } = await rtc.request('pins:list', { channelId: st.channelId });
      overlayList('Pinned messages', pins, { unpin: true });
    });
    $('chat-search').addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const q = e.currentTarget.value.trim();
      if (q.length < 2) return;
      try {
        const { results } = await rtc.request('msg:search',
          { q, channelId: st.channelId });
        overlayList(`Results for “${q}”`, results);
      } catch (err) { flashInputError(err.message); }
    });
    $('jump-latest').addEventListener('click', () => {
      const ch = getChannel(st.channelId);
      if (ch) open(ch);
    });
  }

  function refreshPermsUI() {
    if (!st.channelId) return;
    const p = myPerms();
    const input = $('chat-input');
    const canSend = has(p, P.SEND_MESSAGES);
    input.disabled = !canSend;
    input.placeholder = canSend
      ? `Message # ${getChannel(st.channelId)?.name || ''}`
      : 'You do not have permission to send messages here';
  }

  return { wire, open, close, refreshPermsUI, current: () => st.channelId };
}
