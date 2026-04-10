'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel) {
  return (callback) => {
    const handler = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('polishAPI', {
  // Platform
  platform: process.platform,

  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (key, value) => ipcRenderer.invoke('config:set', key, value),

  // Result events
  onOriginalText: on('polish:original'),
  onResult: on('polish:result'),
  onError: on('polish:error'),
  onProgress: on('polish:progress'),
  onTask: on('polish:task'),

  // Actions
  replaceText: (text) => ipcRenderer.invoke('action:replace', text),
  copyText: (text) => ipcRenderer.invoke('action:copy', text),
  reprocess: (task) => ipcRenderer.invoke('action:reprocess', task),
  openSettings: () => ipcRenderer.invoke('window:open-settings'),
  closeResult: () => ipcRenderer.invoke('window:close-result'),

  // Task
  getTask: () => ipcRenderer.invoke('task:get'),
  setTask: (task) => ipcRenderer.invoke('task:set', task),

  // Shortcut
  getShortcut: () => ipcRenderer.invoke('shortcut:get'),
  setShortcut: (acc) => ipcRenderer.invoke('shortcut:set', acc),

  // AI test
  testConnection: () => ipcRenderer.invoke('ai:test-connection'),

  // Presets
  getPresets: () => ipcRenderer.invoke('presets:get'),

  // Onboarding
  completeOnboarding: (presetId) => ipcRenderer.invoke('onboarding:complete', presetId),
  openOnboarding: () => ipcRenderer.invoke('window:open-onboarding'),

  // Toolbar
  toolbarAction: (task) => ipcRenderer.invoke('toolbar:action', task),
  getToolbarStatus: () => ipcRenderer.invoke('toolbar:get-status'),
  setToolbarEnabled: (enabled) => ipcRenderer.invoke('toolbar:set-enabled', enabled),
  openAccessibilitySettings: () => ipcRenderer.invoke('toolbar:open-accessibility-settings'),
});
