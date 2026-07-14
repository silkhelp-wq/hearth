'use strict';
/**
 * In-app update checker for Hearth.
 *
 * The repo is PRIVATE, so anonymous release polling won't work. This uses
 * the GitHub REST API with a fine-grained, read-only token that ships in a
 * tiny bundled file (build/update-token.txt) — scope limited to "contents:
 * read" on this one repo, so a leak exposes nothing but the ability to read
 * releases you already share with your friends. If the token file is absent,
 * update checking silently disables (dev builds, forks).
 *
 * Flow: compare latest release tag to app version → tell the renderer →
 * on user confirm, download the platform asset to a temp path with the same
 * auth header → hand off to the OS installer. AppImage updates in place;
 * .deb / .exe / .dmg open their installer.
 */

const { app, net, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const REPO = 'silkhelp-wq/hearth';

function readToken() {
  // Packaged: resources/update-token.txt (extraResources). Dev: build/.
  const candidates = [
    path.join(process.resourcesPath || '', 'update-token.txt'),
    path.join(__dirname, '..', 'build', 'update-token.txt')
  ];
  for (const p of candidates) {
    try {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t) return t;
    } catch { /* next */ }
  }
  return null;
}

/** Parse "v1.2.3" / "1.2.3" → [1,2,3]; returns null on garbage. */
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

function ghRequest(urlPath, token, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'GET',
      url: `https://api.github.com${urlPath}`
    });
    request.setHeader('User-Agent', 'Hearth-Updater');
    request.setHeader('Accept',
      raw ? 'application/octet-stream' : 'application/vnd.github+json');
    if (token) request.setHeader('Authorization', `Bearer ${token}`);

    const chunks = [];
    request.on('response', (response) => {
      // Follow the redirect GitHub issues for asset downloads.
      if ([301, 302, 307].includes(response.statusCode) && response.headers.location) {
        const loc = Array.isArray(response.headers.location)
          ? response.headers.location[0] : response.headers.location;
        return resolve({ redirect: loc });
      }
      if (response.statusCode >= 400) {
        return reject(new Error(`GitHub API ${response.statusCode}`));
      }
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => resolve({ body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}

/** Pick the release asset matching this platform. */
function assetForPlatform(assets) {
  const p = process.platform;
  const match = (re) => assets.find((a) => re.test(a.name));
  if (p === 'linux') {
    // Prefer AppImage (in-place update), fall back to .deb / .pacman.
    return match(/\.AppImage$/i) || match(/\.pacman$/i) || match(/\.deb$/i);
  }
  if (p === 'win32') return match(/\.exe$/i);
  if (p === 'darwin') return match(/\.dmg$/i);
  return null;
}

async function checkForUpdate() {
  const token = readToken();
  if (!token) return { available: false, reason: 'updates not configured' };

  const { body } = await ghRequest(`/repos/${REPO}/releases/latest`, token);
  const release = JSON.parse(body.toString());
  const latest = release.tag_name;
  if (!isNewer(latest, app.getVersion())) {
    return { available: false, current: app.getVersion(), latest };
  }
  const asset = assetForPlatform(release.assets || []);
  return {
    available: true,
    current: app.getVersion(),
    latest,
    notes: (release.body || '').slice(0, 4000),
    assetId: asset?.id || null,
    assetName: asset?.name || null,
    htmlUrl: release.html_url
  };
}

/** Download the asset via the API (auth-preserving) to a temp file. */
async function downloadAsset(assetId, assetName, onProgress) {
  const token = readToken();
  const first = await ghRequest(
    `/repos/${REPO}/releases/assets/${assetId}`, token, { raw: true });

  let buf;
  if (first.redirect) {
    // Signed S3 URL — fetch without the GitHub auth header.
    buf = await new Promise((resolve, reject) => {
      const request = net.request({ method: 'GET', url: first.redirect });
      const chunks = [];
      let received = 0;
      request.on('response', (response) => {
        const total = Number(
          (Array.isArray(response.headers['content-length'])
            ? response.headers['content-length'][0]
            : response.headers['content-length']) || 0);
        response.on('data', (c) => {
          chunks.push(c);
          received += c.length;
          if (total && onProgress) onProgress(Math.round((received / total) * 100));
        });
        response.on('end', () => resolve(Buffer.concat(chunks)));
      });
      request.on('error', reject);
      request.end();
    });
  } else {
    buf = first.body;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-update-'));
  const dest = path.join(dir, assetName);
  fs.writeFileSync(dest, buf);
  return dest;
}

/** Launch the downloaded installer / new AppImage, then quit. */
async function installUpdate(filePath) {
  const p = process.platform;
  if (p === 'linux' && /\.AppImage$/i.test(filePath)) {
    fs.chmodSync(filePath, 0o755);
    // Replace the running AppImage if we can locate it, else just launch.
    const running = process.env.APPIMAGE;
    if (running) {
      try {
        fs.copyFileSync(filePath, running);
        fs.chmodSync(running, 0o755);
        spawn(running, [], { detached: true, stdio: 'ignore' }).unref();
        setTimeout(() => app.quit(), 400);
        return;
      } catch { /* fall through to plain launch */ }
    }
    spawn(filePath, [], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 400);
    return;
  }
  // .deb / .pacman / .exe / .dmg — hand to the OS, then quit.
  await shell.openPath(filePath);
  setTimeout(() => app.quit(), 800);
}

module.exports = { checkForUpdate, downloadAsset, installUpdate, isNewer, parseVersion };
