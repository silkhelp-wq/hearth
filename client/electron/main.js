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

const { app, BrowserWindow, ipcMain, session, desktopCapturer } = require('electron');
const path = require('path');
const updater = require('./updater');

// Wayland: route getDisplayMedia through the xdg-desktop-portal / PipeWire.
// AcceleratedVideoEncoder: opt into VA-API hardware encode on Linux where
// the driver offers it (Intel/AMD; NVIDIA's Linux driver has no VA-API
// encode path, so NVIDIA boxes encode on CPU). Harmless where unsupported.
// WebRTCPipeWireCapturer: Wayland screen share via the desktop portal.
// AcceleratedVideoEncoder: allow hw video encode paths where present.
// WebRtcAV1HWEncode: hw AV1 encode (NVENC/QSV/AMF) — Chromium ships this
// OFF by default on Windows, so RTX/Arc/RDNA3 machines would otherwise
// software-encode AV1 shares.
app.commandLine.appendSwitch('enable-features',
  'WebRTCPipeWireCapturer,AcceleratedVideoEncoder,WebRtcAV1HWEncode');
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
  win = new BrowserWindow({
    width: 1360,
    height: 860,
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

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // Screen-share: resolve getDisplayMedia() with whatever the renderer's
  // picker chose. With the PipeWire flag above, getSources() on Wayland
  // brings up the system portal; on X11/Windows/macOS it enumerates
  // screens and windows directly.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const choice = pendingShare;
        pendingShare = null;
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 0, height: 0 }
        });
        // Strict id match on Windows/macOS: falling back to sources[0]
        // there is how a machine with broken capture ends up silently
        // sharing Hearth's own window. Linux is the exception — under
        // PipeWire this call opens a NEW portal session that returns the
        // single source the user just approved, with a fresh id that can
        // never equal the picker's, so that one source IS the answer.
        const source = (choice && sources.find((s) => s.id === choice.id)) ||
          (process.platform === 'linux' ? sources[0] : null);
        if (!source) {
          console.error('[share] picked source not capturable:',
            choice?.id, '— enumerated', sources.length, 'sources');
          return callback(null);
        }

        const wantLoopback =
          choice?.withAudio && process.platform === 'win32';
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (uiohook && uiohookStarted) { try { uiohook.stop(); } catch { /* noop */ } }
  if (process.platform !== 'darwin') app.quit();
});
