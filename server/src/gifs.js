'use strict';
/**
 * GIF search — server-side proxy so API keys never reach clients and CORS
 * never matters. Providers enable individually when their key is set:
 *
 *   HEARTH_TENOR_KEY        https://developers.google.com/tenor (free)
 *   HEARTH_GIPHY_KEY        https://developers.giphy.com        (free)
 *   HEARTH_IMGUR_CLIENT_ID  https://api.imgur.com/oauth2/addclient (free)
 *
 * Results normalize to { id, provider, url, preview, width, height } where
 * `url` is what gets posted into chat (a CDN link — nothing is stored
 * server-side) and `preview` is the small grid thumbnail.
 */

const config = require('./config');

const TIMEOUT_MS = 8000;
const LIMIT = 24;

function providers() {
  const g = config.gifs;
  const out = [];
  if (g.tenorKey) out.push('tenor');
  if (g.giphyKey) out.push('giphy');
  if (g.imgurClientId) out.push('imgur');
  return out;
}

async function fetchJson(url, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers });
    if (!res.ok) throw new Error(`provider returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ── per-provider search (empty query = trending/featured) ── */

async function tenor(q) {
  const key = encodeURIComponent(config.gifs.tenorKey);
  const base = q
    ? `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}`
    : 'https://tenor.googleapis.com/v2/featured?';
  const j = await fetchJson(
    `${base}&key=${key}&limit=${LIMIT}&media_filter=gif,tinygif&contentfilter=medium`);
  return (j.results || []).map((r) => {
    const gif = r.media_formats?.gif;
    const tiny = r.media_formats?.tinygif || gif;
    if (!gif?.url) return null;
    return {
      id: `t_${r.id}`, provider: 'tenor',
      url: gif.url, preview: tiny.url,
      width: tiny.dims?.[0] || 0, height: tiny.dims?.[1] || 0
    };
  }).filter(Boolean);
}

async function giphy(q) {
  const key = encodeURIComponent(config.gifs.giphyKey);
  const base = q
    ? `https://api.giphy.com/v1/gifs/search?q=${encodeURIComponent(q)}&`
    : 'https://api.giphy.com/v1/gifs/trending?';
  const j = await fetchJson(`${base}api_key=${key}&limit=${LIMIT}&rating=pg-13`);
  return (j.data || []).map((r) => {
    const full = r.images?.original;
    const small = r.images?.fixed_width_small || r.images?.fixed_width || full;
    if (!full?.url) return null;
    return {
      id: `g_${r.id}`, provider: 'giphy',
      url: full.url.split('?')[0], preview: small.url,
      width: Number(small.width) || 0, height: Number(small.height) || 0
    };
  }).filter(Boolean);
}

async function imgur(q) {
  const url = q
    ? `https://api.imgur.com/3/gallery/search/viral/all/0?q=${encodeURIComponent(q)}&q_type=anigif`
    : 'https://api.imgur.com/3/gallery/hot/viral/0?showViral=true';
  const j = await fetchJson(url,
    { Authorization: `Client-ID ${config.gifs.imgurClientId}` });
  const out = [];
  for (const item of j.data || []) {
    const img = item.is_album ? (item.images || [])[0] : item;
    if (!img || img.nsfw || item.nsfw) continue;
    if (!img.animated || !String(img.link || '').endsWith('.gif')) continue;
    out.push({
      id: `i_${img.id}`, provider: 'imgur',
      url: img.link,
      preview: `https://i.imgur.com/${img.id}m.gif`,
      width: img.width || 0, height: img.height || 0
    });
    if (out.length >= LIMIT) break;
  }
  return out;
}

const SEARCHERS = { tenor, giphy, imgur };

async function search(q, provider) {
  const enabled = providers();
  if (!enabled.length) throw new Error('no GIF providers configured on the host');
  const pick = enabled.includes(provider) ? provider : enabled[0];
  const results = await SEARCHERS[pick](String(q || '').trim().slice(0, 80));
  return { provider: pick, providers: enabled, results };
}

/** Hosts whose bare links the client may render as inline media. */
const MEDIA_HOSTS = [
  'media.tenor.com', 'media1.tenor.com', 'c.tenor.com',
  'media.giphy.com', 'media0.giphy.com', 'media1.giphy.com',
  'media2.giphy.com', 'media3.giphy.com', 'media4.giphy.com',
  'i.giphy.com', 'i.imgur.com'
];

module.exports = { providers, search, MEDIA_HOSTS };
