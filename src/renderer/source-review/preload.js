'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sourceReview', {
  onRender: callback => ipcRenderer.on('source-review:render', (_event, payload) => callback(payload)),
  act: payload => ipcRenderer.invoke('source-review:action', payload),
});
