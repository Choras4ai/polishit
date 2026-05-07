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
  onExplanations: on('polish:explanations'),
  onTask: on('polish:task'),
  onReviewContext: on('polish:reviewContext'),

  // Actions
  replaceText: (text) => ipcRenderer.invoke('action:replace', text),
  applyReviewChange: (change, mode) => ipcRenderer.invoke('action:apply-review-change', change, mode),
  finalizeReview: (text) => ipcRenderer.invoke('action:finalize-review', text),
  rollbackLastReplace: () => ipcRenderer.invoke('action:rollback-last-replace'),
  dismissUndoToast: () => ipcRenderer.invoke('undo:close'),
  copyText: (text) => ipcRenderer.invoke('action:copy', text),
  reprocess: (task) => ipcRenderer.invoke('action:reprocess', task),
  regenerate: () => ipcRenderer.invoke('action:regenerate'),
  reprocessWithModel: (modelId) => ipcRenderer.invoke('action:reprocessWithModel', modelId),
  recapture: () => ipcRenderer.invoke('action:recapture'),
  onModelInfo: on('polish:modelInfo'),
  openSettings: () => ipcRenderer.invoke('window:open-settings'),
  openHome: () => ipcRenderer.invoke('window:open-home'),
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

  // Shell
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  // Commercial account
  getCommercialStatus: () => ipcRenderer.invoke('commercial:get-status'),
  refreshCommercialStatus: () => ipcRenderer.invoke('commercial:refresh-status'),
  saveCommercialSettings: (payload) => ipcRenderer.invoke('commercial:save-settings', payload),
  testCommercialBackend: () => ipcRenderer.invoke('commercial:test-backend'),
  getCommercialPlans: () => ipcRenderer.invoke('commercial:get-plans'),
  getCommercialModels: () => ipcRenderer.invoke('commercial:getModels'),
  sendCommercialCode: (phone) => ipcRenderer.invoke('commercial:send-code', phone),
  loginCommercial: (phone, code) => ipcRenderer.invoke('commercial:login', phone, code),
  registerCommercial: (email, password) => ipcRenderer.invoke('commercial:register', email, password),
  loginCommercialEmail: (email, password) => ipcRenderer.invoke('commercial:login-email', email, password),
  checkin: () => ipcRenderer.invoke('commercial:checkin'),
  releaseLock: () => ipcRenderer.invoke('commercial:release-lock'),
  getCheckinStatus: () => ipcRenderer.invoke('commercial:checkin-status'),
  subscribeCommercial: (planId) => ipcRenderer.invoke('commercial:subscribe', planId),
  createCommercialOrder: (provider, planId) => ipcRenderer.invoke('commercial:create-order', provider, planId),
  getCommercialOrder: (orderId) => ipcRenderer.invoke('commercial:get-order', orderId),
  logoutCommercial: () => ipcRenderer.invoke('commercial:logout'),

  // Updates
  getUpdateStatus: () => ipcRenderer.invoke('updates:get-status'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  openLatestRelease: () => ipcRenderer.invoke('updates:open-download'),

  // Toolbar
  toolbarAction: (task) => ipcRenderer.invoke('toolbar:action', task),
  getToolbarStatus: () => ipcRenderer.invoke('toolbar:get-status'),
  setToolbarEnabled: (enabled) => ipcRenderer.invoke('toolbar:set-enabled', enabled),
  openAccessibilitySettings: () => ipcRenderer.invoke('toolbar:open-accessibility-settings'),
});
