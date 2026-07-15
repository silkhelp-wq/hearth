'use strict';
/**
 * Server update check. Queries the private repo's latest release tag with a
 * read-only token (server/hearth-update-token.txt, or HEARTH_UPDATE_TOKEN)
 * and compares it to the running version. Only reports — the actual update
 * is applied by re-running install-server.sh (which preserves data/).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = 'silkhelp-wq/hearth';
const PUBLIC_REPO = 'silkhelp-wq/hearth-releases';
const VERSION = require('../package.json').version;

function token() {
  if (process.env.HEARTH_UPDATE_TOKEN) return process.env.HEARTH_UPDATE_TOKEN.trim();
  for (const p of [
    path.join(__dirname, '..', 'hearth-update-token.txt'),
    path.join(process.env.HEARTH_DATA_DIR || path.join(__dirname, '..', 'data'),
      'update-token.txt')
  ]) {
    try {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t) return t;
    } catch { /* next */ }
  }
  return null;
}

function parseVersion(v) {
  const m = String(v).trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(remote, local) {
  const a = parseVersion(remote), b = parseVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

function apiGet(urlPath, tok) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'api.github.com', path: urlPath, method: 'GET',
      headers: {
        'User-Agent': 'Hearth-Server-Updater',
        'Accept': 'application/vnd.github+json',
        ...(tok ? { Authorization: `Bearer ${tok}` } : {})
      }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`GitHub API ${res.statusCode}`));
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('bad API response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function shape(rel, feed) {
  const latest = rel.tag_name;
  return {
    available: isNewer(latest, VERSION),
    current: VERSION,
    latest,
    feed,
    notes: (rel.body || '').slice(0, 2000),
    htmlUrl: rel.html_url
  };
}

async function checkForUpdate() {
  // Public downloads repo first — token-free.
  try {
    return shape(await apiGet(`/repos/${PUBLIC_REPO}/releases/latest`, null), 'public');
  } catch { /* fall back to the private repo + token */ }
  const tok = token();
  if (!tok) return { available: false, current: VERSION, reason: 'not configured' };
  try {
    return shape(await apiGet(`/repos/${REPO}/releases/latest`, tok), 'private');
  } catch (err) {
    return { available: false, current: VERSION, error: err.message };
  }
}

module.exports = { checkForUpdate, isNewer, parseVersion, VERSION };
