'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hearth', {
  platform: process.platform,

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
  }
});
