'use strict';
/**
 * Hearth — Electron main process.
 *
 * Responsibilities:
 *   - window lifecycle
 *   - screen-share source picking (desktopCapturer + setDisplayMediaRequestHandler)
 *   - Wayland screenshare via the PipeWire portal
 *   - global push-to-talk (uiohook-napi, works while the window is unfocused)
 */

const { app, BrowserWindow, ipcMain, session, desktopCapturer, dialog } = require('electron');
const path = require('path');
const updater = require('./updater');

// One profile no matter how Hearth is launched. Unpackaged (`npm start`)
// defaults userData to the package *name* (~/.config/hearth) while packaged
// builds use productName (~/.config/Hearth) — two profiles, two device
// tokens, and suddenly you're a duplicate member who "lost" ownership.
app.setPath('userData', path.join(app.getPath('appData'), 'Hearth'));

// Wayland: route getDisplayMedia through the xdg-desktop-portal / PipeWire.
// AcceleratedVideoEncoder: opt into VA-API hardware encode on Linux where
// the driver offers it (Intel/AMD; NVIDIA's Linux driver has no VA-API
// encode path, so NVIDIA boxes encode on CPU). Harmless where unsupported.
// WebRTCPipeWireCapturer: Wayland screen share via the desktop portal.
// AcceleratedVideoEncoder: allow hw video encode paths where present.
// WebRtcAV1HWEncode: hw AV1 encode (NVENC/QSV/AMF) — Chromium ships this
// OFF by default on Windows, so RTX/Arc/RDNA3 machines would otherwise
// software-encode AV1 shares.
// ONE call only. Chromium stores switches in a map, so a second
// appendSwitch('enable-features', ...) REPLACES the first — it does not
// merge. A v0.6.8 second call silently wiped this entire list, leaving only
// a feature name that doesn't exist ('WebRtcHW264Encoding' was invented;
// hardware H.264 for WebRTC is ON BY DEFAULT and gated by the
// --disable-webrtc-hw-encoding switch, not an enable-feature).
//
// What these actually do:
//   WebRTCPipeWireCapturer — Wayland screen capture via the portal.
//   AcceleratedVideoEncoder / VaapiVideoEncoder / VaapiVideoDecoder —
//     opt into VA-API hardware paths on Linux (Intel/AMD; on NVIDIA the
//     vaapi driver is decode-only, so encode stays software — see
//     docs/engineering/STREAMING_INTERNALS.md).
// Windows (MediaFoundation → NVENC) and macOS (VideoToolbox) need NO flags:
// their hardware encoders are enabled by default.
app.commandLine.appendSwitch('enable-features',
  'WebRTCPipeWireCapturer,AcceleratedVideoEncoder,VaapiVideoEncoder,VaapiVideoDecoder');
// Chromium's Vulkan path conflicts with ozone-wayland ('not compatible with
// Vulkan' spam) and buys nothing on the NVIDIA GL stack — force it off.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-features', 'Vulkan');
}

let win = null;

// The renderer's custom picker stores its choice here; the display-media
// handler consumes it when getDisplayMedia() fires a moment later.
let pendingShare = null; // { id, withAudio }

// ------------------------------------------------------------ push-to-talk

let uiohook = null;
let uiohookKeyNames = null;
let pttBinding = null;      // { type:'key'|'mouse', code:number, label:string }
let captureResolve = null;  // one-shot "press your PTT key" capture
let uiohookStarted = false;

function loadUiohook() {
  try {
    const mod = require('uiohook-napi');
    uiohook = mod.uIOhook;
    uiohookKeyNames = {};
    for (const [name, code] of Object.entries(mod.UiohookKey || {})) {
      if (typeof code === 'number' && !(code in uiohookKeyNames)) {
        uiohookKeyNames[code] = name;
      }
    }
    return true;
  } catch (err) {
    console.warn('[ptt] uiohook-napi unavailable — push-to-talk will only work while the window is focused.', err.message);
    return false;
  }
}

function ensureUiohookStarted() {
  if (!uiohook || uiohookStarted) return;
  uiohookStarted = true;

  const send = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  uiohook.on('keydown', (e) => {
    if (captureResolve) {
      const label = uiohookKeyNames[e.keycode] || `Key ${e.keycode}`;
      finishCapture({ type: 'key', code: e.keycode, label });
      return;
    }
    if (pttBinding?.type === 'key' && e.keycode === pttBinding.code) send('ptt', true);
  });
  uiohook.on('keyup', (e) => {
    if (pttBinding?.type === 'key' && e.keycode === pttBinding.code) send('ptt', false);
  });
  uiohook.on('mousedown', (e) => {
    // Ignore plain left/right clicks for capture; nobody wants left-click PTT.
    if (captureResolve && e.button > 2) {
      finishCapture({ type: 'mouse', code: e.button, label: `Mouse ${e.button}` });
      return;
    }
    if (pttBinding?.type === 'mouse' && e.button === pttBinding.code) send('ptt', true);
  });
  uiohook.on('mouseup', (e) => {
    if (pttBinding?.type === 'mouse' && e.button === pttBinding.code) send('ptt', false);
  });

  uiohook.start();
}

function finishCapture(binding) {
  const resolve = captureResolve;
  captureResolve = null;
  if (resolve) resolve(binding);
}

// ------------------------------------------------------------------ window

function createWindow() {
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');
  let winState = {};
  try { winState = JSON.parse(require('fs').readFileSync(stateFile, 'utf8')); }
  catch { /* first run */ }

  win = new BrowserWindow({
    width: winState.width || 1360,
    height: winState.height || 860,
    x: winState.x,
    y: winState.y,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0d1210',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (winState.maximized) win.maximize();
  win.on('close', () => {
    try {
      const b = win.getNormalBounds();
      require('fs').writeFileSync(stateFile, JSON.stringify({
        width: b.width, height: b.height, x: b.x, y: b.y,
        maximized: win.isMaximized()
      }));
    } catch { /* non-fatal */ }
  });

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.on('closed', () => { win = null; });
}

/**
 * Launch-time version check. Runs a few seconds after the window opens (so it
 * never delays startup) and only nags when there is genuinely something newer.
 * Offers to update immediately, or lets the user carry on and update later
 * from Settings. Silent on any failure — offline must never block the app.
 */
async function checkVersionOnLaunch() {
  try {
    const info = await updater.checkForUpdate();
    if (!info?.available) return;

    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Update now', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      title: 'Hearth update available',
      message: `Hearth ${info.latest} is out — you have ${info.current}.`,
      detail:
        'Updating takes about a minute and Hearth restarts itself when it\'s done.\n\n' +
        'You can keep using this version for now and update later from ' +
        'Settings → Audio → Check for updates.\n\n' +
        'Heads up: if you stay on an old version you might not be able to join ' +
        'your host. The server and app have to speak the same language, so an ' +
        'out-of-date app can fail to connect or lose features after the host ' +
        'upgrades.',
      noLink: true
    });
    if (response !== 0) return;

    if (!info.assetId) {                       // no installer for this platform
      require('electron').shell.openExternal(info.htmlUrl);
      return;
    }
    const file = await updater.downloadAsset(info.assetId, info.assetName,
      (pct) => win?.webContents.send('update:progress', pct));
    await updater.installUpdate(file);         // installs and relaunches
  } catch (err) {
    console.warn('[update] launch check skipped:', err.message);
  }
}

app.whenReady().then(() => {
  // Screen-share: resolve getDisplayMedia() with whatever the renderer's
  // picker chose. With the PipeWire flag above, getSources() on Wayland
  // brings up the system portal; on X11/Windows/macOS it enumerates
  // screens and windows directly.
  // Screen-share source resolution.
  //
  // Wayland is fundamentally different: every desktopCapturer.getSources()
  // call raises the system portal. So the OLD flow (enumerate for a picker,
  // then getDisplayMedia) prompted the portal TWICE and the mismatched
  // sessions aborted. On Wayland we therefore let the portal be the ONLY
  // picker — the renderer sends no pre-chosen id, and we hand libwebrtc the
  // single source the portal returns. X11/Windows/macOS keep the richer
  // in-app picker (their getSources() does not prompt).
  const isWayland = process.platform === 'linux' &&
    (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland');

  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const choice = pendingShare;
        pendingShare = null;

        if (isWayland) {
          // Portal is the picker. getSources() opens it once; the user's
          // approved screen/window comes back as the (usually only) source.
          const sources = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 0, height: 0 }
          });
          const source = sources[0];
          if (!source) {
            console.error('[share] Wayland portal returned no source (cancelled?)');
            return callback(null);
          }
          const wantLoopback = choice?.withAudio;
          return callback({
            video: source,
            audio: wantLoopback ? 'loopback' : undefined
          });
        }

        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 0, height: 0 }
        });
        // Strict id match on Windows/macOS/X11: falling back to sources[0]
        // there is how a machine with broken capture ends up silently
        // sharing Hearth's own window.
        const source = choice && sources.find((s) => s.id === choice.id);
        if (!source) {
          console.error('[share] picked source not capturable:',
            choice?.id, '— enumerated', sources.length, 'sources');
          return callback(null);
        }

        const wantLoopback = choice?.withAudio && process.platform === 'win32';
        callback({ video: source, audio: wantLoopback ? 'loopback' : undefined });
      } catch (err) {
        console.error('[share] handler failed:', err.message);
        callback(null);
      }
    },
    { useSystemPicker: false }
  );

  // ----- IPC -----

  ipcMain.handle('share:getSources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? 'screen' : 'window',
      thumbnail: s.thumbnail?.isEmpty() ? null : s.thumbnail.toDataURL(),
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
    }));
  });

  ipcMain.handle('share:choose', (_e, choice) => {
    pendingShare = choice || null;
    return true;
  });

  ipcMain.handle('ptt:available', () => Boolean(uiohook));

  ipcMain.handle('ptt:set', (_e, binding) => {
    pttBinding = binding || null;
    if (pttBinding) ensureUiohookStarted();
    return true;
  });

  ipcMain.handle('ptt:captureNext', () => {
    if (!uiohook) return null;
    ensureUiohookStarted();
    return new Promise((resolve) => {
      captureResolve = resolve;
      setTimeout(() => finishCapture(null), 10_000); // give up after 10s
    });
  });

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:check', async () => {
    try { return await updater.checkForUpdate(); }
    catch (err) { return { available: false, error: err.message }; }
  });
  ipcMain.handle('update:download', async (_e, { assetId, assetName }) => {
    try {
      const file = await updater.downloadAsset(assetId, assetName,
        (pct) => win?.webContents.send('update:progress', pct));
      return { ok: true, file };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('update:install', async (_e, file) => {
    try { await updater.installUpdate(file); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  loadUiohook();
  createWindow();
  // Nag about a stale version a few seconds in — never blocks startup.
  setTimeout(checkVersionOnLaunch, 4000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (uiohook && uiohookStarted) { try { uiohook.stop(); } catch { /* noop */ } }
  if (process.platform !== 'darwin') app.quit();
});
