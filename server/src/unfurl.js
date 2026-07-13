'use strict';
/**
 * Text-only link unfurler. Fetches a page (with hard limits), pulls
 * title / og:description / site name, and returns a card — or null.
 *
 * Guards: http(s) only, no localhost/.local, no private-range IP
 * literals — the server shouldn't be a proxy into the host's LAN,
 * even a friendly one.
 */

const PRIVATE_IP =
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.)/;

function urlAllowed(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && PRIVATE_IP.test(host)) return false;
  if (host.includes(':')) return false; // IPv6 literals: skip rather than classify
  return true;
}

const decodeEntities = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');

function pick(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeEntities(m[1].trim()).replace(/\s+/g, ' ');
  }
  return null;
}

const meta = (attr, name) => [
  new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
  new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${name}["']`, 'i')
];

/** Resolve a URL into {url,title,description,siteName} or null. */
async function fetchCard(url, { timeoutMs, maxBytes, titleMax, descriptionMax }) {
  if (!urlAllowed(url)) return null;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Hearth-linkbot/0.2 (+self-hosted chat preview)' }
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!type.includes('text/html')) return null;

    // Read at most maxBytes — og tags live in <head>.
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    while (got < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
    }
    ctl.abort(); // stop any remaining body transfer
    const html = Buffer.concat(chunks.map(Buffer.from)).toString('utf8');

    const title = pick(html, [
      ...meta('property', 'og:title'), ...meta('name', 'twitter:title'),
      /<title[^>]*>([^<]+)<\/title>/i
    ]);
    if (!title) return null;

    const description = pick(html, [
      ...meta('property', 'og:description'),
      ...meta('name', 'description'), ...meta('name', 'twitter:description')
    ]);
    const siteName = pick(html, meta('property', 'og:site_name'))
      || new URL(res.url || url).hostname;

    return {
      url,
      title: title.slice(0, titleMax),
      description: description ? description.slice(0, descriptionMax) : null,
      siteName: siteName.slice(0, 60)
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchCard, urlAllowed };
