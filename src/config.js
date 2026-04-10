'use strict';

const Store = require('electron-store');

const DEFAULTS = {
  provider: {
    preset: 'together',
    apiUrl: '',
    apiKey: '',
    model: '',
  },
  shortcut: 'CommandOrControl+Shift+A',
  pipeline: {
    mode: 'single',
    temperature: 0.3,
    task: 'polish',
  },
  ui: {
    theme: 'system',
  },
  onboarding: {
    completed: false,
  },
};

class ConfigStore {
  constructor() {
    this.store = new Store({
      name: 'chinese-polish-config',
      defaults: DEFAULTS,
    });
  }

  get(key) {
    return this.store.get(key);
  }

  set(key, value) {
    this.store.set(key, value);
  }

  getAll() {
    return this.store.store;
  }

  reset() {
    this.store.clear();
  }
}

module.exports = ConfigStore;
