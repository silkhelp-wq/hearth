/**
 * Chat view — everything text. Wired to fixed DOM ids in index.html;
 * app.js injects identity/roster lookups and unread callbacks.
 */

import { renderMarkdown, escapeHtml, timeShort } from './markdown.js';
import { P, has } from './permbits.js';

const $ = (id) => document.getElementById(id);
const GROUP_MS = 5 * 60 * 1000;

/** Curated unicode set for the picker + :name: autocomplete. */
const UNICODE_EMOJI = {
  'smileys': [['😀','grin'],['😁','beam'],['😂','joy'],['🤣','rofl'],['😊','smile'],['😉','wink'],['😍','heart_eyes'],['🥰','smiling_hearts'],['😘','kiss'],['😎','cool'],['🤔','thinking'],['🙃','upside_down'],['😅','sweat_smile'],['😭','sob'],['😢','cry'],['😡','rage'],['🥺','pleading'],['😴','sleeping'],['🤯','mind_blown'],['🥳','party'],['😱','scream'],['🤢','nauseated'],['🤡','clown'],['💀','skull'],['☠️','skull_bones'],['👻','ghost'],['🤖','robot'],['😈','smiling_imp']],
  'gestures': [['👍','thumbsup'],['👎','thumbsdown'],['👌','ok_hand'],['✌️','victory'],['🤞','fingers_crossed'],['🤘','metal'],['🤙','call_me'],['👏','clap'],['🙌','raised_hands'],['🤝','handshake'],['🙏','pray'],['💪','muscle'],['👀','eyes'],['🫡','salute'],['🖕','middle_finger'],['👉','point_right'],['✋','raised_hand'],['🤌','pinched']],
  'hearts': [['❤️','heart'],['🧡','orange_heart'],['💛','yellow_heart'],['💚','green_heart'],['💙','blue_heart'],['💜','purple_heart'],['🖤','black_heart'],['💔','broken_heart'],['💯','100'],['💢','anger'],['💥','boom'],['✨','sparkles'],['⭐','star'],['🔥','fire'],['❄️','snowflake'],['⚡','zap']],
  'things': [['🎉','tada'],['🎊','confetti'],['🏆','trophy'],['🥇','gold'],['🎮','video_game'],['🕹️','joystick'],['🎲','dice'],['🎧','headphones'],['🎵','music_note'],['🎶','notes'],['💰','moneybag'],['💎','gem'],['🔫','pistol'],['🗡️','dagger'],['🛡️','shield'],['🔑','key'],['💣','bomb'],['🚀','rocket'],['⚙️','gear'],['🧠','brain'],['📌','pin'],['⏰','alarm'],['✅','check'],['❌','x'],['❓','question'],['⚠️','warning']],
  'food': [['🍕','pizza'],['🍔','burger'],['🌮','taco'],['🍜','ramen'],['🍣','sushi'],['🍺','beer'],['🍻','cheers'],['☕','coffee'],['🥤','cup'],['🍿','popcorn'],['🍩','donut'],['🍪','cookie'],['🎂','cake'],['🍉','watermelon'],['🥓','bacon'],['🌶️','hot_pepper']],
  'nature': [['🐶','dog'],['🐱','cat'],['🦊','fox'],['🐸','frog'],['🐢','turtle'],['🦀','crab'],['🐙','octopus'],['🦄','unicorn'],['🐉','dragon'],['🌙','moon'],['☀️','sun'],['🌧️','rain'],['🌈','rainbow'],['🌲','tree'],['🍀','clover'],['🌊','wave']]
};
const UNICODE_FLAT = Object.values(UNICODE_EMOJI).flat();

export function createChat({ rtc, getMe, getUsers, getRoles, getChannel,
                             getEmojis, getCaps, getBaseUrl, onIncoming, onRead }) {
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

  const emojiMap = () =>
    new Map((getEmojis() || []).map((e) => [e.name, e]));
  const emojiById = (id) => (getEmojis() || []).find((e) => e.id === id) || null;
  const emojiCtx = () => ({ map: emojiMap(), base: getBaseUrl() });

  /** Bare CDN link from an approved media host → inline gif. */
  function mediaUrl(content) {
    const t = String(content).trim();
    if (!t || /\s/.test(t)) return null;
    try {
      const u = new URL(t);
      const hosts = getCaps()?.mediaHosts || [];
      if (hosts.includes(u.hostname.toLowerCase())) return t;
    } catch { /* not a url */ }
    return null;
  }

  function chipLabel(emoji, count) {
    if (emoji.startsWith('ce:')) {
      const e = emojiById(emoji.slice(3));
      const img = e
        ? `<img class="cemoji chip" src="${getBaseUrl()}/emoji/${e.id}.${e.ext}" alt=":${escapeHtml(e.name)}:" draggable="false">`
        : '❔';
      return `${img} ${count}`;
    }
    return `${escapeHtml(emoji)} ${count}`;
  }
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
      chip.innerHTML = chipLabel(r.emoji, r.count);
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
    btn('😀', 'React', (e) => openPicker(e.currentTarget, 'react', m.id));
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
    const media = mediaUrl(m.content);
    if (media) {
      const a = document.createElement('a');
      a.href = media; a.target = '_blank'; a.rel = 'noreferrer noopener';
      a.className = 'chat-gif-wrap';
      const img = document.createElement('img');
      img.className = 'chat-gif';
      img.src = media;
      img.loading = 'lazy';
      img.alt = 'gif';
      a.appendChild(img);
      body.appendChild(a);
    } else {
      body.innerHTML = renderMarkdown(m.content, names(), me().name, emojiCtx()) +
        (m.editedAt ? ' <span class="edited">(edited)</span>' : '');
    }
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

  /* ───────────────── combined emoji / GIF picker ─────────────────── */

  const picker = { mode: 'insert', messageId: null, tab: 'emoji', gifProvider: null };

  function pickEmoji(token, isCustom) {
    if (picker.mode === 'react' && picker.messageId) {
      const emoji = isCustom ? `ce:${token}` : token;
      rtc.request('react:add', { messageId: picker.messageId, emoji })
        .then(() => st.myReacts.add(`${picker.messageId}:${emoji}`))
        .catch(() => {});
      closePicker();
    } else {
      insertAtCaret(isCustom ? `:${emojiById(token)?.name}:` : token);
    }
  }

  function insertAtCaret(text) {
    const input = $('chat-input');
    const a = input.selectionStart ?? input.value.length;
    const b = input.selectionEnd ?? a;
    input.value = input.value.slice(0, a) + text + input.value.slice(b);
    const pos = a + text.length;
    input.setSelectionRange(pos, pos);
    input.focus();
  }

  function renderEmojiTab(pop) {
    const body = pop.querySelector('.pk-body');
    body.textContent = '';
    const custom = getEmojis() || [];
    if (custom.length) {
      const head = document.createElement('div');
      head.className = 'pk-cat';
      head.textContent = 'server emojis';
      body.appendChild(head);
      const grid = document.createElement('div');
      grid.className = 'pk-grid';
      for (const e of custom) {
        const b = document.createElement('button');
        b.className = 'pk-emoji';
        b.title = `:${e.name}:`;
        b.innerHTML = `<img class="cemoji" src="${getBaseUrl()}/emoji/${e.id}.${e.ext}" alt=":${escapeHtml(e.name)}:" draggable="false">`;
        b.addEventListener('click', () => pickEmoji(e.id, true));
        grid.appendChild(b);
      }
      body.appendChild(grid);
    }
    for (const [cat, list] of Object.entries(UNICODE_EMOJI)) {
      const head = document.createElement('div');
      head.className = 'pk-cat';
      head.textContent = cat;
      body.appendChild(head);
      const grid = document.createElement('div');
      grid.className = 'pk-grid';
      for (const [ch, name] of list) {
        const b = document.createElement('button');
        b.className = 'pk-emoji';
        b.title = `:${name}:`;
        b.textContent = ch;
        b.addEventListener('click', () => pickEmoji(ch, false));
        grid.appendChild(b);
      }
      body.appendChild(grid);
    }
  }

  let gifTimer = null;
  async function loadGifs(pop, q) {
    const body = pop.querySelector('.pk-body');
    body.innerHTML = '<div class="pk-note">searching…</div>';
    try {
      const { provider, results } = await rtc.request('gif:search',
        { q, provider: picker.gifProvider });
      picker.gifProvider = provider;
      pop.querySelectorAll('.pk-prov').forEach((b) =>
        b.classList.toggle('active', b.dataset.p === provider));
      body.textContent = '';
      if (!results.length) {
        body.innerHTML = '<div class="pk-note">nothing found</div>';
        return;
      }
      const grid = document.createElement('div');
      grid.className = 'gif-grid';
      for (const g of results) {
        const b = document.createElement('button');
        b.className = 'gif-cell';
        const img = document.createElement('img');
        img.src = g.preview; img.loading = 'lazy'; img.alt = 'gif';
        b.appendChild(img);
        b.addEventListener('click', async () => {
          closePicker();
          try {
            await rtc.request('msg:send', { channelId: st.channelId, content: g.url });
          } catch (err) { flashInputError(err.message); }
        });
        grid.appendChild(b);
      }
      body.appendChild(grid);
    } catch (err) {
      body.innerHTML = `<div class="pk-note">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderGifTab(pop) {
    const body = pop.querySelector('.pk-body');
    body.textContent = '';
    loadGifs(pop, pop.querySelector('.pk-search').value.trim());
  }

  function openPicker(anchor, mode, messageId = null) {
    const pop = $('picker-pop');
    picker.mode = mode;
    picker.messageId = messageId;
    const providers = getCaps()?.gifProviders || [];
    const gifOk = mode === 'insert' && providers.length > 0;
    if (picker.tab === 'gif' && !gifOk) picker.tab = 'emoji';

    pop.innerHTML =
      `<div class="pk-tabs">` +
      `<button class="pk-tab" data-t="emoji">Emoji</button>` +
      (gifOk ? `<button class="pk-tab" data-t="gif">GIF</button>` : '') +
      `</div>` +
      `<div class="pk-provrow hidden">` +
      providers.map((p) => `<button class="pk-prov" data-p="${p}">${p}</button>`).join('') +
      `<input class="pk-search" type="text" placeholder="search gifs" spellcheck="false">` +
      `</div>` +
      `<div class="pk-body"></div>`;

    const sync = () => {
      pop.querySelectorAll('.pk-tab').forEach((b) =>
        b.classList.toggle('active', b.dataset.t === picker.tab));
      pop.querySelector('.pk-provrow').classList.toggle('hidden', picker.tab !== 'gif');
      if (picker.tab === 'gif') renderGifTab(pop);
      else renderEmojiTab(pop);
    };
    pop.querySelectorAll('.pk-tab').forEach((b) =>
      b.addEventListener('click', () => { picker.tab = b.dataset.t; sync(); }));
    pop.querySelectorAll('.pk-prov').forEach((b) =>
      b.addEventListener('click', () => {
        picker.gifProvider = b.dataset.p;
        renderGifTab(pop);
      }));
    pop.querySelector('.pk-search').addEventListener('input', (e) => {
      clearTimeout(gifTimer);
      gifTimer = setTimeout(() => loadGifs(pop, e.target.value.trim()), 450);
    });
    sync();

    pop.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    pop.style.top = Math.max(8, r.top - h - 8) + 'px';
    const dismiss = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== anchor) {
        closePicker();
        window.removeEventListener('mousedown', dismiss, true);
      }
    };
    setTimeout(() => window.addEventListener('mousedown', dismiss, true), 0);
  }

  function closePicker() { $('picker-pop').classList.add('hidden'); }

  /* ─────────────────── :name: autocomplete ─────────────────────── */

  const ac = { open: false, items: [], index: 0, start: 0 };

  function updateAutocomplete() {
    const input = $('chat-input');
    const pop = $('emoji-ac');
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const m = before.match(/(?:^|\s):([a-z0-9_]{2,32})$/);
    if (!m) { ac.open = false; pop.classList.add('hidden'); return; }
    const q = m[1];
    ac.start = caret - q.length - 1;
    const custom = (getEmojis() || [])
      .filter((e) => e.name.startsWith(q))
      .map((e) => ({ kind: 'custom', e }));
    const uni = UNICODE_FLAT
      .filter(([, n]) => n.startsWith(q))
      .map(([ch, n]) => ({ kind: 'uni', ch, n }));
    ac.items = [...custom, ...uni].slice(0, 8);
    if (!ac.items.length) { ac.open = false; pop.classList.add('hidden'); return; }
    ac.index = 0;
    ac.open = true;
    pop.textContent = '';
    ac.items.forEach((item, i) => {
      const row = document.createElement('button');
      row.className = 'ac-row' + (i === ac.index ? ' active' : '');
      row.innerHTML = item.kind === 'custom'
        ? `<img class="cemoji" src="${getBaseUrl()}/emoji/${item.e.id}.${item.e.ext}" alt="" draggable="false"> :${escapeHtml(item.e.name)}:`
        : `<span class="ac-ch">${item.ch}</span> :${escapeHtml(item.n)}:`;
      row.addEventListener('mousedown', (ev) => { ev.preventDefault(); applyAc(i); });
      pop.appendChild(row);
    });
    pop.classList.remove('hidden');
  }

  function applyAc(i) {
    const item = ac.items[i];
    if (!item) return;
    const input = $('chat-input');
    const caret = input.selectionStart ?? input.value.length;
    const insert = item.kind === 'custom' ? `:${item.e.name}: ` : `${item.ch} `;
    input.value = input.value.slice(0, ac.start) + insert + input.value.slice(caret);
    const pos = ac.start + insert.length;
    input.setSelectionRange(pos, pos);
    ac.open = false;
    $('emoji-ac').classList.add('hidden');
    input.focus();
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
      if (ac.open) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          ac.index = (ac.index + (e.key === 'ArrowDown' ? 1 : ac.items.length - 1)) % ac.items.length;
          $('emoji-ac').querySelectorAll('.ac-row').forEach((r, i) =>
            r.classList.toggle('active', i === ac.index));
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyAc(ac.index); return; }
        if (e.key === 'Escape') { ac.open = false; $('emoji-ac').classList.add('hidden'); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      if (e.key === 'Escape') clearReplyBar();
    });
    input.addEventListener('input', () => {
      autosize(input);
      updateAutocomplete();
      const now = Date.now();
      if (input.value && now - st.lastTypingSent > 2500 && st.channelId) {
        st.lastTypingSent = now;
        rtc.socket.emit('typing', { channelId: st.channelId });
      }
    });
    $('reply-cancel').addEventListener('click', clearReplyBar);
    $('chat-emoji-btn').addEventListener('click', (e) => {
      picker.tab = 'emoji';
      openPicker(e.currentTarget, 'insert');
    });
    $('chat-gif-btn').addEventListener('click', (e) => {
      picker.tab = 'gif';
      openPicker(e.currentTarget, 'insert');
    });

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
    $('chat-emoji-btn').disabled = !canSend;
    const providers = getCaps()?.gifProviders || [];
    $('chat-gif-btn').classList.toggle('hidden', !providers.length);
    $('chat-gif-btn').disabled = !canSend;
    input.placeholder = canSend
      ? `Message # ${getChannel(st.channelId)?.name || ''}`
      : 'You do not have permission to send messages here';
  }

  return { wire, open, close, refreshPermsUI, current: () => st.channelId };
}
