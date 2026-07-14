'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hearth', {
  platform: process.platform,
  isWayland: process.platform === 'linux' &&
    Boolean(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland'),

  // Screen share
  getScreenSources: () => ipcRenderer.invoke('share:getSources'),
  chooseShareSource: (choice) => ipcRenderer.invoke('share:choose', choice),

  // Push-to-talk (global, via uiohook in the main process)
  pttAvailable: () => ipcRenderer.invoke('ptt:available'),
  setPttBinding: (binding) => ipcRenderer.invoke('ptt:set', binding),
  captureNextInput: () => ipcRenderer.invoke('ptt:captureNext'),
  onPtt: (cb) => {
    ipcRenderer.removeAllListeners('ptt');
    ipcRenderer.on('ptt', (_e, down) => cb(down));
  },

  // Auto-update (checks the private GitHub repo's releases)
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: (assetId, assetName) =>
    ipcRenderer.invoke('update:download', { assetId, assetName }),
  installUpdate: (filePath) => ipcRenderer.invoke('update:install', filePath),
  onUpdateProgress: (cb) => {
    ipcRenderer.removeAllListeners('update:progress');
    ipcRenderer.on('update:progress', (_e, pct) => cb(pct));
  }
});
